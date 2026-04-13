// index.js — SquadPicks Telegram Bot
// "Your squad. Any plan. One bot."
require('dotenv').config();

const TelegramBot = require('node-telegram-bot-api');
const db = require('./db');
const {
  detectType, fetchMeta, extractUrls,
  formatCard, formatSummary, buildVoteKeyboard, buildSummaryKeyboard,
  escHtml
} = require('./links');
const { startYouTubeMonitor, formatLatestFCPicks } = require('./youtube');
const { startDigestCron, sendWeeklyDigest } = require('./digest');

// ─── INIT BOT ──────────────────────────────────────────────

if (!process.env.TELEGRAM_TOKEN || process.env.TELEGRAM_TOKEN === 'your_telegram_bot_token_here') {
  console.error('ERROR: TELEGRAM_TOKEN is not set in .env file');
  process.exit(1);
}

const bot = new TelegramBot(process.env.TELEGRAM_TOKEN, { polling: true });
console.log('SquadPicks bot started!');

// ─── WELCOME MESSAGE (when bot is added to a group) ────────

bot.on('new_chat_members', async (msg) => {
  const newMembers = msg.new_chat_members || [];
  const botInfo = await bot.getMe();
  const botAdded = newMembers.some(m => m.id === botInfo.id);
  if (!botAdded) return;

  await db.ensureGroup(msg.chat.id, msg.chat.title || 'SquadPicks Group');

  const welcome =
    `Hey ${escHtml(msg.chat.title || 'Squad')}! <b>SquadPicks is here!</b>\n\n` +
    `I'm your group activity bot. Paste any link in this chat and I'll turn it into a pick card your whole squad can vote on.\n\n` +
    `<b>Works with:</b>\n` +
    `\u{1F3AC} IMDB, Letterboxd \u2014 movies and shows\n` +
    `\u{1F4CD} Google Maps, TripAdvisor \u2014 places\n` +
    `\u{1F37D} Yelp, Zomato \u2014 restaurants and food\n` +
    `\u{1F3AD} Eventbrite, BookMyShow \u2014 events\n\n` +
    `I'm also watching <b>Filmi Craft</b> \u2014 whenever they post a new review I'll drop a card here automatically!\n\n` +
    `<b>Vote on any pick:</b>\n` +
    `\u2705 Seen/Been \u00B7 \u2B50 Want to \u00B7 \u274C Not for me\n\n` +
    `Type /help to see all commands.\n\n` +
    `Let's go! Paste your first link \u{1F680}\n\n` +
    `<i>Your squad. Any plan. One bot. \u2014 SquadPicks</i>`;

  await bot.sendMessage(msg.chat.id, welcome, { parse_mode: 'HTML' });
});

// ─── HANDLE ALL MESSAGES ───────────────────────────────────

bot.on('message', async (msg) => {
  if (!msg.text) return;

  const chatId = msg.chat.id;
  const text = msg.text.trim();
  const from = msg.from;

  if (msg.chat.type !== 'private') {
    await db.ensureGroup(chatId, msg.chat.title || 'SquadPicks Group');
  }

  if (text.startsWith('/')) {
    return handleCommand(bot, msg, text, from);
  }

  const urls = extractUrls(text);
  if (urls.length === 0) return;

  for (const url of urls) {
    await handleLink(bot, chatId, url, from);
  }
});

// ─── LINK HANDLER ──────────────────────────────────────────

async function handleLink(bot, chatId, url, from) {
  let processingMsg;
  try {
    processingMsg = await bot.sendMessage(chatId, '<i>Reading link...</i>', { parse_mode: 'HTML' });
  } catch (e) {}

  const meta = await fetchMeta(url);
  const type = detectType(url, meta);

  const pick = await db.savePick({
    groupId: chatId, type,
    title: meta.title, description: meta.description,
    url, imageUrl: meta.imageUrl,
    addedById: from.id,
    addedByName: from.first_name || from.username || 'Someone',
    reviewerName: null, reviewerScore: null,
    reviewerQuote: null, reviewerVideoId: null
  });

  if (processingMsg) {
    try { await bot.deleteMessage(chatId, processingMsg.message_id); } catch (e) {}
  }

  if (!pick) {
    return bot.sendMessage(chatId,
      `<i>Couldn't read that link. Try /add Title to add it manually.</i>`,
      { parse_mode: 'HTML' });
  }

  const cardText = formatCard(pick, []);
  const sent = await bot.sendMessage(chatId, cardText, {
    parse_mode: 'HTML',
    reply_markup: buildVoteKeyboard(pick.id),
    disable_web_page_preview: false
  });

  await db.updatePickMessageId(pick.id, sent.message_id);
}

// ─── COMMAND HANDLER ───────────────────────────────────────

async function handleCommand(bot, msg, text, from) {
  const chatId = msg.chat.id;
  const command = text.split(' ')[0].split('@')[0].toLowerCase();

  switch (command) {

    case '/help':
    case '/start': {
      const help =
        `<b>SquadPicks \u2014 Command Guide</b>\n\n` +
        `<b>Just paste any link \u2014 I'll do the rest!</b>\n\n` +
        `/summary \u2014 group consensus: what everyone can do\n` +
        `/pending \u2014 picks you haven't voted on yet\n` +
        `/fcpicks \u2014 latest Filmi Craft reviews with ratings\n` +
        `/suggest \u2014 bot recommends the top group pick\n` +
        `/history \u2014 all picks from the last 30 days\n` +
        `/seen \u2014 everything the group has already done\n` +
        `/reviewers \u2014 active YouTube reviewer channels\n` +
        `/add Title \u2014 add a pick manually without a link\n` +
        `/digest \u2014 trigger the weekly summary now\n` +
        `/help \u2014 this message\n\n` +
        `<b>Voting:</b>\n` +
        `Tap \u2705 Seen/Been, \u2B50 Want to, or \u274C Not for me\n` +
        `Tap the same button again to undo your vote.\n\n` +
        `<b>Group ok:</b>\n` +
        `When everyone votes and nobody says \u274C,\n` +
        `I'll flag it as <b>Group ok</b> automatically.\n\n` +
        `<i>Your squad. Any plan. One bot. \u2014 SquadPicks</i>`;
      await bot.sendMessage(chatId, help, { parse_mode: 'HTML' });
      break;
    }

    case '/summary': {
      const picks = await db.getGroupPicks(chatId);
      const pickIds = picks.map(p => p.id);
      const votes = await db.getVotesForPicks(pickIds);
      const summaryText = formatSummary(picks, votes);
      await bot.sendMessage(chatId, summaryText, {
        parse_mode: 'HTML',
        reply_markup: buildSummaryKeyboard()
      });
      break;
    }

    case '/pending': {
      const pending = await db.getUserPendingPicks(chatId, from.id);
      if (!pending.length) {
        await bot.sendMessage(chatId,
          `\u2705 <b>${escHtml(from.first_name)}</b>, you're all caught up! No pending votes.`,
          { parse_mode: 'HTML' });
      } else {
        let t = `\u23F3 <b>${escHtml(from.first_name)}, you haven't voted on these yet:</b>\n\n`;
        pending.slice(0, 10).forEach((p, i) => { t += `${i + 1}. ${escHtml(p.title)}\n`; });
        t += `\n<i>Scroll up to find the cards and tap your vote!</i>`;
        await bot.sendMessage(chatId, t, { parse_mode: 'HTML' });
      }
      break;
    }

    case '/fcpicks': {
      const t = await formatLatestFCPicks();
      await bot.sendMessage(chatId, t, { parse_mode: 'HTML', disable_web_page_preview: true });
      break;
    }

    case '/suggest': {
      const picks = await db.getGroupPicks(chatId);
      const pickIds = picks.map(p => p.id);
      const votes = await db.getVotesForPicks(pickIds);
      const ranked = picks
        .map(pick => {
          const pv = votes.filter(v => v.pick_id === pick.id);
          const wants = pv.filter(v => v.status === 'want').length;
          const skips = pv.filter(v => v.status === 'skip').length;
          return { pick, wants, skips };
        })
        .filter(r => r.skips === 0 && r.wants > 0)
        .sort((a, b) => b.wants - a.wants);

      if (!ranked.length) {
        await bot.sendMessage(chatId,
          `<i>Not enough votes yet. Get your squad to vote!</i>`,
          { parse_mode: 'HTML' });
      } else {
        const top = ranked[0];
        let t = `\u{1F3C6} <b>SquadPicks suggests:</b>\n\n`;
        t += `<b>${escHtml(top.pick.title)}</b>\n`;
        t += `\u2B50 ${top.wants} member${top.wants > 1 ? 's' : ''} want this\n`;
        t += `\u2705 Nobody has said no\n`;
        if (top.pick.reviewer_score) t += `\u{1F4FA} Filmi Craft: ${top.pick.reviewer_score}\n`;
        if (top.pick.url) t += `\n<a href="${escHtml(top.pick.url)}">View details</a>`;
        await bot.sendMessage(chatId, t, { parse_mode: 'HTML' });
      }
      break;
    }

    case '/history': {
      const picks = await db.getGroupPicks(chatId, 30);
      if (!picks.length) {
        await bot.sendMessage(chatId,
          `<i>No picks in the last 30 days. Paste a link to get started!</i>`,
          { parse_mode: 'HTML' });
      } else {
        const emoji = { movie:'\u{1F3AC}', food:'\u{1F37D}', place:'\u{1F4CD}', event:'\u{1F3AD}', show:'\u{1F4FA}', link:'\u{1F517}', video:'\u{25B6}' };
        let t = `\u{1F4CB} <b>Last 30 days (${picks.length} picks)</b>\n\n`;
        picks.slice(0, 20).forEach((p, i) => {
          t += `${i + 1}. ${emoji[p.type] || '\u{1F517}'} ${escHtml(p.title)}\n`;
        });
        if (picks.length > 20) t += `\n<i>...and ${picks.length - 20} more</i>`;
        await bot.sendMessage(chatId, t, { parse_mode: 'HTML' });
      }
      break;
    }

    case '/seen': {
      const picks = await db.getGroupPicks(chatId, 90);
      const pickIds = picks.map(p => p.id);
      const votes = await db.getVotesForPicks(pickIds);
      const seen = picks.filter(p => votes.some(v => v.pick_id === p.id && v.status === 'seen'));
      if (!seen.length) {
        await bot.sendMessage(chatId, `<i>Nothing marked as seen yet!</i>`, { parse_mode: 'HTML' });
      } else {
        let t = `\u2705 <b>Already seen/been (${seen.length})</b>\n\n`;
        seen.slice(0, 15).forEach((p, i) => {
          const who = votes.filter(v => v.pick_id === p.id && v.status === 'seen')
            .map(v => v.first_name || 'Someone').join(', ');
          t += `${i + 1}. ${escHtml(p.title)} \u2014 ${escHtml(who)}\n`;
        });
        await bot.sendMessage(chatId, t, { parse_mode: 'HTML' });
      }
      break;
    }

    case '/reviewers': {
      const t =
        `\u{1F4FA} <b>Active reviewer channels</b>\n\n` +
        `1. <b>Filmi Craft</b> (@filmicraft)\n` +
        `   Tamil and World cinema \u00B7 352K subscribers\n` +
        `   Status: \u2705 Active \u00B7 checks every hour\n\n` +
        `<i>More channels available in Squad+ plan.</i>`;
      await bot.sendMessage(chatId, t, { parse_mode: 'HTML' });
      break;
    }

    case '/add': {
      const title = text.replace('/add', '').trim();
      if (!title) {
        await bot.sendMessage(chatId,
          `<i>Usage: /add Movie or Place Name\nExample: /add Kaantha 2025</i>`,
          { parse_mode: 'HTML' });
        break;
      }
      const pick = await db.savePick({
        groupId: chatId, type: 'link', title,
        description: 'Manually added', url: null, imageUrl: null,
        addedById: from.id, addedByName: from.first_name || 'Someone',
        reviewerName: null, reviewerScore: null,
        reviewerQuote: null, reviewerVideoId: null
      });
      if (pick) {
        const sent = await bot.sendMessage(chatId, formatCard(pick, []), {
          parse_mode: 'HTML',
          reply_markup: buildVoteKeyboard(pick.id)
        });
        await db.updatePickMessageId(pick.id, sent.message_id);
      }
      break;
    }

    case '/digest': {
      await sendWeeklyDigest(bot);
      break;
    }

    default:
      break;
  }
}

// ─── VOTE CALLBACK HANDLER ─────────────────────────────────

bot.on('callback_query', async (query) => {
  const data = query.data;
  const from = query.from;
  const chatId = query.message.chat.id;
  const msgId = query.message.message_id;

  // Summary keyboard buttons
  if (data.startsWith('cmd_')) {
    await bot.answerCallbackQuery(query.id);
    const cmd = data.replace('cmd_', '');
    const fakeMsg = { chat: { id: chatId, title: query.message.chat.title }, from };
    if (cmd === 'pending') return handleCommand(bot, fakeMsg, '/pending', from);
    if (cmd === 'fcpicks') {
      const t = await formatLatestFCPicks();
      return bot.sendMessage(chatId, t, { parse_mode: 'HTML', disable_web_page_preview: true });
    }
    if (cmd === 'suggest') return handleCommand(bot, fakeMsg, '/suggest', from);
    return;
  }

  if (!data.startsWith('vote_')) return;

  const parts = data.split('_');
  const pickId = parseInt(parts[1]);
  const status = parts[2];
  if (!pickId || !status) return;

  // Toggle vote
  const existing = await db.getVote(pickId, from.id);
  if (existing && existing.status === status) {
    await db.deleteVote(pickId, from.id);
    await bot.answerCallbackQuery(query.id, { text: 'Vote removed' });
  } else {
    await db.upsertVote({
      pickId, userId: from.id,
      username: from.username || '',
      firstName: from.first_name || from.username || 'Someone',
      status
    });
    const labels = { seen: 'Seen/Been', want: 'Want to', skip: 'Not for me' };
    await bot.answerCallbackQuery(query.id, { text: `Voted: ${labels[status]}` });
  }

  // Refresh pick card
  const pick = await db.getPick(pickId);
  const votes = await db.getVotesForPick(pickId);
  if (!pick) return;

  try {
    await bot.editMessageText(formatCard(pick, votes), {
      chat_id: chatId,
      message_id: msgId,
      parse_mode: 'HTML',
      reply_markup: buildVoteKeyboard(pickId)
    });
  } catch (err) {
    if (!err.message.includes('not modified')) {
      console.error('editMessageText error:', err.message);
    }
  }
});

// ─── ERROR HANDLING ────────────────────────────────────────

bot.on('polling_error', (err) => {
  console.error('Polling error:', err.message);
});

process.on('unhandledRejection', (reason) => {
  console.error('Unhandled rejection:', reason);
});

// ─── START BACKGROUND JOBS ─────────────────────────────────

startYouTubeMonitor(bot);
startDigestCron(bot);

console.log('SquadPicks is running! Add your bot to a Telegram group to get started.');
