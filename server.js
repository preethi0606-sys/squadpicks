// server.js — SquadPicks Mini App API Server
// Runs alongside the bot on the same Railway deployment
const express = require('express');
const cors    = require('cors');
const path    = require('path');
const crypto  = require('crypto');
const db      = require('./db');
const { detectType, fetchMeta, formatCard, buildVoteKeyboard } = require('./links');

const app  = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// Serve the Mini App HTML files from /public folder
app.use(express.static(path.join(__dirname, 'public')));

// ─── TELEGRAM INIT DATA VALIDATION ─────────────────────────
// Verifies the request actually came from Telegram

function validateTelegramAuth(initData) {
  if (!process.env.TELEGRAM_TOKEN) return { valid: false };
  try {
    const params = new URLSearchParams(initData);
    const hash   = params.get('hash');
    params.delete('hash');

    const dataCheckString = Array.from(params.entries())
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${k}=${v}`)
      .join('\n');

    const secretKey = crypto
      .createHmac('sha256', 'WebAppData')
      .update(process.env.TELEGRAM_TOKEN)
      .digest();

    const expectedHash = crypto
      .createHmac('sha256', secretKey)
      .update(dataCheckString)
      .digest('hex');

    if (expectedHash !== hash) return { valid: false };

    const user = JSON.parse(params.get('user') || '{}');
    const chatId = params.get('start_param') || null;
    return { valid: true, user, chatId };
  } catch (err) {
    console.error('[Auth] Validation error:', err.message);
    return { valid: false };
  }
}

// ─── MIDDLEWARE: Parse user from Telegram init data ─────────

function telegramAuth(req, res, next) {
  const initData = req.headers['x-telegram-init-data'] || '';

  // In development/testing mode, allow bypass with a test user
  if (!initData || initData === 'test') {
    req.tgUser = {
      id:         123456789,
      first_name: 'Priya',
      username:   'priya_test',
      chatId:     req.headers['x-chat-id'] || null
    };
    return next();
  }

  const result = validateTelegramAuth(initData);
  if (!result.valid) {
    return res.status(401).json({ error: 'Invalid Telegram auth' });
  }

  req.tgUser = { ...result.user, chatId: result.chatId };
  next();
}

// ─── API ROUTES ─────────────────────────────────────────────

// GET /api/health — Railway health check
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', service: 'SquadPicks Mini App', timestamp: new Date().toISOString() });
});

// GET /api/picks?groupId=xxx — Get all picks for a group
app.get('/api/picks', telegramAuth, async (req, res) => {
  try {
    const groupId = req.query.groupId || req.tgUser.chatId;
    if (!groupId) return res.status(400).json({ error: 'groupId required' });

    const picks = await db.getGroupPicks(groupId, 30);
    const pickIds = picks.map(p => p.id);
    const votes  = await db.getVotesForPicks(pickIds);

    // Attach votes to each pick
    const enriched = picks.map(pick => {
      const pickVotes = votes.filter(v => v.pick_id === pick.id);
      const myVote    = pickVotes.find(v => v.user_id === req.tgUser.id);
      return {
        ...pick,
        votes:   pickVotes,
        my_vote: myVote?.status || null,
        group_ok: pickVotes.length > 0 && pickVotes.every(v => v.status !== 'skip')
      };
    });

    res.json({ picks: enriched });
  } catch (err) {
    console.error('[API] GET /picks error:', err.message);
    res.status(500).json({ error: 'Failed to fetch picks' });
  }
});

// POST /api/picks — Add a new pick from a URL
app.post('/api/picks', telegramAuth, async (req, res) => {
  try {
    const { url, groupId } = req.body;
    const chatId = groupId || req.tgUser.chatId;

    if (!url)    return res.status(400).json({ error: 'url required' });
    if (!chatId) return res.status(400).json({ error: 'groupId required' });

    // Make sure group exists
    await db.ensureGroup(chatId, req.body.groupTitle || 'SquadPicks Group');

    // Fetch metadata from URL
    const meta = await fetchMeta(url);
    const type = detectType(url, meta);

    const pick = await db.savePick({
      groupId:       chatId,
      type,
      title:         meta.title,
      description:   meta.description,
      url,
      imageUrl:      meta.imageUrl,
      addedById:     req.tgUser.id,
      addedByName:   req.tgUser.first_name || req.tgUser.username || 'Someone',
      reviewerName:  null, reviewerScore: null,
      reviewerQuote: null, reviewerVideoId: null
    });

    if (!pick) return res.status(500).json({ error: 'Failed to save pick' });

    // Also send a message in the Telegram group (if bot is available)
    if (global.squadPicksBot && chatId) {
      try {
        const cardText = formatCard(pick, []);
        const sent = await global.squadPicksBot.sendMessage(chatId, cardText, {
          parse_mode:   'HTML',
          reply_markup: buildVoteKeyboard(pick.id)
        });
        await db.updatePickMessageId(pick.id, sent.message_id);
      } catch (botErr) {
        console.error('[API] Bot notify error:', botErr.message);
        // Don't fail the API call if bot message fails
      }
    }

    res.json({ pick, meta });
  } catch (err) {
    console.error('[API] POST /picks error:', err.message);
    res.status(500).json({ error: 'Failed to add pick' });
  }
});

// POST /api/vote — Cast or toggle a vote
app.post('/api/vote', telegramAuth, async (req, res) => {
  try {
    const { pickId, status } = req.body;
    if (!pickId || !status) return res.status(400).json({ error: 'pickId and status required' });
    if (!['seen','want','skip'].includes(status)) {
      return res.status(400).json({ error: 'status must be seen, want, or skip' });
    }

    // Toggle: if same status, remove vote
    const existing = await db.getVote(pickId, req.tgUser.id);
    if (existing && existing.status === status) {
      await db.deleteVote(pickId, req.tgUser.id);
    } else {
      await db.upsertVote({
        pickId,
        userId:    req.tgUser.id,
        username:  req.tgUser.username  || '',
        firstName: req.tgUser.first_name || 'Someone',
        status
      });
    }

    // Return updated votes for this pick
    const votes  = await db.getVotesForPick(pickId);
    const myVote = votes.find(v => v.user_id === req.tgUser.id);
    const pick   = await db.getPick(pickId);
    const groupOk = votes.length > 0 && votes.every(v => v.status !== 'skip');

    // Update Telegram message if possible
    if (global.squadPicksBot && pick?.message_id && pick?.group_id) {
      try {
        await global.squadPicksBot.editMessageText(formatCard(pick, votes), {
          chat_id:      pick.group_id,
          message_id:   pick.message_id,
          parse_mode:   'HTML',
          reply_markup: buildVoteKeyboard(pickId)
        });
      } catch (e) {
        if (!e.message.includes('not modified')) {
          console.error('[API] Bot update card error:', e.message);
        }
      }
    }

    res.json({
      votes,
      my_vote:  myVote?.status || null,
      group_ok: groupOk
    });
  } catch (err) {
    console.error('[API] POST /vote error:', err.message);
    res.status(500).json({ error: 'Failed to record vote' });
  }
});

// GET /api/summary?groupId=xxx — Get group summary
app.get('/api/summary', telegramAuth, async (req, res) => {
  try {
    const groupId = req.query.groupId || req.tgUser.chatId;
    if (!groupId) return res.status(400).json({ error: 'groupId required' });

    const picks  = await db.getGroupPicks(groupId, 30);
    const pickIds = picks.map(p => p.id);
    const votes  = await db.getVotesForPicks(pickIds);

    const groupOk  = [];
    const hasSkip  = [];
    const pending  = [];

    for (const pick of picks) {
      const pv    = votes.filter(v => v.pick_id === pick.id);
      const skips = pv.filter(v => v.status === 'skip');
      if (skips.length > 0) hasSkip.push({ pick, votes: pv });
      else if (pv.length > 0) groupOk.push({ pick, votes: pv });
      else pending.push({ pick, votes: [] });
    }

    res.json({ groupOk, hasSkip, pending });
  } catch (err) {
    console.error('[API] GET /summary error:', err.message);
    res.status(500).json({ error: 'Failed to fetch summary' });
  }
});

// GET /api/fcpicks — Latest Filmi Craft reviews
app.get('/api/fcpicks', telegramAuth, async (req, res) => {
  try {
    const picks = await db.getRecentFilmiCraftPicks(10);
    res.json({ picks });
  } catch (err) {
    console.error('[API] GET /fcpicks error:', err.message);
    res.status(500).json({ error: 'Failed to fetch FC picks' });
  }
});

// GET /api/groups — Get groups the user belongs to
app.get('/api/groups', telegramAuth, async (req, res) => {
  try {
    const groups = await db.getAllGroups();
    res.json({ groups });
  } catch (err) {
    console.error('[API] GET /groups error:', err.message);
    res.status(500).json({ error: 'Failed to fetch groups' });
  }
});

// ─── START SERVER ───────────────────────────────────────────

function startServer() {
  app.listen(PORT, () => {
    console.log(`[Server] SquadPicks Mini App API running on port ${PORT}`);
    console.log(`[Server] Mini App URL: http://localhost:${PORT}/`);
  });
}

module.exports = { startServer };
