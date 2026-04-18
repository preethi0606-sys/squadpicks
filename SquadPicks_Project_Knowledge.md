# SquadPicks — Project Knowledge Base

*Last updated: April 2026 — v2 update. Update this doc whenever a feature is confirmed built or a design decision is locked in.*

---

## 1. App Overview & Purpose

**SquadPicks** is a group activity coordination app. It works via Telegram bot AND via Google login on the web — no Telegram required.

**Tagline:** *"Your squad. Any plan. One bot."*

**How it works (Telegram path):**
1. Someone pastes any link (IMDB, Google Maps, Zomato, Yelp, Eventbrite, etc.) into a Telegram group
2. The bot auto-detects the type (movie / food / place / event / show) and creates a vote card
3. Squad members vote — labels are context-aware per content type
4. When nobody has vetoed, the card gets a **"Group ok"** badge
5. The **"🚀 Open in SquadPicks"** button is always present in every Telegram card

**How it works (Google / Web path):**
1. User signs in with Google at `/login`
2. Creates a web group and adds members by Gmail address
3. Adds picks and votes via the website dashboard — same experience as Telegram users
4. No Telegram bot required

**Primary platform:** Telegram (free Bot API) + Web (Google OAuth). The Mini App lives inside Telegram via the Web App feature. There is also a marketing website served from the same Railway deployment.

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
- **"🚀 Open in SquadPicks" button** — always shown in every Telegram card as row 2 of the inline keyboard. Built into `buildVoteKeyboard(pickId, groupId)` in `links.js`.

### URL & Image Retention (v2 fix)
- `fetchMeta()` in `links.js` now always returns `sourceUrl` (the original URL) alongside `imageUrl`
- `savePick()` in `db.js` stores the original URL in the `url` column
- **Plan tab:** pick titles are now clickable links (↗) that open the source URL in a new tab
- **Picks tab:** pick cards now show the real thumbnail image (from `image_url` DB column) if available, plus an "🔗 Open link ↗" button below the card title
- Fallback: if no image, the type emoji is shown as before

### Telegram Login (website)
- `data-telegram-login` attribute in `login.html` is now **injected server-side at request time** from `process.env.BOT_USERNAME` — it is never hardcoded
- Fix for "Bot domain invalid": domain must still be registered with BotFather (`/setdomain`) pointing to your Railway domain

### Google OAuth Login (v2 new)
- Users can sign in with Google at `/login` → "Continue with Google" button
- OAuth flow: `/auth/google` → Google consent → `/auth/google/callback` → session set → `/dashboard`
- No Passport.js — uses native `fetch()` to exchange code and fetch profile from Google
- Requires `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `APP_URL`, `SESSION_SECRET` env vars
- Google setup: Google Cloud Console → APIs & Services → Credentials → OAuth 2.0 Client ID
  - Authorised redirect URI: `https://YOUR-APP.up.railway.app/auth/google/callback`
- Users stored in `users` table (Supabase) with `google_id`, `email`, `name`, `avatar`
- Sessions managed via `express-session` (stored server-side, cookie sent to browser)

### Web Groups (v2 new)
- Google-login users can create groups via `POST /api/groups/create`
- Web groups are stored in the existing `groups` table with `is_web_group = true` flag
- Web group IDs are large negative integers (no clash with real Telegram chat IDs)
- `group_members` table tracks membership for web groups
- `GET /api/groups/mine` returns all groups for the logged-in user

### Trending Page (v2 redesign)
- **Category filter tabs** at the top: 🎬 Movies · 🎭 Events · 📍 Places
  - Filters show/hide entire sections — only one section visible at a time
- **Movies section** contains all three movie-related rows:
  - YouTube Top 10 (from subscribed channels)
  - **Netflix Top 10** — separate labelled row with red N badge + ● LIVE indicator
  - **Prime Video Top 10** — separate labelled row with blue P badge + ● LIVE indicator
  - IMDb Top Picks — from DB scraper
- **Events section** — Eventbrite top 10 (static curated)
- **Places section** — Zomato top 10 restaurants (static curated)
- Netflix and Prime are now **split into separate rows** — they were previously mixed into one "N & P" row
- `/api/trending/streaming` now returns `{ netflix: [...], prime: [...], source }` (breaking change from v1 `data.all`)

### Website — Responsive / Adaptive Layout (v2 new)
- All pages now fully responsive across desktop / tablet / mobile
- `styles.css` has breakpoints at 900px, 768px, and 480px
- Mobile hamburger nav (`nav-hamburger` button + `mobile-nav` dropdown) on all website pages
- Fluid typography via CSS `clamp()` for hero title and headings
- Touch targets minimum 44px on all interactive elements
- No horizontal overflow — `overflow-x: hidden` on html/body
- `viewport-fit=cover` meta tag on all pages for notched device support

### Telegram Mini App (app.html)
Accessible at: `t.me/[BOT_USERNAME]/Squadpicks`

**Live API — not static HTML:**
- Reads `groupId` from Telegram `start_param` or `?startapp=` / `?groupId=` URL params
- If `groupId` present → calls `GET /api/picks?groupId=` to load the real group's picks from DB
- If no `groupId` → shows demo data (for browser preview / testing)
- Voting calls `POST /api/vote` to sync to database and update Telegram card
- Adding a pick calls `POST /api/picks` which also notifies the Telegram group chat
- Trending rows call `/api/trending/streaming` and `/api/trending/imdb` on page load

**4 pages:**

| Page | Description |
|------|-------------|
| **Plan** | Squad's picks from DB, grouped by type. Filter chips: All · ✓ Group ok · ✕ Has skip · ⏳ Pending · by type. Compact card layout. Titles are clickable links to source URL. Thumbnails show real image if available. |
| **Picks** | Full pick cards with 165px thumbnail (real image or emoji), "🔗 Open link ↗" button, real vote buttons (synced to API), voter chips (4-char names). Add bar calls real `/api/picks` endpoint. |
| **Trending** | Category tabs: Movies / Events / Places. Movies: YouTube top 10 + Netflix Top 10 + Prime Top 10 + IMDb top picks. Events: Eventbrite. Places: Zomato. Green ● LIVE badge when data is from DB. |
| **Settings (Me)** | Squad members, notifications, YouTube channel management (Admin only), Bot settings (Admin only), Squad+ plan, Help. |

**Navigation:**
- **Bottom nav (LinkedIn-style):** Plan · Picks · ➕ · Trending · Me — purple top-border on active
- **Me tab** → goes directly to Settings page
- **Hamburger drawer** → Plan, Picks, Trending, Settings

### Website
| Route | Page |
|-------|------|
| `/` | Landing/marketing page |
| `/login` | Login page — Telegram widget + Google OAuth button |
| `/auth/google` | Starts Google OAuth flow |
| `/auth/google/callback` | Google OAuth callback handler |
| `/dashboard` | Squad picks dashboard |
| `/blog` | Blog |
| `/app` | Telegram Mini App |

**Website colour theme** matches Mini App purple palette exactly — same CSS variables in `styles.css`.

**Login page now has two methods:**
1. **Google** — "Continue with Google" button (primary, top)
2. **Telegram** — widget (secondary, below divider)

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
| **Web scraping** | node-fetch + cheerio (already in project) |
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
├── server.js         — Express API + static files + Telegram auth + Google OAuth
├── db.js             — All Supabase queries (picks, votes, groups, users, trending)
├── links.js          — Link detection, metadata fetch, card formatting, vote keyboards
├── youtube.js        — YouTube channel monitor (Friday cron)
├── digest.js         — Sunday weekly digest cron
├── scraper.js        — Thursday cron: scrapes Netflix/Prime/IMDb, stores to DB
├── streaming.js      — RapidAPI fallback for streaming data (optional)
│
├── database.sql      — Supabase schema — run once in SQL Editor (10 tables)
├── package.json      — includes express-session dependency
├── Procfile
├── railway.toml
├── .node-version     — 20
├── .env.example      — template with all env vars including GOOGLE_CLIENT_ID
│
└── public/
    ├── app.html          — Telegram Mini App (live API-connected)
    ├── index.html        — Marketing landing page (responsive, mobile nav)
    ├── login.html        — Login: Google OAuth + Telegram Widget (bot username injected server-side)
    ├── styles.css        — Shared website styles + responsive breakpoints
    ├── dashboard/index.html
    └── blog/index.html
```

### Database Tables

| Table | Purpose |
|-------|---------|
| `groups` | Telegram groups + web-created groups (`is_web_group`, `owner_id` columns added) |
| `picks` | All squad picks with metadata — `url` column stores source URL reliably |
| `votes` | Per-person votes on each pick |
| `posted_videos` | Tracks which YouTube videos have been posted (dedup) |
| `trending_netflix` | Scraped Netflix top 10 by region + week |
| `trending_prime` | Scraped Prime Video top 10 by region + week |
| `trending_imdb` | Scraped IMDb top picks by category + week |
| `users` | Google + Telegram website users (`google_id`, `telegram_id`, `email`, `name`, `avatar`) |
| `group_members` | Membership for web groups (`group_id`, `user_id`, `email`, `status`) |

### API Endpoints

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/api/health` | Health check |
| GET | `/api/picks?groupId=` | Get group picks with votes |
| POST | `/api/picks` | Add pick + notify Telegram group |
| POST | `/api/vote` | Cast/toggle vote + update Telegram card |
| GET | `/api/summary?groupId=` | Group ok/skip/pending summary |
| GET | `/api/fcpicks` | Latest Filmi Craft reviewed picks |
| POST | `/api/picks/notify` | Post/update card in Telegram group |
| GET | `/api/trending/streaming?region=canada` | Returns `{ netflix:[...], prime:[...], source }` separately |
| GET | `/api/trending/imdb?category=top_movies` | IMDb top picks from DB |
| GET | `/api/session` | Current logged-in user info |
| POST | `/api/auth/telegram` | Verify Telegram OAuth hash for website login |
| POST | `/api/auth/logout` | Destroy session |
| GET | `/auth/google` | Start Google OAuth flow |
| GET | `/auth/google/callback` | Google OAuth callback |
| POST | `/api/groups/create` | Create web group (requires web session) |
| GET | `/api/groups/mine` | List user's groups (requires web session) |
| POST | `/api/admin/scrape` | Manual scrape trigger (requires `x-admin-secret` header) |

---

## 5. Design Rules & Preferences

### Colour Palette (Purple — matched to screenshot)

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

### Typography
- **Headings / titles / logo:** Fraunces (serif, weights 400–900)
- **Body / UI:** DM Sans (sans-serif, weights 400–600)

### Component Rules
- **Pick cards (Picks tab)** — real image thumbnail (165px) if `image_url` present; emoji fallback. "🔗 Open link ↗" button below title. Voter chips, vote buttons unchanged.
- **Plan cards** — title is now a clickable `<a>` linking to `url` with ↗ icon. Thumbnail shows real image if `image_url` present; emoji fallback.
- **Voter chips** — max 4 characters from first name. vc-1 (done) = purple tint, vc-2 (want) = sky tint, vc-3 (skip) = red tint.
- **Trending filter bar** — `trend-cat-bar` with `tcb-btn` pills. Active = purple fill. Filters `.trend-cat-section` divs by toggling `.on` class.
- **Netflix / Prime rows** — separate rows, each with platform badge and ● LIVE indicator.
- **Google login button** — white bg, 1.5px border, Google G SVG icon, hover purple border.
- **Mobile nav** — `nav-hamburger` (3 lines, white) + `mobile-nav` dropdown (fixed, purple bg). Toggled via `.open` class.
- **"Open in SquadPicks" button** — appears in **Telegram bot cards ONLY**. NOT shown inside the Mini App UI itself.
- **"● LIVE" badge** — green, appears on Trending rows when data is sourced from database.

### UX Rules
- Navigation: hamburger drawer + LinkedIn-style bottom nav only (no tab bar)
- **Me tab** on bottom nav → goes directly to Settings page
- **Trending page** → default view is Movies section (filter tab pre-selected)
- **Group ok badge** = all 4+ squad members voted with no skips
- Vote labels are content-type specific throughout
- Website is fully responsive — hamburger nav on mobile, fluid type, 44px touch targets

---

## 6. Environment Variables

Set all of these in Railway → Variables:

| Variable | Required | Description |
|----------|----------|-------------|
| `TELEGRAM_TOKEN` | ✅ | From @BotFather /newbot |
| `SUPABASE_URL` | ✅ | Supabase project URL |
| `SUPABASE_KEY` | ✅ | Supabase anon/public key |
| `YOUTUBE_API_KEY` | ✅ | Google Cloud Console → YouTube Data API v3 |
| `BOT_USERNAME` | ✅ | Bot username without @ (e.g. `squadpicks_bot`) |
| `BOT_NAME` | ✅ | Display name (e.g. `SquadPicks`) |
| `MINI_APP_URL` | ✅ | `https://YOUR-APP.up.railway.app` |
| `MINI_APP_SHORT_NAME` | ✅ | BotFather short name (e.g. `Squadpicks`) — case-sensitive |
| `RAILWAY_PUBLIC_DOMAIN` | ✅ | `YOUR-APP.up.railway.app` (no https://) |
| `APP_URL` | ✅ | `https://YOUR-APP.up.railway.app` (with https://) |
| `GOOGLE_CLIENT_ID` | ✅ | From Google Cloud Console OAuth credentials |
| `GOOGLE_CLIENT_SECRET` | ✅ | From Google Cloud Console OAuth credentials |
| `SESSION_SECRET` | ✅ | Any random 32+ char string for express-session |
| `FILMICRAFT_CHANNEL_ID` | ✅ | `UClF9UTljviumfJf7t-VR5tg` |
| `FILMICRAFT_CHANNEL_NAME` | ✅ | `Filmi Craft` |
| `ADMIN_SECRET` | ✅ | Any string — protects `/api/admin/scrape` |
| `RAPIDAPI_KEY` | ⚪ Optional | RapidAPI streaming fallback |
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
1. Run `database.sql` in Supabase SQL Editor (includes new `users` and `group_members` tables)
2. Set all env vars in Railway (including new `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `SESSION_SECRET`, `APP_URL`)
3. Register Mini App with BotFather: `/newapp` → Web App URL: `https://YOUR-APP.up.railway.app/app` → Short name: `Squadpicks`
4. **Register your domain with BotFather for Telegram Login Widget:** `/setdomain` → paste `YOUR-APP.up.railway.app` (no https://)
5. Set up Google OAuth: Google Cloud Console → APIs & Services → Credentials → Create OAuth 2.0 Client ID → add redirect URI `https://YOUR-APP.up.railway.app/auth/google/callback`
6. Add bot to your Telegram group
7. Paste any link in the group to test the full flow

### Updating an existing deployment (v1 → v2)
Run these in Supabase SQL Editor to add new columns/tables without losing existing data:
```sql
-- New tables (safe to run on existing DB)
CREATE TABLE IF NOT EXISTS users ( ... );  -- see database.sql
CREATE TABLE IF NOT EXISTS group_members ( ... );  -- see database.sql
ALTER TABLE groups ADD COLUMN IF NOT EXISTS is_web_group BOOLEAN DEFAULT FALSE;
ALTER TABLE groups ADD COLUMN IF NOT EXISTS owner_id UUID REFERENCES users(id);
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
- **Per-group YouTube channels in DB** — currently stored in browser localStorage; should move to `group_channels` Supabase table
- **Real Zomato/Eventbrite API integration** — Places and Events rows are currently static curated lists for Vancouver; intended to become live API data
- **Email invites for web groups** — `group_members` table has `email` and `status` columns ready; email sending (via Nodemailer/Resend) not yet implemented
- **Google users on dashboard** — `/dashboard` currently serves the Telegram Mini App shell; a dedicated web dashboard for Google-login users showing their web group picks is planned

### Known caveats & technical decisions
- **`web_app` vs `url` button in Telegram group cards** — Telegram restricts the `web_app` button type to private chats only. Group cards use the `url` type. This is intentional, not a bug.
- **`/api/trending/streaming` response shape changed in v2** — v1 returned `{ data: { all: [...] } }`. v2 returns `{ netflix: [...], prime: [...] }`. The `app.html` streaming loader has been updated to match. If you have any other clients consuming this endpoint, update them.
- **Bot domain invalid error** — caused by two things: (a) `BOT_USERNAME` env var not set (server now injects it into login.html at request time), and (b) domain not registered with BotFather via `/setdomain`. Both must be fixed.
- **Google OAuth requires HTTPS** — Google will not allow `http://localhost` as a redirect URI in production. Use Railway's domain or a custom domain. For local dev, use `http://localhost:3000` as the redirect URI and add it to your OAuth client's allowed URIs.
- **express-session in Railway** — sessions are stored in memory by default. On Railway, this means sessions reset on each deploy. For production persistence, add a Redis store (`connect-redis`) or use Supabase for session storage. For low-traffic use, in-memory is fine.
- **Scraper resilience** — Netflix, Prime, and IMDb all use React/Next.js with heavy client-side rendering. The scraper uses 4-layer fallback and never crashes the bot.
- **Netflix `tudum/top10` is the official source** — this URL publishes Netflix's official weekly top 10 rankings.
- **Prime Video Canada only** — `primevideo.com/collection/SVODTop10` (Canada) is scraped.
- **First-deploy auto-scrape** — on a fresh deploy with empty DB, the scraper runs automatically 12 seconds after startup.

---

*End of document. Update whenever a feature is confirmed built or a design decision is locked in.*
