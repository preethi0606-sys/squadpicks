// db.js — SquadPicks database helpers
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY
);

// ─── GROUPS ────────────────────────────────────────────────

async function ensureGroup(chatId, title) {
  const { error } = await supabase
    .from('groups')
    .upsert({ id: chatId, title }, { onConflict: 'id' });
  if (error) console.error('ensureGroup error:', error.message);
}

async function getAllGroups() {
  const { data, error } = await supabase.from('groups').select('id, title');
  if (error) { console.error('getAllGroups error:', error.message); return []; }
  return data || [];
}

// ─── PICKS ─────────────────────────────────────────────────

async function savePick({ groupId, type, title, description, url, imageUrl,
  addedById, addedByName, reviewerName, reviewerScore, reviewerQuote, reviewerVideoId }) {
  const { data, error } = await supabase
    .from('picks')
    .insert({
      group_id: groupId, type, title, description, url, image_url: imageUrl,
      added_by_id: addedById, added_by_name: addedByName,
      reviewer_name: reviewerName, reviewer_score: reviewerScore,
      reviewer_quote: reviewerQuote, reviewer_video_id: reviewerVideoId
    })
    .select()
    .single();
  if (error) { console.error('savePick error:', error.message); return null; }
  return data;
}

async function updatePickMessageId(pickId, messageId) {
  await supabase.from('picks').update({ message_id: messageId }).eq('id', pickId);
}

async function getPick(pickId) {
  const { data, error } = await supabase
    .from('picks').select('*').eq('id', pickId).single();
  if (error) { console.error('getPick error:', error.message); return null; }
  return data;
}

async function getGroupPicks(groupId, days = 30) {
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
  const { data, error } = await supabase
    .from('picks').select('*')
    .eq('group_id', groupId)
    .gte('created_at', since)
    .order('created_at', { ascending: false });
  if (error) { console.error('getGroupPicks error:', error.message); return []; }
  return data || [];
}

async function getRecentFilmiCraftPicks(limit = 5) {
  const { data, error } = await supabase
    .from('picks').select('*')
    .not('reviewer_name', 'is', null)
    .order('created_at', { ascending: false })
    .limit(limit);
  if (error) { console.error('getRecentFilmiCraftPicks error:', error.message); return []; }
  return data || [];
}

// ─── VOTES ─────────────────────────────────────────────────

async function upsertVote({ pickId, userId, username, firstName, status }) {
  const { error } = await supabase
    .from('votes')
    .upsert({
      pick_id: pickId, user_id: userId,
      username, first_name: firstName, status,
      updated_at: new Date().toISOString()
    }, { onConflict: 'pick_id,user_id' });
  if (error) { console.error('upsertVote error:', error.message); }
}

async function deleteVote(pickId, userId) {
  const { error } = await supabase
    .from('votes')
    .delete()
    .eq('pick_id', pickId)
    .eq('user_id', userId);
  if (error) { console.error('deleteVote error:', error.message); }
}

async function getVote(pickId, userId) {
  const { data } = await supabase
    .from('votes')
    .select('status')
    .eq('pick_id', pickId)
    .eq('user_id', userId)
    .single();
  return data;
}

async function getVotesForPick(pickId) {
  const { data, error } = await supabase
    .from('votes').select('*').eq('pick_id', pickId);
  if (error) { console.error('getVotesForPick error:', error.message); return []; }
  return data || [];
}

async function getVotesForPicks(pickIds) {
  if (!pickIds.length) return [];
  const { data, error } = await supabase
    .from('votes').select('*').in('pick_id', pickIds);
  if (error) { console.error('getVotesForPicks error:', error.message); return []; }
  return data || [];
}

async function getUserPendingPicks(groupId, userId) {
  const picks = await getGroupPicks(groupId);
  const pickIds = picks.map(p => p.id);
  const votes = await getVotesForPicks(pickIds);
  const votedPickIds = new Set(
    votes.filter(v => v.user_id === userId).map(v => v.pick_id)
  );
  return picks.filter(p => !votedPickIds.has(p.id));
}

// ─── YOUTUBE TRACKING ──────────────────────────────────────

async function wasVideoPosted(videoId) {
  const { data } = await supabase
    .from('posted_videos').select('video_id').eq('video_id', videoId).single();
  return !!data;
}

async function markVideoPosted(videoId, channelId, title) {
  await supabase.from('posted_videos').upsert({
    video_id: videoId, channel_id: channelId, title,
    posted_at: new Date().toISOString()
  });
}

module.exports = {
  ensureGroup, getAllGroups,
  savePick, updatePickMessageId, getPick, getGroupPicks,
  getRecentFilmiCraftPicks,
  upsertVote, deleteVote, getVote, getVotesForPick,
  getVotesForPicks, getUserPendingPicks,
  wasVideoPosted, markVideoPosted
};
