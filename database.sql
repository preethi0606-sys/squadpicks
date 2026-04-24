-- SquadPicks Database Schema
-- Run this in your Supabase SQL Editor (supabase.com → SQL Editor → New query)

-- 1. Telegram groups that have added SquadPicks bot
CREATE TABLE IF NOT EXISTS groups (
  id BIGINT PRIMARY KEY,
  title TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 2. All picks (movies, restaurants, places, events, shows)
CREATE TABLE IF NOT EXISTS picks (
  id SERIAL PRIMARY KEY,
  group_id BIGINT REFERENCES groups(id) ON DELETE CASCADE,
  type TEXT NOT NULL DEFAULT 'link', -- movie | food | place | event | show | link
  title TEXT NOT NULL,
  description TEXT,
  url TEXT,
  image_url TEXT,
  added_by_id BIGINT,
  added_by_name TEXT,
  reviewer_name TEXT,       -- e.g. "Filmi Craft"
  reviewer_score TEXT,      -- e.g. "4.1/5"
  reviewer_quote TEXT,      -- e.g. "Dulquer at his best"
  reviewer_video_id TEXT,   -- YouTube video ID
  message_id BIGINT,        -- Telegram message ID of the card (for editing)
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 3. Per-person votes on each pick
CREATE TABLE IF NOT EXISTS votes (
  id SERIAL PRIMARY KEY,
  pick_id INTEGER REFERENCES picks(id) ON DELETE CASCADE,
  user_id BIGINT NOT NULL,
  username TEXT,
  first_name TEXT,
  status TEXT NOT NULL CHECK (status IN ('seen', 'want', 'skip')),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(pick_id, user_id)
);

-- 4. Track which YouTube videos have already been posted
CREATE TABLE IF NOT EXISTS posted_videos (
  video_id TEXT PRIMARY KEY,
  channel_id TEXT NOT NULL,
  title TEXT,
  posted_at TIMESTAMPTZ DEFAULT NOW()
);

-- 5. Indexes for performance
CREATE INDEX IF NOT EXISTS idx_picks_group_id ON picks(group_id);
CREATE INDEX IF NOT EXISTS idx_votes_pick_id ON votes(pick_id);
CREATE INDEX IF NOT EXISTS idx_votes_user_id ON votes(user_id);

-- Done! Your SquadPicks database is ready.

-- ─── TRENDING TABLES (added for scraping cron jobs) ──────────────────────────

-- 6. Netflix Top 10 — refreshed every Thursday
CREATE TABLE IF NOT EXISTS trending_netflix (
  id          SERIAL PRIMARY KEY,
  rank        INTEGER NOT NULL,              -- 1-10
  title       TEXT NOT NULL,
  type        TEXT DEFAULT 'show',           -- 'show' | 'movie'
  genre       TEXT,
  image_url   TEXT,
  netflix_url TEXT,
  region      TEXT NOT NULL,                 -- 'canada' | 'us' | 'india'
  weeks_in_top10 INTEGER DEFAULT 1,
  score       TEXT,                          -- IMDb score if scraped
  fetched_at  TIMESTAMPTZ DEFAULT NOW(),
  week_of     DATE NOT NULL DEFAULT CURRENT_DATE,
  UNIQUE(title, region, week_of)
);

-- 7. Prime Video Top 10 — refreshed every Thursday
CREATE TABLE IF NOT EXISTS trending_prime (
  id          SERIAL PRIMARY KEY,
  rank        INTEGER NOT NULL,
  title       TEXT NOT NULL,
  type        TEXT DEFAULT 'show',
  genre       TEXT,
  image_url   TEXT,
  prime_url   TEXT,                          -- search link on Prime Video
  tmdb_url    TEXT,                          -- direct TMDB page link (used for add-to-picks)
  badge       TEXT DEFAULT 'P',
  badge_color TEXT DEFAULT '#00A8E0',
  score       TEXT,
  region      TEXT NOT NULL DEFAULT 'us',
  fetched_at  TIMESTAMPTZ DEFAULT NOW(),
  week_of     DATE NOT NULL DEFAULT CURRENT_DATE,
  UNIQUE(title, region, week_of)
);

-- 8. TMDB Top Picks — refreshed every Thursday (replaces IMDb scraping)
CREATE TABLE IF NOT EXISTS trending_imdb (
  id          SERIAL PRIMARY KEY,
  rank        INTEGER NOT NULL,
  title       TEXT NOT NULL,
  type        TEXT DEFAULT 'movie',          -- 'movie' | 'show'
  year        TEXT,
  rating      TEXT,
  genre       TEXT,
  image_url   TEXT,
  tmdb_url    TEXT,                          -- direct TMDB link (used for add-to-picks)
  imdb_url    TEXT,                          -- kept for schema compatibility
  category    TEXT NOT NULL,                 -- 'top_movies' | 'popular_shows' | 'popular_movies'
  fetched_at  TIMESTAMPTZ DEFAULT NOW(),
  week_of     DATE NOT NULL DEFAULT CURRENT_DATE,
  UNIQUE(title, category, week_of)
);

-- Indexes for trending tables
CREATE INDEX IF NOT EXISTS idx_trending_netflix_week ON trending_netflix(week_of, region);
CREATE INDEX IF NOT EXISTS idx_trending_prime_week   ON trending_prime(week_of, region);
CREATE INDEX IF NOT EXISTS idx_trending_imdb_week    ON trending_imdb(week_of, category);

-- ─── NEW TABLES FOR v2 FEATURES ──────────────────────────────────────────────

-- 9. Users (Google OAuth + Telegram website login)
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

-- 10. Web-created groups (non-Telegram) — extend groups table
ALTER TABLE groups ADD COLUMN IF NOT EXISTS is_web_group BOOLEAN DEFAULT FALSE;
ALTER TABLE groups ADD COLUMN IF NOT EXISTS owner_id UUID REFERENCES users(id);

-- 11. Group members for web groups (Google / email invites)
CREATE TABLE IF NOT EXISTS group_members (
  id         UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  group_id   BIGINT NOT NULL,
  user_id    UUID REFERENCES users(id),
  email      TEXT,
  status     TEXT DEFAULT 'active',  -- 'invited' | 'active'
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(group_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_group_members_group  ON group_members(group_id);
CREATE INDEX IF NOT EXISTS idx_group_members_user   ON group_members(user_id);
CREATE INDEX IF NOT EXISTS idx_users_telegram       ON users(telegram_id);
CREATE INDEX IF NOT EXISTS idx_users_google         ON users(google_id);

-- Done! Run this full file on a fresh DB, or just the NEW TABLES section on an existing DB.

-- ─── v2.2 ADDITIONS ──────────────────────────────────────────────────────────
-- Run these if upgrading from v2.0/v2.1

-- Add invited_by to group_members
ALTER TABLE group_members ADD COLUMN IF NOT EXISTS invited_by UUID REFERENCES users(id);

-- Allow email-only invites (user_id can be null until they sign up)
ALTER TABLE group_members ALTER COLUMN user_id DROP NOT NULL;

-- Unique on (group_id, email) so we can upsert invites by email
CREATE UNIQUE INDEX IF NOT EXISTS idx_group_members_group_email
  ON group_members(group_id, email) WHERE email IS NOT NULL;
