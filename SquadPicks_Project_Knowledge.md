# SquadPicks — Project Knowledge Base

*Last updated: April 2026 — v3.1. Update this doc whenever a feature is confirmed built or a design decision is locked in.*

---

## 1. App Overview & Purpose

**SquadPicks** is a group activity coordination app — works via Telegram bot AND via Google login on the web. No Telegram required for web users.

**Tagline:** *"Your squad. Any plan. One bot."*

**How it works (Telegram path):**
1. Someone pastes any link (TMDB, IMDB, Google Maps, Zomato, YouTube, Eventbrite, etc.) into a Telegram group
2. The bot auto-detects the type (movie / show / food / place / event / video) and creates a vote card
3. Squad members vote — labels are context-aware per content type
4. When nobody has vetoed, the card gets a **"Group ok"** badge
5. The **"🚀 Open in SquadPicks"** button opens the Mini App with the group pre-loaded

**How it works (Google / Full App path):**
1. User signs in with Google at `/login` → "Continue with Google" button
2. Creates a Google squad or links a Telegram group via "My Squads"
3. Adds picks with category selection and votes via the Full App at `/dashboard`
4. Full Plan / Picks / Trending / Settings experience

**Two completely separate post-login experiences:**
- **Telegram login** → `/app?groupId=xxx` (Mini App — Plan/Picks/Trending/Settings tabs)
- **Google login** → `/dashboard` (Full App — drawer nav, squad management, picks grid)

---

## 2. Confirmed Features

### Telegram Bot

- **Universal link detection** — TMDB, IMDB (resolved via TMDB), Letterboxd, YouTube, Google Maps (short + long URLs), Yelp, Zomato, Swiggy, Eventbrite, BookMyShow, Netflix, Hotstar, SonyLiv, Prime Video
- **Auto-type detection** — classifies into: `movie | show | food | place | event | video | link`
- **Vote cards** — bot replies directly to the user's original URL message (not a separate new message)
- **Vote labels are context-aware by type:**
  - Movie/Show → Seen/Been · Want to · Not for me
  - Food → Tried it · Want to try · Skip it
  - Place → Been there · Want to go · Not for me
  - Event → Attended · Want to go · Not going
  - Video → Seen it · Want to watch · Not for me
- **Group ok detection** — auto-detects when all voters have voted with no skips
- **Card updates** — bot edits the original Telegram message when anyone votes
- **"🚀 Open in SquadPicks" button** — always shown in every card as row 2 of inline keyboard
- **`/groupid` command** — shows the current group's Telegram ID in a copyable `<code>` block with a link to the Full App. In private chat: shows user's own chat ID with explanation.
- **Typing indicator** — shows `sendChatAction('typing')` while fetching metadata instead of a "Reading link..." message

### Link Detection & Metadata (`links.js`)

**Supported URL types and handlers:**

| URL pattern | Type | Metadata source |
|-------------|------|-----------------|
| `themoviedb.org/movie/*` | movie | TMDB API by ID |
| `themoviedb.org/tv/*` | show | TMDB API by ID |
| `imdb.com/title/tt*` | movie | TMDB `/find` by IMDB ID |
| `youtube.com/watch`, `youtu.be/`, `/shorts`, `/live` | video | YouTube oEmbed API (free, no key) |
| `maps.app.goo.gl`, `maps.google.com`, `goo.gl/maps` | place | Redirect follow + place name extraction |
| `letterboxd.com` | movie | ogs |
| `netflix.com`, `primevideo.com`, `hotstar.com`, `sonyliv.com` | show | ogs |
| `yelp.com`, `zomato.com`, `swiggy.com`, `opentable.com`, `doordash.com`, `ubereats.com` | food | ogs |
| `tripadvisor.com` | place | ogs |
| `eventbrite.com`, `bookmyshow.com`, `meetup.com`, `ticketmaster.com` | event | ogs |
| Everything else | link | ogs |

**YouTube oEmbed** — `fetchYoutubeMeta(url)`:
- Calls `youtube.com/oembed?url=...&format=json` — no API key needed, always works for public videos
- Returns exact video title, channel name (`by Channel Name`), and thumbnail URL
- Why not ogs: YouTube blocks server-side scrapers with consent/cookie walls

**Google Maps** — `fetchGoogleMapsMeta(url)`:
- `maps.app.goo.gl` is a multi-hop redirect — follows the chain with `redirect: 'follow'`
- Extracts place name using 3 strategies in order: `/maps/place/Name/` path → `?q=Name` param → `og:title` from page HTML
- Always returns something — minimum is `"Google Maps location"`
- No image (Maps Static API requires a billing-enabled key) — emoji fallback used

**TMDB** — primary movie/show database:
- `fetchTmdbByUrl(url)` — for direct `themoviedb.org` links, fetches by TMDB movie/tv ID
- `fetchTmdbByImdbId(imdbId)` — for IMDB URLs, calls TMDB `/find?external_source=imdb_id`
- `fetchTmdbByTitle(title, type)` — for scraper poster enrichment, searches by title. `type` = `'movie' | 'tv' | 'multi'`
- All use `Bearer ${TMDB_API_KEY}` auth header

**IMDB** — still detected and supported, but metadata is fetched exclusively via TMDB. No web scraping of IMDB. The string "Movie on IMDB" is completely gone — replaced by TMDB data.

### URL & Image Retention (CONFIRMED BUILT)
- `fetchMeta()` always returns `sourceUrl` (the original pasted URL)
- `savePick()` stores URL in `picks.url` column and image in `picks.image_url`
- Plan tab: pick titles are clickable links (↗) to source URL
- Picks tab: real thumbnail from `image_url`; emoji fallback if missing

### Telegram Login — Website (CONFIRMED BUILT)
- Hash verification uses SHA-256 of `TELEGRAM_TOKEN` as HMAC key
- `req.session.save()` explicitly awaited before responding
- Success: redirects to `/app?groupId=xxx`
- Error messages include exact `/setdomain` command pre-filled with user's domain

### Google OAuth Login (CONFIRMED BUILT)
- Native `fetch()` — no Passport.js
- Flow: `/auth/google` → Google consent → `/auth/google/callback` → session → `/dashboard`
- `applyPendingInvites()` called on every Google login
- Requires: `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `APP_URL`, `SESSION_SECRET`

### Session / Cookie (CONFIRMED BUILT)
- `app.set('trust proxy', 1)` — required for Railway
- `secure: true`, `sameSite: 'none'` in production
- `POST /api/auth/logout` clears both `connect.sid` and `tg_user_id` cookies
- `GET /logout` direct-navigation fallback

### Two-Path Routing (CONFIRMED BUILT)
- Telegram login → `/app?groupId=xxx` (Mini App). Never to `/dashboard`.
- Google login → `/dashboard` (Full App). Never to `/app`.
- `/dashboard` server-side guard: no session → `/login`; Telegram session → `/app`
- `/login` already-authenticated redirect: Telegram → `/app`; Google → `/dashboard`

### Google Squads & Squad Management (CONFIRMED BUILT)

**Squad types:**
- **Google Squad** (`is_web_group = true`) — created via Full App, managed fully in-app, invite by Gmail
- **Telegram Squad** (`is_web_group = false`) — linked Telegram group where bot is present, ID found via `/groupid` command

**My Squads panel (3 tabs):**
- **📋 My Squads** — lists all squads. "Manage" opens squad detail view (rename, invite, members list with remove, delete)
- **🌐 New Google Squad** — create a web squad by name
- **💬 Link Telegram** — link one or more Telegram groups by ID (starts with -100). Shows already-linked groups below the form.

**Squad detail view:**
- Editable name + Rename button (Google squads only, owner only)
- Invite member by Gmail (Google squads only)
- Members list with Remove button (owner only)
- Delete squad with confirmation (Google squads only, irreversible, cascades to picks)

**Settings page rows:** My Squads (manage), New Google Squad, Link Telegram Group — each opens correct panel tab.

### Add Pick — Full App (CONFIRMED BUILT)
- Category buttons: 🎬 Movie · 📺 Show · 🍽 Restaurant · 📍 Place · 🎭 Event · 🔗 Other
- URL field — paste any URL for auto title + image fetch (700ms debounce, calls `GET /api/meta?url=`)
- Title field — auto-filled from URL fetch, can be typed manually
- Preview strip — shows thumbnail + title + description after URL fetch
- Auto-detect category from URL (`detectTypeFromUrl()` in Full App JS)
- `POST /api/picks` accepts `manualType` and `manualTitle` to override auto-detection

### Trending Page (CONFIRMED BUILT)
- **Category filter tabs:** 🎬 Movies · 🎭 Events · 📍 Places
- **Movies section:** Netflix Top 10 (per region) + Prime Video Top 10 + IMDb chart picks — all with TMDB poster images
- **Events section:** Eventbrite top 10 (static curated Vancouver)
- **Places section:** Zomato top 10 restaurants (static curated Vancouver)
- `/api/trending/streaming` returns `{ netflix: [...], prime: [...], source }` — v2 shape (breaking change from v1)

### Netflix Top 10 Scraper (CONFIRMED BUILT)
- Downloads `https://www.netflix.com/tudum/top10/data/all-weeks-global.xlsx` every Monday at 10:00 UTC
- Uses `xlsx` npm package with `XLSX.read(buffer, { type: 'buffer', cellDates: true })`
- **Important:** Uses `res.arrayBuffer()` + `Buffer.from()` — NOT `res.buffer()` (node-fetch v3 breaking change)
- Filters to **Canada, United States, India** for the most recent week only
- Enriches each title with TMDB poster via `tmdbPoster(title, type)` with 300ms between calls
- Stores to `trending_netflix` via `db.upsertTrendingNetflix(rows)`
- Also runs as part of the full Thursday scrape

---

## 3. Tech Stack

| Layer | Technology |
|-------|-----------|
| **Runtime** | Node.js 20+ |
| **Bot framework** | node-telegram-bot-api v0.66 |
| **Web server** | Express v5 |
| **Database** | Supabase (PostgreSQL) via @supabase/supabase-js |
| **Deployment** | Railway (nixpacks, auto-deploy from GitHub) |
| **Movie/TV database** | TMDB API (themoviedb.org) — primary |
| **Web scraping** | node-fetch v3 + cheerio (scraper.js) |
| **Cron jobs** | node-cron v4 |
| **YouTube API** | googleapis v171 (for channel monitoring) |
| **YouTube metadata** | YouTube oEmbed API (free, no key) |
| **Link metadata** | open-graph-scraper v6 (non-TMDB/YouTube/Maps URLs) |
| **Netflix data** | Official XLSX from netflix.com/tudum/top10 |
| **Sessions** | express-session v1.18 |
| **Google OAuth** | Native fetch — no Passport.js |
| **Mini App** | Vanilla HTML/CSS/JS (`public/app.html`) |
| **Full App** | Vanilla HTML/CSS/JS (`public/dashboard/index.html`) |
| **Fonts** | Fraunces (serif, headings) + DM Sans (body) via Google Fonts |

---

## 4. Project File Structure

```
squadpicks-bot/
│
├── index.js          — Bot entry point: commands, handleLink, cron wiring, server start
├── server.js         — Express API, Google OAuth, session, all API routes
├── db.js             — All Supabase queries (no FK joins — two plain queries pattern)
├── links.js          — detectType, fetchMeta, TMDB functions, YouTube oEmbed, Google Maps
├── youtube.js        — YouTube channel monitor (Friday cron)
├── digest.js         — Sunday weekly digest cron
├── scraper.js        — Netflix XLSX + Prime Video + IMDb chart scrapers + TMDB enrichment
├── streaming.js      — Static fallback streaming data
│
├── database.sql      — Full Supabase schema + migrations
├── package.json      — node-fetch ^3.3.2 (must be v3 for dynamic import() syntax)
├── package-lock.json — Required for Railway npm ci
├── railway.toml      — builder = nixpacks, buildCommand = npm install
├── Procfile          — web: node index.js
├── .env.example      — all env vars documented
│
└── public/
    ├── app.html              — Telegram Mini App (async init, /api/session auth)
    ├── dashboard/index.html  — Full App (Google login, drawer nav, squad management)
    ├── login.html            — Google button + Telegram Widget
    ├── index.html            — Landing page
    └── styles.css            — Shared styles + responsive breakpoints
```

### Database Tables

| Table | Purpose |
|-------|---------|
| `groups` | Telegram + web groups (`is_web_group`, `owner_id`) |
| `picks` | All picks — `url`, `image_url`, `type`, `title`, `description`, `added_by_*`, `reviewer_*` |
| `votes` | Per-person votes (`pick_id`, `user_id`, `status`: seen/want/skip) |
| `posted_videos` | Dedup for YouTube videos already posted |
| `trending_netflix` | Netflix Top 10 by region + week (includes `image_url` from TMDB) |
| `trending_prime` | Prime Video Top 10 by region + week |
| `trending_imdb` | IMDb chart picks by category (titles from IMDb, images from TMDB) |
| `users` | Google + Telegram users (`google_id`, `telegram_id`, `email`, `name`, `avatar`) |
| `group_members` | Squad membership — `user_id`, `email`, `status` (active/invited), `invited_by` |

**FK constraints required in Supabase:**
```sql
ALTER TABLE group_members ADD CONSTRAINT fk_group_members_groups
  FOREIGN KEY (group_id) REFERENCES groups(id) ON DELETE CASCADE;
ALTER TABLE picks ADD CONSTRAINT picks_group_id_fkey
  FOREIGN KEY (group_id) REFERENCES groups(id) ON DELETE CASCADE;
```

### API Endpoints

| Method | Path | Auth | Purpose |
|--------|------|------|---------|
| GET | `/api/health` | — | Health check |
| GET | `/api/session` | — | Current session user |
| POST | `/api/auth/logout` | — | Destroy session + clear cookies |
| GET | `/logout` | — | Direct-nav logout fallback |
| GET | `/auth/google` | — | Start Google OAuth |
| GET | `/auth/google/callback` | — | Google OAuth callback → `/dashboard` |
| POST | `/api/auth/telegram` | — | Verify Telegram widget → `/app?groupId=xxx` |
| GET | `/api/groups` | — | All real groups (Mini App use) |
| GET | `/api/groups/mine` | session | User's own groups (Full App use) |
| POST | `/api/groups/create` | session | Create Google squad |
| PATCH | `/api/groups/:id/rename` | session | Rename squad (owner only) |
| DELETE | `/api/groups/:id` | session | Delete Google squad (owner only) |
| GET | `/api/groups/:id/members` | session | List squad members |
| DELETE | `/api/groups/:id/members/:memberId` | session | Remove member (owner only) |
| POST | `/api/groups/link-telegram` | session | Link Telegram group (supports multiple) |
| POST | `/api/groups/invite` | session | Invite member by email |
| GET | `/api/meta?url=` | — | Metadata preview for Add Pick modal |
| GET | `/api/picks?groupId=` | tg | Get group picks with votes |
| POST | `/api/picks` | tg | Add pick (accepts `manualType`, `manualTitle`) |
| POST | `/api/vote` | tg | Cast/toggle vote + update Telegram card |
| GET | `/api/summary?groupId=` | tg | Group ok/skip/pending summary |
| GET | `/api/fcpicks` | tg | Latest Filmi Craft reviewed picks |
| GET | `/api/trending/streaming?region=canada` | — | `{ netflix:[...], prime:[...], source }` |
| GET | `/api/trending/imdb?category=top_movies` | — | IMDb chart data (images from TMDB) |
| POST | `/api/admin/scrape` | x-admin-secret | Manual scrape trigger |

---

## 5. Design Rules & Preferences

### Colour Palette

```css
--navy:    #6B21A8   /* Header, drawer bg */
--blue:    #7C3AED   /* Primary buttons, active elements */
--blue2:   #8B5CF6   /* Hover / lighter accent */
--beige:   #F5F3FF   /* Page background */
--beige2:  #EDE9FE   /* Reviewer strip, chip backgrounds */
--beige3:  #DDD6FE   /* Borders, dividers */
--text:    #1E1333   /* Primary text */
--text2:   #3B1F6B   /* Secondary text */
--text3:   #7C5AB8   /* Muted text */
--white:   #FFFFFF   /* Card backgrounds */
--green:   #059669   /* Group ok */
--red:     #DC2626   /* Skip / danger */
--amber:   #D97706   /* Pending */
```

### Typography
- **Headings / logo:** Fraunces (serif, weights 400–900)
- **Body / UI:** DM Sans (sans-serif, weights 400–600)

### Component Rules
- **Pick cards (Picks tab)** — 170px thumbnail: real `image_url` fills card; emoji fallback. Title floats over image with gradient. Vote buttons at bottom.
- **Plan cards** — 72px side thumbnail: real image or emoji. Clickable title with ↗ icon.
- **Trending poster cards** — 120×175px. All use real `image_url` from TMDB.
- **Group ok badge** — green, shown when all voters have voted with no skips.
- **"🚀 Open in SquadPicks"** — Telegram bot cards only. Never inside Mini App UI.
- **"● LIVE" badge** — green, on Trending rows when data is from DB.
- **Mobile nav** — hamburger drawer in both Mini App and Full App.
- **Vote labels** — content-type specific throughout all views.

---

## 6. Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `TELEGRAM_TOKEN` | ✅ | From @BotFather /newbot |
| `SUPABASE_URL` | ✅ | Supabase project URL |
| `SUPABASE_KEY` | ✅ | Supabase anon/public key |
| `YOUTUBE_API_KEY` | ✅ | Google Cloud → YouTube Data API v3 |
| `BOT_USERNAME` | ✅ | Bot username without @ |
| `BOT_NAME` | ✅ | Display name e.g. `SquadPicks` |
| `MINI_APP_URL` | ✅ | `https://YOUR-APP.up.railway.app` |
| `MINI_APP_SHORT_NAME` | ✅ | BotFather short name e.g. `Squadpicks` |
| `RAILWAY_PUBLIC_DOMAIN` | ✅ | `YOUR-APP.up.railway.app` (no https://) |
| `APP_URL` | ✅ | `https://YOUR-APP.up.railway.app` |
| `GOOGLE_CLIENT_ID` | ✅ | Google Cloud OAuth 2.0 credentials |
| `GOOGLE_CLIENT_SECRET` | ✅ | Google Cloud OAuth 2.0 credentials |
| `SESSION_SECRET` | ✅ | Random 32+ char string |
| `FILMICRAFT_CHANNEL_ID` | ✅ | `UClF9UTljviumfJf7t-VR5tg` |
| `FILMICRAFT_CHANNEL_NAME` | ✅ | `Filmi Craft` |
| `ADMIN_SECRET` | ✅ | Protects `/api/admin/scrape` |
| `TMDB_API_KEY` | ✅ | TMDB Read Access Token (v4 auth, starts with `eyJ...`). Get at https://www.themoviedb.org/settings/api. Used for: IMDB URL metadata, Netflix/IMDb poster enrichment. |
| `RAPIDAPI_KEY` | ⚪ Optional | RapidAPI streaming fallback |
| `NODE_ENV` | ⚪ Optional | `production` |

**OMDB_API_KEY — removed.** No longer used. Delete from Railway if previously set.

### Quick-copy for Railway Raw Editor
```
TELEGRAM_TOKEN=
SUPABASE_URL=
SUPABASE_KEY=
YOUTUBE_API_KEY=
FILMICRAFT_CHANNEL_ID=UClF9UTljviumfJf7t-VR5tg
FILMICRAFT_CHANNEL_NAME=Filmi Craft
BOT_USERNAME=squadpicks_bot
BOT_NAME=SquadPicks
MINI_APP_URL=https://YOUR-APP.up.railway.app
APP_URL=https://YOUR-APP.up.railway.app
MINI_APP_SHORT_NAME=Squadpicks
RAILWAY_PUBLIC_DOMAIN=YOUR-APP.up.railway.app
GOOGLE_CLIENT_ID=
GOOGLE_CLIENT_SECRET=
SESSION_SECRET=
ADMIN_SECRET=
TMDB_API_KEY=eyJ...
NODE_ENV=production
```

---

## 7. Deployment

- **Platform:** Railway (railway.app)
- **Builder:** nixpacks (`railway.toml` → `builder = "nixpacks"`, `buildCommand = "npm install"`)
- **Deploy method:** Push to GitHub → Railway auto-redeploys (~60s)
- **Health check:** `GET /api/health`
- **Mini App URL:** `t.me/squadpicks_bot/Squadpicks`

### Deploy checklist (first time)
1. Run `database.sql` in Supabase SQL Editor
2. Run the FK constraint migrations (see Section 4)
3. Set all env vars in Railway
4. Register Mini App with BotFather: `/newapp` → URL: `https://YOUR-APP.up.railway.app/app` → Short name: `Squadpicks`
5. Register domain for Telegram Login Widget: `/setdomain` → `YOUR-APP.up.railway.app` (no https://)
6. Set up Google OAuth: add redirect URI `https://YOUR-APP.up.railway.app/auth/google/callback`
7. Add yourself as Test User in Google Cloud OAuth consent screen
8. Add bot to Telegram group, paste a link to test

### Manual scrape trigger
```bash
curl -X POST https://YOUR-APP.up.railway.app/api/admin/scrape \
  -H "x-admin-secret: YOUR_ADMIN_SECRET"
```

### Cron schedule
| Cron | Schedule | What runs |
|------|----------|-----------|
| Monday 10:00 UTC | Weekly | Netflix XLSX download + TMDB enrichment |
| Thursday 20:30 UTC | Weekly | Full scrape: Netflix + Prime + IMDb charts |
| Friday (configurable) | Weekly | YouTube channel monitor (Filmi Craft) |
| Sunday (configurable) | Weekly | Weekly digest sent to all groups |

---

## 8. GitHub Repo

**Repo URL:** https://github.com/preethi0606-sys/squadpicks

---

## 9. Known Caveats & Technical Decisions

| Topic | Decision / Caveat |
|-------|-------------------|
| **Telegram login vs Google login routing** | Intentionally different destinations. Telegram → `/app`. Google → `/dashboard`. Never swap. |
| **`web_app` vs `url` in Telegram group cards** | Telegram restricts `web_app` button type to private chats. Group cards use `url`. |
| **`/api/trending/streaming` shape** | v2: `{ netflix: [...], prime: [...] }`. v1 was `{ data: { all: [...] } }`. Breaking change. |
| **Bot domain + `/setdomain`** | Required for Telegram Login Widget. Without it: phone number prompt or "Bot domain invalid". |
| **Google "Access Denied"** | Add Gmail as Test User in Google Cloud OAuth consent screen. Required until app is Published. |
| **`trust proxy` + `sameSite: 'none'`** | Both required for Railway's HTTPS reverse proxy to pass session cookies. |
| **express-session memory store** | Sessions reset on Railway deploy. For persistence use connect-redis. |
| **Supabase FK joins** | Always use two plain queries instead of `select('col, table(col)')` join syntax. The FK join syntax requires schema cache to recognise the relationship — two plain queries always work regardless. |
| **node-fetch version** | Must be v3 (`^3.3.2`). The code uses `import('node-fetch')` dynamic ESM syntax which is v3-only. v2 is CommonJS (`require()`). |
| **`res.buffer()` vs `res.arrayBuffer()`** | node-fetch v3 removed `buffer()`. Use `res.arrayBuffer()` + `Buffer.from()` for binary responses (XLSX download). |
| **TMDB rate limit** | Free tier: 40 requests / 10 seconds. Scraper adds 300ms between TMDB calls. |
| **YouTube oEmbed** | Free, no API key, works for all public videos. Much more reliable than scraping YouTube with ogs which gets blocked by consent walls. |
| **Google Maps short URLs** | `maps.app.goo.gl` is a multi-hop redirect chain. Must use `redirect: 'follow'` with node-fetch and extract place name from final URL path/params. ogs doesn't handle this correctly. |
| **IMDB scraping** | Not done. IMDB blocks cloud IPs with Cloudflare. All IMDB URLs are resolved via TMDB's `/find?external_source=imdb_id` endpoint instead. |
| **OMDB** | Removed entirely. TMDB is the sole movie/TV metadata source. |
| **Netflix images** | Only populated after the Monday cron runs. Trigger manually with `POST /api/admin/scrape` on fresh deploy. |
| **Static Zomato/Eventbrite data** | Places and Events rows are static curated Vancouver lists. Intended to become live data. |
| **First-deploy auto-scrape** | Scraper runs automatically 12 seconds after startup if `trending_netflix` table is empty. |

---

## 10. Planned / Future Features

- **WhatsApp integration** — Phase 2
- **iOS app** — longer-term
- **Pricing tier enforcement** — Free/Squad+/Community limits defined but not yet enforced in code
- **Per-group YouTube channels in DB** — currently browser localStorage; should move to `group_channels` Supabase table
- **Live Zomato/Eventbrite API** — Places and Events currently static Vancouver data
- **Email sending for invites** — `group_members` table ready; Nodemailer/Resend not yet wired up
- **Redis session store** — replace in-memory express-session for persistence across deploys
- **TMDB direct URL as primary share format** — users could paste `themoviedb.org/movie/...` links instead of IMDB links

---

*End of document. Update whenever a feature is confirmed built or a design decision is locked in.*
