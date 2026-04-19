# SquadPicks — Project Knowledge Base

*Last updated: April 2026 — v2.1. Update this doc whenever a feature is confirmed built or a design decision is locked in.*

---

## 1. App Overview & Purpose

**SquadPicks** is a group activity coordination app — works via Telegram bot AND via Google login on the web. No Telegram required for web users.

**Tagline:** *"Your squad. Any plan. One bot."*

**How it works (Telegram path):**
1. Someone pastes any link (IMDB, Google Maps, Zomato, Yelp, Eventbrite, etc.) into a Telegram group
2. The bot auto-detects the type (movie / food / place / event / show) and creates a vote card
3. Squad members vote — labels are context-aware per content type
4. When nobody has vetoed, the card gets a **"Group ok"** badge — the squad has consensus
5. The **"🚀 Open in SquadPicks"** button is always present in every Telegram card, linking to the Mini App

**How it works (Google / Web path):**
1. User signs in with Google at `/login` → "Continue with Google" button
2. Creates a web group (no Telegram needed) and adds members by Gmail address
3. Adds picks and votes via the website dashboard — same experience as Telegram users
4. Full Plan / Picks / Trending views available on web

**Primary platform:** Telegram (free Bot API) + Web (Google OAuth). Mini App lives inside Telegram via the Web App feature. Marketing website served from the same Railway deployment.

---

## 2. Confirmed Features

### Telegram Bot
- **Universal link detection** — IMDB, Letterboxd, Google Maps, Yelp, Zomato, Swiggy, Eventbrite, BookMyShow, Netflix, Hotstar, SonyLiv, Prime Video
- **Auto-type detection** — classifies into: `movie | food | place | event | show | link`
- **Vote cards** — bot posts a formatted card with inline vote buttons in the group chat
- **Vote labels are context-aware by type:**
  - Movie/Show → Watched · Want to watch · Not for me
  - Food → Tried it · Willing to try · Skip it
  - Place → Been there · Want to go · Not for me
  - Event → Attended · Want to go · Not going
- **Group ok detection** — auto-detects when all voters have voted with no skips
- **Card updates** — bot edits the original Telegram message when anyone votes
- **"🚀 Open in SquadPicks" button** — always shown in every Telegram card as row 2 of the inline keyboard. Built into `buildVoteKeyboard(pickId, groupId)` in `links.js`

### URL & Image Retention (v2 fix — CONFIRMED BUILT)
- `fetchMeta()` in `links.js` now always returns `sourceUrl` (the original pasted URL) alongside `imageUrl`
- `savePick()` in `db.js` stores the original URL in the `url` column
- **Plan tab:** pick titles are now clickable `<a>` links (↗ icon) that open the source URL in a new tab
- **Picks tab:** pick cards show real thumbnail image from `image_url` DB column (165px); emoji fallback if no image
- **Picks tab:** "🔗 Open link ↗" button shown below card title linking to source URL
- `onerror` fallback on all `<img>` tags — broken images silently hide and show emoji instead

### Telegram Login (website) — Bot Domain Fix (v2 fix — CONFIRMED BUILT)
- `data-telegram-login` attribute in `login.html` is now **injected server-side at request time** from `process.env.BOT_USERNAME` — never hardcoded in the HTML file
- Fix for "Bot domain invalid" error: two things required:
  1. `BOT_USERNAME` env var must be set in Railway (server injects it)
  2. Domain must be registered with BotFather: `/setdomain` → paste Railway domain (no https://)

### Google OAuth Login (v2 — CONFIRMED BUILT)
- "Continue with Google" button on `/login` page — primary login method, shown above Telegram widget
- OAuth flow: `/auth/google` → Google consent screen → `/auth/google/callback` → session → `/dashboard`
- **No Passport.js** — implemented with native `fetch()` to exchange code and fetch Google profile
- Requires env vars: `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `APP_URL`, `SESSION_SECRET`
- Sessions managed via `express-session` (server-side, cookie sent to browser)
- Users stored in `users` Supabase table with `google_id`, `email`, `name`, `avatar`
- Error states handled: `/login?error=google_denied` and `/login?error=google_failed` show user-friendly messages

#### Google Cloud Console setup (required for Google login to work)
1. Go to `https://console.cloud.google.com`
2. Create project named `SquadPicks`
3. APIs & Services → Library → enable **Google People API**
4. APIs & Services → OAuth consent screen → External → fill App name, emails
5. Add scopes: `openid`, `email`, `profile`
6. **Add your Gmail as a test user** (required until app is published — omitting this causes "Access Denied")
7. APIs & Services → Credentials → Create OAuth 2.0 Client ID → Web application
8. Authorised redirect URI: `https://YOUR-APP.up.railway.app/auth/google/callback`
9. Copy Client ID and Client Secret → paste into Railway env vars
10. To allow all users (not just test users): OAuth consent screen → Publish App

### Web Groups (v2 — CONFIRMED BUILT)
- Google-login users can create groups via `POST /api/groups/create`
- Web groups stored in `groups` table with `is_web_group = true` flag
- Web group IDs are large negative integers (no clash with real Telegram chat IDs)
- `group_members` table tracks membership
- `GET /api/groups/mine` returns all groups for logged-in user

### Trending Page — Redesign (v2 — CONFIRMED BUILT)
- **Category filter tabs** at the top of the Trending page: 🎬 Movies · 🎭 Events · 📍 Places
  - One section visible at a time; toggled via `.on` class on `.trend-cat-section` divs
- **Movies section** contains all movie-related rows:
  - YouTube Top 10 (from subscribed channels)
  - **Netflix Top 10** — separate labelled row, red N badge, ● LIVE indicator
  - **Prime Video Top 10** — separate labelled row, blue P badge, ● LIVE indicator
  - IMDb Top Picks — from DB scraper
- **Events section** — Eventbrite top 10 (static curated Vancouver data)
- **Places section** — Zomato top 10 restaurants (static curated Vancouver data)
- Netflix and Prime are **split into separate rows** (previously mixed into one "N & P" row)

### Trending Poster Images (v2.1 — CONFIRMED BUILT)
- **All three poster render functions** now use real `image_url` from DB when available:
  - `renderImdbRow()` — shows IMDb poster image; falls back to 🎬 emoji
  - `renderStreamRow()` — shows Netflix / Prime poster image; falls back to 📺 emoji
  - `renderYTRow()` — shows YouTube / Filmi Craft thumbnail; falls back to 🎬 emoji
- Images use `position:absolute; inset:0; width:100%; height:100%; object-fit:cover` so they fill the full 120×175px poster area
- Badges (platform, rank, score) still float on top of the real image via `position:absolute`
- `onerror` handler on every `<img>` hides the image silently if it fails to load
- The `tc-poster-img` CSS has `background:var(--navy2)` as the base — visible if image is missing

### `/api/trending/streaming` — Response Shape Changed (v2 breaking change)
- **v1 shape:** `{ data: { all: [...mixed array] }, source }`
- **v2 shape:** `{ netflix: [...], prime: [...], source }` — split into separate arrays
- `app.html` `loadLiveStreamingData()` updated to read `data.netflix` and `data.prime` separately
- Fallback splits `STREAM_FALLBACK` array by `badge === 'N'` vs `badge === 'P'`

### Website — Responsive / Adaptive Layout (v2 — CONFIRMED BUILT)
- All pages fully responsive: desktop / tablet / mobile
- `styles.css` breakpoints at **900px**, **768px**, **480px**
- Mobile hamburger nav (`nav-hamburger` button + `mobile-nav` dropdown) on `index.html` and `login.html`
- Fluid typography via CSS `clamp()` for hero title and headings (`--text-hero`, `--text-h2`)
- Touch targets minimum 44px on all interactive elements
- `overflow-x: hidden` on `html, body` — no horizontal scroll
- `viewport-fit=cover` on all pages for notched device support

### Telegram Mini App (app.html)
Accessible at: `t.me/[BOT_USERNAME]/Squadpicks`

**Live API — not static HTML:**
- Reads `groupId` from Telegram `start_param` or `?startapp=` / `?groupId=` URL params
- If `groupId` present → calls `GET /api/picks?groupId=` to load real group picks from DB
- If no `groupId` → shows demo data (for browser preview / testing)
- Voting calls `POST /api/vote` to sync to DB and update Telegram card
- Adding a pick calls `POST /api/picks` which also notifies the Telegram group chat
- Trending rows call `/api/trending/streaming` and `/api/trending/imdb` on page load

**4 pages:**

| Page | Description |
|------|-------------|
| **Plan** | Squad's picks from DB, grouped by type. Filter chips: All · ✓ Group ok · ✕ Has skip · ⏳ Pending · by type. Compact card layout. **Titles are clickable links** to source URL (↗). **Thumbnails show real image** if `image_url` present. |
| **Picks** | Full pick cards with 165px thumbnail (**real image** or emoji fallback), **"🔗 Open link ↗" button**, real vote buttons synced to API, voter chips (4-char names). Add bar calls real `/api/picks` endpoint. |
| **Trending** | Category filter tabs (Movies / Events / Places). Movies: YouTube top 10 + **Netflix Top 10** (separate row) + **Prime Top 10** (separate row) + IMDb top picks. All poster cards show **real images** from DB. Events: Eventbrite. Places: Zomato. Green ● LIVE badge when data is from DB. |
| **Settings (Me)** | Squad members, notifications, YouTube channel management (Admin only), Bot settings (Admin only), Squad+ plan, Help. |

**Navigation:**
- **Bottom nav (LinkedIn-style):** Plan · Picks · ➕ · Trending · Me — purple top-border on active
- **Me tab** → goes directly to Settings page
- **Hamburger drawer** → Plan, Picks, Trending, Settings

### Website
| Route | Page |
|-------|------|
| `/` | Landing/marketing page (responsive, mobile hamburger nav) |
| `/login` | Login: Google OAuth button (primary) + Telegram Widget (secondary). Bot username injected server-side. |
| `/auth/google` | Starts Google OAuth flow |
| `/auth/google/callback` | Google OAuth callback handler |
| `/dashboard` | Squad picks dashboard |
| `/blog` | Blog |
| `/app` | Telegram Mini App |

### Pricing Tiers (defined, not yet enforced in code)
| Plan | Price | Limits |
|------|-------|--------|
| Free | $0 | Groups ≤ 6 members, 1 reviewer channel |
| Squad+ | $2.99/mo | Groups ≤ 20 members, 5 channels |
| Community | $9.99/mo | Unlimited |

---

## 3. Tech Stack

| Layer | Technology |
|-------|-----------|
| **Runtime** | Node.js 20+ |
| **Bot framework** | node-telegram-bot-api v0.66 |
| **Web server** | Express v5 |
| **Database** | Supabase (PostgreSQL) via @supabase/supabase-js |
| **Deployment** | Railway (auto-deploy from GitHub) |
| **Web scraping** | node-fetch + cheerio |
| **Cron jobs** | node-cron v4 |
| **YouTube API** | googleapis v171 |
| **Link metadata** | open-graph-scraper v6 |
| **Sessions** | express-session v1.18 |
| **Google OAuth** | Native fetch — no Passport.js |
| **Mini App** | Vanilla HTML/CSS/JS (single file: `public/app.html`) |
| **Website** | Vanilla HTML + shared `styles.css` |
| **Fonts** | Fraunces (serif, headings) + DM Sans (body) via Google Fonts |

---

## 4. Project File Structure

```
squadpicks-bot/
│
├── index.js          — Bot entry point: starts bot, wires all crons, starts server
├── server.js         — Express API + static files + Telegram auth + Google OAuth routes
├── db.js             — All Supabase queries (picks, votes, groups, users, trending)
├── links.js          — Link detection, metadata fetch (now returns sourceUrl), card formatting
├── youtube.js        — YouTube channel monitor (Friday cron)
├── digest.js         — Sunday weekly digest cron
├── scraper.js        — Thursday cron: scrapes Netflix/Prime/IMDb, stores to DB
├── streaming.js      — RapidAPI fallback for streaming data (optional)
│
├── database.sql      — Supabase schema — run once in SQL Editor (9 tables)
├── package.json      — includes express-session, node-fetch
├── Procfile          — web: node index.js
├── railway.toml      — Railway config with healthcheck /api/health
├── .node-version     — 20
├── .env.example      — template including GOOGLE_CLIENT_ID, SESSION_SECRET, APP_URL
│
└── public/
    ├── app.html          — Telegram Mini App (~1300 lines, live API-connected)
    ├── index.html        — Marketing landing page (responsive, mobile hamburger nav)
    ├── login.html        — Google OAuth button + Telegram Widget (bot username injected server-side)
    ├── styles.css        — Shared website styles + responsive breakpoints (900/768/480px)
    ├── dashboard/index.html
    └── blog/index.html
```

### Database Tables

| Table | Purpose |
|-------|---------|
| `groups` | Telegram + web groups (`is_web_group`, `owner_id` columns added in v2) |
| `picks` | All squad picks — `url` column stores source URL reliably (v2 fix) |
| `votes` | Per-person votes on each pick |
| `posted_videos` | Tracks which YouTube videos have been posted (dedup) |
| `trending_netflix` | Scraped Netflix top 10 by region + week (includes `image_url`) |
| `trending_prime` | Scraped Prime Video top 10 by region + week (includes `image_url`) |
| `trending_imdb` | Scraped IMDb top picks by category + week (includes `image_url`) |
| `users` | Google + Telegram website users (`google_id`, `telegram_id`, `email`, `name`, `avatar`) |
| `group_members` | Membership for web groups (`group_id`, `user_id`, `email`, `status`) |

### API Endpoints

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/api/health` | Health check (Railway uses this) |
| GET | `/api/picks?groupId=` | Get group picks with votes |
| POST | `/api/picks` | Add pick + notify Telegram group |
| POST | `/api/vote` | Cast/toggle vote + update Telegram card |
| GET | `/api/summary?groupId=` | Group ok/skip/pending summary |
| GET | `/api/fcpicks` | Latest Filmi Craft reviewed picks |
| POST | `/api/picks/notify` | Post/update card in Telegram group |
| GET | `/api/trending/streaming?region=canada` | Returns `{ netflix:[...], prime:[...], source }` — split in v2 |
| GET | `/api/trending/imdb?category=top_movies` | IMDb top picks from DB |
| GET | `/api/session` | Current logged-in user info |
| POST | `/api/auth/telegram` | Verify Telegram OAuth hash for website login |
| POST | `/api/auth/logout` | Destroy session |
| GET | `/auth/google` | Start Google OAuth flow |
| GET | `/auth/google/callback` | Google OAuth callback — exchanges code, upserts user, sets session |
| POST | `/api/groups/create` | Create web group (requires web session auth) |
| GET | `/api/groups/mine` | List user's groups (requires web session auth) |
| POST | `/api/admin/scrape` | Manual scrape trigger (requires `x-admin-secret` header) |

---

## 5. Design Rules & Preferences

### Colour Palette (Purple)

```css
--navy:    #6B21A8   /* Header, drawer bg */
--blue:    #7C3AED   /* Primary buttons, active elements */
--blue2:   #8B5CF6   /* Hover / lighter accent */
--sky-bg:  #EDE9FE   /* Reviewer strip, chip backgrounds */
--beige:   #F5F3FF   /* Page background */
--beige3:  #DDD6FE   /* Borders, dividers */
--text:    #1E1333   /* Primary text */
--text2:   #3B1F6B   /* Secondary text */
--text3:   #7C5AB8   /* Muted text */
--white:   #FFFFFF   /* Card backgrounds */
```

Applies to both Mini App (`app.html`) and website (`styles.css`) — shared variable names.

### Typography
- **Headings / titles / logo:** Fraunces (serif, weights 400–900)
- **Body / UI:** DM Sans (sans-serif, weights 400–600)

### Component Rules
- **Pick cards (Picks tab)** — 165px thumbnail: real `image_url` fills card if present, emoji fallback. `onerror` silently hides broken images. "🔗 Open link ↗" button below title. Voter chips + vote buttons unchanged.
- **Plan cards** — title is clickable `<a>` link with ↗ icon opening `url` in new tab. Thumbnail: real image (78px wide) if `image_url` present, emoji fallback.
- **Trending poster cards** — 120×175px portrait. All three row types (`renderImdbRow`, `renderStreamRow`, `renderYTRow`) now use real `image_url` from DB. Rank badge top-right, score bottom-right, platform badge top-left. Images use `position:absolute;inset:0;object-fit:cover` to fill the poster area.
- **Voter chips** — max 4 characters from first name. vc-1 (done) = purple tint, vc-2 (want) = sky tint, vc-3 (skip) = red tint.
- **Trending filter bar** — `trend-cat-bar` with `tcb-btn` pills. Active = navy fill. Filters `.trend-cat-section` divs by toggling `.on` class. Default active = Movies.
- **Netflix / Prime rows** — separate rows each with own platform badge and ● LIVE indicator.
- **Google login button** — white bg, 1.5px border-beige3, Google G SVG icon, hover border-blue2.
- **Mobile nav** — `nav-hamburger` (3 lines) + `mobile-nav` dropdown (fixed, navy bg, `.open` toggle).
- **"Open in SquadPicks" button** — Telegram bot cards ONLY. Never shown inside Mini App UI.
- **"● LIVE" badge** — green, appears on Trending rows when data is from database.
- **Website nav** — fixed purple nav bar matching Mini App header colour.

### UX Rules
- Trending page → default view is Movies section (filter tab pre-selected on load)
- Group ok badge = all 4+ squad members voted with no skips
- Vote labels are content-type specific throughout
- Website fully responsive — hamburger nav on mobile, fluid type, 44px touch targets

---

## 6. Environment Variables

Set all of these in Railway → Variables:

| Variable | Required | Description |
|----------|----------|-------------|
| `TELEGRAM_TOKEN` | ✅ | From @BotFather /newbot |
| `SUPABASE_URL` | ✅ | Supabase project URL |
| `SUPABASE_KEY` | ✅ | Supabase anon/public key |
| `YOUTUBE_API_KEY` | ✅ | Google Cloud Console → YouTube Data API v3 |
| `BOT_USERNAME` | ✅ | Bot username without @ (e.g. `squadpicks_bot`) — injected into login.html at serve time |
| `BOT_NAME` | ✅ | Display name (e.g. `SquadPicks`) |
| `MINI_APP_URL` | ✅ | `https://YOUR-APP.up.railway.app` |
| `MINI_APP_SHORT_NAME` | ✅ | BotFather short name e.g. `Squadpicks` — case-sensitive |
| `RAILWAY_PUBLIC_DOMAIN` | ✅ | `YOUR-APP.up.railway.app` (no https://) |
| `APP_URL` | ✅ | `https://YOUR-APP.up.railway.app` (with https://) — used by Google OAuth redirect |
| `GOOGLE_CLIENT_ID` | ✅ | From Google Cloud Console OAuth 2.0 credentials |
| `GOOGLE_CLIENT_SECRET` | ✅ | From Google Cloud Console OAuth 2.0 credentials |
| `SESSION_SECRET` | ✅ | Any random 32+ char string for express-session |
| `FILMICRAFT_CHANNEL_ID` | ✅ | `UClF9UTljviumfJf7t-VR5tg` |
| `FILMICRAFT_CHANNEL_NAME` | ✅ | `Filmi Craft` |
| `ADMIN_SECRET` | ✅ | Any string — protects `/api/admin/scrape` |
| `RAPIDAPI_KEY` | ⚪ Optional | RapidAPI streaming fallback (100 free req/day) |
| `NODE_ENV` | ⚪ Optional | `production` |

### Quick-copy template for Railway Raw Editor
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
NODE_ENV=production
```

---

## 7. Deployment

- **Platform:** Railway (railway.app)
- **Live URL:** `https://squadpicks-production.up.railway.app` (or your custom domain)
- **Deploy method:** Push to GitHub → Railway auto-redeploys (~60 seconds)
- **Health check:** `GET /api/health`
- **Mini App URL:** `t.me/squadpicks_bot/Squadpicks`
- **Node version:** 20+ (`.node-version` + `package.json engines`)
- **Start command:** `node index.js` (via Procfile)

### First deploy checklist
1. Run `database.sql` in Supabase SQL Editor (includes `users` and `group_members` tables)
2. Set all env vars in Railway (including `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `SESSION_SECRET`, `APP_URL`)
3. Register Mini App with BotFather: `/newapp` → Web App URL: `https://YOUR-APP.up.railway.app/app` → Short name: `Squadpicks`
4. **Register domain with BotFather for Telegram Login Widget:** `/setdomain` → paste `YOUR-APP.up.railway.app` (no https://) — fixes "Bot domain invalid"
5. Set up Google OAuth in Google Cloud Console (see Section 2 → Google OAuth Login for full steps)
6. Add bot to your Telegram group
7. Paste any link in the group to test the full flow

### Updating an existing deployment (v1 → v2)
Run in Supabase SQL Editor to add new columns/tables without losing data:
```sql
ALTER TABLE groups ADD COLUMN IF NOT EXISTS is_web_group BOOLEAN DEFAULT FALSE;
ALTER TABLE groups ADD COLUMN IF NOT EXISTS owner_id UUID;

CREATE TABLE IF NOT EXISTS users (
  id          UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  telegram_id BIGINT  UNIQUE,
  google_id   TEXT    UNIQUE,
  email       TEXT,
  name        TEXT,
  avatar      TEXT,
  updated_at  TIMESTAMPTZ DEFAULT NOW(),
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS group_members (
  id         UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  group_id   BIGINT NOT NULL,
  user_id    UUID REFERENCES users(id),
  email      TEXT,
  status     TEXT DEFAULT 'active',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(group_id, user_id)
);
```

### Manual scrape trigger (anytime)
```bash
curl -X POST https://YOUR-APP.up.railway.app/api/admin/scrape \
  -H "x-admin-secret: YOUR_ADMIN_SECRET"
```

---

## 8. GitHub Repo

**Repo URL:** https://github.com/preethi0606-sys/squadpicks

---

## 9. Known / Planned Future Features

### Discussed but not yet built
- **WhatsApp integration** — Phase 2 after Telegram launch
- **iOS app** — longer-term expansion
- **Enforce pricing tiers in code** — Free/Squad+/Community limits defined but not yet enforced
- **Per-group YouTube channels in DB** — currently stored in browser localStorage; should move to `group_channels` Supabase table so preferences persist across devices
- **Real Zomato/Eventbrite API integration** — Places and Events rows are currently static curated Vancouver lists; intended to become live API data
- **Email invites for web groups** — `group_members` table has `email` and `status` columns ready; email sending (Nodemailer/Resend) not yet implemented
- **Dedicated web dashboard for Google users** — `/dashboard` currently serves the Telegram Mini App shell; a proper web dashboard showing web group picks for Google-login users is planned

### Known caveats & technical decisions
- **`web_app` vs `url` button in Telegram group cards** — Telegram restricts `web_app` button type to private chats only. Group cards use `url` type. Intentional, not a bug.
- **`/api/trending/streaming` response shape changed in v2** — v1 returned `{ data: { all: [...] } }`. v2 returns `{ netflix: [...], prime: [...] }`. The `app.html` loader is updated. Any other clients consuming this endpoint must be updated.
- **Bot domain invalid error** — two causes: (a) `BOT_USERNAME` env var not set — server now injects it into `login.html` at request time; (b) domain not registered with BotFather via `/setdomain`. Both must be fixed.
- **Google "Access Denied" error** — caused by not adding your Gmail as a test user in the OAuth consent screen. Until the app is Published in Google Cloud Console, only listed test users can sign in.
- **Google OAuth requires HTTPS** — Google will not allow `http://` redirect URIs in production. Use Railway's domain. For local dev, add `http://localhost:3000/auth/google/callback` as an allowed redirect URI in your OAuth client.
- **express-session in Railway** — sessions stored in memory by default. On Railway, sessions reset on each deploy. For production persistence, add a Redis store (`connect-redis`) or use Supabase for session storage. For low-traffic use, in-memory is fine.
- **Trending images require scraper to have run** — `image_url` in `trending_netflix`, `trending_prime`, `trending_imdb` tables is only populated after the Thursday scraper cron runs. On a fresh deploy, trigger manually: `POST /api/admin/scrape`.
- **Scraper resilience** — Netflix, Prime, and IMDb use heavy client-side rendering. Scraper uses 4-layer fallback (JSON-LD → embedded state JSON → HTML selectors → link parsing) and never crashes the bot. If 0 titles are scraped, existing DB data is preserved.
- **Netflix `tudum/top10` is the official source** — this URL publishes Netflix's own official weekly top 10 rankings, not the main netflix.com.
- **Prime Video Canada only** — only `primevideo.com/collection/SVODTop10` (Canada) is scraped. India Prime removed by design.
- **First-deploy auto-scrape** — on a fresh deploy with an empty database, the scraper runs automatically 12 seconds after startup so the Trending page has data immediately.

---

*End of document. Update whenever a feature is confirmed built or a design decision is locked in.*

---

## 10. v2.2 Bug Fixes & Features (April 2026)

### Bug Fix: Google login redirects back to login page
- **Root cause:** Two issues combined:
  1. `express-session` cookie was not persisting on Railway because `sameSite` was not set — Railway uses a reverse proxy and the cookie was being dropped
  2. Dashboard was checking `localStorage` for Telegram user instead of the server session
- **Fix in `server.js`:** Added `app.set('trust proxy', 1)` and `sameSite: 'none'` (prod) / `'lax'` (dev) to the session cookie config
- **Fix in `dashboard/index.html`:** Init now calls `GET /api/session` first. If server session exists (Google or Telegram), it uses that. Falls back to `localStorage` for legacy Telegram users. Redirects to `/login` (not `/login.html`) only if neither exists.

### Bug Fix: Netflix/Prime/IMDb data not showing / images missing
- **Root cause:** DB region key mismatch — Netflix data scraped as `'canada'` but Prime as `'ca'`; no fallback tried other variants
- **Fix in `server.js`:** `/api/trending/streaming` now tries multiple region variants in sequence (`['canada','ca','us']` for Netflix, `['ca','canada']` for Prime) until it finds data
- **IMDb images:** Already fixed in v2.1 — `renderImdbRow`, `renderStreamRow`, `renderYTRow` all use `image_url` from DB. Images only appear after the Thursday scraper cron runs. Trigger manually: `POST /api/admin/scrape`

### Bug Fix: IMDB URL not capturing movie name/image correctly
- **Root cause:** `open-graph-scraper` is blocked by IMDB's bot protection — returns empty or generic titles
- **Fix in `links.js`:** Added `fetchImdbMeta()` — a dedicated IMDB scraper using `node-fetch` + `cheerio` that fetches the page directly with browser headers. Extraction uses 3-layer fallback:
  1. `<script type="application/ld+json">` JSON-LD structured data (most reliable — includes title, image, year, rating)
  2. `<meta property="og:*">` tags (strips "- IMDb" suffix from title)
  3. DOM selectors (`[data-testid="hero__pageTitle"]`, `img.ipc-image`, etc.)
- `fetchMeta()` now routes IMDB URLs to `fetchImdbMeta()` first before trying ogs
- Scraped `title`, `image_url`, `year`, `rating` are all stored in the pick record

### New Feature: My Squads panel (Google users)
- Dashboard nav now has a **"My Squads"** link (desktop + mobile hamburger)
- Opens a panel with three tabs:
  - **+ New squad** — create a web group by name (no Telegram needed)
  - **🔗 Link Telegram** — paste a Telegram group ID to link it to your Google account. Group must already have the SquadPicks bot. Find ID by adding @userinfobot to your group.
  - **✉️ Invite members** — add people to a squad by Gmail address. If they already have an account they are added immediately. If not, their invite is saved and they auto-join when they sign in with Google.
- New server endpoints: `POST /api/groups/link-telegram`, `POST /api/groups/invite`
- New DB functions: `getUserByEmail()`, `addPendingInvite()`, `applyPendingInvites()`
- `applyPendingInvites()` is called in the Google OAuth callback — invited users auto-join all pending squads on first login

### New DB migrations (v2.2 — run in Supabase SQL Editor)
```sql
ALTER TABLE group_members ADD COLUMN IF NOT EXISTS invited_by UUID REFERENCES users(id);
ALTER TABLE group_members ALTER COLUMN user_id DROP NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_group_members_group_email
  ON group_members(group_id, email) WHERE email IS NOT NULL;
```

### Dashboard improvements
- Shows 🌐 prefix for web groups, 💬 prefix for Telegram groups in the group selector
- Empty state now shows "Create a squad" button when user has no groups
- `loadGroups()` merges both web groups (`/api/groups/mine`) and Telegram groups (`/api/groups`) into one unified list
- Mobile hamburger nav added to dashboard
- All API calls use `currentUser` from session — no more `localStorage` dependency for Google users
