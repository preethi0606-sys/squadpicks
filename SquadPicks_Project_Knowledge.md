# SquadPicks — Project Knowledge Base

*Last updated: April 2026 — v3.3. Update this doc whenever a feature is confirmed built.*

---

## 1. App Overview & Purpose

**SquadPicks** is a group activity coordination app — works via Telegram bot AND via Google login on the web.

**Tagline:** *"Your squad. Any plan. One app."*

**Two entry points, one codebase:**
- **Telegram Mini App** (`/app`) → immediately redirects to `/dashboard` (the Full App). The mini app is just a redirect. There is only one UI: the Full App.
- **Google login** → `/dashboard` (Full App). Hamburger drawer nav. Dashboard, Trending, Settings.

---

## 2. Confirmed Features

### Telegram Bot
- Universal link detection: TMDB, IMDB (via TMDB), YouTube (oEmbed), Google Maps (redirect follow), Facebook/Instagram, Zomato, Yelp, Eventbrite, Netflix, Hotstar, SonyLiv, Prime Video, TikTok, Twitter/X
- Auto-type detection: `movie | show | food | place | event | video | link`
- Vote cards reply to the original URL message. Vote labels are context-aware by type.
- Group ok = 50% threshold: `Math.ceil(activeMembers × 0.5)` positive (want/seen) votes, zero skips
- Auto-vote "want" for the person who adds a pick
- `/groupid` command: shows group ID in copyable `<code>` block

### Link Detection & Metadata (`links.js`)
| URL Pattern | Type | Handler |
|-------------|------|---------|
| `themoviedb.org/movie/*` | movie | TMDB API by ID |
| `themoviedb.org/tv/*` | show | TMDB API by ID |
| `imdb.com/title/tt*` | movie | TMDB `/find` by IMDB ID |
| `youtube.com/watch`, `youtu.be/`, `/shorts`, `/live` | video | YouTube oEmbed (free, no key) |
| `maps.app.goo.gl`, `maps.google.com`, `goo.gl/maps` | place | Redirect-follow + place name extraction |
| `facebook.com/share/*`, `fb.com/*` | link | `fetchFacebookMeta()` — facebookexternalhit UA + OG scrape |
| `facebook.com/events/*` | event | OGS with bot UA |
| `instagram.com/reel/*` | video | OGS with bot UA |
| `instagram.com/*` | link | OGS with bot UA |
| `tiktok.com` | video | OGS |
| `twitter.com`, `x.com` | link | OGS |
| `netflix.com`, `primevideo.com`, `hotstar.com`, `sonyliv.com` | show | OGS |
| `yelp.com`, `zomato.com`, `swiggy.com`, etc. | food | OGS |
| `tripadvisor.com` | place | OGS |
| `eventbrite.com`, `bookmyshow.com`, `meetup.com`, `ticketmaster.com` | event | OGS |

**Facebook share URLs** (`facebook.com/share/r/CODE`): `fetchFacebookMeta()` follows redirect with facebookexternalhit UA, extracts OG tags. `cleanFbTitle()` strips likes counts before pipe/bullet separators (e.g. `"1.2K likes · Venue Name"` → `"Venue Name"`). Decodes HTML entities.

**Duplicate URL check:** `POST /api/picks` calls `fetchMeta()` first to get the resolved `sourceUrl`, then checks both the original URL and `sourceUrl` against the DB. Returns HTTP 409 `{ duplicate: true, error: "Title was already added" }` if found.

### Email Notifications (`server.js`)
- **`sendPickNotification()`** — emails all active group members when a new pick is added. Non-blocking (`.catch()` so it never fails the pick-add request). Uses Resend API.
- **`sendInviteEmail()`** — emails an invite with a unique token link. Invitee must click "Accept invite" before they join the group.
- Both require `RESEND_API_KEY` and `RESEND_FROM_EMAIL` in Railway. Without them, emails are logged to console but the app still works.

### Invite & Approval Flow (`server.js`, `db.js`)
- `POST /api/groups/invite` creates a DB record with `status='invited'`, a random 32-byte hex token, and 7-day expiry. Sends email with the acceptance link.
- `GET /api/groups/accept-invite/:token` — recipient clicks the link → token verified → `status` updated to `'active'` → redirect to the group dashboard.
- Existing users go through the same flow (status starts as `'invited'`, not `'active'`).
- `applyPendingInvites()` called on every Google login to auto-join any pending email invites.

### Mini App → Full App (`public/app.html`)
- `app.html` is now a 5-line redirect. It reads `start_param` from Telegram WebApp or `?groupId=` from the URL and redirects to `/dashboard?groupId=...`.
- No separate codebase. Both Telegram Mini App and browser users see the same Full App.

### Full App — Dashboard (`public/dashboard/index.html`)
**Navigation:** Hamburger drawer → Dashboard · Trending · Settings · My Squads

**Dashboard (default landing):**
- Group tabs at top: "All squads" + individual squad tabs
- Picks from all squads aggregated when "All squads" selected (parallel fetch + merge)
- Deduplicates by title (case-insensitive) when showing all squads
- Stats row: Total picks · Group ok · Need your vote · Squads
- Filter pills: All / ★ Want to / ✓ Group ok / 🎬 🍽 📍 🎭 type filters
- Vote buttons on each card — `castDashVote()` syncs to DB

**Trending (5 tabs):**
- 🎬 **Movies** — Netflix Top 10 + Prime Video + TMDB Popular
- 🎭 **Events** — Ticketmaster by GPS location (auto-detect), category sections (Concerts/Sports/Arts/Family)
- 📍 **Places** — TripAdvisor API or Wikimedia curated static (10 per region, Canada/US/India)
- 📺 **Channels** — YouTube channels configured per squad. Select squad from dropdown → shows channels. "+ Add channel" opens a prompt. Calls `/api/groups/:id/channels`.
- 🌍 **Community** — group-ok picks from squads the current user is NOT in. Calls `/api/trending/community`.

**Settings (functional):**
- Profile card — shows name and email from session
- Squads — links to My Squads panel (manage/rename/invite/delete)
- Notifications — toggle switches for: New picks / Group ok / Weekly digest. Saved to `user_preferences` table via `/api/preferences`.
- Account — Plan badge (Free), Share SquadPicks (copies link), Telegram Bot link, Sign out

**Global FAB:** Purple circle fixed bottom-right, always visible, opens Add Pick modal on every screen.

**Add Pick modal:**
- Category: 🎬 Movie · 📺 Show · 🍽 Restaurant · 📍 Place · 🎭 Event · 🔗 Other
- URL field: auto-fetches title + image (700ms debounce → `/api/meta?url=`)
- Auto-votes "want" for adder on save
- Duplicate check: shows `⚠️ "Title" was already added` toast (HTTP 409), keeps modal open

**Squad Management (My Squads panel):**
- 📋 My Squads tab — lists all squads with Manage/View buttons
- 🌐 New Google Squad — create by name
- 💬 Link Telegram — paste group ID (must start with minus, e.g. `-1001234567890`)
- Squad detail: rename, invite by email (sends approval email), members list with roles, admin toggle, remove

**Admin Management:**
- `group_members.role` column: `'owner'` | `'admin'` | `'member'`
- Only the owner can promote/demote members to admin
- Admins can manage members (view, remove non-owner members) but cannot delete the group or change ownership
- `PATCH /api/groups/:id/members/:memberId/role` — owner only
- Members list shows Owner/Admin badges and "Make admin" / "Revoke admin" buttons

---

## 3. Tech Stack

| Layer | Technology |
|-------|-----------|
| Runtime | Node.js 20+ |
| Bot | node-telegram-bot-api v0.66 |
| Web server | Express v5 |
| Database | Supabase (PostgreSQL) |
| Movie/TV | TMDB API (primary — replaces IMDB + OMDB) |
| Scraping | node-fetch v3 + cheerio |
| Cron | node-cron v4 |
| YouTube monitoring | googleapis v171 |
| YouTube metadata | YouTube oEmbed API (free, no key) |
| OG metadata | open-graph-scraper v6 |
| Netflix data | Official XLSX from netflix.com/tudum/top10 |
| Events (CA/US) | Ticketmaster Discovery API (free, 5000/day) |
| Events (India) | Insider.in public API (free) |
| Places | TripAdvisor Content API (free, 5000/month) → Wikimedia fallback |
| Email | Resend API (free, 3000/month) |
| Sessions | express-session v1.18 |
| Google OAuth | Native fetch (no Passport.js) |
| UI | Vanilla HTML/CSS/JS — one file: `public/dashboard/index.html` |
| Fonts | Fraunces (headings) + DM Sans (body) via Google Fonts |

---

## 4. File Structure

```
squadpicks-bot/
├── index.js          — Bot: commands, handleLink, cron start
├── server.js         — Express API, OAuth, all routes, email functions
├── db.js             — All Supabase queries (two-query pattern, no FK joins)
├── links.js          — detectType, fetchMeta, TMDB, YouTube, Google Maps, Facebook
├── youtube.js        — YouTube channel monitor (Friday cron)
├── digest.js         — Sunday weekly digest cron
├── scraper.js        — Netflix XLSX + TMDB popular + Prime + TripAdvisor + Ticketmaster
├── streaming.js      — Static fallback streaming data
├── database.sql      — Full schema + all migrations (v3.3 latest)
├── package.json      — node-fetch ^3.3.2
├── package-lock.json — Required for Railway
├── railway.toml      — builder = nixpacks
├── .env.example      — All env vars documented
└── public/
    ├── app.html              — Telegram Mini App (redirects to /dashboard)
    ├── dashboard/index.html  — The Full App (single file, all UI)
    ├── login.html            — Google + Telegram login
    ├── index.html            — Landing page
    └── styles.css            — Shared styles
```

### Database Tables

| Table | Purpose |
|-------|---------|
| `groups` | Telegram + web groups (`is_web_group`, `owner_id`) |
| `picks` | All picks — url, image_url, type, title, description, added_by_* |
| `votes` | Per-person votes — `status`: seen/want/skip |
| `users` | Google + Telegram users |
| `group_members` | Squad membership — `status` (invited/active), `role` (owner/admin/member), `invite_token`, `invite_expires_at` |
| `group_channels` | YouTube channels per squad — `channel_id`, `channel_name`, `channel_url` |
| `user_preferences` | Notification toggles per user — `notify_pick_add`, `notify_group_ok`, `notify_digest` |
| `trending_netflix` | Netflix Top 10 by region + week |
| `trending_prime` | Prime Video top 10 (TMDB discover, region='us') |
| `trending_imdb` | TMDB popular movies/shows (stored here) |
| `trending_places` | Top attractions — `url` (maps), `tripadvisor_url`, `image_url` (Wikimedia) |
| `trending_events` | Events by region + category (concerts/sports/arts/family) |
| `posted_videos` | Dedup for YouTube video posts |

### v3.3 SQL Migrations (run in Supabase SQL Editor)
```sql
-- Roles
ALTER TABLE group_members ADD COLUMN IF NOT EXISTS role TEXT DEFAULT 'member';
ALTER TABLE group_members ADD COLUMN IF NOT EXISTS invite_token TEXT;
ALTER TABLE group_members ADD COLUMN IF NOT EXISTS invite_expires_at TIMESTAMPTZ;

-- YouTube channels per group
CREATE TABLE IF NOT EXISTS group_channels (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  group_id BIGINT NOT NULL, channel_id TEXT NOT NULL,
  channel_name TEXT, channel_url TEXT, added_by UUID REFERENCES users(id),
  created_at TIMESTAMPTZ DEFAULT NOW(), UNIQUE(group_id, channel_id)
);

-- Notification preferences
CREATE TABLE IF NOT EXISTS user_preferences (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID REFERENCES users(id) UNIQUE,
  notify_pick_add BOOLEAN DEFAULT true, notify_group_ok BOOLEAN DEFAULT true,
  notify_digest BOOLEAN DEFAULT true, updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- TripAdvisor link in places
ALTER TABLE trending_places ADD COLUMN IF NOT EXISTS tripadvisor_url TEXT;

-- Stale data cleanup (uncomment to run)
-- TRUNCATE trending_places;
-- TRUNCATE trending_prime;
-- TRUNCATE trending_imdb;
-- TRUNCATE trending_events;
```

### API Endpoints
| Method | Path | Auth | Purpose |
|--------|------|------|---------|
| GET | `/api/health` | — | Health check |
| GET | `/api/session` | — | Current session |
| POST | `/api/auth/logout` | — | Destroy session |
| GET | `/auth/google` | — | Start OAuth |
| GET | `/auth/google/callback` | — | OAuth → `/dashboard` |
| POST | `/api/auth/telegram` | — | Telegram widget → `/app` |
| GET | `/api/picks?groupId=` | tg | Get picks with votes |
| POST | `/api/picks` | tg | Add pick (duplicate check, auto-vote, email notify) |
| POST | `/api/vote` | tg | Cast/toggle vote |
| GET | `/api/meta?url=` | — | Metadata preview |
| GET | `/api/groups/mine` | session | User's squads |
| POST | `/api/groups/create` | session | Create Google squad |
| PATCH | `/api/groups/:id/rename` | session | Rename (owner only) |
| DELETE | `/api/groups/:id` | session | Delete (owner only) |
| GET | `/api/groups/:id/members` | session | List members with roles |
| DELETE | `/api/groups/:id/members/:memberId` | session | Remove member |
| PATCH | `/api/groups/:id/members/:memberId/role` | session | Promote/demote admin (owner only) |
| POST | `/api/groups/invite` | session | Invite by email (sends approval email) |
| GET | `/api/groups/accept-invite/:token` | — | Accept invite link |
| GET | `/api/groups/:id/channels` | session | List YouTube channels |
| POST | `/api/groups/:id/channels` | session | Add YouTube channel |
| DELETE | `/api/groups/:id/channels/:channelId` | session | Remove channel |
| GET | `/api/preferences` | session | Load notification prefs |
| POST | `/api/preferences` | session | Save notification prefs |
| GET | `/api/trending/streaming` | — | Netflix + Prime data |
| GET | `/api/trending/tmdb?category=` | — | TMDB popular |
| GET | `/api/trending/places?region=` | — | Places by region |
| GET | `/api/trending/events?region=` | — | Events by region (DB) |
| GET | `/api/trending/events/nearby?lat=&lng=` | — | Events by GPS |
| GET | `/api/trending/community` | session | Group-ok picks from other squads |
| POST | `/api/admin/scrape` | x-admin-secret | Manual scrape trigger |

---

## 5. Design System

### Colours
```css
--navy:#6B21A8  --blue:#7C3AED  --blue2:#8B5CF6
--beige:#F5F3FF --beige2:#EDE9FE --beige3:#DDD6FE
--text:#1E1333  --text2:#3B1F6B --text3:#7C5AB8
--green:#059669 --red:#DC2626   --amber:#D97706
```

### Typography
- Headings: **Fraunces** (serif, Google Fonts)
- Body/UI: **DM Sans** (sans-serif, Google Fonts)

### Key Components
- **Dashboard pick cards** — 170px image header, gradient overlay, type badge, voter chips, vote buttons
- **Trending poster cards** — 150×220px, `object-fit:cover`. Stream badge (top-left), rank (top-right), score (bottom-right)
- **Wide cards** (places/events) — 210×130px image, 3 action buttons: + Add / 📍 Maps / ★ TripAdvisor
- **Trend row** — horizontal scroll with thin visible scrollbar + right-fade gradient hint
- **Places grid** — CSS `grid; auto-fill; minmax(180px,1fr)` — wraps responsively
- **Toggle switches** — notification preferences in Settings
- **Global FAB** — `position:fixed; bottom:24px; right:24px; z-index:250`

---

## 6. Environment Variables

| Variable | Required | Notes |
|----------|----------|-------|
| `TELEGRAM_TOKEN` | ✅ | From @BotFather |
| `SUPABASE_URL` | ✅ | Project URL |
| `SUPABASE_KEY` | ✅ | anon/public key |
| `YOUTUBE_API_KEY` | ✅ | Google Cloud → YouTube Data API v3 |
| `BOT_USERNAME` | ✅ | Without @ |
| `BOT_NAME` | ✅ | Display name |
| `MINI_APP_URL` | ✅ | `https://YOUR-APP.up.railway.app` |
| `MINI_APP_SHORT_NAME` | ✅ | BotFather short name e.g. `Squadpicks` |
| `RAILWAY_PUBLIC_DOMAIN` | ✅ | Without https:// |
| `APP_URL` | ✅ | With https:// |
| `GOOGLE_CLIENT_ID` | ✅ | OAuth 2.0 |
| `GOOGLE_CLIENT_SECRET` | ✅ | OAuth 2.0 |
| `SESSION_SECRET` | ✅ | 32+ random chars |
| `FILMICRAFT_CHANNEL_ID` | ✅ | `UClF9UTljviumfJf7t-VR5tg` |
| `FILMICRAFT_CHANNEL_NAME` | ✅ | `Filmi Craft` |
| `ADMIN_SECRET` | ✅ | Protects `/api/admin/scrape` |
| `TMDB_API_KEY` | ✅ | v4 Read Access Token (starts `eyJ...`). https://themoviedb.org/settings/api |
| `TICKETMASTER_API_KEY` | ✅ | Free at https://developer.ticketmaster.com |
| `RESEND_API_KEY` | ⚪ Recommended | Free at https://resend.com — 3000 emails/month |
| `RESEND_FROM_EMAIL` | ⚪ | e.g. `SquadPicks <noreply@yourdomain.com>` |
| `TRIPADVISOR_API_KEY` | ⚪ | Free at https://tripadvisor.com/developers — 5000/month |
| `NODE_ENV` | ⚪ | `production` |

---

## 7. Critical Technical Decisions

| Topic | Decision |
|-------|----------|
| **Single UI** | `app.html` redirects to `/dashboard`. There is only one frontend codebase. |
| **Picks page** | Removed. Dashboard is the primary view with group switching and aggregation. |
| **Group ok threshold** | `Math.ceil(activeMembers × 0.5)` positive votes + zero skips. Computed in server.js on every `GET /api/picks` and `POST /api/vote`. |
| **Invite approval** | Status starts as `'invited'`, not `'active'`. User must click the email link to become active. Token expires in 7 days. |
| **Pick email notify** | `sendPickNotification()` is always non-blocking — called with `.catch()` so it never fails the pick-add response. |
| **Duplicate URL check** | Runs AFTER `fetchMeta()` so both original and resolved URLs are checked. Facebook share short links resolve to different final URLs each time — we check both. |
| **Facebook titles** | `cleanFbTitle()` splits on `|·•` separator and takes the LAST segment (the real name, not the likes count). |
| **TMDB as sole movie source** | IMDB URLs → TMDB `/find`. OMDB removed. No IMDB scraping. |
| **Prime region** | Scraper stores Prime data as `region='us'`. Server endpoint always tries `'us'` first when fetching Prime. |
| **Places images** | Wikimedia Commons URLs in `PLACES_STATIC` client-side fallback. DB `trending_places.image_url` from TripAdvisor API or Wikimedia. Run `TRUNCATE trending_places;` then manual scrape to repopulate. |
| **TripAdvisor link** | With API key: `tripadvisor.com/Attraction_Review-g-dLOCATION_ID` (real page). Without: `tripadvisor.com/Search?q=Title` (search page). |
| **Community trending** | `GET /api/trending/community` fetches `group_ok=true` picks from groups the user is NOT in. The `group_ok` column must be kept updated in the `picks` table. |
| **YouTube channels** | Stored in `group_channels` table per squad. Shown as cards with Watch button (link to channel). |
| **Admin roles** | `group_members.role`: owner → admin → member. Only owner can promote/demote. Admins can manage members. Neither can change ownership. |
| **Supabase FK joins** | Always two plain queries. Never `select('col, table(col)')`. |
| **node-fetch v3** | `import('node-fetch')` dynamic ESM syntax. `res.arrayBuffer()` not `res.buffer()`. |
| **TMDB rate limit** | 40 req/10s. Scraper adds 300ms between calls. |

---

## 8. Deployment

- **Platform:** Railway — nixpacks, `npm install`, `node index.js`
- **Repo:** https://github.com/preethi0606-sys/squadpicks
- **Cron:** Monday 10:00 UTC (Netflix) · Thursday 20:30 UTC (full scrape) · Startup 15s (always runs)

### Manual scrape
```bash
curl -X POST https://YOUR-APP.up.railway.app/api/admin/scrape \
  -H "x-admin-secret: YOUR_ADMIN_SECRET"
```

### After deploying v3.3 — run in Supabase SQL Editor
```sql
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
ALTER TABLE trending_places ADD COLUMN IF NOT EXISTS tripadvisor_url TEXT;
TRUNCATE trending_places;
TRUNCATE trending_prime;
```

---

*End of document. v3.3 — April 2026*
