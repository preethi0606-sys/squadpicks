// server.js — SquadPicks Mini App API + Static Server
// KEY: starts listening IMMEDIATELY on 0.0.0.0
// DB is loaded lazily so nothing blocks the server from starting
require('dotenv').config();

const express = require('express');
const cors    = require('cors');
const path    = require('path');
const crypto  = require('crypto');

const app  = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// ─── STATIC FILES ──────────────────────────────────────────
app.use(express.static(path.join(__dirname, 'public')));
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ─── HEALTH CHECK ──────────────────────────────────────────
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', service: 'SquadPicks', port: PORT, ts: new Date().toISOString() });
});

// ─── LAZY DB/LINKS ─────────────────────────────────────────
let _db = null, _links = null;
const getDb    = () => { if (!_db)    _db    = require('./db');    return _db;    };
const getLinks = () => { if (!_links) _links = require('./links'); return _links; };

// ─── AUTH ──────────────────────────────────────────────────
function telegramAuth(req, res, next) {
  const initData = req.headers['x-telegram-init-data'] || '';
  if (!initData || initData === 'test') {
    req.tgUser = {
      id:         Number(req.headers['x-user-id'])  || 123456789,
      first_name: req.headers['x-user-name']         || 'User',
      username:   req.headers['x-username']           || 'user',
      chatId:     req.headers['x-chat-id']            || null
    };
    return next();
  }
  try {
    const params = new URLSearchParams(initData);
    const hash   = params.get('hash');
    params.delete('hash');
    const dataStr  = Array.from(params.entries()).sort(([a],[b])=>a.localeCompare(b)).map(([k,v])=>`${k}=${v}`).join('\n');
    const secret   = crypto.createHmac('sha256','WebAppData').update(process.env.TELEGRAM_TOKEN||'').digest();
    const expected = crypto.createHmac('sha256',secret).update(dataStr).digest('hex');
    if (expected !== hash) return res.status(401).json({ error: 'Invalid auth' });
    req.tgUser = { ...JSON.parse(params.get('user')||'{}'), chatId: params.get('start_param')||null };
    next();
  } catch (e) {
    return res.status(401).json({ error: 'Auth error' });
  }
}

// ─── API: GET PICKS ────────────────────────────────────────
app.get('/api/picks', telegramAuth, async (req, res) => {
  try {
    const db      = getDb();
    const groupId = req.query.groupId || req.tgUser.chatId;
    if (!groupId) return res.status(400).json({ error: 'groupId required' });
    const picks   = await db.getGroupPicks(groupId, 30);
    const votes   = await db.getVotesForPicks(picks.map(p => p.id));
    const enriched = picks.map(p => {
      const pv = votes.filter(v => v.pick_id === p.id);
      return { ...p, votes: pv, my_vote: pv.find(v=>v.user_id===req.tgUser.id)?.status||null, group_ok: pv.length>0 && pv.every(v=>v.status!=='skip') };
    });
    res.json({ picks: enriched });
  } catch (e) { console.error('[GET /picks]',e.message); res.status(500).json({ error: e.message }); }
});

// ─── API: ADD PICK ─────────────────────────────────────────
app.post('/api/picks', telegramAuth, async (req, res) => {
  try {
    const db = getDb(), links = getLinks();
    const { url, groupId, groupTitle } = req.body;
    const chatId = groupId || req.tgUser.chatId;
    if (!url || !chatId) return res.status(400).json({ error: 'url and groupId required' });
    await db.ensureGroup(chatId, groupTitle || 'SquadPicks Group');
    const meta = await links.fetchMeta(url);
    const type = links.detectType(url, meta);
    const pick = await db.savePick({ groupId:chatId, type, title:meta.title, description:meta.description, url, imageUrl:meta.imageUrl, addedById:req.tgUser.id, addedByName:req.tgUser.first_name||'Someone', reviewerName:null, reviewerScore:null, reviewerQuote:null, reviewerVideoId:null });
    if (!pick) return res.status(500).json({ error: 'Failed to save' });
    if (global.squadPicksBot) {
      try {
        const sent = await global.squadPicksBot.sendMessage(chatId, links.formatCard(pick,[]), { parse_mode:'HTML', reply_markup: links.buildVoteKeyboard(pick.id) });
        await db.updatePickMessageId(pick.id, sent.message_id);
      } catch(e) { console.error('[Bot notify]',e.message); }
    }
    res.json({ pick, meta });
  } catch(e) { console.error('[POST /picks]',e.message); res.status(500).json({ error: e.message }); }
});

// ─── API: VOTE ─────────────────────────────────────────────
app.post('/api/vote', telegramAuth, async (req, res) => {
  try {
    const db = getDb(), links = getLinks();
    const { pickId, status } = req.body;
    if (!pickId||!status) return res.status(400).json({ error: 'pickId and status required' });
    if (!['seen','want','skip'].includes(status)) return res.status(400).json({ error: 'Invalid status' });
    const existing = await db.getVote(pickId, req.tgUser.id);
    if (existing?.status === status) await db.deleteVote(pickId, req.tgUser.id);
    else await db.upsertVote({ pickId, userId:req.tgUser.id, username:req.tgUser.username||'', firstName:req.tgUser.first_name||'Someone', status });
    const votes   = await db.getVotesForPick(pickId);
    const pick    = await db.getPick(pickId);
    const groupOk = votes.length>0 && votes.every(v=>v.status!=='skip');
    if (global.squadPicksBot && pick?.message_id && pick?.group_id) {
      try { await global.squadPicksBot.editMessageText(links.formatCard(pick,votes),{ chat_id:pick.group_id, message_id:pick.message_id, parse_mode:'HTML', reply_markup:links.buildVoteKeyboard(pickId) }); }
      catch(e) { if (!e.message?.includes('not modified')) console.error('[Card update]',e.message); }
    }
    res.json({ votes, my_vote: votes.find(v=>v.user_id===req.tgUser.id)?.status||null, group_ok: groupOk });
  } catch(e) { console.error('[POST /vote]',e.message); res.status(500).json({ error: e.message }); }
});

// ─── API: SUMMARY ──────────────────────────────────────────
app.get('/api/summary', telegramAuth, async (req, res) => {
  try {
    const db      = getDb();
    const groupId = req.query.groupId || req.tgUser.chatId;
    if (!groupId) return res.status(400).json({ error: 'groupId required' });
    const picks = await db.getGroupPicks(groupId, 30);
    const votes = await db.getVotesForPicks(picks.map(p=>p.id));
    const groupOk=[], hasSkip=[], pending=[];
    for (const pick of picks) {
      const pv = votes.filter(v=>v.pick_id===pick.id);
      if (pv.some(v=>v.status==='skip')) hasSkip.push({pick,votes:pv});
      else if (pv.length>0) groupOk.push({pick,votes:pv});
      else pending.push({pick,votes:[]});
    }
    res.json({ groupOk, hasSkip, pending });
  } catch(e) { console.error('[GET /summary]',e.message); res.status(500).json({ error: e.message }); }
});

// ─── API: FILMI CRAFT PICKS ────────────────────────────────
app.get('/api/fcpicks', telegramAuth, async (req, res) => {
  try {
    const picks = await getDb().getRecentFilmiCraftPicks(10);
    res.json({ picks });
  } catch(e) { console.error('[GET /fcpicks]',e.message); res.status(500).json({ error: e.message }); }
});

// ─── PAGE ROUTES ────────────────────────────────────────────
// Mini App (Telegram Web App)
app.get('/app', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'app.html'));
});
// Login page
app.get('/login', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'login.html'));
});
// Dashboard
app.get('/dashboard', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'dashboard', 'index.html'));
});
// Blog
app.get('/blog', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'blog', 'index.html'));
});
// CATCH-ALL: serve landing page for anything else
app.get('/{*splat}', (req, res) => {
  if (req.path.startsWith('/api/')) return res.status(404).json({ error: 'Not found' });
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ─── START ─────────────────────────────────────────────────
function startServer() {
  const server = app.listen(PORT, '0.0.0.0', () => {
    console.log(`[Server] OK — listening on 0.0.0.0:${PORT}`);
  });
  server.on('error', err => {
    console.error('[Server] FAILED to start:', err.message);
    process.exit(1);
  });
}


// ─── API: TRENDING DATA (from scraped tables) ──────────────
app.get('/api/trending/streaming', async (req, res) => {
  try {
    const region  = req.query.region  || 'canada';
    const combined = await getDb().getMixedStreamingTop10(region);
    // If DB has data, use it; else fall back to streaming.js static data
    if (combined.length > 0) {
      return res.json({ ok: true, data: { all: combined }, source: 'db', ts: new Date().toISOString() });
    }
    // Fallback to the static list in streaming.js
    const { getStreamingTop10 } = require('./streaming');
    const data = await getStreamingTop10(region);
    res.json({ ok: true, data, source: 'fallback', ts: new Date().toISOString() });
  } catch (e) {
    console.error('[GET /trending/streaming]', e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.get('/api/trending/imdb', async (req, res) => {
  try {
    const category = req.query.category || 'top_movies';
    const data = await getDb().getLatestImdbTop10(category);
    res.json({ ok: true, data, ts: new Date().toISOString() });
  } catch (e) {
    console.error('[GET /trending/imdb]', e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// Manual trigger for admins (protect with a secret)
app.post('/api/admin/scrape', async (req, res) => {
  const secret = req.headers['x-admin-secret'];
  if (!secret || secret !== process.env.ADMIN_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  try {
    const { runAllScrapers } = require('./scraper');
    res.json({ ok: true, message: 'Scrape started in background' });
    runAllScrapers().catch(e => console.error('[Admin scrape]', e.message));
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

module.exports = { startServer };

// ─── FIX 3+4: NOTIFY ENDPOINT — posts card to Telegram with mini app link ──
app.post('/api/picks/notify', telegramAuth, async (req, res) => {
  try {
    const db = getDb(), links = getLinks();
    const { pickId, groupId, miniAppUrl } = req.body;
    if (!pickId) return res.status(400).json({ error: 'pickId required' });
    const pick  = await db.getPick(pickId);
    const votes = await db.getVotesForPick(pickId);
    if (!pick) return res.status(404).json({ error: 'Pick not found' });
    const chatId = groupId || pick.group_id;
    if (global.squadPicksBot && chatId) {
      try {
        const appUrl = miniAppUrl || (process.env.MINI_APP_URL ? `https://t.me/${process.env.BOT_USERNAME||'squadpicks_bot'}/${process.env.MINI_APP_SHORT_NAME||'Squadpicks'}?startapp=${chatId}` : null);
        const keyboard = {
          inline_keyboard: [
            [
              { text:'✅ Seen/Been',  callback_data:`vote_${pickId}_seen` },
              { text:'⭐ Want to',    callback_data:`vote_${pickId}_want` },
              { text:'❌ Not for me', callback_data:`vote_${pickId}_skip` },
            ],
            ...(appUrl ? [[{ text:'🚀 Open SquadPicks', url: appUrl }]] : [])
          ]
        };
        const sent = await global.squadPicksBot.sendMessage(chatId, links.formatCard(pick, votes), {
          parse_mode: 'HTML', reply_markup: keyboard, disable_web_page_preview: false
        });
        await db.updatePickMessageId(pickId, sent.message_id);
      } catch(e) { console.error('[Notify] Bot error:', e.message); }
    }
    res.json({ ok: true });
  } catch(e) { console.error('[Notify]', e.message); res.status(500).json({ error: e.message }); }
});

// ─── API: TRENDING — Top 10 streaming across Netflix + Prime + Hotstar ─────
app.get('/api/trending/streaming', async (req, res) => {
  try {
    const { getStreamingTop10 } = require('./streaming');
    const country = req.query.country || 'ca';
    const data = await getStreamingTop10(country);
    res.json({ ok: true, data, source: process.env.RAPIDAPI_KEY ? 'live' : 'fallback', ts: new Date().toISOString() });
  } catch (e) {
    console.error('[GET /trending/streaming]', e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});
