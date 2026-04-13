# 🎬 SquadPicks Bot

A Telegram bot for families and friend groups to collaboratively track movies, places, restaurants, and anything else — just by pasting a link.

## How it works

1. Add the bot to your Telegram group
2. Anyone pastes a link (Google Maps, IMDB, Zomato, YouTube, any URL)
3. The bot automatically fetches the title and details
4. Everyone taps ✅ Seen/Been · ⭐ Want to · ❌ Not interested
5. Use `/canwatch` to see what the whole group agrees on

---

## Setup (15 minutes)

### Step 1 — Create your bot on Telegram

1. Open Telegram and search for **@BotFather**
2. Send `/newbot`
3. Choose a name: e.g. `Family Squad Picks`
4. Choose a username: e.g. `familysquadpicks_bot` (must end in `_bot`)
5. BotFather gives you a **token** like `7123456789:AAHx...` — copy it

### Step 2 — Install and run locally

```bash
# Clone or download this project
cd squadpicks-bot

# Install dependencies
npm install

# Create your .env file
cp .env.example .env

# Edit .env and paste your token
nano .env   # or open in any text editor

# Start the bot
npm start
```

You'll see: `🤖 SquadPicks bot is running…`

### Step 3 — Add the bot to your group

1. Open your family/friends Telegram group
2. Tap the group name → Add members
3. Search for your bot's username and add it
4. Send `/start` in the group

---

## Deploy to Railway (always online, free tier)

So the bot runs 24/7 without your computer being on:

1. Push this code to a GitHub repo
2. Go to [railway.app](https://railway.app) → New Project → Deploy from GitHub
3. Select your repo
4. Go to **Variables** tab → Add `BOT_TOKEN` = your token
5. Railway auto-deploys — done!

### Deploy to Render (alternative)

1. Go to [render.com](https://render.com) → New → Web Service
2. Connect your GitHub repo
3. Set **Start Command**: `node index.js`
4. Add environment variable: `BOT_TOKEN` = your token
5. Deploy

---

## Commands

| Command | What it does |
|---------|-------------|
| `/start` or `/help` | Shows welcome message |
| `/picks` | Shows last 10 picks with vote buttons |
| `/canwatch` | Shows only picks nobody vetoed |
| `/mystats` | Your personal seen/want/skip counts |

---

## Supported link types

| Source | Detected as |
|--------|-------------|
| IMDB, TheMovieDB, Letterboxd | 🎬 Movie |
| Netflix, Prime Video, Disney+, Hulu | 📺 Show |
| Google Maps, Maps shortened links | 📍 Place |
| Zomato, Yelp, TripAdvisor, OpenTable | 🍽️ Food |
| YouTube, anything else | 🔗 Link |

Any URL with Open Graph tags (og:title, og:description) will be parsed automatically — which covers most modern websites.

---

## File structure

```
squadpicks-bot/
├── index.js          # Entry point
├── src/
│   ├── bot.js        # Main bot logic, message handling, commands
│   ├── metadata.js   # URL fetching and OG tag extraction
│   └── db.js         # JSON file database (one file per run)
├── data/             # Auto-created, stores picks.json
├── .env.example      # Copy to .env and add your token
├── package.json
└── Procfile          # For Railway/Render deployment
```

---

## Notes

- Picks are stored in `data/picks.json` locally. On Railway/Render, use a persistent volume or swap `db.js` for a real database (SQLite or Supabase) for production use.
- The bot needs to be an **admin** in the group to read all messages (or users can forward links directly to it).
- Clicking the same status button twice removes the vote (toggle).
