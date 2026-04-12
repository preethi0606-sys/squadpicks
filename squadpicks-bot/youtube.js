// youtube.js — Filmi Craft channel monitor
const { google } = require('googleapis');
const cron = require('node-cron');
const db = require('./db');
const { formatFilmiCraftCard, buildVoteKeyboard, escHtml } = require('./links');

const youtube = google.youtube({
  version: 'v3',
  auth: process.env.YOUTUBE_API_KEY
});

const CHANNEL_ID   = process.env.FILMICRAFT_CHANNEL_ID;
const CHANNEL_NAME = process.env.FILMICRAFT_CHANNEL_NAME || 'Filmi Craft';

// ─── EXTRACT SCORE FROM VIDEO TITLE ────────────────────────
// Filmi Craft titles often contain ratings like "4.1/5" or "4 stars"

function extractScore(title) {
  const patterns = [
    /(\d+\.?\d*)\s*\/\s*5/i,       // "4.1/5"
    /(\d+\.?\d*)\s*out\s*of\s*5/i, // "4 out of 5"
    /(\d+\.?\d*)\s*stars?/i,        // "4 stars"
    /rating[:\s]+(\d+\.?\d*)/i,     // "Rating: 4.1"
  ];
  for (const pattern of patterns) {
    const match = title.match(pattern);
    if (match) return `${match[1]}/5`;
  }
  return null;
}

// ─── EXTRACT MOVIE NAME FROM VIDEO TITLE ───────────────────
// Filmi Craft titles: "Kaantha Movie Review by Filmi craft Arun | ..."

function extractMovieName(title) {
  // Remove common suffixes like "Movie Review by Filmi craft Arun | ..."
  let clean = title
    .replace(/\s*\|.*/g, '')           // remove everything after |
    .replace(/movie review.*/gi, '')   // remove "movie review ..."
    .replace(/review.*/gi, '')         // remove "review ..."
    .replace(/by filmi.*/gi, '')       // remove "by Filmi craft ..."
    .replace(/trailer.*/gi, '')        // remove "trailer ..."
    .replace(/\s+/g, ' ')
    .trim();
  return clean || title;
}

// ─── CHECK FOR NEW VIDEOS ───────────────────────────────────

async function checkForNewVideos(bot) {
  if (!process.env.YOUTUBE_API_KEY || process.env.YOUTUBE_API_KEY === 'your_youtube_api_key_here') {
    return; // Skip if not configured
  }

  console.log(`[YouTube] Checking ${CHANNEL_NAME} for new videos...`);

  try {
    const res = await youtube.search.list({
      part: ['snippet'],
      channelId: CHANNEL_ID,
      maxResults: 5,
      order: 'date',
      type: ['video']
    });

    const items = res.data.items || [];

    for (const item of items) {
      const videoId   = item.id.videoId;
      const rawTitle  = item.snippet.title;
      const thumbnail = item.snippet.thumbnails?.high?.url || '';

      // Skip if already posted
      const alreadyPosted = await db.wasVideoPosted(videoId);
      if (alreadyPosted) continue;

      console.log(`[YouTube] New video: ${rawTitle}`);

      const movieName = extractMovieName(rawTitle);
      const score     = extractScore(rawTitle);
      const videoUrl  = `https://youtube.com/watch?v=${videoId}`;

      // Save as a pick in all active groups
      const groups = await db.getAllGroups();
      for (const group of groups) {
        const pick = await db.savePick({
          groupId:       group.id,
          type:          'movie',
          title:         movieName,
          description:   `${CHANNEL_NAME} reviewed this`,
          url:           videoUrl,
          imageUrl:      thumbnail,
          addedById:     null,
          addedByName:   CHANNEL_NAME,
          reviewerName:  CHANNEL_NAME,
          reviewerScore: score,
          reviewerQuote: null,
          reviewerVideoId: videoId
        });

        if (!pick) continue;

        // Send the card to the group
        const text = buildFilmiCraftMessage(movieName, score, videoUrl, rawTitle);
        try {
          const sent = await bot.sendMessage(group.id, text, {
            parse_mode: 'HTML',
            reply_markup: buildVoteKeyboard(pick.id)
          });
          await db.updatePickMessageId(pick.id, sent.message_id);
        } catch (sendErr) {
          console.error(`[YouTube] Failed to send to group ${group.id}:`, sendErr.message);
        }
      }

      // Mark as posted so we don't post it again
      await db.markVideoPosted(videoId, CHANNEL_ID, rawTitle);
    }
  } catch (err) {
    console.error('[YouTube] API error:', err.message);
  }
}

// ─── FILMI CRAFT CARD MESSAGE ───────────────────────────────

function buildFilmiCraftMessage(movieName, score, videoUrl, rawTitle) {
  let text = `📺 <b>New review from ${escHtml(CHANNEL_NAME)}!</b>\n\n`;
  text += `🎬 <b>${escHtml(movieName)}</b>\n`;
  if (score) text += `⭐ Score: <b>${escHtml(score)}</b>\n`;
  text += `\n<a href="${escHtml(videoUrl)}">Watch the review on YouTube →</a>\n`;
  text += `\n<i>Vote below — does your squad want to watch this?</i>`;
  return text;
}

// ─── LATEST FC PICKS FORMATTER (for /fcpicks command) ──────

async function formatLatestFCPicks() {
  const picks = await db.getRecentFilmiCraftPicks(5);
  if (!picks.length) {
    return `<i>No Filmi Craft reviews yet. The bot checks every hour for new videos.</i>`;
  }
  let text = `📺 <b>Latest from ${CHANNEL_NAME}</b>\n\n`;
  picks.forEach((p, i) => {
    text += `${i + 1}. 🎬 <b>${escHtml(p.title)}</b>`;
    if (p.reviewer_score) text += `  ⭐ ${escHtml(p.reviewer_score)}`;
    if (p.reviewer_video_id) {
      text += `\n   <a href="https://youtube.com/watch?v=${p.reviewer_video_id}">Watch review</a>`;
    }
    text += '\n\n';
  });
  return text;
}

// ─── START CRON JOB ────────────────────────────────────────

function startYouTubeMonitor(bot) {
  // Check every hour
  cron.schedule('0 9 * * 5', () => checkForNewVideos(bot));
  console.log('[YouTube] Filmi Craft monitor started — checks every hour');

  // Also check immediately on startup
  setTimeout(() => checkForNewVideos(bot), 5000);
}

module.exports = { startYouTubeMonitor, formatLatestFCPicks, checkForNewVideos };
