const TelegramBot = require('node-telegram-bot-api');
const { extractMetadata } = require('./metadata');
const { db } = require('./db');

const TOKEN = process.env.BOT_TOKEN;
if (!TOKEN) { console.error('BOT_TOKEN env variable is required'); process.exit(1); }

const bot = new TelegramBot(TOKEN, { polling: true });

const STATUS_EMOJI = { seen: '✅', want: '⭐', skip: '❌' };
const STATUS_LABEL = { seen: 'Seen/Been', want: 'Want to', skip: 'Not interested' };
const TYPE_EMOJI   = { movie: '🎬', place: '📍', food: '🍽️', show: '📺', link: '🔗' };

// ── URL detection ─────────────────────────────────────────────
const URL_RE = /https?:\/\/[^\s]+/g;

function detectType(url, meta) {
  if (/imdb\.com|themoviedb\.org|letterboxd\.com/i.test(url))       return 'movie';
  if (/netflix\.com|primevideo|hulu\.com|disneyplus/i.test(url))    return 'show';
  if (/maps\.google|goo\.gl\/maps|maps\.app\.goo/i.test(url))       return 'place';
  if (/zomato|yelp\.com|tripadvisor|opentable/i.test(url))          return 'food';
  if (/youtube\.com|youtu\.be/i.test(url))                          return 'link';
  return 'link';
}

// ── Format a pick card ────────────────────────────────────────
function formatCard(pick) {
  const typeEmoji = TYPE_EMOJI[pick.type] || '🔗';
  const votes = pick.votes || {};
  const lines = [`${typeEmoji} *${escMd(pick.title)}*`];
  if (pick.description) lines.push(`_${escMd(pick.description.slice(0, 120))}${pick.description.length > 120 ? '…' : ''}_`);
  lines.push(`🔗 [Open link](${pick.url})`);
  lines.push('');
  lines.push(`*Added by* ${escMd(pick.addedBy)}`);
  lines.push('');

  // Tally
  const seen = [], want = [], skip = [];
  for (const [name, status] of Object.entries(votes)) {
    if (status === 'seen') seen.push(name);
    else if (status === 'want') want.push(name);
    else if (status === 'skip') skip.push(name);
  }
  if (seen.length)  lines.push(`✅ *Seen/Been:* ${seen.join(', ')}`);
  if (want.length)  lines.push(`⭐ *Want to:* ${want.join(', ')}`);
  if (skip.length)  lines.push(`❌ *Not interested:* ${skip.join(', ')}`);
  if (!seen.length && !want.length && !skip.length) lines.push('_No votes yet — be the first!_');

  // Group verdict
  if (Object.keys(votes).length > 0 && skip.length === 0 && (seen.length + want.length) > 0) {
    lines.push('');
    lines.push('🟢 *Group can watch/go!*');
  }

  return lines.join('\n');
}

function escMd(str = '') {
  return str.replace(/[_*[\]()~`>#+\-=|{}.!\\]/g, c => '\\' + c);
}

// ── Inline keyboard for a pick ────────────────────────────────
function keyboard(pickId) {
  return {
    inline_keyboard: [[
      { text: '✅ Seen/Been',       callback_data: `vote:${pickId}:seen` },
      { text: '⭐ Want to',          callback_data: `vote:${pickId}:want` },
      { text: '❌ Not interested',   callback_data: `vote:${pickId}:skip` },
    ],[
      { text: '📋 Show all picks',   callback_data: `list:${pickId}` },
    ]]
  };
}

// ── Handle any message with a URL ─────────────────────────────
bot.on('message', async (msg) => {
  const text = msg.text || msg.caption || '';
  const urls = text.match(URL_RE);
  if (!urls || urls.length === 0) {
    // Handle commands
    if (text.startsWith('/')) handleCommand(msg, text);
    return;
  }

  const url = urls[0];
  const chatId = msg.chat.id;
  const userName = msg.from.first_name || msg.from.username || 'Someone';

  // Send "working on it" immediately
  const loadMsg = await bot.sendMessage(chatId, '⏳ Fetching details…');

  try {
    const meta = await extractMetadata(url);
    const type = detectType(url, meta);
    const pick = db.addPick(chatId, {
      url,
      title: meta.title || url,
      description: meta.description || '',
      image: meta.image || '',
      type,
      addedBy: userName,
      votes: {},
    });

    await bot.deleteMessage(chatId, loadMsg.message_id);
    await bot.sendMessage(chatId, formatCard(pick), {
      parse_mode: 'MarkdownV2',
      reply_markup: keyboard(pick.id),
      disable_web_page_preview: false,
    });
  } catch (err) {
    console.error(err);
    await bot.editMessageText('❌ Couldn\'t fetch that link. Try again!', {
      chat_id: chatId, message_id: loadMsg.message_id
    });
  }
});

// ── Handle vote button presses ────────────────────────────────
bot.on('callback_query', async (query) => {
  const data = query.data;
  const chatId = query.message.chat.id;
  const msgId  = query.message.message_id;
  const userName = query.from.first_name || query.from.username || 'Someone';

  if (data.startsWith('vote:')) {
    const [, pickId, status] = data.split(':');
    const pick = db.vote(chatId, pickId, userName, status);
    if (!pick) { await bot.answerCallbackQuery(query.id, { text: 'Pick not found!' }); return; }

    await bot.editMessageText(formatCard(pick), {
      chat_id: chatId,
      message_id: msgId,
      parse_mode: 'MarkdownV2',
      reply_markup: keyboard(pickId),
      disable_web_page_preview: true,
    });
    const label = STATUS_LABEL[status] || status;
    await bot.answerCallbackQuery(query.id, { text: `Marked as: ${label}` });
  }

  if (data.startsWith('list:')) {
    const picks = db.getPicks(chatId);
    if (!picks.length) {
      await bot.answerCallbackQuery(query.id, { text: 'No picks yet in this group!' });
      return;
    }
    const lines = [`📋 *Squad Picks* \\(${picks.length} total\\)\n`];
    for (const p of picks.slice(-20)) {
      const typeEmoji = TYPE_EMOJI[p.type] || '🔗';
      const seenCount = Object.values(p.votes).filter(v => v === 'seen').length;
      const wantCount = Object.values(p.votes).filter(v => v === 'want').length;
      const skipCount = Object.values(p.votes).filter(v => v === 'skip').length;
      lines.push(`${typeEmoji} [${escMd(p.title)}](${p.url})`);
      lines.push(`  ✅${seenCount} ⭐${wantCount} ❌${skipCount}`);
    }
    await bot.answerCallbackQuery(query.id);
    await bot.sendMessage(chatId, lines.join('\n'), {
      parse_mode: 'MarkdownV2',
      disable_web_page_preview: true,
    });
  }
});

// ── Slash commands ────────────────────────────────────────────
async function handleCommand(msg, text) {
  const chatId = msg.chat.id;
  const cmd = text.split(' ')[0].toLowerCase();

  if (cmd === '/start' || cmd === '/help') {
    await bot.sendMessage(chatId,
      `👋 *Welcome to SquadPicks\\!*\n\nJust paste any link in this group and I'll track it for everyone\\.\n\n` +
      `*Commands:*\n` +
      `/picks — Show all picks\n` +
      `/canwatch — Picks nobody vetoed\n` +
      `/mystats — Your personal stats\n` +
      `/clear — Clear all picks \\(admin only\\)`,
      { parse_mode: 'MarkdownV2' }
    );
  }

  if (cmd === '/picks') {
    const picks = db.getPicks(chatId);
    if (!picks.length) { await bot.sendMessage(chatId, '📭 No picks yet\\! Paste any link to add one\\.', { parse_mode: 'MarkdownV2' }); return; }
    for (const pick of picks.slice(-10)) {
      await bot.sendMessage(chatId, formatCard(pick), {
        parse_mode: 'MarkdownV2',
        reply_markup: keyboard(pick.id),
        disable_web_page_preview: true,
      });
    }
  }

  if (cmd === '/canwatch') {
    const picks = db.getPicks(chatId).filter(p => {
      const votes = Object.values(p.votes);
      return votes.length > 0 && !votes.includes('skip');
    });
    if (!picks.length) { await bot.sendMessage(chatId, '🤷 No picks where everyone agrees yet\\!', { parse_mode: 'MarkdownV2' }); return; }
    await bot.sendMessage(chatId, `🟢 *${picks.length} picks your group can all watch/go to:*`, { parse_mode: 'MarkdownV2' });
    for (const pick of picks) {
      await bot.sendMessage(chatId, formatCard(pick), {
        parse_mode: 'MarkdownV2',
        reply_markup: keyboard(pick.id),
        disable_web_page_preview: true,
      });
    }
  }

  if (cmd === '/mystats') {
    const name = msg.from.first_name || msg.from.username;
    const picks = db.getPicks(chatId);
    const seen = picks.filter(p => p.votes[name] === 'seen').length;
    const want = picks.filter(p => p.votes[name] === 'want').length;
    const skip = picks.filter(p => p.votes[name] === 'skip').length;
    const total = picks.length;
    await bot.sendMessage(chatId,
      `📊 *${escMd(name)}'s Stats*\n\n✅ Seen/Been: ${seen}\n⭐ Want to: ${want}\n❌ Skipped: ${skip}\n📋 Total picks: ${total}`,
      { parse_mode: 'MarkdownV2' }
    );
  }
}

console.log('🤖 SquadPicks bot is running…');
