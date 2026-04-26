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
// Cookie config: Railway always serves over HTTPS, Telegram WebView is cross-site.
// We must ALWAYS use secure=true + sameSite='none' for the cookie to work
// inside Telegram's in-app browser regardless of NODE_ENV.
const isHttps = process.env.APP_URL ? process.env.APP_URL.startsWith('https') : true;
app.use(session({
  secret:            process.env.SESSION_SECRET || 'squadpicks-dev-secret',
  resave:            false,
  saveUninitialized: false,
  cookie: {
    secure:   isHttps,   // true on Railway (HTTPS), false on localhost
    httpOnly: true,
    sameSite: isHttps ? 'none' : 'lax',  // 'none' required for Telegram WebView cross-site
    maxAge:   7 * 24 * 60 * 60 * 1000   // 7 days
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
// Helper: group_ok = no skips AND at least 50% of active members voted "want" or "seen"
async function computeGroupOk(db, pickId, groupId, votes) {
  if (!votes.length) return false;
  if (votes.some(v => v.status === 'skip')) return false;
  // Count active members in the group
  try {
    const members = await db.getGroupMembers(groupId);
    const activeCount = members.filter(m => m.status === 'active').length;
    const positiveVotes = votes.filter(v => v.status === 'want' || v.status === 'seen').length;
    // Group ok if at least 50% of members voted positively
    if (activeCount >= 2) return positiveVotes >= Math.ceil(activeCount * 0.5);
    return positiveVotes > 0; // single-person group: any positive vote = ok
  } catch(e) {
    // Fallback: at least 1 positive vote, no skips
    return votes.some(v => v.status === 'want' || v.status === 'seen');
  }
}

app.get('/api/picks', telegramAuth, async (req, res) => {
  try {
    const db      = getDb();
    const groupId = req.query.groupId || req.tgUser.chatId;
    if (!groupId) return res.status(400).json({ error: 'groupId required' });
    const picks   = await db.getGroupPicks(groupId, 30);
    const votes   = await db.getVotesForPicks(picks.map(p => p.id));
    // Compute group_ok with 50% threshold
    const members = await db.getGroupMembers(groupId).catch(() => []);
    const activeCount = members.filter(m => m.status === 'active').length || 1;
    const enriched = picks.map(p => {
      const pv = votes.filter(v => v.pick_id === p.id);
      const hasSkip = pv.some(v => v.status === 'skip');
      const positiveVotes = pv.filter(v => v.status === 'want' || v.status === 'seen').length;
      const threshold = Math.ceil(activeCount * 0.5);
      const group_ok = !hasSkip && positiveVotes >= threshold && pv.length > 0;
      return { ...p, votes: pv, my_vote: pv.find(v=>v.user_id===req.tgUser.id)?.status||null, group_ok };
    });
    res.json({ picks: enriched });
  } catch (e) { console.error('[GET /picks]',e.message); res.status(500).json({ error: e.message }); }
});

// Vote label for each type — used to auto-vote "want" equivalent on add
const WANT_STATUS = { movie:'want', show:'want', food:'want', place:'want', event:'want', video:'want', link:'want' };

// ─── API: ADD PICK ─────────────────────────────────────────
app.post('/api/picks', telegramAuth, async (req, res) => {
  try {
    const db = getDb(), links = getLinks();
    const { url, groupId, groupTitle, manualType, manualTitle, manualImageUrl } = req.body;
    const chatId = String(groupId || req.tgUser.chatId || '').trim();
    if (!url || !chatId) return res.status(400).json({ error: 'url and groupId required' });
    await db.ensureGroup(chatId, groupTitle || req.tgUser.first_name + "'s Group" || 'SquadPicks Group');

    // Fetch metadata first so we know the resolved URL
    let meta;
    if (manualTitle && manualImageUrl) {
      meta = { title: manualTitle, description: '', imageUrl: manualImageUrl, sourceUrl: url };
    } else {
      meta = await links.fetchMeta(url);
    }

    const type  = manualType  || links.detectType(url, meta);
    const title = manualTitle || meta.title;

    // Duplicate check: compare both the original input URL AND the resolved sourceUrl
    const urlsToCheck = [url, meta.sourceUrl].filter(Boolean).filter((u, i, arr) => arr.indexOf(u) === i);
    let existing = null;
    for (const checkUrl of urlsToCheck) {
      existing = await db.getPickByUrl(chatId, checkUrl);
      if (existing) break;
    }
    if (existing) {
      return res.status(409).json({
        ok: false,
        duplicate: true,
        error: `"${existing.title}" was already added to this squad${existing.added_by_name ? ' by ' + existing.added_by_name : ''}.`,
        pick: existing
      });
    }

    const pick = await db.savePick({
      groupId: chatId, type, title,
      description:  meta.description || '',
      url:          url,
      sourceUrl:    meta.sourceUrl || url,
      imageUrl:     manualImageUrl || meta.imageUrl || '',
      addedById:    req.tgUser.id,
      addedByName:  req.tgUser.first_name || 'Someone',
      reviewerName: null, reviewerScore: null, reviewerQuote: null, reviewerVideoId: null
    });
    if (!pick) return res.status(500).json({ error: 'Failed to save' });

    // Fix 6: Auto-vote "want" (type-appropriate status) for the person who added it
    const autoStatus = WANT_STATUS[type] || 'want';
    await db.upsertVote({
      pickId: pick.id, userId: req.tgUser.id,
      username: req.tgUser.username || '', firstName: req.tgUser.first_name || 'Someone',
      status: autoStatus
    });

    if (global.squadPicksBot) {
      try {
        const votes = await db.getVotesForPick(pick.id);
        const sent = await global.squadPicksBot.sendMessage(chatId, links.formatCard(pick, votes), { parse_mode:'HTML', reply_markup: links.buildVoteKeyboard(pick.id, pick.group_id || chatId) });
        await db.updatePickMessageId(pick.id, sent.message_id);
      } catch(e) { console.error('[Bot notify]',e.message); }
    }

    // Fix 1: Notify all group members by email (non-blocking)
    sendPickNotification({
      pick, groupId: chatId,
      adderName: req.tgUser.first_name || 'Someone',
    }).catch(e => console.error('[Pick notify]', e.message));

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
    const groupOk = await computeGroupOk(db, pickId, pick?.group_id, votes);
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
    const region = req.query.region || 'canada';
    const db = getDb();

    // Netflix: try region variants
    const netflixRegions = ['canada', 'us', 'ca', 'india'].includes(region)
      ? (region === 'india' ? ['india'] : ['canada', 'ca', 'us'])
      : [region];

    // Prime: scraper ALWAYS stores as 'us' — always fetch 'us' first
    const primeRegions = ['us', 'canada', 'ca'];

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
      const nfTagged = netflix.map(r => ({ ...r, source:'netflix', badge:'N', badge_color:'#E50914',
        url: r.netflix_url || `https://www.netflix.com/search?q=${encodeURIComponent(r.title)}` }));
      const pvTagged = prime.map(r => ({ ...r, source:'prime', badge:'P', badge_color:'#00A8E0',
        url: r.prime_url || `https://www.primevideo.com/search/ref=atv_nb_sr?phrase=${encodeURIComponent(r.title)}` }));
      return res.json({ ok:true, netflix: nfTagged, prime: pvTagged, source:'db', ts: new Date().toISOString() });
    }

    // No DB data yet — use fallback static data from streaming.js
    const { getStreamingTop10 } = require('./streaming');
    const data = await getStreamingTop10(region);
    const nf = (data.netflix || []).map(r => ({ ...r, source:'netflix', badge:'N', badge_color:'#E50914' }));
    const pv = (data.prime   || data.all || []).map(r => ({ ...r, source:'prime', badge:'P', badge_color:'#00A8E0' }));
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

// Events top 10 — location-aware (region fallback)
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

// Events by GPS coordinates — called from browser with user's actual location
app.get('/api/trending/events/nearby', async (req, res) => {
  try {
    const lat = parseFloat(req.query.lat);
    const lng = parseFloat(req.query.lng);
    const region = req.query.region || 'canada';
    if (isNaN(lat) || isNaN(lng)) return res.status(400).json({ error: 'lat and lng required' });
    // Determine country code from region
    const countryCode = region === 'us' ? 'US' : region === 'india' ? null : 'CA';
    const { fetchEventsByLatLng } = require('./scraper');
    const events = await fetchEventsByLatLng(lat, lng, countryCode, region);
    res.json({ ok: true, data: events, source: events.length ? 'live' : 'empty', ts: new Date().toISOString() });
  } catch (e) {
    console.error('[GET /trending/events/nearby]', e.message);
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

// POST /api/groups/invite — invite member by email (approval required before joining)
app.post('/api/groups/invite', requireWebAuth, async (req, res) => {
  try {
    const db = getDb();
    const { groupId, email } = req.body;
    if (!groupId || !email) return res.status(400).json({ error: 'groupId and email required' });

    // Get group details
    const sb = getSupabase();
    const { data: grpData } = await sb.from('groups').select('title').eq('id', groupId).maybeSingle();
    const groupName  = grpData?.title || 'a SquadPicks group';
    const inviterName = req.session.userName || req.session.userEmail || 'Someone';
    const appUrl     = process.env.APP_URL || 'https://squadpicks.app';

    // Generate a unique invite token (valid 7 days)
    const crypto    = require('crypto');
    const token     = crypto.randomBytes(32).toString('hex');
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();

    const existing = await db.getUserByEmail(email);
    if (existing) {
      // User exists — add as invited (status='invited') until they accept
      await sb.from('group_members').upsert({
        group_id: groupId, user_id: existing.id, email, status: 'invited',
        role: 'member', invite_token: token, invite_expires_at: expiresAt
      }, { onConflict: 'group_id,user_id' });
      await sendInviteEmail({ to: email, inviterName, groupName, appUrl, isNew: false, token });
      return res.json({ ok: true, status: 'invited', message: `Invite sent to ${email} — they must accept before joining` });
    }

    // New user — create pending invite record
    await db.addPendingInvite({ groupId, email, invitedBy: req.session.userId, token, expiresAt });
    await sendInviteEmail({ to: email, inviterName, groupName, appUrl, isNew: true, token });
    res.json({ ok: true, status: 'invited', message: `Invite sent to ${email}` });
  } catch(e) { console.error('[invite]', e.message); res.status(500).json({ error: e.message }); }
});

// GET /api/groups/accept-invite/:token — user clicks the link in their email
app.get('/api/groups/accept-invite/:token', async (req, res) => {
  try {
    const { token } = req.params;
    const sb = getSupabase();
    // Find the invite by token
    const { data: member } = await sb.from('group_members')
      .select('*').eq('invite_token', token).maybeSingle();
    if (!member) return res.redirect('/dashboard?invite=invalid');
    if (member.invite_expires_at && new Date(member.invite_expires_at) < new Date()) {
      return res.redirect('/dashboard?invite=expired');
    }
    // Activate the member
    await sb.from('group_members').update({
      status: 'active', invite_token: null, invite_expires_at: null
    }).eq('id', member.id);
    // Redirect to the group
    res.redirect(`/dashboard?groupId=${member.group_id}&invite=accepted`);
  } catch(e) { console.error('[accept-invite]', e.message); res.redirect('/dashboard?invite=error'); }
});

// ─── EMAIL: Invite with approval link ──────────────────────
async function sendInviteEmail({ to, inviterName, groupName, appUrl, isNew, token }) {
  const resendKey   = process.env.RESEND_API_KEY;
  const acceptLink  = `${appUrl}/api/groups/accept-invite/${token}`;
  const subject     = `${inviterName} invited you to "${groupName}" on SquadPicks`;
  const html = `
    <div style="font-family:'DM Sans',sans-serif;max-width:520px;margin:0 auto;background:#F5F3FF;padding:32px 24px;border-radius:16px">
      <h1 style="font-family:Georgia,serif;color:#6B21A8;font-size:26px;margin:0 0 16px">SquadPicks 🎬</h1>
      <p style="color:#3B1F6B;font-size:15px;margin:0 0 8px">
        <strong>${inviterName}</strong> has invited you to join <strong>${groupName}</strong>.
      </p>
      <p style="color:#7C5AB8;font-size:14px;margin:0 0 24px">
        SquadPicks is how your squad decides what to watch, eat, and do together.
      </p>
      <a href="${acceptLink}" style="display:inline-block;background:#7C3AED;color:#fff;text-decoration:none;padding:14px 28px;border-radius:12px;font-size:16px;font-weight:700;margin-bottom:20px">
        ✅ Accept invite &amp; join ${groupName}
      </a>
      <p style="color:#9D86D4;font-size:12px;margin-top:16px">
        This link expires in 7 days. ${isNew ? 'You\'ll be asked to sign in with Google first.' : ''}
      </p>
      <hr style="border:none;border-top:1px solid #DDD6FE;margin:20px 0"/>
      <p style="color:#B8A9D9;font-size:11px">SquadPicks · Your squad. Any plan. One app.</p>
    </div>`;

  if (!resendKey) {
    console.log(`[Email] No RESEND_API_KEY — invite to ${to}: ${acceptLink}`);
    return;
  }
  try {
    const fetch = (...a) => import('node-fetch').then(m => m.default(...a));
    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${resendKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: process.env.RESEND_FROM_EMAIL || 'SquadPicks <noreply@squadpicks.app>', to: [to], subject, html })
    });
    const d = await r.json();
    if (r.ok) console.log(`[Email] Invite sent to ${to}, id: ${d.id}`);
    else      console.error(`[Email] Resend error:`, d);
  } catch(e) { console.error('[Email] Send failed:', e.message); }
}

// ─── EMAIL: Pick added notification ────────────────────────
// Fix 1: notify all group members when a new pick is added
async function sendPickNotification({ pick, groupId, adderName }) {
  const resendKey = process.env.RESEND_API_KEY;
  if (!resendKey) return;
  try {
    const sb = getSupabase();
    // Get all active members of this group except the adder
    const { data: members } = await sb.from('group_members')
      .select('email, user_id').eq('group_id', groupId).eq('status', 'active');
    if (!members || !members.length) return;

    // Get their emails from users table
    const userIds = members.map(m => m.user_id).filter(Boolean);
    const { data: users } = await sb.from('users').select('email, name').in('id', userIds);
    if (!users || !users.length) return;

    const appUrl   = process.env.APP_URL || 'https://squadpicks.app';
    const typeIcon = { movie:'🎬', show:'📺', food:'🍽', place:'📍', event:'🎭', video:'▶️', link:'🔗' }[pick.type] || '🔗';
    const subject  = `${adderName} added a new pick to your squad`;
    const html = `
      <div style="font-family:'DM Sans',sans-serif;max-width:520px;margin:0 auto;background:#F5F3FF;padding:32px 24px;border-radius:16px">
        <h1 style="font-family:Georgia,serif;color:#6B21A8;font-size:22px;margin:0 0 16px">New SquadPick ${typeIcon}</h1>
        <p style="color:#3B1F6B;font-size:15px;margin:0 0 4px">
          <strong>${adderName}</strong> added a new pick:
        </p>
        <div style="background:#fff;border-radius:12px;padding:16px 20px;margin:16px 0;border:1px solid #DDD6FE">
          <div style="font-size:18px;font-weight:700;color:#1E1333;margin-bottom:4px">${pick.title}</div>
          ${pick.description ? `<div style="font-size:13px;color:#7C5AB8">${pick.description.slice(0,120)}</div>` : ''}
        </div>
        <a href="${appUrl}/dashboard?groupId=${groupId}" style="display:inline-block;background:#7C3AED;color:#fff;text-decoration:none;padding:12px 24px;border-radius:10px;font-size:14px;font-weight:700">
          Vote on it →
        </a>
        <hr style="border:none;border-top:1px solid #DDD6FE;margin:20px 0"/>
        <p style="color:#B8A9D9;font-size:11px">SquadPicks · <a href="${appUrl}/dashboard" style="color:#8B5CF6">Open app</a></p>
      </div>`;

    const fetch = (...a) => import('node-fetch').then(m => m.default(...a));
    for (const user of users) {
      if (!user.email || user.email === pick.added_by_email) continue;
      try {
        await fetch('https://api.resend.com/emails', {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${resendKey}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ from: process.env.RESEND_FROM_EMAIL || 'SquadPicks <noreply@squadpicks.app>', to: [user.email], subject, html })
        });
        console.log(`[Email] Pick notification sent to ${user.email}`);
      } catch(e) { console.error('[Email] Pick notify failed:', e.message); }
    }
  } catch(e) { console.error('[Email] sendPickNotification error:', e.message); }
}

// Helper: get raw supabase client (for operations not in db.js)
function getSupabase() {
  const { createClient } = require('@supabase/supabase-js');
  return createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
}

// ─── GROUP CHANNELS (YouTube per group) ────────────────────

app.get('/api/groups/:id/channels', requireWebAuth, async (req, res) => {
  try {
    const sb = getSupabase();
    const { data } = await sb.from('group_channels')
      .select('*').eq('group_id', req.params.id).order('created_at', { ascending: true });
    res.json({ ok: true, channels: data || [] });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/groups/:id/channels', requireWebAuth, async (req, res) => {
  try {
    const sb = getSupabase();
    const { channelId, channelName, channelUrl } = req.body;
    if (!channelId) return res.status(400).json({ error: 'channelId required' });
    await sb.from('group_channels').upsert({
      group_id: req.params.id, channel_id: channelId,
      channel_name: channelName || channelId, channel_url: channelUrl || '',
      added_by: req.session.userId
    }, { onConflict: 'group_id,channel_id' });
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/groups/:id/channels/:channelId', requireWebAuth, async (req, res) => {
  try {
    const sb = getSupabase();
    await sb.from('group_channels').delete()
      .eq('group_id', req.params.id).eq('channel_id', req.params.channelId);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ─── ADMIN MANAGEMENT ──────────────────────────────────────

// Promote/demote member to admin (owner only)
app.patch('/api/groups/:id/members/:memberId/role', requireWebAuth, async (req, res) => {
  try {
    const sb = getSupabase();
    const { role } = req.body; // 'admin' | 'member'
    if (!['admin','member'].includes(role)) return res.status(400).json({ error: 'role must be admin or member' });
    // Check caller is owner
    const { data: group } = await sb.from('groups').select('owner_id').eq('id', req.params.id).maybeSingle();
    if (!group || group.owner_id !== req.session.userId) return res.status(403).json({ error: 'Only the owner can change roles' });
    await sb.from('group_members').update({ role }).eq('id', req.params.memberId);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ─── COMMUNITY TRENDING ────────────────────────────────────
// Shows group-ok picks from groups the current user is NOT in
app.get('/api/trending/community', requireWebAuth, async (req, res) => {
  try {
    const sb  = getSupabase();
    const uid = req.session.userId;
    // Get groups this user belongs to
    const { data: myGroups } = await sb.from('group_members')
      .select('group_id').eq('user_id', uid).eq('status', 'active');
    const myGroupIds = (myGroups || []).map(g => String(g.group_id));

    // Get picks from ALL other groups that are group_ok
    const { data: picks } = await sb.from('picks')
      .select('id, title, type, image_url, url, group_id, description, created_at')
      .eq('group_ok', true)
      .not('group_id', 'in', `(${myGroupIds.join(',') || '0'})`)
      .order('created_at', { ascending: false })
      .limit(30);

    // Get group names for these picks
    const groupIds = [...new Set((picks||[]).map(p => p.group_id))];
    let groupMap = {};
    if (groupIds.length) {
      const { data: groups } = await sb.from('groups').select('id, title').in('id', groupIds);
      (groups||[]).forEach(g => { groupMap[g.id] = g.title; });
    }

    const enriched = (picks||[]).map(p => ({
      ...p, group_title: groupMap[p.group_id] || 'Another squad'
    }));
    res.json({ ok: true, picks: enriched });
  } catch(e) { console.error('[community trending]', e.message); res.status(500).json({ error: e.message }); }
});

// ─── USER PREFERENCES ──────────────────────────────────────

app.get('/api/preferences', requireWebAuth, async (req, res) => {
  try {
    const sb = getSupabase();
    const { data } = await sb.from('user_preferences')
      .select('*').eq('user_id', req.session.userId).maybeSingle();
    res.json({ ok: true, prefs: data || { notify_pick_add: true, notify_group_ok: true, notify_digest: true } });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/preferences', requireWebAuth, async (req, res) => {
  try {
    const sb = getSupabase();
    const { notify_pick_add, notify_group_ok, notify_digest } = req.body;
    await sb.from('user_preferences').upsert({
      user_id: req.session.userId,
      notify_pick_add: !!notify_pick_add,
      notify_group_ok: !!notify_group_ok,
      notify_digest:   !!notify_digest,
      updated_at: new Date().toISOString()
    }, { onConflict: 'user_id' });
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
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

// ─── TELEGRAM MINI APP AUTH — SERVER-SIDE REDIRECT (reliable cookie) ───────
// app.html redirects here: GET /auth/telegram-miniapp?initData=...&groupId=...
// The server verifies initData, creates the session, then redirects to /dashboard.
// This is the reliable path because the server sets Set-Cookie on a GET redirect,
// which Telegram's in-app WebView always honours (unlike fetch()-based auth where
// the WebView sometimes drops the Set-Cookie response header).
app.get('/auth/telegram-miniapp', async (req, res) => {
  try {
    const initData = req.query.initData || '';
    const groupId  = req.query.groupId  || '';

    console.log('[TG MiniApp] Received auth request, groupId:', groupId, 'initData length:', initData.length);

    if (!initData) {
      console.warn('[TG MiniApp] No initData received');
      return res.redirect('/login?error=no_initdata');
    }

    // --- Verify initData HMAC ---
    // initData is a URL-encoded string like: query_id=...&user=...&hash=...
    const params = new URLSearchParams(initData);
    const hash   = params.get('hash');

    if (!hash) {
      console.warn('[TG MiniApp] No hash in initData');
      return res.redirect('/login?error=no_hash');
    }

    // Build data-check string: all params except hash, sorted alphabetically, joined with \n
    const entries = [];
    params.forEach((v, k) => { if (k !== 'hash') entries.push(k + '=' + v); });
    const dataCheckStr = entries.sort().join('\n');

    const secret   = crypto.createHmac('sha256', 'WebAppData')
                           .update(process.env.TELEGRAM_TOKEN || '').digest();
    const expected = crypto.createHmac('sha256', secret)
                           .update(dataCheckStr).digest('hex');
    const authOk   = (expected === hash);

    console.log('[TG MiniApp] HMAC verify:', authOk ? 'OK' : 'FAILED', '| token set:', !!process.env.TELEGRAM_TOKEN);

    if (!authOk) {
      // In production this must fail. But if token is missing, let it through
      // so the user sees the dashboard rather than a hard login wall.
      if (process.env.TELEGRAM_TOKEN) {
        console.warn('[TG MiniApp] HMAC verification failed - rejecting');
        return res.redirect('/login?error=tgauth');
      }
      console.warn('[TG MiniApp] No TELEGRAM_TOKEN set - skipping HMAC check');
    }

    // --- Parse user from initData ---
    const userRaw = params.get('user');
    if (!userRaw) {
      console.warn('[TG MiniApp] No user field in initData');
      return res.redirect('/login?error=nouser');
    }
    const tgUser = JSON.parse(decodeURIComponent(userRaw));
    console.log('[TG MiniApp] User:', tgUser.id, tgUser.first_name);

    // --- Upsert user in DB ---
    const db = getDb();
    const dbUser = await db.upsertTelegramUser({
      telegram_id: String(tgUser.id),
      first_name:  tgUser.first_name || tgUser.username || 'Member',
      username:    tgUser.username || ''
    });

    if (!dbUser) {
      console.error('[TG MiniApp] Failed to upsert user in DB');
      return res.redirect('/login?error=db');
    }

    // --- Save session ---
    req.session.userId    = dbUser.id;
    req.session.userName  = tgUser.first_name || tgUser.username || 'Member';
    req.session.loginType = 'telegram';
    req.session.tgId      = String(tgUser.id);

    await new Promise((resolve, reject) =>
      req.session.save(err => {
        if (err) { console.error('[TG MiniApp] Session save error:', err); reject(err); }
        else resolve();
      })
    );

    console.log('[TG MiniApp] Session saved, SID:', req.sessionID);

    // --- Redirect to dashboard ---
    // Pass tgauth=1 so dashboard knows auth already happened server-side
    // Pass groupId so dashboard pre-selects the right squad
    const dest = '/dashboard'
      + '?tgauth=1'
      + (groupId ? '&groupId=' + encodeURIComponent(groupId) : '');

    console.log('[TG MiniApp] Redirecting to:', dest);
    res.redirect(dest);
  } catch(e) {
    console.error('[TG MiniApp GET Auth] Exception:', e.message, e.stack);
    res.redirect('/login?error=tgauth');
  }
});

// ─── TELEGRAM MINI APP AUTH (initData from Telegram.WebApp) ───────────────
// Called by dashboard/index.html when it detects Telegram.WebApp.initData
// Different from the Login Widget endpoint — uses HMAC-SHA256 of "WebAppData"

app.post('/api/auth/telegram-webapp', async (req, res) => {
  try {
    const { initData } = req.body;
    if (!initData) return res.status(400).json({ ok: false, error: 'initData required' });

    // Verify: secret = HMAC-SHA256("WebAppData", bot_token); check = HMAC-SHA256(secret, data_check_string)
    const params  = new URLSearchParams(initData);
    const hash    = params.get('hash');
    if (!hash) return res.status(400).json({ ok: false, error: 'Missing hash' });

    // Build data-check string: all params except hash, sorted, joined with \n
    const entries = [];
    params.forEach((v, k) => { if (k !== 'hash') entries.push(`${k}=${v}`); });
    const dataCheckStr = entries.sort().join('\n');

    const secret = crypto.createHmac('sha256', 'WebAppData')
      .update(process.env.TELEGRAM_TOKEN || '').digest();
    const expected = crypto.createHmac('sha256', secret)
      .update(dataCheckStr).digest('hex');

    if (expected !== hash) {
      // Allow in dev/test mode
      const isDev = process.env.NODE_ENV !== 'production';
      if (!isDev) return res.status(401).json({ ok: false, error: 'Invalid initData' });
    }

    // Parse the user object from initData
    const userRaw = params.get('user');
    if (!userRaw) return res.status(400).json({ ok: false, error: 'No user in initData' });
    const tgUser = JSON.parse(userRaw);

    // Upsert user in DB and create session
    const db = getDb();
    const dbUser = await db.upsertTelegramUser({
      telegram_id: String(tgUser.id),
      first_name:  tgUser.first_name || tgUser.username || 'Member',
      username:    tgUser.username || ''
    });
    if (dbUser) {
      req.session.userId    = dbUser.id;
      req.session.userName  = tgUser.first_name || tgUser.username;
      req.session.loginType = 'telegram';
      await new Promise((resolve, reject) => req.session.save(err => err ? reject(err) : resolve()));
    }
    res.json({
      ok:   true,
      user: { id: String(tgUser.id), name: tgUser.first_name || 'Member', username: tgUser.username || '' }
    });
  } catch(e) {
    console.error('[Telegram WebApp Auth]', e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ─── TELEGRAM LOGIN WIDGET (website button, not Mini App) ─────────────────
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
    return res.redirect('/dashboard');  // all logged-in users go to dashboard
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

// /dashboard — Main app for ALL authenticated users (Google AND Telegram)
// Telegram users arrive here after /auth/telegram-miniapp sets their session.
// dashboard/index.html handles both loginTypes — do NOT redirect Telegram users away.
app.get('/dashboard', (req, res) => {
  if (!req.session || !req.session.userId) {
    return res.redirect('/login');
  }
  // Serve dashboard to everyone — Google and Telegram users alike
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

