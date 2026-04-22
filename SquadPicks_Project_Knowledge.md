# SquadPicks — Project Knowledge Base

*Last updated: April 2026 — v2.3. Update this doc whenever a feature is confirmed built or a design decision is locked in.*

---

## 1. App Overview & Purpose

**SquadPicks** is a group activity coordination app — works via Telegram bot AND via Google login on the web. No Telegram required for web users.

**Tagline:** *"Your squad. Any plan. One bot."*

**How it works (Telegram path):**
1. Someone pastes any link (IMDB, Google Maps, Zomato, Yelp, Eventbrite, etc.) into a Telegram group
2. The bot auto-detects the type (movie / food / place / event / show) and creates a vote card
3. Squad members vote — labels are context-aware per content type
4. When nobody has vetoed, the card gets a **"Group ok"** badge
5. The **"🚀 Open in SquadPicks"** button opens the Mini App with the group pre-loaded

**How it works (Google / Web path):**
1. User signs in with Google at `/login` → "Continue with Google" button
2. Creates a web group (no Telegram needed) and adds members by Gmail address
3. Adds picks and votes via the web dashboard — full Plan / Picks / Trending experience
4. Can also link their Telegram group to their Google account via "My Squads" panel

**Two completely separate post-login experiences:**
- **Telegram login** → redirects to `/app?groupId=xxx` (the Mini App — Plan/Picks/Trending/Me tabs)
- **Google login** → redirects to `/dashboard` (the web dashboard — picks grid, group management)

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

### IMDB Metadata Fix (v2.2 — CONFIRMED BUILT)
- `open-graph-scraper` is blocked by IMDB's bot protection — returns empty or generic "Movie on IMDB" titles
- `links.js` now has `fetchImdbMeta()` — a dedicated scraper using `node-fetch` + `cheerio` with browser headers
- Extraction uses 3-layer fallback:
  1. `<script type="application/ld+json">` JSON-LD structured data — gives title, image, year, rating in one go
  2. `<meta property="og:*">` tags — strips "- IMDb" suffix from title automatically
  3. DOM selectors — `[data-testid="hero__pageTitle"]`, `img.ipc-image`, etc.
- `fetchMeta()` now routes all `imdb.com/title/` URLs to `fetchImdbMeta()` first before trying ogs
- Movie name, poster image, year, and rating are all now captured and stored in the pick record

### URL & Image Retention (v2 — CONFIRMED BUILT)
- `fetchMeta()` always returns `sourceUrl` (the original pasted URL)
- `savePick()` stores the original URL in the `url` column
- **Plan tab:** pick titles are clickable links (↗ icon) that open the source URL in a new tab
- **Picks tab:** real thumbnail image (165px) from `image_url` DB column; emoji fallback
- **Picks tab:** "🔗 Open link ↗" button below card title

### Telegram Login — Website (CONFIRMED BUILT)
- `data-telegram-login` attribute in `login.html` is injected server-side from `process.env.BOT_USERNAME`
- Hash verification uses SHA-256 of `TELEGRAM_TOKEN` as key for HMAC — all fields except `hash`, sorted, joined with `\n`
- `req.session.save()` is explicitly awaited before responding to ensure the session is written
- After successful auth: server finds user's first group and redirects to `/app?groupId=xxx`
- Success message shows clickable "🚀 Squad Name" links per group, each going to `/app?groupId=xxx`
- If hash mismatch: error message shows the exact `/setdomain` command with the user's domain pre-filled

**Fix for "Invalid Telegram auth" error — two required steps:**
1. In @BotFather: `/setdomain` → select your bot → paste `YOUR-APP.up.railway.app` (no https://)
2. In Railway vars: `BOT_USERNAME` must exactly match your bot username without `@`

**Fix for phone number prompt instead of button:**
- Means the domain is not registered with BotFather yet — run `/setdomain` above
- Login page now shows a yellow tip box automatically if the widget appears to be in phone-entry mode
- Google sign-in works as an alternative while BotFather setup is pending

### Google OAuth Login (v2 — CONFIRMED BUILT)
- "Continue with Google" button on `/login` page — primary login method
- OAuth flow: `/auth/google` → Google consent → `/auth/google/callback` → session → `/dashboard`
- No Passport.js — native `fetch()` to exchange code and fetch Google profile
- `applyPendingInvites()` called on every Google login — auto-joins any squads the user was invited to
- Requires env vars: `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `APP_URL`, `SESSION_SECRET`

**Fix for "Access Denied" on Google login:**
1. Google Cloud Console → OAuth consent screen → add your Gmail as a **Test User**
2. Until the app is Published, only test users can sign in

### Session / Cookie Fix (v2.2 — CONFIRMED BUILT)
- `app.set('trust proxy', 1)` added — required for Railway's reverse proxy to pass cookies correctly
- Session cookie: `secure: true` (prod), `sameSite: 'none'` (prod) / `'lax'` (dev)
- `sameSite: 'none'` is required for cross-origin cookie to work on Railway's HTTPS domain

### Two-Path Post-Login Routing (v2.3 — CONFIRMED BUILT)
- **Telegram login** → `/api/auth/telegram` looks up user's first group → `redirectUrl: '/app?groupId=xxx'` → Mini App
- **Google login** → `/auth/google/callback` → `res.redirect('/dashboard')` → Web Dashboard
- These are now completely separate flows — Telegram users never see the web dashboard
- `app.html` init is now `async` — checks `GET /api/session` if no Telegram `initData` found, so web-Telegram users (who logged in via the website) get their identity and group loaded correctly
- New `GET /api/groups` public endpoint — `app.html` calls this to resolve the user's group when loaded via browser

### Web Groups & My Squads Panel (v2.2 — CONFIRMED BUILT)
- Dashboard nav has **"My Squads"** link (desktop + mobile hamburger)
- Three-tab panel:
  - **+ New squad** — create a web group by name (no Telegram needed)
  - **🔗 Link Telegram** — paste a Telegram group ID to link it to your Google account. Find the ID by adding @userinfobot to your group.
  - **✉️ Invite members** — invite by Gmail. Existing users added immediately; new users auto-join on first Google sign-in
- New endpoints: `POST /api/groups/link-telegram`, `POST /api/groups/invite`, `GET /api/groups`
- New DB functions: `getUserByEmail()`, `addPendingInvite()`, `applyPendingInvites()`

### Trending Page (v2 — CONFIRMED BUILT)
- **Category filter tabs:** 🎬 Movies · 🎭 Events · 📍 Places
- **Movies section:** YouTube Top 10 + Netflix Top 10 (separate row) + Prime Video Top 10 (separate row) + IMDb Top Picks
- **Events section:** Eventbrite top 10 (static curated Vancouver)
- **Places section:** Zomato top 10 restaurants (static curated Vancouver)
- All poster cards show real `image_url` from DB — `renderImdbRow`, `renderStreamRow`, `renderYTRow` all updated
- `/api/trending/streaming` returns `{ netflix: [...], prime: [...], source }` — split in v2 (breaking change from v1)
- Region fallback: tries `['canada','ca','us']` for Netflix, `['ca','canada']` for Prime until data found

### Telegram Mini App (app.html)
Accessible at: `t.me/[BOT_USERNAME]/Squadpicks` AND at `/app?groupId=xxx` via browser after website Telegram login

**4 pages:**

| Page | Description |
|------|-------------|
| **Plan** | Squad picks grouped by type. Titles are clickable links (↗) to source URL. Thumbnails show real image if available. |
| **Picks** | Full pick cards with 165px thumbnail (real image or emoji), "🔗 Open link ↗" button, vote buttons synced to API. |
| **Trending** | Category tabs: Movies / Events / Places. All poster cards show real images from DB. ● LIVE badge when data is from DB. |
| **Settings (Me)** | Squad members, notifications, YouTube channels (Admin), Bot settings (Admin), Squad+ plan, Help. |

### Web Dashboard (`/dashboard`)
For Google-login users only. Features:
- Picks grid with filter pills (All / I want to / Group ok / Movies / Food / Places / Events)
- Group selector showing 🌐 web groups and 💬 Telegram groups
- Stats row (Total picks / Group ok / Need my vote / From Filmi Craft)
- Add pick modal — paste any URL, server fetches metadata
- My Squads panel — create squads, link Telegram groups, invite by Gmail
- Mobile responsive with hamburger nav
- All API calls use `currentUser` from server session — no `localStorage` dependency

### Website
| Route | Description |
|-------|-------------|
| `/` | Landing page (responsive, mobile hamburger nav) |
| `/login` | Google OAuth button (primary) + Telegram Widget (bot username injected server-side) |
| `/auth/google` | Starts Google OAuth flow |
| `/auth/google/callback` | Google OAuth callback → `/dashboard` |
| `/api/auth/telegram` | Verifies Telegram widget hash → `/app?groupId=xxx` |
| `/app` | Telegram Mini App — for Telegram users (both in-app and via browser) |
| `/dashboard` | Web dashboard — for Google users |
| `/blog` | Blog |

---

## 3. Tech Stack

| Layer | Technology |
|-------|-----------|
| **Runtime** | Node.js 20+ |
| **Bot framework** | node-telegram-bot-api v0.66 |
| **Web server** | Express v5 |
| **Database** | Supabase (PostgreSQL) via @supabase/supabase-js |
| **Deployment** | Railway (auto-deploy from GitHub) |
| **Web scraping** | node-fetch + cheerio (scraper.js + fetchImdbMeta in links.js) |
| **Cron jobs** | node-cron v4 |
| **YouTube API** | googleapis v171 |
| **Link metadata** | open-graph-scraper v6 (+ dedicated IMDB scraper in links.js) |
| **Sessions** | express-session v1.18 |
| **Google OAuth** | Native fetch — no Passport.js |
| **Mini App** | Vanilla HTML/CSS/JS (`public/app.html`) |
| **Website** | Vanilla HTML + shared `styles.css` |
| **Fonts** | Fraunces (serif, headings) + DM Sans (body) via Google Fonts |

---

## 4. Project File Structure

```
squadpicks-bot/
│
├── index.js          — Bot entry point: starts bot, wires all crons, starts server
├── server.js         — Express API + Telegram auth + Google OAuth + group endpoints
├── db.js             — All Supabase queries (picks, votes, groups, users, trending, invites)
├── links.js          — Link detection, fetchMeta (with dedicated fetchImdbMeta), card formatting
├── youtube.js        — YouTube channel monitor (Friday cron)
├── digest.js         — Sunday weekly digest cron
├── scraper.js        — Thursday cron: scrapes Netflix/Prime/IMDb, stores to DB
├── streaming.js      — RapidAPI fallback + static curated data for streaming
│
├── database.sql      — Full Supabase schema (9 tables + v2.2 migrations)
├── package.json      — includes express-session, node-fetch
├── .env.example      — all env vars including GOOGLE_CLIENT_ID, SESSION_SECRET, APP_URL
│
└── public/
    ├── app.html          — Telegram Mini App (async init, checks /api/session for web users)
    ├── index.html        — Landing page (responsive, mobile hamburger nav)
    ├── login.html        — Google button + Telegram Widget + setup tips + actionable errors
    ├── styles.css        — Shared styles + responsive breakpoints (900/768/480px)
    ├── dashboard/index.html  — Web dashboard for Google users
    └── blog/index.html
```

### Database Tables

| Table | Purpose |
|-------|---------|
| `groups` | Telegram + web groups (`is_web_group`, `owner_id` added in v2) |
| `picks` | All picks — `url` column stores source URL; `image_url` stores poster/thumbnail |
| `votes` | Per-person votes on each pick |
| `posted_videos` | Tracks YouTube videos already posted (dedup) |
| `trending_netflix` | Scraped Netflix top 10 by region + week (includes `image_url`) |
| `trending_prime` | Scraped Prime Video top 10 by region + week (includes `image_url`) |
| `trending_imdb` | Scraped IMDb top picks by category + week (includes `image_url`) |
| `users` | Google + Telegram website users (`google_id`, `telegram_id`, `email`, `name`, `avatar`) |
| `group_members` | Squad membership — `user_id` (nullable for pending invites), `email`, `status`, `invited_by` |

### API Endpoints

| Method | Path | Auth | Purpose |
|--------|------|------|---------|
| GET | `/api/health` | — | Health check |
| GET | `/api/session` | — | Current session user info |
| POST | `/api/auth/logout` | — | Destroy session |
| GET | `/auth/google` | — | Start Google OAuth |
| GET | `/auth/google/callback` | — | Google OAuth callback → `/dashboard` |
| POST | `/api/auth/telegram` | — | Verify Telegram widget hash → `/app?groupId=xxx` |
| GET | `/api/groups` | — | All groups (used by app.html) |
| GET | `/api/groups/mine` | session | Groups for logged-in web user |
| POST | `/api/groups/create` | session | Create web group |
| POST | `/api/groups/link-telegram` | session | Link Telegram group to Google account |
| POST | `/api/groups/invite` | session | Invite member by email |
| GET | `/api/picks?groupId=` | tg | Get group picks with votes |
| POST | `/api/picks` | tg | Add pick + notify Telegram group |
| POST | `/api/vote` | tg | Cast/toggle vote + update Telegram card |
| GET | `/api/summary?groupId=` | tg | Group ok/skip/pending summary |
| GET | `/api/fcpicks` | tg | Latest Filmi Craft reviewed picks |
| POST | `/api/picks/notify` | tg | Post/update card in Telegram group |
| GET | `/api/trending/streaming?region=canada` | — | `{ netflix:[...], prime:[...], source }` |
| GET | `/api/trending/imdb?category=top_movies` | — | IMDb top picks from DB |
| POST | `/api/admin/scrape` | secret header | Manual scrape trigger |

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
- **Pick cards (Picks tab)** — 165px thumbnail: real `image_url` fills card; emoji fallback. "🔗 Open link ↗" button below title.
- **Plan cards** — title is clickable `<a>` with ↗ icon. Thumbnail: real image (78px) or emoji fallback.
- **Trending poster cards** — 120×175px. All three render functions use real `image_url`. Badges float on top via `position:absolute`.
- **Trending filter bar** — `trend-cat-bar` with `tcb-btn` pills. Active = navy fill. Default = Movies section.
- **Netflix / Prime rows** — separate rows each with own platform badge and ● LIVE indicator.
- **Google login button** — white bg, 1.5px border, Google G SVG icon, hover border-blue2.
- **Mobile nav** — `nav-hamburger` (3 lines) + `mobile-nav` dropdown (fixed, navy bg, `.open` toggle).
- **"Open in SquadPicks" button** — Telegram bot cards ONLY. Never shown inside Mini App UI.
- **"● LIVE" badge** — green, on Trending rows when data is from DB.

### UX Rules
- **Telegram login** → always goes to Mini App (`/app`) — never to web dashboard
- **Google login** → always goes to web dashboard (`/dashboard`) — never to Mini App
- Group ok badge = all 4+ squad members voted with no skips
- Vote labels are content-type specific throughout
- Website fully responsive — hamburger nav on mobile, fluid type, 44px touch targets

---

## 6. Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `TELEGRAM_TOKEN` | ✅ | From @BotFather /newbot |
| `SUPABASE_URL` | ✅ | Supabase project URL |
| `SUPABASE_KEY` | ✅ | Supabase anon/public key |
| `YOUTUBE_API_KEY` | ✅ | Google Cloud Console → YouTube Data API v3 |
| `BOT_USERNAME` | ✅ | Bot username without @ — must match BotFather exactly |
| `BOT_NAME` | ✅ | Display name (e.g. `SquadPicks`) |
| `MINI_APP_URL` | ✅ | `https://YOUR-APP.up.railway.app` |
| `MINI_APP_SHORT_NAME` | ✅ | BotFather short name e.g. `Squadpicks` — case-sensitive |
| `RAILWAY_PUBLIC_DOMAIN` | ✅ | `YOUR-APP.up.railway.app` (no https://) |
| `APP_URL` | ✅ | `https://YOUR-APP.up.railway.app` — used by Google OAuth |
| `GOOGLE_CLIENT_ID` | ✅ | From Google Cloud Console OAuth 2.0 credentials |
| `GOOGLE_CLIENT_SECRET` | ✅ | From Google Cloud Console OAuth 2.0 credentials |
| `SESSION_SECRET` | ✅ | Any random 32+ char string for express-session |
| `FILMICRAFT_CHANNEL_ID` | ✅ | `UClF9UTljviumfJf7t-VR5tg` |
| `FILMICRAFT_CHANNEL_NAME` | ✅ | `Filmi Craft` |
| `ADMIN_SECRET` | ✅ | Any string — protects `/api/admin/scrape` |
| `RAPIDAPI_KEY` | ⚪ Optional | RapidAPI streaming fallback |
| `NODE_ENV` | ⚪ Optional | `production` |

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
NODE_ENV=production
```

---

## 7. Deployment

- **Platform:** Railway (railway.app)
- **Deploy method:** Push to GitHub → Railway auto-redeploys (~60 seconds)
- **Health check:** `GET /api/health`
- **Mini App URL:** `t.me/squadpicks_bot/Squadpicks`
- **Node version:** 20+

### Deploy checklist (first time)
1. Run `database.sql` in Supabase SQL Editor
2. Set all env vars in Railway
3. Register Mini App with BotFather: `/newapp` → Web App URL: `https://YOUR-APP.up.railway.app/app` → Short name: `Squadpicks`
4. **Register domain with BotFather for Telegram Login Widget:** `/setdomain` → `YOUR-APP.up.railway.app` (no https://) — fixes "Bot domain invalid" and phone-number prompt
5. Set up Google OAuth: Google Cloud Console → Credentials → OAuth 2.0 Client → add redirect URI `https://YOUR-APP.up.railway.app/auth/google/callback`
6. Add yourself as a Test User in OAuth consent screen (until app is Published)
7. Add bot to your Telegram group and paste a link to test

### Upgrading existing deployment (v2.2 migrations)
Run in Supabase SQL Editor:
```sql
ALTER TABLE groups ADD COLUMN IF NOT EXISTS is_web_group BOOLEAN DEFAULT FALSE;
ALTER TABLE groups ADD COLUMN IF NOT EXISTS owner_id UUID;
CREATE TABLE IF NOT EXISTS users (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  telegram_id BIGINT UNIQUE, google_id TEXT UNIQUE,
  email TEXT, name TEXT, avatar TEXT,
  updated_at TIMESTAMPTZ DEFAULT NOW(), created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS group_members (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  group_id BIGINT NOT NULL, user_id UUID REFERENCES users(id),
  email TEXT, status TEXT DEFAULT 'active', invited_by UUID REFERENCES users(id),
  created_at TIMESTAMPTZ DEFAULT NOW(), UNIQUE(group_id, user_id)
);
ALTER TABLE group_members ALTER COLUMN user_id DROP NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_group_members_group_email
  ON group_members(group_id, email) WHERE email IS NOT NULL;
```

### Manual scrape trigger
```bash
curl -X POST https://YOUR-APP.up.railway.app/api/admin/scrape \
  -H "x-admin-secret: YOUR_ADMIN_SECRET"
```

---

## 8. GitHub Repo

**Repo URL:** https://github.com/preethi0606-sys/squadpicks

---

## 9. Known Caveats & Technical Decisions

- **Telegram login vs Google login routing** — intentionally different destinations. Telegram → `/app` (Mini App). Google → `/dashboard` (web). Never swap these.
- **`web_app` vs `url` button in Telegram group cards** — Telegram restricts `web_app` to private chats. Group cards use `url`. Intentional.
- **`/api/trending/streaming` response shape** — v1 was `{ data: { all: [...] } }`. v2+ is `{ netflix: [...], prime: [...] }`. Any client consuming this must use the new shape.
- **Bot domain invalid / phone number prompt** — run `/setdomain` in BotFather. `BOT_USERNAME` env var must match exactly. Both required for the one-click Telegram Login Widget to work.
- **Google "Access Denied"** — add your Gmail as a Test User in Google Cloud Console → OAuth consent screen. Required until app is Published.
- **Session on Railway** — `app.set('trust proxy', 1)` and `sameSite: 'none'` are both required for Railway's HTTPS proxy to pass the session cookie correctly.
- **express-session memory store** — sessions reset on each Railway deploy. For production persistence use `connect-redis` or Supabase session storage.
- **IMDB scraper** — `fetchImdbMeta()` in `links.js` uses browser headers + cheerio. Works as of April 2026. IMDB occasionally changes its DOM; if it breaks, the JSON-LD layer (layer 1) is the most resilient.
- **Trending images require scraper run** — `image_url` in trending tables only populated after the Thursday cron runs. Trigger manually with `POST /api/admin/scrape` on fresh deploy.
- **Netflix `tudum/top10`** — official Netflix top 10 source. Not the main netflix.com.
- **Prime Video Canada only** — `primevideo.com/collection/SVODTop10` (Canada). India Prime removed by design.
- **First-deploy auto-scrape** — scraper runs automatically 12 seconds after startup on a fresh empty DB.

---

## 10. Planned / Future Features

- **WhatsApp integration** — Phase 2
- **iOS app** — longer-term
- **Enforce pricing tiers in code** — Free/Squad+/Community limits defined, not yet enforced
- **Per-group YouTube channels in DB** — currently browser localStorage; should move to `group_channels` Supabase table
- **Real Zomato/Eventbrite API** — Places and Events rows are static curated Vancouver lists; intended to become live data
- **Email sending for invites** — `group_members` table ready; Nodemailer/Resend not yet wired up
- **Redis session store** — replace in-memory express-session for persistence across deploys

---

*End of document. Update whenever a feature is confirmed built or a design decision is locked in.*

---

## 11. v2.4 Bug Fixes (April 2026)

### Fix 1 & 2: Sign out not working / no sign out in Mini App
- **Root cause:** The web dashboard sign-out was only clearing `localStorage` without properly destroying the server session cookie. The Mini App (`app.html`) had no sign-out option at all.
- **Fix in `server.js`:** `POST /api/auth/logout` now explicitly calls `res.clearCookie('connect.sid')` and `res.clearCookie('tg_user_id')` in addition to `req.session.destroy()`. Added `GET /logout` route as a direct-navigation fallback.
- **Fix in `public/app.html` Settings tab:** Added an "Account" section row: **Sign out** (🚪 icon, red text). Tapping it calls `signOutApp()` which calls `POST /api/auth/logout`, clears `localStorage`, then redirects to `/login`.
- **Fix in `public/app.html` Settings tab:** Added identity card at the top of Settings showing the user's name and "Signed in via Telegram".

### Fix 3: Unauthenticated users can visit protected pages
- **Fix in `server.js` — `/dashboard` route:** Now has a server-side session guard. If no session → redirect to `/login`. If session exists but `loginType === 'telegram'` → redirect to `/app` (Telegram users should never see the web dashboard).
- **Fix in `server.js` — `/login` route:** If user already has a valid session, skip the login page and redirect directly to the right destination (`/app` for Telegram, `/dashboard` for Google).
- **Fix in `public/app.html` — init function:** Detects whether the app is running inside Telegram (`tg.initData` non-empty) or in a browser. If in browser with no session → redirects to `/login`. If in browser with session → loads user identity and groups. Removes the demo "Priya" fallback user for browser context.

### Fix 4: Google users seeing all groups including DM chats
- **Root cause:** `getAllGroups()` in `db.js` returned every row in the `groups` table — including private/DM chat IDs (positive integers) that the bot was added to for testing. Telegram group IDs are always **negative integers**; private chat IDs are **positive integers**.
- **Fix in `db.js` — `getAllGroups()`:** Added `.lt('id', 0)` filter — returns only groups with negative IDs (real Telegram groups/supergroups). DM/private chats are silently excluded.
- **Fix in `db.js` — `getUserGroups()`:** Added `.eq('status', 'active')` filter and post-filters to only return groups that are either `is_web_group = true` or have a negative ID. Pending-invite members (`status = 'invited'`) are excluded until they confirm.
- **Fix in `dashboard/index.html` — `loadGroups()`:** Google users (`loginType === 'google'`) now only call `/api/groups/mine` — they never see `getAllGroups()` results. Only groups they are explicitly an active member of are shown.

### How group IDs work
| ID range | Meaning |
|----------|---------|
| Positive (e.g. `123456789`) | Telegram private/DM chat — should NOT appear in group selectors |
| Negative (e.g. `-1001234567890`) | Real Telegram group or supergroup — correct, shows in selector |
| Large negative (e.g. `-5678901234`) | Web-created group (assigned by `createWebGroup()`) — shows in selector |

---

## 12. v2.5 — Full App Redesign & Fixes (April 2026)

### Terminology change
The Google-login experience is now called the **Full App** (was: "dashboard"). The URL `/dashboard` and file `public/dashboard/index.html` remain the same — only the UI title and conceptual name changed.

### Fix 1: Groups dropdown shows all Telegram groups for Google users
- **Root cause:** `loadGroups()` was falling back to `GET /api/groups` (which returns ALL groups) when `/api/groups/mine` returned nothing. Google users who haven't linked anything saw every Telegram group the bot had ever joined.
- **Fix:** Google users now exclusively call `/api/groups/mine`. No fallback to `getAllGroups()`. If `groups/mine` returns nothing, the user sees an empty state with a "Create a squad" prompt.

### Fix 2: Linked Telegram group not saving / not appearing in dropdown
- **Root cause:** `addGroupMember` used `onConflict: 'group_id,user_id'` but when linking a Telegram group by email, the `user_id` may not be in `group_members` yet — only email. The upsert silently failed.
- **Fix in `db.js`:** Added `addGroupMemberByEmail()` — checks for existing row by `(group_id, email)` first, updates it if found, inserts fresh otherwise. Used by link-telegram, create-squad, and Google OAuth group creation.
- **Fix in `server.js` link-telegram endpoint:** Now validates that group ID is negative (Telegram groups must be negative integers), returns full group object so UI can update immediately without a second API call.

### Fix 3: Groups dropdown differentiation
- **Google Squads** (created via "New squad") shown in `<optgroup label="🌐 Google Squads">`
- **Telegram Groups** (linked via "Link Telegram") shown in `<optgroup label="💬 Telegram Groups">`
- Uses HTML `<optgroup>` for clean visual separation in native dropdowns

### Fix 4: Google login experience renamed to "Full App"
- `public/dashboard/index.html` page title: "SquadPicks — Full App"
- Conceptual name throughout: "Full App" (not "dashboard", not "web dashboard", not "Mini App")

### Fix 5: Full App — hamburger menu with Trending, Plan, Settings
- Left-side drawer (same style as Mini App) with: ✓ Picks · 📋 Plan · 🔥 Trending · ⚙️ Settings · 👥 My Squads
- Sign out button at the bottom of the drawer
- **Picks section** — main view, filter bar, picks grid
- **Plan section** — compact card list grouped by type, filter bar, image thumbnails
- **Trending section** — category tabs (Movies/Events/Places), Netflix/Prime/IMDb carousels with real poster images, Zomato/Eventbrite static lists
- **Settings section** — identity card (name + email), My Squads link, Sign out button

### Fix 6: Full App — images on pick cards
- Pick cards now have a 170px `card-thumb` section showing the real `image_url` as a full-cover photo
- Title and type badge float over the image with a gradient overlay (same style as Mini App's Picks tab)
- Emoji fallback when `image_url` is missing or fails to load (`onerror` hides broken image)
- Plan section pcard also shows `image_url` in the 72px side thumbnail
- Trending poster cards all show real `image_url` from DB using `position:absolute; object-fit:cover`

### Full App architecture
- Single-page app at `/dashboard`
- Sections: `#sec-picks`, `#sec-plan`, `#sec-trending`, `#sec-settings`
- `goSection(name)` shows/hides sections and updates drawer active state
- Auth: checked via `GET /api/session` on load — redirects to `/login` if no session
- Groups: loaded from `GET /api/groups/mine` only — never falls back to all-groups
- Vote labels are context-aware by content type (same as Mini App)

---

## 13. v2.6 — Full App Group Fixes (April 2026)

### Fix 1 & 3: Multiple squads / multiple Telegram groups
- Users can now create as many Google squads as they want — no limit enforced in the UI
- Users can link as many Telegram groups as they want — each link call creates a new `group_members` row
- `createSquad()` and `linkTelegram()` both close the panel immediately after success and switch the active group to the newly created/linked one
- Both functions show a loading state on the button while the request is in flight

### Fix 2: Saving a squad does not appear in dropdown
- **Root cause:** `addGroupMemberByEmail()` called `.single()` on a Supabase query for a row that may not exist yet — this throws an error (`"JSON object requested, multiple (or no) rows returned"`) which crashes the function before the insert path runs. The group was created in `groups` but the membership row was never written to `group_members`, so `getUserGroups()` returned nothing.
- **Fix in `db.js`:** Changed `.single()` to `.maybeSingle()` — returns `null` instead of throwing when no row exists
- **Fix in `db.js`:** Added a second `maybeSingle()` check by `user_id` to prevent duplicate key errors on re-linking
- **Fix in `db.js` `getUserGroups()`:** Added fallback — if the `groups` join returns null for some rows (race condition on FK resolution), fetches those groups directly by ID using `supabase.from('groups').select().in('id', missingIds)`
- **Fix in `createSquad()`:** After API returns `ok: true`, immediately sets `currentGroupId` to the new group's ID and calls `loadGroups(false)` — the dropdown reloads with the new group pre-selected

### Fix 4: App should depend on group selection first
- `loadGroups(autoSelectFirst)` now has smarter selection logic:
  - URL has a valid `groupId` → load that group's picks directly (no prompt)
  - Exactly 1 group exists → auto-select it silently
  - Multiple groups, no URL param → call `showGroupPrompt(groups)` which renders a full-page squad picker in the picks grid area
- `showGroupPrompt()` renders big clickable squad buttons (Google Squads and Telegram Groups in separate labelled sections) with an "+ Add new squad" button at the bottom
- Clicking any squad button calls `switchGroup(id)` which updates URL, dropdown, title, and loads picks
- The group selector dropdown at the top still works for switching after initial selection
- `<select>` now has a disabled placeholder option "— Select a squad —" so the user sees something meaningful when no group is selected

### `loadGroups(autoSelectFirst)` parameter
- `false` (default on init and after create/link): respects multi-group picker
- `true`: auto-selects the first group regardless (used when you just want to force a refresh)

---

## 14. v2.7 — Full App Squad Management & Add Pick (April 2026)

### Feature 1: Manage Squads (Settings → My Squads)
The Settings page now has three separate rows: **My Squads** (manage), **New Google Squad** (create), **Link Telegram Group** (link). Each opens the My Squads panel to the correct tab.

**My Squads panel — 3 tabs:**
- **📋 My Squads** — lists all your Google squads and Telegram groups. Each has a "Manage" / "View" button.
- **🌐 New Google Squad** — create a web squad (no Telegram needed)
- **💬 Link Telegram** — link one or more Telegram groups. Shows already-linked groups below the form.

**Squad detail view (opened from Manage):**
- Editable name field with a **Rename** button (Google squads only)
- **Invite member** by Gmail (Google squads only) — instantly adds if user exists, records as pending invite otherwise
- **Members list** — shows name, email, pending status; owner can remove any member
- **Delete squad** button with confirmation (Google squads only, irreversible, cascades to picks)

**New API endpoints:**
| Method | Path | Purpose |
|--------|------|---------|
| PATCH | `/api/groups/:id/rename` | Rename a web squad (owner only) |
| DELETE | `/api/groups/:id` | Delete a web squad (owner only) |
| GET | `/api/groups/:id/members` | List members of a group |
| DELETE | `/api/groups/:id/members/:memberId` | Remove a member (owner only) |

**New DB functions:** `renameGroup`, `deleteGroup`, `getGroupMembers`, `removeGroupMember`

### Feature 2 & 3: Squad types — Google vs Telegram
- **Google Squad** = created via "New Google Squad" tab. `is_web_group = true`. Managed fully in the app. Invite by Gmail.
- **Telegram Squad** = linked via "Link Telegram" tab. `is_web_group = false`. The SquadPicks bot must be in the Telegram group. Multiple groups can be linked — each becomes a separate squad in the dropdown.
- Linked Telegram groups are shown in a read-only list at the bottom of the Link Telegram tab after linking.
- Settings page has dedicated rows for each squad type so it's clear what each action does.

### Feature 4: Add Pick with category selection
**Add Pick modal now has:**
- **Category buttons** — 🎬 Movie · 📺 Show · 🍽 Restaurant · 📍 Place · 🎭 Event · 🔗 Other. Pre-selected. Overrides auto-detection.
- **Link field** (optional) — paste any URL for auto title + image fetch. Debounced 700ms, calls `GET /api/meta?url=`.
- **Title field** — auto-filled from the URL fetch. Can be typed manually if no URL.
- **Preview strip** — shows thumbnail + title + description after URL fetch.
- **Auto-detect category from URL** — `detectTypeFromUrl()` maps IMDB→movie, Yelp/Zomato→food, Maps→place, Eventbrite→event etc. Updates category buttons automatically.
- `POST /api/picks` now accepts `manualType` and `manualTitle` fields — Full App sends these to override auto-detection.

**New API endpoint:**
- `GET /api/meta?url=` — fetches title, description, imageUrl, sourceUrl from any URL. Used by the Add Pick modal preview. No auth required.

### Supabase migration needed
Run this in Supabase SQL Editor to support the delete-group cascade:
```sql
-- Make picks cascade-delete when their group is deleted (for deleteGroup to work cleanly)
ALTER TABLE picks DROP CONSTRAINT IF EXISTS picks_group_id_fkey;
ALTER TABLE picks ADD CONSTRAINT picks_group_id_fkey
  FOREIGN KEY (group_id) REFERENCES groups(id) ON DELETE CASCADE;

-- Same for group_members
ALTER TABLE group_members DROP CONSTRAINT IF EXISTS fk_group_members_groups;
ALTER TABLE group_members ADD CONSTRAINT fk_group_members_groups
  FOREIGN KEY (group_id) REFERENCES groups(id) ON DELETE CASCADE;
```

---

## 15. v2.8 — Bot Improvements (April 2026)

### Feature 1: `/groupid` command
- New bot command that returns the current group's Telegram ID in a copyable `<code>` block
- In a **group chat**: shows the group name + ID + instructions to paste it in SquadPicks web app under Settings → Link Telegram Group. Includes a direct link to the web app.
- In a **private/DM chat**: shows the user's own chat ID + explains that group IDs are negative and require being in a group
- Added to `/help` command list
- Added to the welcome message when the bot joins a group
- Uses `APP_URL` or `MINI_APP_URL` env var for the web app link

### Feature 2: Vote card replies to original message instead of new message
- **Before:** `handleLink` sent a `"Reading link..."` placeholder message, then deleted it, then sent a brand-new card message — resulting in two messages in the chat (user's URL + bot's card)
- **After:** Bot sends a `sendChatAction('typing')` indicator while fetching metadata, then sends the vote card as a **reply to the user's original URL message** using `reply_to_message_id: origMsgId`
- Result: In Telegram, the vote card appears visually attached to the user's message — one clean thread instead of two separate messages
- `disable_web_page_preview: true` is set on the card so the URL in the card text doesn't generate a second preview
- Fallback: if the original message was deleted before the card could be sent, falls back to sending without `reply_to_message_id`
- The `"Reading link..."` intermediate message has been completely removed — no more ghost messages

---

## 16. v2.9 — Fix IMDB Title/Image Not Captured by Bot (April 2026)

### Root cause
When a user pastes an IMDB URL in Telegram, two things happen:
1. **Telegram** fetches the Open Graph data from IMDB using its own servers (not blocked) and shows the movie preview in the message bubble — title, image, description all visible.
2. **The bot** also tries to fetch the same IMDB page from Railway's cloud servers. IMDB actively blocks cloud/VPS/datacenter IP ranges, so the bot gets a blocked response, `fetchImdbMeta` returns `null`, and the pick is saved with the generic fallback title `"Movie on IMDB"` and no image.

### Fix 1: Read metadata from Telegram's own preview first (`index.js`)
Added `extractTelegramPreview(msg)` function that reads the preview data Telegram already fetched and includes in the `msg` object:
- Checks `msg.link_preview_options`, `msg.web_page`, and `msg.entities[].url_details`
- If Telegram's preview contains a title, use it directly — no scraping needed
- Only falls back to `fetchMeta()` (our own scraping) if Telegram didn't provide preview data

This is the most reliable fix — if Telegram can show the preview, the bot now captures that same data.

### Fix 2: Improved `fetchImdbMeta` fallback (`links.js`)
When Telegram preview data is unavailable (e.g. user disabled link previews):
- Changed User-Agent to **iPhone/Mobile Safari** — IMDB is significantly more likely to serve a simple HTML page to mobile browsers vs desktop Chrome from a VPS IP
- Added `Referer: https://www.google.com/` header to look like organic traffic
- Extended timeout to 14 seconds
- Added more `@type` values in JSON-LD parser: `TVMovie`, `VideoGame`, `Short`
- Improved image extraction: handles `data.image` as string, array, or object
- Added `twitter:image:src` and `img[src*="media-amazon"]` as additional image sources
- Changed condition from `title !== 'Movie on IMDB'` to just `title` — cleaner check
- Logs whether image was found or not for easier debugging in Railway logs

### Fix 3: OGS gets proper browser headers
The fallback `ogs()` call now passes `fetchOptions.headers` with a Chrome User-Agent and `Accept-Language`, making it less likely to be blocked by other sites.

### How to debug on Railway
Check Railway logs after pasting an IMDB URL. You should see one of:
- `[Link] Using Telegram preview data: <Movie Title>` ← ideal path
- `[fetchImdbMeta] OK: <Movie Title> | image: yes` ← scraping worked
- `[fetchImdbMeta] HTTP 403 for ...` ← IMDB blocked the scrape (Telegram preview should have caught it)
- `[fetchImdbMeta] Could not parse title from page. Length: N` ← got a response but not a full page (CAPTCHA/redirect)

---

## 16. v2.9 — IMDB Metadata Fix (April 2026)

### Root cause analysis
Two compounding issues were causing the bot to save "Movie on IMDB" with no image:

1. **`extractTelegramPreview` always returned null.** The Telegram Bot API does not include link preview data (title, image, description) in the `message` object received by bots via polling. The `link_preview_options`, `web_page`, and `url_details` fields simply are not populated. The function was dead code — always falling through to `fetchMeta` anyway. Now removed entirely.

2. **IMDB blocks Railway/cloud IPs.** IMDB uses Cloudflare bot detection. Even with realistic browser `User-Agent` and `Referer` headers, requests from Railway's shared IP ranges are blocked or served a Cloudflare challenge page — the response is valid HTML but contains no movie data. `fetchImdbMeta` was logging a warning and returning `null`, then `fetchMeta` fell back to `titleFromUrl()` which returned the useless string `"Movie on IMDB"`.

### Fix in `links.js`

**New function `extractImdbId(url)`** — extracts the `tt\d+` IMDB title ID from any IMDB URL.

**`fetchImdbMeta()` now has three strategies in order:**

1. **OMDB API** — if `OMDB_API_KEY` env var is set, calls `https://www.omdbapi.com/?i=ttXXXXXXX&apikey=...`. Returns title, poster URL, plot, year, rating, genre. No web scraping, no IP blocking, 100% reliable. Free tier: 1,000 calls/day. Get a key at https://www.omdbapi.com/apikey.aspx.

2. **Cheerio scrape** — tries the movie page directly with a mobile iPhone `User-Agent`. Extracts from JSON-LD structured data first (most reliable), then OG/meta tags. Fallback when OMDB key is not set or OMDB doesn't have the title.

3. **`titleFromUrl()` last resort** — returns `"Movie on IMDB"` only if both above fail (e.g. completely blocked IP + no OMDB key).

**`extractTelegramPreview()` removed** — was dead code, Bot API never populates those fields.

### Required Railway env var
```
OMDB_API_KEY=your_free_key_here
```
Get a free key (1,000 calls/day) at: https://www.omdbapi.com/apikey.aspx

Without this key, Strategy 2 (cheerio scrape) is used, which works on some IPs but may fail on Railway. **Setting `OMDB_API_KEY` is strongly recommended.**
