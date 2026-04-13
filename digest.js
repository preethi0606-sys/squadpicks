// digest.js — Weekly Sunday digest sender
const cron = require('node-cron');
const db = require('./db');
const { formatDigest } = require('./links');

// ─── BUILD AND SEND DIGEST TO ALL GROUPS ───────────────────

async function sendWeeklyDigest(bot) {
  console.log('[Digest] Sending weekly digest to all groups...');
  const groups = await db.getAllGroups();

  for (const group of groups) {
    try {
      // New picks in last 7 days
      const newPicks = await db.getGroupPicks(group.id, 7);

      // Filmi Craft reviews in last 7 days
      const allPicks = await db.getRecentFilmiCraftPicks(10);
      const fcPicks  = allPicks.filter(p => {
        const created = new Date(p.created_at);
        const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
        return created > weekAgo;
      });

      // Count pending votes across the group (no specific user, just total)
      const pendingCount = newPicks.filter(p => {
        // picks with zero votes are "pending"
        return true; // simplified — full version queries votes table
      }).length;

      const text = formatDigest(newPicks, fcPicks, pendingCount);
      await bot.sendMessage(group.id, text, { parse_mode: 'HTML' });

      console.log(`[Digest] Sent to group: ${group.title}`);
    } catch (err) {
      console.error(`[Digest] Failed for group ${group.id}:`, err.message);
    }
  }
}

// ─── START CRON ────────────────────────────────────────────

function startDigestCron(bot) {
  // Every Sunday at 9:00 AM
  cron.schedule('0 9 * * 0', () => sendWeeklyDigest(bot), {
    timezone: 'Asia/Kolkata' // IST — change to your timezone
  });
  console.log('[Digest] Weekly digest scheduled: Sundays at 9am IST');
}

module.exports = { startDigestCron, sendWeeklyDigest };
