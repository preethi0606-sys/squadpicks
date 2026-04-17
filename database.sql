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
  prime_url   TEXT,
  region      TEXT NOT NULL,                 -- 'ca' | 'in'
  fetched_at  TIMESTAMPTZ DEFAULT NOW(),
  week_of     DATE NOT NULL DEFAULT CURRENT_DATE,
  UNIQUE(title, region, week_of)
);

-- 8. IMDb Top Picks — refreshed every Thursday
CREATE TABLE IF NOT EXISTS trending_imdb (
  id          SERIAL PRIMARY KEY,
  rank        INTEGER NOT NULL,
  title       TEXT NOT NULL,
  type        TEXT DEFAULT 'movie',          -- 'movie' | 'show'
  year        TEXT,
  rating      TEXT,                          -- IMDb rating e.g. "8.4"
  votes       TEXT,                          -- e.g. "2.3M"
  genre       TEXT,
  image_url   TEXT,
  imdb_url    TEXT,
  category    TEXT NOT NULL,                 -- 'top_movies' | 'top_shows' | 'fan_picks'
  fetched_at  TIMESTAMPTZ DEFAULT NOW(),
  week_of     DATE NOT NULL DEFAULT CURRENT_DATE,
  UNIQUE(title, category, week_of)
);

-- Indexes for trending tables
CREATE INDEX IF NOT EXISTS idx_trending_netflix_week ON trending_netflix(week_of, region);
CREATE INDEX IF NOT EXISTS idx_trending_prime_week   ON trending_prime(week_of, region);
CREATE INDEX IF NOT EXISTS idx_trending_imdb_week    ON trending_imdb(week_of, category);
