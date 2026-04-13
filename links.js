// links.js — Link detection, metadata fetching, card formatting
const ogs = require('open-graph-scraper');

// ─── DETECT LINK TYPE FROM URL ─────────────────────────────

function detectType(url, meta = {}) {
  const u = url.toLowerCase();

  // Movies & Shows
  if (/imdb\.com\/(title|name)/.test(u))        return 'movie';
  if (/letterboxd\.com/.test(u))                 return 'movie';
  if (/rottentomatoes\.com/.test(u))             return 'movie';
  if (/justwatch\.com/.test(u))                  return 'show';
  if (/netflix\.com/.test(u))                    return 'show';
  if (/primevideo\.com/.test(u))                 return 'show';
  if (/hotstar\.com/.test(u))                    return 'show';
  if (/sonyliv\.com/.test(u))                    return 'show';

  // Food & Restaurants
  if (/yelp\.com/.test(u))                       return 'food';
  if (/zomato\.com/.test(u))                     return 'food';
  if (/swiggy\.com/.test(u))                     return 'food';
  if (/opentable\.com/.test(u))                  return 'food';
  if (/doordash\.com/.test(u))                   return 'food';
  if (/ubereats\.com/.test(u))                   return 'food';

  // Places & Attractions
  if (/maps\.google|goo\.gl\/maps|maps\.app\.goo\.gl/.test(u)) return 'place';
  if (/tripadvisor\.com/.test(u))                return 'place';
  if (/airbnb\.com\/experiences/.test(u))        return 'place';

  // Events
  if (/eventbrite\.com/.test(u))                 return 'event';
  if (/bookmyshow\.com/.test(u))                 return 'event';
  if (/meetup\.com/.test(u))                     return 'event';
  if (/ticketmaster\.com/.test(u))               return 'event';

  // YouTube (trailers / reviews)
  if (/youtube\.com|youtu\.be/.test(u))          return 'video';

  return 'link'; // fallback
}

// ─── FETCH METADATA FROM ANY URL ───────────────────────────

async function fetchMeta(url) {
  try {
    const { result } = await ogs({ url, timeout: 8000 });
    return {
      title: result.ogTitle || result.twitterTitle || result.dcTitle || url,
      description: result.ogDescription || result.twitterDescription || '',
      imageUrl: result.ogImage?.[0]?.url || '',
    };
  } catch (err) {
    console.error('fetchMeta error:', err.message);
    return { title: url, description: '', imageUrl: '' };
  }
}

// ─── EXTRACT URL FROM MESSAGE ───────────────────────────────

function extractUrls(text) {
  const regex = /https?:\/\/[^\s]+/gi;
  return text.match(regex) || [];
}

// ─── TYPE LABELS & ICONS ───────────────────────────────────

const TYPE_LABELS = {
  movie: '🎬 Movie',
  show:  '📺 Show',
  food:  '🍽 Restaurant',
  place: '📍 Place',
  event: '🎭 Event',
  video: '▶️ Video',
  link:  '🔗 Link',
};

function typeLabel(type) {
  return TYPE_LABELS[type] || '🔗 Link';
}

// ─── FORMAT PICK CARD (Telegram HTML) ──────────────────────

function formatCard(pick, votes) {
  const seen  = votes.filter(v => v.status === 'seen').map(v => v.first_name || v.username || 'Someone');
  const want  = votes.filter(v => v.status === 'want').map(v => v.first_name || v.username || 'Someone');
  const skip  = votes.filter(v => v.status === 'skip').map(v => v.first_name || v.username || 'Someone');
  const allVoted = seen.length + want.length + skip.length;
  const groupOk  = skip.length === 0 && allVoted > 0;

  let text = '';

  // Header
  text += `<b>${typeLabel(pick.type)}  |  ${escHtml(pick.title)}</b>\n`;
  if (pick.description) {
    text += `<i>${escHtml(truncate(pick.description, 100))}</i>\n`;
  }
  text += '\n';

  // Filmi Craft review strip
  if (pick.reviewer_name) {
    text += `📺 <b>${escHtml(pick.reviewer_name)}</b>`;
    if (pick.reviewer_score) text += `  ⭐ <b>${escHtml(pick.reviewer_score)}</b>`;
    if (pick.reviewer_quote) text += `\n<i>"${escHtml(pick.reviewer_quote)}"</i>`;
    text += '\n\n';
  }

  // Votes
  if (seen.length)  text += `✅ <b>Seen/Been:</b> ${escHtml(seen.join(', '))}\n`;
  if (want.length)  text += `⭐ <b>Want to:</b>   ${escHtml(want.join(', '))}\n`;
  if (skip.length)  text += `❌ <b>Not for me:</b> ${escHtml(skip.join(', '))}\n`;
  if (!seen.length && !want.length && !skip.length) {
    text += `<i>No votes yet — be the first!</i>\n`;
  }

  // Group ok badge
  if (groupOk) {
    text += `\n✅ <b>Group ok — everyone can do this together!</b>`;
  }

  // Added by
  text += `\n\n<i>Added by ${escHtml(pick.added_by_name || 'someone')} · via SquadPicks</i>`;

  return text;
}

// ─── FORMAT SUMMARY ────────────────────────────────────────

function formatSummary(picks, allVotes) {
  const groupOk  = [];
  const hasSkip  = [];
  const pending  = [];

  for (const pick of picks) {
    const pv = allVotes.filter(v => v.pick_id === pick.id);
    const skips = pv.filter(v => v.status === 'skip');
    const total  = pv.length;
    if (skips.length > 0) hasSkip.push({ pick, votes: pv });
    else if (total > 0)   groupOk.push({ pick, votes: pv });
    else                  pending.push({ pick });
  }

  let text = `📊 <b>SquadPicks Summary</b>\n\n`;

  if (groupOk.length) {
    text += `✅ <b>Group can do together (${groupOk.length})</b>\n`;
    groupOk.forEach(({ pick, votes }) => {
      const want = votes.filter(v => v.status === 'want').length;
      const seen = votes.filter(v => v.status === 'seen').length;
      text += `  • ${escHtml(pick.title)}`;
      if (pick.reviewer_score) text += ` · ⭐${pick.reviewer_score}`;
      if (want) text += ` · ${want} want`;
      if (seen) text += ` · ${seen} seen`;
      text += '\n';
    });
    text += '\n';
  }

  if (hasSkip.length) {
    text += `⚠️ <b>Someone said not for me (${hasSkip.length})</b>\n`;
    hasSkip.forEach(({ pick, votes }) => {
      const skipper = votes.filter(v => v.status === 'skip').map(v => v.first_name || 'Someone').join(', ');
      text += `  • ${escHtml(pick.title)} — ${escHtml(skipper)} skipped\n`;
    });
    text += '\n';
  }

  if (pending.length) {
    text += `⏳ <b>No votes yet (${pending.length})</b>\n`;
    pending.forEach(({ pick }) => {
      text += `  • ${escHtml(pick.title)}\n`;
    });
    text += '\n';
  }

  if (!picks.length) {
    text += `<i>No picks yet! Paste any link in this chat to get started.</i>`;
  }

  text += `\n<i>Type /pending to see what YOU still need to vote on.</i>`;
  return text;
}

// ─── FORMAT WEEKLY DIGEST ──────────────────────────────────

function formatDigest(newPicks, fcPicks, pendingCount) {
  let text = `📅 <b>SquadPicks — Weekly Digest</b>\n`;
  text += `<i>Here's what happened in your group this week</i>\n\n`;

  if (newPicks.length) {
    text += `🆕 <b>New picks this week (${newPicks.length})</b>\n`;
    newPicks.slice(0, 8).forEach(p => {
      text += `  ${typeLabel(p.type).split(' ')[0]} ${escHtml(p.title)} · by ${escHtml(p.added_by_name || 'someone')}\n`;
    });
    text += '\n';
  }

  if (fcPicks.length) {
    text += `📺 <b>Filmi Craft reviewed this week</b>\n`;
    fcPicks.forEach(p => {
      text += `  🎬 ${escHtml(p.title)}`;
      if (p.reviewer_score) text += ` · ⭐ ${p.reviewer_score}`;
      text += '\n';
    });
    text += '\n';
  }

  if (pendingCount > 0) {
    text += `⏳ <b>You still need to vote on ${pendingCount} pick${pendingCount > 1 ? 's' : ''}</b>\n`;
    text += `Type /pending to see them.\n\n`;
  }

  text += `<i>Have a great week from SquadPicks! 🎬🍜📍</i>`;
  return text;
}

// ─── FORMAT FILMI CRAFT CARD ───────────────────────────────

function formatFilmiCraftCard(pick, votes) {
  return formatCard(pick, votes);
}

// ─── KEYBOARD BUILDERS ─────────────────────────────────────

function buildVoteKeyboard(pickId) {
  return {
    inline_keyboard: [[
      { text: '✅ Seen/Been',   callback_data: `vote_${pickId}_seen` },
      { text: '⭐ Want to',     callback_data: `vote_${pickId}_want` },
      { text: '❌ Not for me',  callback_data: `vote_${pickId}_skip` },
    ]]
  };
}

function buildSummaryKeyboard() {
  return {
    inline_keyboard: [[
      { text: '📋 Pending',   callback_data: 'cmd_pending' },
      { text: '📺 FC Picks',  callback_data: 'cmd_fcpicks' },
      { text: '💡 Suggest',   callback_data: 'cmd_suggest' },
    ]]
  };
}

// ─── HELPERS ───────────────────────────────────────────────

function escHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function truncate(str, len) {
  if (!str) return '';
  return str.length > len ? str.slice(0, len) + '...' : str;
}

module.exports = {
  detectType, fetchMeta, extractUrls,
  typeLabel, formatCard, formatSummary,
  formatDigest, formatFilmiCraftCard,
  buildVoteKeyboard, buildSummaryKeyboard,
  escHtml, truncate
};
