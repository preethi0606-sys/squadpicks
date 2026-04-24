// server.js — SquadPicks Mini App API + Static Server
// KEY: starts listening IMMEDIATELY on 0.0.0.0
// DB is loaded lazily so nothing blocks the server from starting
require('dotenv').config();

const express   = require('express');
const cors      = require('cors');
const path      = require('path');
const crypto    = require('crypto');
const fs        = require('fs');
const session   = require('express-session');

const app  = express();
const PORT = process.env.PORT || 3000;

// Trust Railway's reverse proxy so secure cookies work over HTTPS
app.set('trust proxy', 1);

app.use(cors());
app.use(express.json());
app.use(session({
  secret:            process.env.SESSION_SECRET || 'squadpicks-dev-secret',
  resave:            false,
  saveUninitialized: false,
  cookie: {
    secure:   process.env.NODE_ENV === 'production', // HTTPS only in prod
    httpOnly: true,
    sameSite: process.env.NODE_ENV === 'production' ? 'none' : 'lax', // 'none' needed for cross-site on Railway
    maxAge:   7 * 24 * 60 * 60 * 1000 // 7 days
  }
}));

// ─── GOOGLE OAUTH ──────────────────────────────────────────
const GOOGLE_CLIENT_ID     = process.env.GOOGLE_CLIENT_ID     || '';
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET || '';
const APP_URL              = process.env.APP_URL || (process.env.RAILWAY_PUBLIC_DOMAIN ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}` : 'http://localhost:3000');

// Step 1: Redirect user to Google
app.get('/auth/google', (req, res) => {
  const params = new URLSearchParams({
    client_id:     GOOGLE_CLIENT_ID,
    redirect_uri:  `${APP_URL}/auth/google/callback`,
    response_type: 'code',
    scope:         'openid profile email',
    access_type:   'offline',
    prompt:        'select_account'
  });
  res.redirect(`https://accounts.google.com/o/oauth2/v2/auth?${params}`);
});

// Step 2: Handle Google callback
app.get('/auth/google/callback', async (req, res) => {
  const { code, error } = req.query;
  if (error || !code) return res.redirect('/login?error=google_denied');
  try {
    // Exchange code for tokens
    const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
      method:  'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body:    new URLSearchParams({
        code, client_id: GOOGLE_CLIENT_ID, client_secret: GOOGLE_CLIENT_SECRET,
        redirect_uri: `${APP_URL}/auth/google/callback`, grant_type: 'authorization_code'
      })
    });
    const tokens    = await tokenRes.json();
    if (!tokens.access_token) throw new Error('No access token from Google');

    // Get user profile
    const profileRes  = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
      headers: { Authorization: `Bearer ${tokens.access_token}` }
    });
    const profile = await profileRes.json();
    if (!profile.id)  throw new Error('Could not fetch Google profile');

    // Upsert user in DB
    const db   = getDb();
    const user = await db.upsertGoogleUser({
      google_id: profile.id,
      email:     profile.email,
      name:      profile.name,
      avatar:    profile.picture
    });
    if (!user) throw new Error('Failed to save user');

    // Auto-join any squads this email was invited to
    await db.applyPendingInvites(user.id, profile.email);

    // Set session
    req.session.userId     = user.id;
    req.session.userName   = user.name;
    req.session.userEmail  = user.email;
    req.session.userAvatar = user.avatar;
    req.session.loginType  = 'google';

    res.redirect('/dashboard');
  } catch (e) {
    console.error('[Google OAuth]', e.message);
    res.redirect('/login?error=google_failed');
  }
});

// ─── SESSION AUTH MIDDLEWARE ───────────────────────────────
function requireWebAuth(req, res, next) {
  if (req.session && req.session.userId) return next();
  res.redirect('/login');
}

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
    const { url, groupId, groupTitle, manualType, manualTitle } = req.body;
    const chatId = groupId || req.tgUser.chatId;
    if (!url || !chatId) return res.status(400).json({ error: 'url and groupId required' });
    await db.ensureGroup(chatId, groupTitle || 'SquadPicks Group');
    const meta = await links.fetchMeta(url);
    // manualType overrides auto-detection (from Full App category picker)
    // manualTitle overrides fetched title (from Full App manual entry)
    const type  = manualType  || links.detectType(url, meta);
    const title = manualTitle || meta.title;
    const pick = await db.savePick({
      groupId: chatId, type,
      title:        title,
      description:  meta.description,
      url:          url,
      sourceUrl:    meta.sourceUrl || url,
      imageUrl:     meta.imageUrl,
      addedById:    req.tgUser.id,
      addedByName:  req.tgUser.first_name || 'Someone',
      reviewerName: null, reviewerScore: null, reviewerQuote: null, reviewerVideoId: null
    });
    if (!pick) return res.status(500).json({ error: 'Failed to save' });
    if (global.squadPicksBot) {
      try {
        const sent = await global.squadPicksBot.sendMessage(chatId, links.formatCard(pick,[]), { parse_mode:'HTML', reply_markup: links.buildVoteKeyboard(pick.id, pick.group_id || chatId) });
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
      try { await global.squadPicksBot.editMessageText(links.formatCard(pick,votes),{ chat_id:pick.group_id, message_id:pick.message_id, parse_mode:'HTML', reply_markup:links.buildVoteKeyboard(pickId, pick?.group_id) }); }
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

// ─── API: TRENDING — STREAMING (split Netflix + Prime) ─────
app.get('/api/trending/streaming', async (req, res) => {
  try {
    const region      = req.query.region || 'canada';
    const primeRegion = (region === 'canada') ? 'ca' : (region === 'india') ? 'in' : 'ca';
    const db = getDb();

    // Try DB first — try multiple region variants to handle data inserted under different keys
    const netflixRegions = region === 'canada' ? ['canada', 'ca', 'us'] : [region];
    const primeRegions   = primeRegion === 'ca'  ? ['ca', 'canada']     : [primeRegion];

    let netflix = [], prime = [];
    for (const r of netflixRegions) {
      netflix = await db.getLatestNetflixTop10(r);
      if (netflix.length) break;
    }
    for (const r of primeRegions) {
      prime = await db.getLatestPrimeTop10(r);
      if (prime.length) break;
    }

    const hasDbData = (netflix.length + prime.length) > 0;
    if (hasDbData) {
      const nfTagged = netflix.map(r => ({ ...r, source:'netflix', badge:'N', badgeColor:'#E50914',
        url: r.netflix_url || `https://www.netflix.com/search?q=${encodeURIComponent(r.title)}` }));
      const pvTagged = prime.map(r => ({ ...r, source:'prime', badge:'P', badgeColor:'#00A8E0',
        url: r.prime_url   || `https://www.primevideo.com/search/ref=atv_nb_sr?phrase=${encodeURIComponent(r.title)}` }));
      return res.json({ ok:true, netflix: nfTagged, prime: pvTagged, source:'db', ts: new Date().toISOString() });
    }

    // No DB data yet — use fallback static data
    const { getStreamingTop10 } = require('./streaming');
    const data = await getStreamingTop10(region);
    const nf = (data.netflix || []).map(r => ({ ...r, source:'netflix', badge:'N', badgeColor:'#E50914' }));
    const pv = (data.prime   || data.all || []).map(r => ({ ...r, source:'prime', badge:'P', badgeColor:'#00A8E0' }));
    res.json({ ok:true, netflix: nf, prime: pv, source:'fallback', ts: new Date().toISOString() });
  } catch (e) {
    console.error('[GET /trending/streaming]', e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// TMDB trending (replaces IMDb scraping)
app.get('/api/trending/tmdb', async (req, res) => {
  try {
    const category = req.query.category || 'top_movies';
    const data = await getDb().getLatestImdbTop10(category);  // reuses trending_imdb table
    res.json({ ok: true, data, source: data.length ? 'db' : 'empty', ts: new Date().toISOString() });
  } catch (e) {
    console.error('[GET /trending/tmdb]', e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// Legacy alias — keep for any old clients
app.get('/api/trending/imdb', async (req, res) => {
  const category = req.query.category || 'top_movies';
  try {
    const data = await getDb().getLatestImdbTop10(category);
    res.json({ ok: true, data, ts: new Date().toISOString() });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// Places top 10 — location-aware
app.get('/api/trending/places', async (req, res) => {
  try {
    const region = req.query.region || 'canada';
    const data   = await getDb().getLatestPlaces(region);
    res.json({ ok: true, data, source: data.length ? 'db' : 'empty', region, ts: new Date().toISOString() });
  } catch (e) {
    console.error('[GET /trending/places]', e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// Events top 10 — location-aware
app.get('/api/trending/events', async (req, res) => {
  try {
    const region = req.query.region || 'canada';
    const data   = await getDb().getLatestEvents(region);
    res.json({ ok: true, data, source: data.length ? 'db' : 'empty', region, ts: new Date().toISOString() });
  } catch (e) {
    console.error('[GET /trending/events]', e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ─── API: WEB GROUPS ───────────────────────────────────────

// GET /api/groups — returns all real groups (public, used by app.html)
app.get('/api/groups', async (req, res) => {
  try {
    const groups = await getDb().getAllGroups();
    res.json({ ok: true, groups });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// GET /api/groups/mine — user's own groups
app.get('/api/groups/mine', requireWebAuth, async (req, res) => {
  try {
    const groups = await getDb().getUserGroups(req.session.userId);
    res.json({ ok: true, groups });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// POST /api/groups/create — create a web (Google) squad
app.post('/api/groups/create', requireWebAuth, async (req, res) => {
  try {
    const db    = getDb();
    const { name } = req.body;
    if (!name) return res.status(400).json({ error: 'name required' });
    const group  = await db.createWebGroup({ name, ownerId: req.session.userId });
    if (!group)  return res.status(500).json({ error: 'Failed to create group' });
    await db.addGroupMemberByEmail({ groupId: group.id, userId: req.session.userId, email: req.session.userEmail });
    res.json({ ok: true, group });
  } catch(e) { console.error('[POST /groups/create]', e.message); res.status(500).json({ error: e.message }); }
});

// PATCH /api/groups/:id/rename — rename a squad (owner only)
app.patch('/api/groups/:id/rename', requireWebAuth, async (req, res) => {
  try {
    const { name } = req.body;
    if (!name?.trim()) return res.status(400).json({ error: 'name required' });
    const group = await getDb().renameGroup(req.params.id, name.trim(), req.session.userId);
    if (!group) return res.status(403).json({ error: 'Not authorised or group not found' });
    res.json({ ok: true, group });
  } catch(e) { console.error('[PATCH /groups/rename]', e.message); res.status(500).json({ error: e.message }); }
});

// DELETE /api/groups/:id — delete a web squad (owner only)
app.delete('/api/groups/:id', requireWebAuth, async (req, res) => {
  try {
    const ok = await getDb().deleteGroup(req.params.id, req.session.userId);
    if (!ok) return res.status(403).json({ error: 'Not authorised or group not found' });
    res.json({ ok: true });
  } catch(e) { console.error('[DELETE /groups]', e.message); res.status(500).json({ error: e.message }); }
});

// GET /api/groups/:id/members — list members of a group
app.get('/api/groups/:id/members', requireWebAuth, async (req, res) => {
  try {
    const members = await getDb().getGroupMembers(req.params.id);
    res.json({ ok: true, members });
  } catch(e) { console.error('[GET /groups/members]', e.message); res.status(500).json({ error: e.message }); }
});

// DELETE /api/groups/:id/members/:memberId — remove a member (owner only)
app.delete('/api/groups/:id/members/:memberId', requireWebAuth, async (req, res) => {
  try {
    const ok = await getDb().removeGroupMember(req.params.memberId, req.params.id, req.session.userId);
    if (!ok) return res.status(403).json({ error: 'Not authorised' });
    res.json({ ok: true });
  } catch(e) { console.error('[DELETE /groups/member]', e.message); res.status(500).json({ error: e.message }); }
});

// POST /api/groups/link-telegram — link Telegram group (supports multiple)
app.post('/api/groups/link-telegram', requireWebAuth, async (req, res) => {
  try {
    const db = getDb();
    const { telegramGroupId, name } = req.body;
    if (!telegramGroupId) return res.status(400).json({ error: 'telegramGroupId required' });
    const chatId = parseInt(telegramGroupId, 10);
    if (isNaN(chatId)) return res.status(400).json({ error: 'Invalid Telegram group ID — must be a number like -1001234567890' });
    if (chatId > 0) return res.status(400).json({ error: 'Telegram group IDs start with a minus sign (e.g. -1001234567890). Positive numbers are private chats.' });
    await db.ensureGroup(chatId, name || 'Telegram Group');
    await db.addGroupMemberByEmail({ groupId: chatId, userId: req.session.userId, email: req.session.userEmail });
    res.json({ ok: true, group: { id: chatId, title: name || 'Telegram Group', is_web_group: false } });
  } catch(e) { console.error('[link-telegram]', e.message); res.status(500).json({ error: e.message }); }
});

// POST /api/groups/invite — invite member by email
app.post('/api/groups/invite', requireWebAuth, async (req, res) => {
  try {
    const db = getDb();
    const { groupId, email } = req.body;
    if (!groupId || !email) return res.status(400).json({ error: 'groupId and email required' });
    const existing = await db.getUserByEmail(email);
    if (existing) {
      await db.addGroupMember({ groupId, userId: existing.id, email });
      return res.json({ ok: true, status: 'added', message: `${email} added to squad` });
    }
    await db.addPendingInvite({ groupId, email, invitedBy: req.session.userId });
    res.json({ ok: true, status: 'invited', message: `Invite recorded for ${email}` });
  } catch(e) { console.error('[invite]', e.message); res.status(500).json({ error: e.message }); }
});

// ─── API: METADATA PREVIEW (for Add Pick modal) ────────────
app.get('/api/meta', async (req, res) => {
  const { url } = req.query;
  if (!url) return res.status(400).json({ error: 'url required' });
  try {
    const meta = await getLinks().fetchMeta(url);
    res.json({ title: meta.title, description: meta.description, imageUrl: meta.imageUrl, sourceUrl: meta.sourceUrl });
  } catch(e) { res.status(500).json({ error: e.message }); }
});
app.get('/api/session', (req, res) => {
  if (req.session && req.session.userId) {
    res.json({ ok: true, user: { id: req.session.userId, name: req.session.userName, email: req.session.userEmail, avatar: req.session.userAvatar, loginType: req.session.loginType } });
  } else {
    res.json({ ok: false });
  }
});

// POST /api/auth/logout — used by JS fetch calls
app.post('/api/auth/logout', (req, res) => {
  req.session.destroy(() => {
    res.clearCookie('connect.sid');
    res.clearCookie('tg_user_id');
    res.json({ ok: true });
  });
});

// GET /logout — direct navigation fallback (e.g. if JS fails)
app.get('/logout', (req, res) => {
  req.session.destroy(() => {
    res.clearCookie('connect.sid');
    res.clearCookie('tg_user_id');
    res.redirect('/login');
  });
});

// Manual trigger for admins
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

// ─── API: NOTIFY ──────────────────────────────────────────
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
        const appUrl = miniAppUrl || `https://t.me/${process.env.BOT_USERNAME||'squadpicks_bot'}/${process.env.MINI_APP_SHORT_NAME||'Squadpicks'}?startapp=${chatId}`;
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

// ─── API: TELEGRAM LOGIN (for website) ─────────────────────
app.post('/api/auth/telegram', async (req, res) => {
  try {
    const user = req.body;
    if (!user || !user.id || !user.hash) {
      return res.status(400).json({ ok: false, error: 'Missing auth data' });
    }

    // Build the data-check string exactly as Telegram specifies:
    // All fields EXCEPT hash, sorted alphabetically, joined with \n
    const { hash, ...fields } = user;

    // Telegram sends id as a number — convert all values to string for the check
    const dataCheckStr = Object.keys(fields)
      .sort()
      .map(k => `${k}=${fields[k]}`)
      .join('\n');

    // Secret key = SHA-256 of the bot token (NOT HMAC — plain SHA-256)
    const secret = crypto
      .createHash('sha256')
      .update(process.env.TELEGRAM_TOKEN || '')
      .digest();

    const expected = crypto
      .createHmac('sha256', secret)
      .update(dataCheckStr)
      .digest('hex');

    console.log('[TG Auth] dataCheckStr:', dataCheckStr);
    console.log('[TG Auth] expected:', expected);
    console.log('[TG Auth] received:', hash);
    console.log('[TG Auth] match:', expected === hash);

    if (expected !== hash) {
      // Before failing, check if the auth_date is stale (> 1 day old)
      const authDate = parseInt(fields.auth_date, 10);
      const now = Math.floor(Date.now() / 1000);
      if (!authDate || (now - authDate) > 86400) {
        return res.status(401).json({ ok: false, error: 'Auth data expired — please try logging in again' });
      }
      return res.status(401).json({ ok: false, error: 'Invalid Telegram auth — please check BOT_USERNAME matches your bot exactly, and that your domain is registered with BotFather via /setdomain' });
    }

    // Auth passed
    const db = getDb();
    const dbUser = await db.upsertTelegramUser({
      telegram_id: user.id,
      first_name:  user.first_name,
      username:    user.username
    });

    // Set server session
    if (dbUser) {
      req.session.userId    = dbUser.id;
      req.session.userName  = user.first_name || user.username;
      req.session.loginType = 'telegram';
      await new Promise((resolve, reject) =>
        req.session.save(err => err ? reject(err) : resolve())
      );
    }

    // Find the first group this user's Telegram ID belongs to
    const groups = await db.getAllGroups();
    const firstGroup = groups && groups.length ? groups[0] : null;

    // Telegram users → redirect to the Mini App (app.html) with their group context
    // Google users → redirect to the web dashboard
    const miniAppUrl = firstGroup
      ? `/app?groupId=${firstGroup.id}`
      : `/app`;

    res.json({
      ok:          true,
      user:        { id: user.id, name: user.first_name, username: user.username },
      groups,
      redirectUrl: miniAppUrl   // ← send Telegram users to the Mini App, not the web dashboard
    });
  } catch(e) {
    console.error('[Auth/Telegram]', e.message);
    res.status(500).json({ ok: false, error: 'Server error: ' + e.message });
  }
});

// ─── PAGE ROUTES ────────────────────────────────────────────

// /app — Telegram Mini App
// Accessible from inside Telegram (no session, uses initData) AND from browser after Telegram website login.
// We allow unauthenticated access here — client-side init() checks session and redirects to /login if needed.
app.get('/app', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'app.html'));
});

// Login page — inject real bot username from env at serve time
app.get('/login', (req, res) => {
  // Already logged in? Send them to the right place
  if (req.session && req.session.userId) {
    if (req.session.loginType === 'telegram') return res.redirect('/app');
    return res.redirect('/dashboard');
  }
  try {
    let html = fs.readFileSync(path.join(__dirname, 'public', 'login.html'), 'utf8');
    const botUsername = process.env.BOT_USERNAME || 'squadpicks_bot';
    html = html.replace(/data-telegram-login="[^"]*"/g, `data-telegram-login="${botUsername}"`);
    const googleEnabled = !!(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_ID !== '');
    html = html.replace('__GOOGLE_ENABLED__', googleEnabled ? 'true' : 'false');
    res.send(html);
  } catch(e) {
    res.sendFile(path.join(__dirname, 'public', 'login.html'));
  }
});

// /dashboard — Web dashboard, Google users only
// Server-side auth guard: must have a session. Telegram users go to /app.
app.get('/dashboard', (req, res) => {
  if (!req.session || !req.session.userId) {
    return res.redirect('/login');
  }
  if (req.session.loginType === 'telegram') {
    return res.redirect('/app');
  }
  res.sendFile(path.join(__dirname, 'public', 'dashboard', 'index.html'));
});

app.get('/blog', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'blog', 'index.html'));
});

// CATCH-ALL
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

module.exports = { startServer };

