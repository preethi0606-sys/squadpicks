# SquadPicks — Project Knowledge Base

*Last updated: April 2026 — v3.2. Update this doc whenever a feature is confirmed built or a design decision is locked in.*

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
4. Full Plan / Picks / Trending / Settings experience with live data

**Two completely separate post-login experiences:**
- **Telegram login** → `/app?groupId=xxx` (Mini App — Plan/Picks/Trending/Settings tabs)
- **Google login** → `/dashboard` (Full App — drawer nav, squad management, picks grid)

---

## 2. Confirmed Features

### Telegram Bot
- **Universal link detection** — TMDB, IMDB (resolved via TMDB), Letterboxd, YouTube, Google Maps (short + long URLs), Yelp, Zomato, Swiggy, Eventbrite, BookMyShow, Netflix, Hotstar, SonyLiv, Prime Video
- **Auto-type detection** — classifies into: `movie | show | food | place | event | video | link`
- **Vote cards** — bot replies directly to the user's original URL message (not a new separate message)
- **Vote labels are context-aware by type:**
  - Movie/Show → Seen/Been · Want to · Not for me
  - Food → Tried it · Want to try · Skip it
  - Place → Been there · Want to go · Not for me
  - Event → Attended · Want to go · Not going
  - Video → Seen it · Want to watch · Not for me
- **Group ok detection** — auto-detects when all voters have voted with no skips
- **Card updates** — bot edits the original Telegram message when anyone votes
- **"🚀 Open in SquadPicks" button** — always shown in every card as row 2 of inline keyboard
- **`/groupid` command** — shows current group's Telegram ID in a copyable `<code>` block + link to Full App. In private chat: shows user's own chat ID.
- **Typing indicator** — `sendChatAction('typing')` while fetching metadata; no intermediate message

### Link Detection & Metadata (`links.js`)

| URL pattern | Detected type | Metadata source |
|-------------|--------------|-----------------|
| `themoviedb.org/movie/*` | movie | TMDB API by ID |
| `themoviedb.org/tv/*` | show | TMDB API by ID |
| `imdb.com/title/tt*` | movie | TMDB `/find` by IMDB ID |
| `youtube.com/watch`, `youtu.be/`, `/shorts`, `/live` | video | YouTube oEmbed API (free, no key) |
| `maps.app.goo.gl`, `maps.google.com`, `goo.gl/maps` | place | Redirect-follow + place name extraction |
| `letterboxd.com` | movie | ogs |
| `netflix.com`, `primevideo.com`, `hotstar.com`, `sonyliv.com` | show | ogs |
| `yelp.com`, `zomato.com`, `swiggy.com`, `opentable.com`, `doordash.com`, `ubereats.com` | food | ogs |
| `tripadvisor.com` | place | ogs |
| `eventbrite.com`, `bookmyshow.com`, `meetup.com`, `ticketmaster.com` | event | ogs |
| Everything else | link | ogs |

**YouTube oEmbed** — `fetchYoutubeMeta(url)`: calls `youtube.com/oembed?url=...&format=json`. Free, no key, returns title + channel + thumbnail. ogs is blocked by YouTube consent walls.

**Google Maps** — `fetchGoogleMapsMeta(url)`: follows redirect chain (`maps.app.goo.gl` is multi-hop). Extracts place name from: `/maps/place/Name/` path → `?q=Name` param → `og:title` scrape. Always returns something.

**TMDB functions:**
- `fetchTmdbByUrl(url)` — direct `themoviedb.org` links, fetches full details by ID
- `fetchTmdbByImdbId(imdbId)` — IMDB URLs, calls `/find?external_source=imdb_id`
- `fetchTmdbByTitle(title, type)` — title search for scraper enrichment. `type` = `'movie' | 'tv' | 'multi'`

**IMDB** — detected and handled via TMDB. No web scraping of IMDB. "Movie on IMDB" fallback string is gone.

### URL & Image Retention
- `fetchMeta()` returns `sourceUrl` (original URL), `imageUrl`, `title`, `description`
- `savePick()` stores URL in `picks.url` + image in `picks.image_url`
- Plan tab: pick titles are clickable links (↗). Picks tab: real thumbnail; emoji fallback.

### Authentication
- **Telegram login:** Hash verification → `req.session.save()` → redirect to `/app?groupId=xxx`
- **Google OAuth:** Native fetch (no Passport.js) → `/auth/google` → callback → `/dashboard`. `applyPendingInvites()` on every login.
- **Session:** `trust proxy: 1`, `secure: true`, `sameSite: 'none'` in production. Logout clears both `connect.sid` and `tg_user_id` cookies.
- **Route guards:** `/dashboard` → requires session; Telegram session → redirects to `/app`. `/login` → already-authenticated users skip to correct destination.

### Google Squads & Squad Management

**Squad types:**
- **Google Squad** (`is_web_group = true`) — created in Full App, managed in-app, invite by Gmail
- **Telegram Squad** (`is_web_group = false`) — linked Telegram group where bot is active; ID found via `/groupid`

**My Squads panel (3 tabs):** 📋 My Squads (list + manage) · 🌐 New Google Squad · 💬 Link Telegram (multiple groups supported, shows already-linked list)

**Squad detail:** rename (owner) · invite by Gmail · members list with remove · delete squad (cascades to picks)

### Add Pick — Full App
- Category buttons: 🎬 Movie · 📺 Show · 🍽 Restaurant · 📍 Place · 🎭 Event · 🔗 Other
- URL field: auto-fetches title + image via `GET /api/meta?url=` (700ms debounce)
- Title field: auto-filled, editable
- Preview strip: thumbnail + title + description
- `POST /api/picks` accepts `manualType` and `manualTitle`

### Trending Page

**Movies section:**
- **Netflix Top 10** — from official XLSX (`netflix.com/tudum/top10/data/all-weeks-global.xlsx`), Monday cron. Canada + US + India. TMDB poster enrichment.
- **Prime Video** — TMDB discover `/discover/tv` + `/discover/movie` with `with_watch_providers=9`. Cross-checked against `/watch/providers` per item for accuracy.
- **TMDB Popular** — `/movie/popular` + `/tv/popular` updated daily. Stored in `trending_imdb` table.

**Events section:** Ticketmaster Discovery API for Canada + US. Insider.in for India. **Auto-detects user GPS location** (`navigator.geolocation`) — no dropdown. Falls back to: Toronto (CA), San Francisco (US), New Delhi (IN) based on `navigator.language`. India always uses Insider.in data.

**Places section:** TripAdvisor Content API (`TRIPADVISOR_API_KEY`) for live nearby attractions by lat/lng. Falls back to curated static lists for all 3 regions. Region inferred from `navigator.language`.

**"+ Add" button:** Stores items in `window._trendItems` map (avoids `JSON.stringify` in onclick attributes which breaks on quotes). `addTrendPickDirect(itemId)` adds directly to the selected squad via `POST /api/picks`, updates Picks and Plan tabs immediately.

---

## 3. Tech Stack

| Layer | Technology |
|-------|-----------|
| Runtime | Node.js 20+ |
| Bot framework | node-telegram-bot-api v0.66 |
| Web server | Express v5 |
| Database | Supabase (PostgreSQL) via @supabase/supabase-js |
| Deployment | Railway (nixpacks, auto-deploy from GitHub) |
| Movie/TV database | **TMDB API** (primary — replaces IMDB scraping and OMDB) |
| Web scraping | node-fetch v3 + cheerio |
| Cron jobs | node-cron v4 |
| YouTube API | googleapis v171 (channel monitoring) |
| YouTube metadata | YouTube oEmbed API (free, no key) |
| Link metadata | open-graph-scraper v6 (non-TMDB/YouTube/Maps URLs) |
| Netflix data | Official XLSX — `netflix.com/tudum/top10` |
| Events (CA/US) | Ticketmaster Discovery API (free, 5000/day) |
| Events (India) | Insider.in public API (free, no key) |
| Places | TripAdvisor Content API (free, 5000/month) — falls back to curated static |
| Sessions | express-session v1.18 |
| Google OAuth | Native fetch — no Passport.js |
| Mini App | Vanilla HTML/CSS/JS (`public/app.html`) |
| Full App | Vanilla HTML/CSS/JS (`public/dashboard/index.html`) |
| Fonts | Fraunces (serif, headings) + DM Sans (body) via Google Fonts |

---

## 4. Project File Structure

```
squadpicks-bot/
│
├── index.js          — Bot: commands, handleLink, cron wiring, server start
├── server.js         — Express API, Google OAuth, session, all routes
├── db.js             — All Supabase queries (two-query pattern, no FK joins)
├── links.js          — detectType, fetchMeta, TMDB functions, YouTube oEmbed, Google Maps
├── youtube.js        — YouTube channel monitor (Friday cron)
├── digest.js         — Sunday weekly digest cron
├── scraper.js        — Netflix XLSX + TMDB popular + Prime + TripAdvisor + Ticketmaster/Insider
├── streaming.js      — Static fallback streaming data
│
├── database.sql      — Full Supabase schema + migrations
├── package.json      — node-fetch ^3.3.2 (must be v3 for dynamic import() syntax)
├── package-lock.json — Required for Railway npm ci / npm install
├── railway.toml      — builder = nixpacks, buildCommand = npm install
├── Procfile          — web: node index.js
├── .env.example      — all env vars documented
│
└── public/
    ├── app.html              — Telegram Mini App
    ├── dashboard/index.html  — Full App (Google login)
    ├── login.html            — Google + Telegram login
    ├── index.html            — Landing page
    └── styles.css            — Shared styles
```

### Database Tables

| Table | Purpose |
|-------|---------|
| `groups` | Telegram + web groups (`is_web_group`, `owner_id`) |
| `picks` | All picks — `url`, `image_url`, `type`, `title`, `description`, `added_by_*`, `reviewer_*` |
| `votes` | Per-person votes (`pick_id`, `user_id`, `status`: seen/want/skip) |
| `posted_videos` | Dedup for YouTube videos already posted |
| `trending_netflix` | Netflix Top 10 by region + week (images from TMDB) |
| `trending_prime` | Prime Video top 10 (from TMDB discover, images from TMDB) |
| `trending_imdb` | TMDB popular movies/shows (stored here — table renamed conceptually to "tmdb_trending") |
| `trending_places` | Top attractions per region (TripAdvisor or curated static) |
| `trending_events` | Upcoming events per region (Ticketmaster/Insider) |
| `users` | Google + Telegram users (`google_id`, `telegram_id`, `email`, `name`, `avatar`) |
| `group_members` | Squad membership (`user_id`, `email`, `status`: active/invited, `invited_by`) |

**Supabase SQL needed for new tables:**
```sql
CREATE TABLE IF NOT EXISTS trending_places (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  rank INT, title TEXT, description TEXT, image_url TEXT, url TEXT,
  region TEXT, type TEXT DEFAULT 'place',
  week_of DATE, fetched_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(title, region, week_of)
);
CREATE TABLE IF NOT EXISTS trending_events (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  rank INT, title TEXT, description TEXT, image_url TEXT, url TEXT,
  region TEXT, type TEXT DEFAULT 'event',
  week_of DATE, fetched_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(title, region, week_of)
);
-- FK constraints
ALTER TABLE group_members ADD CONSTRAINT fk_group_members_groups
  FOREIGN KEY (group_id) REFERENCES groups(id) ON DELETE CASCADE;
ALTER TABLE picks ADD CONSTRAINT picks_group_id_fkey
  FOREIGN KEY (group_id) REFERENCES groups(id) ON DELETE CASCADE;
```

### API Endpoints

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/api/health` | Health check |
| GET | `/api/session` | Current session user |
| POST | `/api/auth/logout` | Destroy session + clear cookies |
| GET | `/logout` | Direct-nav logout |
| GET | `/auth/google` | Start Google OAuth |
| GET | `/auth/google/callback` | Google OAuth → `/dashboard` |
| POST | `/api/auth/telegram` | Verify Telegram widget → `/app?groupId=xxx` |
| GET | `/api/groups` | All real groups (Mini App) |
| GET | `/api/groups/mine` | User's own groups (Full App) |
| POST | `/api/groups/create` | Create Google squad |
| PATCH | `/api/groups/:id/rename` | Rename squad (owner only) |
| DELETE | `/api/groups/:id` | Delete Google squad (owner only) |
| GET | `/api/groups/:id/members` | List squad members |
| DELETE | `/api/groups/:id/members/:memberId` | Remove member (owner only) |
| POST | `/api/groups/link-telegram` | Link Telegram group (multiple supported) |
| POST | `/api/groups/invite` | Invite member by email |
| GET | `/api/meta?url=` | Metadata preview for Add Pick modal |
| GET | `/api/picks?groupId=` | Get group picks with votes |
| POST | `/api/picks` | Add pick (accepts `manualType`, `manualTitle`) |
| POST | `/api/vote` | Cast/toggle vote + update Telegram card |
| GET | `/api/summary?groupId=` | Group ok/skip/pending summary |
| GET | `/api/fcpicks` | Latest Filmi Craft reviewed picks |
| GET | `/api/trending/streaming?region=` | `{ netflix:[...], prime:[...], source }` |
| GET | `/api/trending/tmdb?category=` | TMDB popular movies/shows |
| GET | `/api/trending/imdb?category=` | Legacy alias for tmdb endpoint |
| GET | `/api/trending/places?region=` | Top places by region |
| GET | `/api/trending/events?region=` | Events by region (DB) |
| GET | `/api/trending/events/nearby?lat=&lng=&region=` | Events by GPS coordinates (live from Ticketmaster) |
| POST | `/api/admin/scrape` | Manual scrape trigger (x-admin-secret header) |

---

## 5. Design System

### Colour Palette

```css
--navy:    #6B21A8   /* Header, drawer bg, primary dark */
--blue:    #7C3AED   /* Primary buttons, active elements */
--blue2:   #8B5CF6   /* Hover / lighter accent */
--beige:   #F5F3FF   /* Page background */
--beige2:  #EDE9FE   /* Chip backgrounds, reviewer strip */
--beige3:  #DDD6FE   /* Borders, dividers */
--text:    #1E1333   /* Primary text */
--text2:   #3B1F6B   /* Secondary text */
--text3:   #7C5AB8   /* Muted text */
--white:   #FFFFFF   /* Card backgrounds */
--green:   #059669   /* Group ok badge */
--red:     #DC2626   /* Skip / danger */
--amber:   #D97706   /* Pending / want */
```

### Typography
- **Headings / logo:** Fraunces (serif, 400–900)
- **Body / UI:** DM Sans (sans-serif, 400–600)

### Component Rules
- **Pick cards** — 170px image header, gradient overlay, title + type badge float on top, vote buttons at bottom
- **Plan cards** — 72px left thumbnail, clickable title (↗), voter chips
- **Trending poster cards** — 150×220px (increased from 120×175). `object-fit:cover` for all images.
- **Wide cards** (places/events) — 210×130px image top, title + description body, Add + View buttons
- **Group ok badge** — green, shown when all voters have voted with no skips
- **"🚀 Open in SquadPicks"** — Telegram bot cards only. Never inside Mini App/Full App UI.
- **"● LIVE" badge** — green, on Trending rows when data is from DB
- **Mobile nav** — hamburger drawer on both Mini App and Full App
- **Vote labels** — content-type specific throughout all views
- **Trending items store** — `window._trendItems` map + `storeTrendItem()`. Never use `JSON.stringify` in onclick attributes.

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
| `GOOGLE_CLIENT_ID` | ✅ | Google Cloud OAuth 2.0 |
| `GOOGLE_CLIENT_SECRET` | ✅ | Google Cloud OAuth 2.0 |
| `SESSION_SECRET` | ✅ | Random 32+ char string |
| `FILMICRAFT_CHANNEL_ID` | ✅ | `UClF9UTljviumfJf7t-VR5tg` |
| `FILMICRAFT_CHANNEL_NAME` | ✅ | `Filmi Craft` |
| `ADMIN_SECRET` | ✅ | Protects `/api/admin/scrape` |
| `TMDB_API_KEY` | ✅ | TMDB Read Access Token (v4, starts `eyJ...`). https://www.themoviedb.org/settings/api |
| `TICKETMASTER_API_KEY` | ✅ | Free at https://developer.ticketmaster.com. 5000 calls/day. Required for live events (CA/US). |
| `TRIPADVISOR_API_KEY` | ⚪ Optional | Free at https://tripadvisor.com/developers. 5000 calls/month. Enhances Places tab. |
| `RAPIDAPI_KEY` | ⚪ Optional | RapidAPI streaming fallback |
| `NODE_ENV` | ⚪ Optional | `production` |

**Removed:** `OMDB_API_KEY`, `OPENTRIPMAP_API_KEY` — delete from Railway if set.

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
TICKETMASTER_API_KEY=
TRIPADVISOR_API_KEY=
NODE_ENV=production
```

---

## 7. Deployment

- **Platform:** Railway — nixpacks builder, `npm install`, `node index.js`
- **Deploy:** Push to GitHub → Railway auto-redeploys (~60s)
- **Health check:** `GET /api/health`
- **Mini App URL:** `t.me/squadpicks_bot/Squadpicks`

### Deploy checklist (first time)
1. Run `database.sql` in Supabase SQL Editor
2. Run the new table + FK constraint SQL (Section 4)
3. Set all env vars in Railway
4. Register Mini App: `/newapp` → URL: `https://YOUR-APP.up.railway.app/app` → Short name: `Squadpicks`
5. Register domain for Login Widget: `/setdomain` → `YOUR-APP.up.railway.app` (no https://)
6. Google OAuth: add redirect URI `https://YOUR-APP.up.railway.app/auth/google/callback`
7. Add yourself as Test User in Google Cloud OAuth consent screen
8. Add bot to Telegram group, paste a link to test

### Cron schedule
| Schedule | What runs |
|----------|-----------|
| Monday 10:00 UTC | Netflix XLSX download + TMDB poster enrichment |
| Thursday 20:30 UTC | Full scrape: TMDB popular + Prime provider check + TripAdvisor places + Ticketmaster/Insider events |
| Friday (configurable) | YouTube channel monitor (Filmi Craft) |
| Sunday (configurable) | Weekly digest |
| Startup (15s delay) | Always runs full scrape on deploy to ensure fresh data |

### Manual scrape trigger
```bash
curl -X POST https://YOUR-APP.up.railway.app/api/admin/scrape \
  -H "x-admin-secret: YOUR_ADMIN_SECRET"
```

---

## 8. GitHub Repo

**URL:** https://github.com/preethi0606-sys/squadpicks

---

## 9. Known Caveats & Technical Decisions

| Topic | Decision |
|-------|----------|
| **Telegram vs Google routing** | Intentionally different. Telegram → `/app`. Google → `/dashboard`. Never swap. |
| **`web_app` vs `url` in Telegram cards** | `web_app` restricted to private chats by Telegram. Group cards use `url`. |
| **Supabase FK joins** | Always two plain queries, never `select('col, table(col)')`. FK join requires schema cache — two queries always work. |
| **node-fetch v3** | Must be `^3.3.2`. Code uses `import('node-fetch')` dynamic ESM syntax (v3-only). v2 uses `require()`. |
| **`res.arrayBuffer()` not `res.buffer()`** | node-fetch v3 removed `buffer()`. Use `arrayBuffer()` + `Buffer.from()` for XLSX download. |
| **IMDB scraping** | Never done. IMDB blocks cloud IPs. All IMDB URLs resolved via TMDB `/find?external_source=imdb_id`. |
| **OMDB** | Removed. TMDB is sole movie/TV source. |
| **Prime Video data** | TMDB discover API with `with_watch_providers=9`, cross-checked per-item via `/watch/providers`. More accurate than discover alone. |
| **TMDB popular vs trending** | `/movie/popular` is the right endpoint — updated daily, reflects what people are actually watching. `/trending/week` is broader. |
| **Netflix title "01Thrash" bug** | XLSX sometimes encodes rank + title with no separator. Fixed via regex: `^\d{1,3}([A-Z].*)$` captures from uppercase letter onward. |
| **`JSON.stringify` in onclick** | Never put `JSON.stringify(obj)` in an HTML onclick attribute. Use `window._trendItems` map + `storeTrendItem()` instead. |
| **Events geolocation** | `navigator.geolocation.getCurrentPosition()` with 5s fallback timer. Denied → default city from `navigator.language`. India → always Insider.in (Ticketmaster doesn't cover India). |
| **TripAdvisor places** | Free tier (5000/month). Requires separate photo API call per location. Falls back to curated static lists when no key or quota exceeded. |
| **Startup scrape** | Runs on every deploy (15s delay) to ensure fresh data with latest code fixes. Not conditional. |
| **TMDB rate limit** | 40 req/10s on free tier. Scraper adds 300ms between calls. Prime provider check adds 120ms between per-item checks. |
| **Google Maps short URLs** | Multi-hop redirect chain. `redirect: 'follow'` required. Place name extracted from final URL path. |
| **YouTube oEmbed** | Free, no key. More reliable than ogs which gets blocked by YouTube consent walls. |
| **Session memory store** | Resets on deploy. Use connect-redis for persistence. |
| **`/api/trending/streaming` shape** | `{ netflix: [...], prime: [...], source }`. Breaking change from v1 `{ data: { all: [...] } }`. |

---

## 10. Planned / Future Features

- **WhatsApp integration** — Phase 2
- **iOS app** — longer-term
- **Pricing tier enforcement** — Free/Squad+/Community limits defined, not yet enforced
- **Per-group YouTube channels in DB** — currently browser localStorage
- **Email sending for invites** — table ready, Nodemailer/Resend not wired up
- **Redis session store** — replace in-memory express-session
- **Real-time vote updates** — WebSocket or SSE so votes appear instantly for all members
- **TMDB direct URL as primary format** — paste `themoviedb.org/movie/...` instead of IMDB

---

*End of document. Update whenever a feature is confirmed built or a design decision is locked in.*
