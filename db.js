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

// Returns only real Telegram groups (negative IDs) — excludes private/DM chats (positive IDs)
// Telegram group IDs are always negative; private chat IDs are positive.
async function getAllGroups() {
  const { data, error } = await supabase
    .from('groups')
    .select('id, title, is_web_group')
    .lt('id', 0);   // negative IDs = real groups/supergroups only
  if (error) { console.error('getAllGroups error:', error.message); return []; }
  return data || [];
}

// Returns groups for a specific user — two plain queries, no FK join required
async function getUserGroups(userId) {
  // Step 1: get the group_ids this user belongs to
  const { data: memberRows, error: memberErr } = await supabase
    .from('group_members')
    .select('group_id')
    .eq('user_id', userId)
    .eq('status', 'active');

  if (memberErr) { console.error('getUserGroups members error:', memberErr.message); return []; }
  if (!memberRows || !memberRows.length) return [];

  const groupIds = memberRows.map(r => r.group_id);

  // Step 2: fetch the actual group records by those IDs
  const { data: groups, error: groupErr } = await supabase
    .from('groups')
    .select('id, title, is_web_group')
    .in('id', groupIds);

  if (groupErr) { console.error('getUserGroups groups error:', groupErr.message); return []; }

  // Only return real groups: web groups (any ID) + Telegram groups (negative IDs)
  return (groups || []).filter(g => g.is_web_group || g.id < 0);
}

// ─── PICKS ─────────────────────────────────────────────────

async function savePick({ groupId, type, title, description, url, imageUrl, sourceUrl,
  addedById, addedByName, reviewerName, reviewerScore, reviewerQuote, reviewerVideoId }) {
  const { data, error } = await supabase
    .from('picks')
    .insert({
      group_id: groupId, type, title, description,
      url: sourceUrl || url,          // store the original source URL
      image_url: imageUrl,
      added_by_id: addedById, added_by_name: addedByName,
      reviewer_name: reviewerName, reviewer_score: reviewerScore,
      reviewer_quote: reviewerQuote, reviewer_video_id: reviewerVideoId
    })
    .select()
    .single();
  if (error) { console.error('savePick error:', error.message); return null; }
  return data;
}

// ─── USERS (Google + Telegram) ──────────────────────────────

async function upsertGoogleUser({ google_id, email, name, avatar }) {
  const { data, error } = await supabase
    .from('users')
    .upsert({ google_id, email, name, avatar, updated_at: new Date().toISOString() },
             { onConflict: 'google_id' })
    .select().single();
  if (error) { console.error('upsertGoogleUser error:', error.message); return null; }
  return data;
}

async function upsertTelegramUser({ telegram_id, first_name, username }) {
  const name = first_name || username || 'Member';
  const { data, error } = await supabase
    .from('users')
    .upsert({ telegram_id, name, updated_at: new Date().toISOString() },
             { onConflict: 'telegram_id' })
    .select().single();
  if (error) { console.error('upsertTelegramUser error:', error.message); return null; }
  return data;
}

async function getUserById(id) {
  const { data } = await supabase.from('users').select('*').eq('id', id).single();
  return data;
}

async function getUserByEmail(email) {
  const { data } = await supabase
    .from('users').select('*').eq('email', email).single();
  return data;
}

async function addPendingInvite({ groupId, email, invitedBy }) {
  const { error } = await supabase
    .from('group_members')
    .upsert({ group_id: groupId, email, status: 'invited', invited_by: invitedBy },
             { onConflict: 'group_id,email' });
  if (error) console.error('addPendingInvite error:', error.message);
}

// When a new Google user signs up, auto-join any pending invites for their email
async function applyPendingInvites(userId, email) {
  try {
    const { data: pending } = await supabase
      .from('group_members')
      .select('group_id')
      .eq('email', email)
      .eq('status', 'invited');
    if (!pending || !pending.length) return;
    for (const row of pending) {
      await supabase.from('group_members')
        .update({ user_id: userId, status: 'active' })
        .eq('group_id', row.group_id).eq('email', email);
    }
    console.log(`[DB] Applied ${pending.length} pending invite(s) for ${email}`);
  } catch(e) { console.error('applyPendingInvites error:', e.message); }
}

async function createWebGroup({ name, ownerId }) {
  // Use a negative fake chat ID for web-only groups (won't clash with real Telegram IDs)
  const webGroupId = -Math.floor(Math.random() * 9000000000 + 1000000000);
  const { data, error } = await supabase
    .from('groups')
    .insert({ id: webGroupId, title: name, is_web_group: true, owner_id: ownerId })
    .select().single();
  if (error) { console.error('createWebGroup error:', error.message); return null; }
  return data;
}

async function addGroupMember({ groupId, userId, email }) {
  const { data, error } = await supabase
    .from('group_members')
    .upsert({ group_id: groupId, user_id: userId, email, status: 'active' },
             { onConflict: 'group_id,user_id' })
    .select().single();
  if (error) { console.error('addGroupMember error:', error.message); return null; }
  return data;
}

// Used when linking a Telegram group or creating a squad — handles both user_id and email conflict paths
async function addGroupMemberByEmail({ groupId, userId, email }) {
  // Check for existing row by email (maybeSingle returns null instead of throwing when no row)
  const { data: existing } = await supabase
    .from('group_members')
    .select('id')
    .eq('group_id', groupId)
    .eq('email', email)
    .maybeSingle();

  if (existing) {
    // Update the existing invite row with the user_id
    const { error } = await supabase
      .from('group_members')
      .update({ user_id: userId, status: 'active' })
      .eq('id', existing.id);
    if (error) console.error('addGroupMemberByEmail update error:', error.message);
    return;
  }

  // Check for existing row by user_id (prevent duplicate key error)
  const { data: existingByUser } = await supabase
    .from('group_members')
    .select('id')
    .eq('group_id', groupId)
    .eq('user_id', userId)
    .maybeSingle();

  if (existingByUser) {
    // Already a member — just make sure status is active
    await supabase.from('group_members').update({ status: 'active', email }).eq('id', existingByUser.id);
    return;
  }

  // No existing row — insert fresh
  const { error } = await supabase
    .from('group_members')
    .insert({ group_id: groupId, user_id: userId, email, status: 'active' });
  if (error) console.error('addGroupMemberByEmail insert error:', error.message);
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

async function renameGroup(groupId, newTitle, ownerId) {
  // Only allow rename if user is the owner
  const { data, error } = await supabase
    .from('groups')
    .update({ title: newTitle })
    .eq('id', groupId)
    .eq('owner_id', ownerId)
    .select('id, title, is_web_group')
    .single();
  if (error) { console.error('renameGroup error:', error.message); return null; }
  return data;
}

async function deleteGroup(groupId, ownerId) {
  // Only allow delete if user is the owner of a web group
  const { error } = await supabase
    .from('groups')
    .delete()
    .eq('id', groupId)
    .eq('owner_id', ownerId)
    .eq('is_web_group', true);
  if (error) { console.error('deleteGroup error:', error.message); return false; }
  return true;
}

async function getGroupMembers(groupId) {
  // Get members — join to users table for name/email
  const { data: memberRows, error: mErr } = await supabase
    .from('group_members')
    .select('id, user_id, email, status')
    .eq('group_id', groupId)
    .order('status', { ascending: false }); // active first
  if (mErr) { console.error('getGroupMembers error:', mErr.message); return []; }
  if (!memberRows || !memberRows.length) return [];

  // Fetch user details for members who have user_id
  const userIds = memberRows.filter(r => r.user_id).map(r => r.user_id);
  let userMap = {};
  if (userIds.length) {
    const { data: users } = await supabase
      .from('users')
      .select('id, name, email, avatar')
      .in('id', userIds);
    (users || []).forEach(u => { userMap[u.id] = u; });
  }

  return memberRows.map(r => ({
    memberId: r.id,
    userId:   r.user_id,
    email:    r.email || userMap[r.user_id]?.email || '',
    name:     userMap[r.user_id]?.name || r.email || 'Pending',
    avatar:   userMap[r.user_id]?.avatar || null,
    status:   r.status
  }));
}

async function removeGroupMember(memberId, groupId, requestingOwnerId) {
  // Verify requester is the owner before removing
  const { data: grp } = await supabase
    .from('groups')
    .select('owner_id')
    .eq('id', groupId)
    .maybeSingle();
  if (!grp || String(grp.owner_id) !== String(requestingOwnerId)) return false;

  const { error } = await supabase
    .from('group_members')
    .delete()
    .eq('id', memberId)
    .eq('group_id', groupId);
  if (error) { console.error('removeGroupMember error:', error.message); return false; }
  return true;
}

module.exports = {
  ensureGroup, getAllGroups, getUserGroups,
  savePick, updatePickMessageId, getPick, getGroupPicks,
  getRecentFilmiCraftPicks,
  upsertVote, deleteVote, getVote, getVotesForPick,
  getVotesForPicks, getUserPendingPicks,
  wasVideoPosted, markVideoPosted,
  upsertGoogleUser, upsertTelegramUser, getUserById, getUserByEmail,
  createWebGroup, addGroupMember, addGroupMemberByEmail, getUserGroups,
  addPendingInvite, applyPendingInvites,
  renameGroup, deleteGroup, getGroupMembers, removeGroupMember
};

// ─── TRENDING DATA ──────────────────────────────────────────

async function upsertTrendingNetflix(rows) {
  if (!rows.length) return;
  const weekOf = new Date().toISOString().slice(0, 10);
  // Clear old rows for this region this week first, then insert fresh
  for (const row of rows) {
    await supabase.from('trending_netflix')
      .upsert({ ...row, week_of: weekOf, fetched_at: new Date().toISOString() },
               { onConflict: 'title,region,week_of' });
  }
  console.log(`[DB] Upserted ${rows.length} Netflix rows`);
}

async function upsertTrendingPrime(rows) {
  if (!rows.length) return;
  const weekOf = new Date().toISOString().slice(0, 10);
  for (const row of rows) {
    await supabase.from('trending_prime')
      .upsert({ ...row, week_of: weekOf, fetched_at: new Date().toISOString() },
               { onConflict: 'title,region,week_of' });
  }
  console.log(`[DB] Upserted ${rows.length} Prime rows`);
}

async function upsertTrendingImdb(rows) {
  if (!rows.length) return;
  const weekOf = new Date().toISOString().slice(0, 10);
  for (const row of rows) {
    await supabase.from('trending_imdb')
      .upsert({ ...row, week_of: weekOf, fetched_at: new Date().toISOString() },
               { onConflict: 'title,category,week_of' });
  }
  console.log(`[DB] Upserted ${rows.length} IMDb rows`);
}

async function getLatestNetflixTop10(region) {
  const { data, error } = await supabase
    .from('trending_netflix')
    .select('*')
    .eq('region', region)
    .order('week_of', { ascending: false })
    .order('rank', { ascending: true })
    .limit(10);
  if (error) { console.error('getLatestNetflixTop10:', error.message); return []; }
  return data || [];
}

async function getLatestPrimeTop10(region) {
  const { data, error } = await supabase
    .from('trending_prime')
    .select('*')
    .eq('region', region)
    .order('week_of', { ascending: false })
    .order('rank', { ascending: true })
    .limit(10);
  if (error) { console.error('getLatestPrimeTop10:', error.message); return []; }
  return data || [];
}

async function getLatestImdbTop10(category) {
  const { data, error } = await supabase
    .from('trending_imdb')
    .select('*')
    .eq('category', category)
    .order('week_of', { ascending: false })
    .order('rank', { ascending: true })
    .limit(10);
  if (error) { console.error('getLatestImdbTop10:', error.message); return []; }
  return data || [];
}

// Mixed top 10: Netflix + Prime, sorted by week then rank
async function getMixedStreamingTop10(region) {
  const [nf, pv] = await Promise.all([
    getLatestNetflixTop10(region),
    getLatestPrimeTop10(region === 'canada' ? 'ca' : region === 'india' ? 'in' : 'ca')
  ]);
  // Tag with source
  const tagged = [
    ...nf.map(r => ({ ...r, source: 'netflix', badge: 'N', badgeColor: '#E50914',
      url: r.netflix_url || `https://www.netflix.com/search?q=${encodeURIComponent(r.title)}` })),
    ...pv.map(r => ({ ...r, source: 'prime',   badge: 'P', badgeColor: '#00A8E0',
      url: r.prime_url   || `https://www.primevideo.com/search/ref=atv_nb_sr?phrase=${encodeURIComponent(r.title)}` }))
  ];
  // Sort: newest week_of first, then by rank
  tagged.sort((a, b) => {
    if (b.week_of > a.week_of) return 1;
    if (b.week_of < a.week_of) return -1;
    return (a.rank || 99) - (b.rank || 99);
  });
  return tagged.slice(0, 10);
}

module.exports = Object.assign(module.exports, {
  upsertTrendingNetflix, upsertTrendingPrime, upsertTrendingImdb,
  getLatestNetflixTop10, getLatestPrimeTop10, getLatestImdbTop10,
  getMixedStreamingTop10,
  upsertTrendingPlaces, upsertTrendingEvents,
  getLatestPlaces, getLatestEvents
});

async function upsertTrendingPlaces(rows) {
  if (!rows || !rows.length) return;
  const weekOf = new Date().toISOString().slice(0, 10);
  for (const row of rows) {
    await supabase.from('trending_places')
      .upsert({ ...row, week_of: weekOf, fetched_at: new Date().toISOString() },
               { onConflict: 'title,region,week_of' });
  }
  console.log(`[DB] Upserted ${rows.length} places rows`);
}

async function upsertTrendingEvents(rows) {
  if (!rows || !rows.length) return;
  const weekOf = new Date().toISOString().slice(0, 10);
  for (const row of rows) {
    await supabase.from('trending_events')
      .upsert({ ...row, week_of: weekOf, fetched_at: new Date().toISOString() },
               { onConflict: 'title,region,week_of' });
  }
  console.log(`[DB] Upserted ${rows.length} events rows`);
}

async function getLatestPlaces(region) {
  const { data, error } = await supabase
    .from('trending_places')
    .select('*')
    .eq('region', region)
    .order('week_of', { ascending: false })
    .order('rank', { ascending: true })
    .limit(10);
  if (error) { console.error('getLatestPlaces:', error.message); return []; }
  return data || [];
}

async function getLatestEvents(region) {
  const { data, error } = await supabase
    .from('trending_events')
    .select('*')
    .eq('region', region)
    .order('week_of', { ascending: false })
    .order('rank', { ascending: true })
    .limit(10);
  if (error) { console.error('getLatestEvents:', error.message); return []; }
  return data || [];
}
