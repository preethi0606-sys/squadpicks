# SquadPicks — Project Knowledge Base
**Version:** 3.5 | **Last updated:** April 2026
**Repo:** https://github.com/preethi0606-sys/squadpicks
**Deploy:** Railway (railway.app) | **DB:** Supabase (PostgreSQL)

> **How to use this document in a new Claude session:**
> Upload this file and say: *"You are my app builder for SquadPicks. Read the knowledge base and help me with [task]."*
> Claude will understand the full codebase, architecture, and current state without needing to re-read every file.

---

## 1. What SquadPicks Is

Group activity coordination app. Your squad votes on what to watch, eat, visit, or attend — together.

**Two ways to use it:**
- **Telegram bot** — paste any link in a group chat → bot creates a vote card → squad votes
- **Web app** — sign in with Google at `/login` → dashboard to manage picks, vote, explore trending

**Core flow:** Link detected → type classified → metadata fetched → pick saved → group votes → "Group ok" when ≥50% agree

---

## 2. Architecture

### Single Codebase, Single UI

```
┌─────────────────────────────────────────────────────┐
│  Telegram Bot (index.js)                            │
│  • Detects links, fetches metadata, posts vote cards│
│  • "🚀 Open in SquadPicks" → t.me/BOT/APP?startapp=g{digits} │
└──────────────────┬──────────────────────────────────┘
                   │
┌──────────────────▼──────────────────────────────────┐
│  public/app.html  (Mini App entry point)            │
│  • Waits for Telegram SDK to init                   │
│  • Reads tg.initData + groupId from start_param     │
│  • Decodes g-prefix: g1001234567890 → -1001234567890│
│  • Redirects to /dashboard?groupId=X&tgInitData=Y   │
└──────────────────┬──────────────────────────────────┘
                   │
┌──────────────────▼──────────────────────────────────┐
│  public/dashboard/index.html  (THE Full App)        │
│  • Single HTML file                                 │
│  • Handles BOTH Google users and Telegram users     │
│  • Reads ?tgInitData= from URL → POST /api/auth/telegram-webapp │
│  • Falls back to Google session check               │
│  • If neither → redirects to /login                 │
│  • decodeGId() decodes g-prefix from URL groupId    │
│  • Auto-selects correct squad tab after loadGroups()│
└──────────────────┬──────────────────────────────────┘
                   │
┌──────────────────▼──────────────────────────────────┐
│  server.js  (Express API)                           │
│  • All API routes                                   │
│  • Google OAuth, Telegram auth, session management  │
│  • Email via Resend (invites + pick notifications)  │
└──────────────────┬──────────────────────────────────┘
                   │
         ┌─────────┴─────────┐
         ▼                   ▼
      db.js              links.js
   (Supabase)        (metadata fetching)
```

### Key Technical Decisions
| Decision | Rationale |
|----------|-----------|
| One frontend file (`dashboard/index.html`) | No build tools needed, easy Railway deploy |
| `app.html` is just a redirect | Unified UI — no separate Mini App codebase |
| Telegram auth via URL param (`?tgInitData=`) | Session cookie can't survive cross-page redirect reliably |
| Two plain Supabase queries instead of FK joins | FK join syntax requires schema cache — two queries always work |
| node-fetch v3 (`^3.3.2`) | Uses `import('node-fetch')` dynamic ESM; `res.arrayBuffer()` not `res.buffer()` |
| TMDB as sole movie/TV source | IMDB blocks cloud IPs; OMDB removed |
| Group ok = `Math.ceil(members × 0.5)` | 50% threshold, no skips |
| `ensureGroup` casts chatId to `Number()` | Supabase BIGINT vs JS string type mismatch |
| g-prefix encoding for startapp | Telegram startapp param forbids "-"; `encodeGroupId()` in index.js; `decodeGId()` in dashboard |

---

## 3. File Structure

```
squadpicks-bot/
├── index.js              Bot: commands, handleLink, cron wiring, server start
├── server.js             Express API, OAuth, all routes, email functions
├── db.js                 All Supabase queries
├── links.js              Link detection, metadata fetching, card/keyboard builders
├── scraper.js            Netflix XLSX + TMDB + TripAdvisor + Ticketmaster cron scrapers
├── youtube.js            YouTube channel monitor (Friday cron)
├── digest.js             Sunday weekly digest cron
├── streaming.js          Static fallback streaming data
├── database.sql          Full schema + all migrations (v3.5 latest)
├── package.json          Dependencies (node-fetch ^3.3.2 critical)
├── package-lock.json     Required for Railway
├── railway.toml          builder = nixpacks
├── Procfile              web: node index.js
├── .env.example          All env vars documented
└── public/
    ├── app.html              Telegram Mini App entry (redirects to /dashboard)
    ├── dashboard/index.html  THE Full App — all UI here
    ├── login.html            Google + Telegram Login Widget
    ├── index.html            Landing page
    └── styles.css            Shared styles
```

---

## 4. Database Schema

### Core Tables

```sql
-- Groups: Telegram groups (negative ID) + web squads (random negative ID)
groups (id BIGINT PK, title TEXT, is_web_group BOOLEAN, owner_id UUID→users)

-- Picks: everything added by anyone
picks (id UUID PK, group_id BIGINT, type TEXT, title TEXT, description TEXT,
       url TEXT, image_url TEXT, added_by_id, added_by_name TEXT,
       reviewer_name, reviewer_score, reviewer_quote, reviewer_video_id,
       message_id BIGINT, group_ok BOOLEAN, created_at)

-- Votes: one row per person per pick
votes (id UUID PK, pick_id UUID, user_id TEXT, username TEXT, first_name TEXT,
       status TEXT CHECK(seen|want|skip), created_at
       UNIQUE(pick_id, user_id))

-- Users: Google + Telegram unified
users (id UUID PK, telegram_id TEXT UNIQUE, google_id TEXT UNIQUE,
       email TEXT, name TEXT, avatar TEXT, created_at)

-- Squad membership
group_members (id UUID PK, group_id BIGINT, user_id UUID→users, email TEXT,
               status TEXT CHECK(invited|active), role TEXT DEFAULT 'member',
               invited_by UUID→users, invite_token TEXT, invite_expires_at TIMESTAMPTZ)
  UNIQUE(group_id, user_id)
  UNIQUE INDEX on (group_id, email)

-- YouTube channels per squad
group_channels (id UUID PK, group_id BIGINT, channel_id TEXT,
                channel_name TEXT, channel_url TEXT, added_by UUID→users
                UNIQUE(group_id, channel_id))

-- Notification preferences per user
user_preferences (id UUID PK, user_id UUID→users UNIQUE,
                  notify_pick_add BOOLEAN DEFAULT true,
                  notify_group_ok BOOLEAN DEFAULT true,
                  notify_digest BOOLEAN DEFAULT true)

-- Dedup for YouTube video posts
posted_videos (id UUID PK, video_id TEXT, channel_id TEXT, title TEXT, posted_at)
```

### Trending Tables

```sql
trending_netflix (id, rank, title, type, region, image_url, netflix_url,
                  badge, badge_color, week_of UNIQUE(title,region,week_of))

trending_prime   (id, rank, title, type, image_url, prime_url, tmdb_url,
                  badge, badge_color, score, region, week_of UNIQUE(title,region,week_of))

trending_imdb    (id, rank, title, type, year, rating, genre, image_url,
                  tmdb_url, imdb_url, category, week_of UNIQUE(title,category,week_of))

trending_places  (id, rank, title, description, image_url, url, tripadvisor_url,
                  region, type DEFAULT 'place', week_of UNIQUE(title,region,week_of))

trending_events  (id, rank, title, description, image_url, url, region,
                  type DEFAULT 'event', category DEFAULT 'concerts',
                  week_of UNIQUE(title,region,week_of))
```

### All Required SQL Migrations (run in Supabase SQL Editor)

```sql
-- v3.1
ALTER TABLE trending_imdb  ADD COLUMN IF NOT EXISTS tmdb_url TEXT;
ALTER TABLE trending_prime ADD COLUMN IF NOT EXISTS prime_url TEXT;
ALTER TABLE trending_prime ADD COLUMN IF NOT EXISTS tmdb_url TEXT;
ALTER TABLE trending_prime ADD COLUMN IF NOT EXISTS badge TEXT DEFAULT 'P';
ALTER TABLE trending_prime ADD COLUMN IF NOT EXISTS badge_color TEXT DEFAULT '#00A8E0';
ALTER TABLE trending_prime ADD COLUMN IF NOT EXISTS score TEXT;
ALTER TABLE trending_events ADD COLUMN IF NOT EXISTS category TEXT DEFAULT 'concerts';

-- v3.3
ALTER TABLE group_members ADD COLUMN IF NOT EXISTS role TEXT DEFAULT 'member';
ALTER TABLE group_members ADD COLUMN IF NOT EXISTS invite_token TEXT;
ALTER TABLE group_members ADD COLUMN IF NOT EXISTS invite_expires_at TIMESTAMPTZ;

CREATE TABLE IF NOT EXISTS group_channels (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  group_id BIGINT NOT NULL, channel_id TEXT NOT NULL,
  channel_name TEXT, channel_url TEXT, added_by UUID REFERENCES users(id),
  created_at TIMESTAMPTZ DEFAULT NOW(), UNIQUE(group_id, channel_id)
);

CREATE TABLE IF NOT EXISTS user_preferences (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID REFERENCES users(id) UNIQUE,
  notify_pick_add BOOLEAN DEFAULT true, notify_group_ok BOOLEAN DEFAULT true,
  notify_digest BOOLEAN DEFAULT true, updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS trending_places (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  rank INT, title TEXT, description TEXT, image_url TEXT,
  url TEXT, tripadvisor_url TEXT, region TEXT, type TEXT DEFAULT 'place',
  week_of DATE, fetched_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(title, region, week_of)
);
ALTER TABLE trending_places ADD COLUMN IF NOT EXISTS tripadvisor_url TEXT;

-- Refresh stale data after migration
TRUNCATE trending_places;
TRUNCATE trending_prime;
TRUNCATE trending_imdb;
TRUNCATE trending_events;
```

---

## 5. All API Endpoints

### Auth
| Method | Path | Auth | Purpose |
|--------|------|------|---------|
| GET | `/auth/google` | — | Start Google OAuth |
| GET | `/auth/google/callback` | — | OAuth callback → sets session → `/dashboard` |
| POST | `/api/auth/telegram` | — | Telegram Login Widget |
| POST | `/api/auth/telegram-webapp` | — | Telegram Mini App auth. Takes `{initData}` |
| POST | `/api/auth/logout` | — | Destroy session |
| GET | `/logout` | — | Direct-nav logout |
| GET | `/api/session` | — | Returns `{ok, user}` |
| GET | `/api/health` | — | Health check |

### Picks
| Method | Path | Auth | Purpose |
|--------|------|------|---------|
| GET | `/api/picks?groupId=` | telegramAuth | Picks with votes + group_ok |
| POST | `/api/picks` | telegramAuth | Add pick. Body: `{url, groupId, groupTitle, manualType, manualTitle, manualImageUrl}` |
| POST | `/api/vote` | telegramAuth | Cast/toggle vote. Body: `{pickId, status}` |
| GET | `/api/meta?url=` | — | Fetch metadata preview |
| GET | `/api/summary?groupId=` | telegramAuth | Summary of ok/skip/pending |
| GET | `/api/fcpicks` | telegramAuth | Latest Filmi Craft reviewed picks |

### Groups
| Method | Path | Auth | Purpose |
|--------|------|------|---------|
| GET | `/api/groups` | — | All real groups |
| GET | `/api/groups/mine` | requireWebAuth | User's squads |
| POST | `/api/groups/create` | requireWebAuth | Create Google squad |
| PATCH | `/api/groups/:id/rename` | requireWebAuth | Rename squad |
| DELETE | `/api/groups/:id` | requireWebAuth | Delete group |
| GET | `/api/groups/:id/members` | requireWebAuth | List members |
| DELETE | `/api/groups/:id/members/:memberId` | requireWebAuth | Remove member |
| PATCH | `/api/groups/:id/members/:memberId/role` | requireWebAuth | Set role. Owner only. |
| POST | `/api/groups/link-telegram` | requireWebAuth | Link Telegram group |
| POST | `/api/groups/invite` | requireWebAuth | Invite by email |
| GET | `/api/groups/accept-invite/:token` | — | Accept invite |
| GET | `/api/groups/:id/channels` | requireWebAuth | List YouTube channels |
| POST | `/api/groups/:id/channels` | requireWebAuth | Add channel. Body: `{channelId, channelName, channelUrl}` |
| DELETE | `/api/groups/:id/channels/:channelId` | requireWebAuth | Remove channel |

### Trending
| Method | Path | Auth | Purpose |
|--------|------|------|---------|
| GET | `/api/trending/streaming?region=` | — | Netflix + Prime |
| GET | `/api/trending/tmdb?category=` | — | TMDB popular |
| GET | `/api/trending/places?region=` | — | Places by region |
| GET | `/api/trending/events?region=` | — | Events from DB |
| GET | `/api/trending/events/nearby?lat=&lng=&region=` | — | Live events by GPS |
| GET | `/api/trending/community` | requireWebAuth | Community picks |

### Settings & Admin
| Method | Path | Auth | Purpose |
|--------|------|------|---------|
| GET | `/api/preferences` | requireWebAuth | Load notification prefs |
| POST | `/api/preferences` | requireWebAuth | Save notification prefs |
| POST | `/api/admin/scrape` | x-admin-secret | Manual scrape |

---

## 6. Link Detection & Metadata (`links.js`)

### `detectType(url)`
| Pattern | Returns |
|---------|---------|
| `themoviedb.org/movie` | `'movie'` |
| `themoviedb.org/tv` | `'show'` |
| `imdb.com/title/tt*` | `'movie'` |
| `youtube.com/watch`, `youtu.be/`, `/shorts`, `/live` | `'video'` |
| `facebook.com/events/*` | `'event'` |
| `maps.app.goo.gl`, `maps.google.com` | `'place'` |
| `yelp.com`, `zomato.com`, `swiggy.com` | `'food'` |
| `eventbrite.com`, `bookmyshow.com`, `ticketmaster.com` | `'event'` |
| `netflix.com`, `primevideo.com`, `hotstar.com` | `'show'` |
| Anything else | `'link'` |

### VOTE_LABELS
```js
movie/show: {seen:'Watched', want:'Want to watch', skip:'Not for me'}
food:       {seen:'Tried it', want:'Want to try',  skip:'Skip it'}
place:      {seen:'Been there', want:'Want to go', skip:'Not for me'}
event:      {seen:'Attended', want:'Want to go',   skip:'Not going'}
link:       {seen:'Seen', want:'Interested',        skip:'Not for me'}
```

---

## 7. Telegram Bot (`index.js`)

- Detects any URL pasted in a group or DM
- Auto-votes "want" for the user who added the pick
- Commands: `/summary`, `/pending`, `/suggest`, `/groupid`

### Key functions (v3.5)
```js
function encodeGroupId(chatId) {
  // Telegram startapp param can't have "-"
  // -1001234567890 → g1001234567890
  const s = String(chatId);
  return s.startsWith('-') ? 'g' + s.slice(1) : s;
}

function getMiniAppUrl(chatId) {
  const botUsername = process.env.BOT_USERNAME     || 'squadpicks_bot';
  const appName     = process.env.MINI_APP_SHORT_NAME || 'Squadpicks';
  return `https://t.me/${botUsername}/${appName}?startapp=${encodeGroupId(chatId)}`;
}
```

---

## 8. Full App (`public/dashboard/index.html`)

### Init Flow (v3.5)
```
1. Read ?tgInitData= or check window.Telegram.WebApp.initData
2. POST /api/auth/telegram-webapp OR GET /api/session for Google
3. If neither authed → redirect to /login
4. decodeGId(params.get('groupId')) — decode g-prefix if present
5. Also try tg.initDataUnsafe.start_param as fallback groupId source
6. currentGroupId = urlGroupId || localStorage('sp_last_group')
7. Save urlGroupId to localStorage if present
8. await loadGroups(false)
9. If urlGroupId → update dropdown, title, history to that squad
10. loadDashboard() + loadTrending()
11. goSection('dashboard')
```

```js
function decodeGId(raw) {
  if (!raw) return null;
  const s = String(raw).trim();
  return /^g\d+$/.test(s) ? '-' + s.slice(1) : s;
}
```

### Settings Section (v3.5) — YouTube Channels
New section **"📺 YouTube Channels"** added between Squads and Notifications:
- Squad selector: `#settings-yt-squad` — populated by `settingsPopulateSquadDropdown()` on `loadSettings()`
- Channel list: `#settings-yt-list` — rendered by `settingsLoadChannels(groupId)`
- Add form: `#settings-yt-input` + `+ Add` button → `settingsAddChannel()`
- Remove: per-channel ✕ button → `settingsRemoveChannel(groupId, channelRowId)`
- `settingsParseChannelInput(raw)` — parses URL / @handle / UC... channel ID

### Key JS functions added (v3.5)
```js
settingsPopulateSquadDropdown()   // fills squad select from allGroups, auto-selects currentGroupId
settingsLoadChannels(groupId)     // GET /api/groups/:id/channels → render list
settingsAddChannel()              // POST /api/groups/:id/channels
settingsRemoveChannel(gid, rowId) // DELETE /api/groups/:id/channels/:channelId
settingsParseChannelInput(raw)    // parses YouTube URL/@handle/channel ID
settingsYtErr(msg)                // shows error in #settings-yt-err
```

### Key JS State Variables
```js
let currentUser    = null;
let currentGroupId = null;
let allPicks       = [];
let allGroups      = [];
let myVotes        = {};
let dashAllGroups  = [];
let dashAllPicks   = [];
let dashFilter     = 'all';
let dashGroupId    = 'all';
window._trendItems = {};
```

### Critical Pattern: Trending Item onclick
Never use `JSON.stringify(item)` in onclick. Use `storeTrendItem(item)` → key → `window._trendItems[key]`.

---

## 9. Email System (`server.js`)

- **`sendPickNotification`** — non-blocking, after `savePick()`. Emails all active members except adder.
- **`sendInviteEmail`** — generates 32-byte hex token, valid 7 days. Link: `APP_URL/api/groups/accept-invite/{token}`

---

## 10. Scraper (`scraper.js`)

| Time (UTC) | What runs |
|-----------|-----------|
| Monday 10:00 | Netflix XLSX + TMDB poster enrichment |
| Thursday 20:30 | TMDB + Prime + TripAdvisor + Ticketmaster |
| Startup (15s delay) | Full scrape on deploy |

- Netflix: Official XLSX, `cleanNetflixTitle()` regex strips rank prefix
- TMDB: `/movie/popular`, `/tv/popular` → stored in `trending_imdb`
- Prime: TMDB watch providers, `region='us'`
- Places: TripAdvisor API or `PLACES_CURATED` static Wikimedia data
- Events: Ticketmaster (4 categories) + Insider.in for India

---

## 11. Design System

### CSS Variables
```css
--navy:#6B21A8  --blue:#7C3AED  --blue2:#8B5CF6
--beige:#F5F3FF  --beige2:#EDE9FE  --beige3:#DDD6FE
--text:#1E1333  --text2:#3B1F6B  --muted:#7C5AB8
--green:#059669  --red:#DC2626  --amber:#D97706
```

### Typography
- Headings/Logo: Fraunces (serif)
- Body/UI: DM Sans (sans-serif)

---

## 12. Environment Variables

| Variable | Required | Notes |
|----------|----------|-------|
| `TELEGRAM_TOKEN` | ✅ | From @BotFather |
| `SUPABASE_URL` | ✅ | |
| `SUPABASE_KEY` | ✅ | anon/public key |
| `YOUTUBE_API_KEY` | ✅ | YouTube Data API v3 |
| `BOT_USERNAME` | ✅ | Without @ |
| `BOT_NAME` | ✅ | Display name |
| `MINI_APP_URL` | ✅ | `https://YOUR-APP.up.railway.app` |
| `MINI_APP_SHORT_NAME` | ✅ | BotFather short name e.g. `Squadpicks` |
| `RAILWAY_PUBLIC_DOMAIN` | ✅ | Without https:// |
| `APP_URL` | ✅ | With https:// |
| `GOOGLE_CLIENT_ID` | ✅ | |
| `GOOGLE_CLIENT_SECRET` | ✅ | |
| `SESSION_SECRET` | ✅ | 32+ random chars |
| `FILMICRAFT_CHANNEL_ID` | ✅ | `UClF9UTljviumfJf7t-VR5tg` |
| `FILMICRAFT_CHANNEL_NAME` | ✅ | `Filmi Craft` |
| `ADMIN_SECRET` | ✅ | Protects `/api/admin/scrape` |
| `TMDB_API_KEY` | ✅ | v4 token starting `eyJ...` |
| `TICKETMASTER_API_KEY` | ✅ | 5000/day free tier |
| `RESEND_API_KEY` | ⚪ | 3000 emails/month |
| `RESEND_FROM_EMAIL` | ⚪ | |
| `TRIPADVISOR_API_KEY` | ⚪ | 5000/month |

---

## 13. BotFather Setup Checklist

```
/newbot        → get TELEGRAM_TOKEN
/setdomain     → YOUR-APP.up.railway.app  (no https://)
/newapp        → URL: https://YOUR-APP.up.railway.app/app
               → Short name: Squadpicks  (case-sensitive, matches MINI_APP_SHORT_NAME)
/setuserpic    → set bot avatar
```

**startapp encoding:** `-1001234567890` → `g1001234567890`. Decoded in both `app.html` and `dashboard/index.html`.

---

## 14. Deployment

```bash
# Push to GitHub → Railway auto-deploys (~60s)

# Manual scrape:
curl -X POST https://YOUR-APP.up.railway.app/api/admin/scrape \
  -H "x-admin-secret: YOUR_ADMIN_SECRET"

# Google OAuth redirect URI:
# https://YOUR-APP.up.railway.app/auth/google/callback
```

---

## 15. Known Gotchas & Bug History

| Issue | Root Cause | Fix Applied |
|-------|-----------|-------------|
| Pick posts to wrong group | `currentGroupId` was last-saved, not visible | Squad dropdown in Add Pick modal reads from UI |
| Group renamed to "SquadPicks Group" | BIGINT vs string type mismatch in ensureGroup | `Number(chatId)` cast + send `groupTitle` |
| Mini App → login page | app.html redirected before SDK populated initData | Passes `tgInitData=` in URL; dashboard reads from URL param |
| "Open Squad Picks" → wrong group | g-prefix not decoded; `urlGroupId` not used to set active tab | `decodeGId()` in init; set `currentGroupId` + update dropdown/title after `loadGroups()` |
| getMiniAppUrl sent raw negative ID | Telegram startapp can't have "-" | `encodeGroupId()` wraps `-` IDs with `g` prefix |
| Prime shows 3 cards | Wrong `week_of` in clear query | Clear ALL rows for region unconditionally |
| Prime images missing | region mismatch `ca` vs `us` | Server tries `['us','canada','ca']` in order |
| Netflix "01Thrash" | Rank column merged into title | `cleanNetflixTitle()` regex |
| Duplicate picks ignored | Checked original URL not resolved `sourceUrl` | Check BOTH urls |
| JSON.stringify in onclick | Quotes break HTML attribute | `storeTrendItem()` + `window._trendItems` |
| IMDB scraping | Cloudflare blocks Railway | All IMDB → TMDB `/find?external_source=imdb_id` |

---

## 16. Pending / Future Work

- **WhatsApp integration** — Phase 2
- **Redis session store** — replace in-memory express-session
- **Real-time votes** — WebSocket or SSE
- **iOS app** — longer term
- **Pricing enforcement** — tiers defined but not enforced
- **YouTube channel video feed** — show latest videos from group_channels via YouTube API
- **Insider.in India events** — make live per GPS

---

*End of document — v3.5, April 2026*
