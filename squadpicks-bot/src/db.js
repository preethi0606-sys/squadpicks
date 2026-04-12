const fs = require('fs');
const path = require('path');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, '..', 'data', 'picks.json');

// Ensure data directory exists
function ensureDir() {
  const dir = path.dirname(DB_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function load() {
  ensureDir();
  if (!fs.existsSync(DB_PATH)) return {};
  try { return JSON.parse(fs.readFileSync(DB_PATH, 'utf8')); } catch { return {}; }
}

function save(data) {
  ensureDir();
  fs.writeFileSync(DB_PATH, JSON.stringify(data, null, 2));
}

function getChatData(chatId) {
  const data = load();
  const key = String(chatId);
  if (!data[key]) data[key] = { picks: [] };
  return { data, key };
}

const db = {
  addPick(chatId, pick) {
    const { data, key } = getChatData(chatId);
    const newPick = {
      ...pick,
      id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
      addedAt: new Date().toISOString(),
      votes: pick.votes || {},
    };
    data[key].picks.push(newPick);
    save(data);
    return newPick;
  },

  vote(chatId, pickId, userName, status) {
    const { data, key } = getChatData(chatId);
    const pick = data[key].picks.find(p => p.id === pickId);
    if (!pick) return null;
    // Toggle: clicking same status removes it
    if (pick.votes[userName] === status) {
      delete pick.votes[userName];
    } else {
      pick.votes[userName] = status;
    }
    save(data);
    return pick;
  },

  getPicks(chatId) {
    const { data, key } = getChatData(chatId);
    return data[key].picks || [];
  },

  clearPicks(chatId) {
    const { data, key } = getChatData(chatId);
    data[key].picks = [];
    save(data);
  },
};

module.exports = { db };
