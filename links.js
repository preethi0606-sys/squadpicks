// links.js — Link detection, metadata fetching, card formatting
// Primary movie/show database: TMDB (themoviedb.org)
// YouTube: oEmbed API (no key needed)
// Google Maps: redirect-follow + place name extraction
'use strict';

const ogs = require('open-graph-scraper');

// ─── DETECT LINK TYPE FROM URL ─────────────────────────────

function detectType(url, meta = {}) {
  const u = url.toLowerCase();

  // Movies & Shows — TMDB as primary, IMDB still detected (resolved via TMDB)
  if (/themoviedb\.org\/movie/.test(u))              return 'movie';
  if (/themoviedb\.org\/tv/.test(u))                 return 'show';
  if (/letterboxd\.com/.test(u))                     return 'movie';
  if (/rottentomatoes\.com/.test(u))                 return 'movie';
  if (/justwatch\.com/.test(u))                      return 'show';
  if (/netflix\.com/.test(u))                        return 'show';
  if (/primevideo\.com/.test(u))                     return 'show';
  if (/hotstar\.com/.test(u))                        return 'show';
  if (/sonyliv\.com/.test(u))                        return 'show';
  if (/imdb\.com/.test(u))                           return 'movie';

  // YouTube
  if (/youtube\.com\/watch|youtu\.be\//.test(u))     return 'video';
  if (/youtube\.com\/(shorts|live)/.test(u))         return 'video';

  // Social media — Facebook (all URL patterns including share/r/ short links)
  if (/facebook\.com\/(events|pages\/.*\/events)/.test(u)) return 'event';
  if (/facebook\.com\/share\//.test(u))                    return 'link';  // share short links
  if (/fb\.com\/|fb\.me\//.test(u))                        return 'link';  // other FB short links
  if (/facebook\.com/.test(u))                             return 'link';
  if (/instagram\.com\/(reel|reels|tv)/.test(u))           return 'video';
  if (/instagram\.com/.test(u))                            return 'link';
  if (/threads\.net/.test(u))                              return 'link';
  if (/twitter\.com|x\.com/.test(u))                       return 'link';
  if (/tiktok\.com/.test(u))                               return 'video';

  // Food
  if (/yelp\.com/.test(u))                           return 'food';
  if (/zomato\.com/.test(u))                         return 'food';
  if (/swiggy\.com/.test(u))                         return 'food';
  if (/opentable\.com/.test(u))                      return 'food';
  if (/doordash\.com/.test(u))                       return 'food';
  if (/ubereats\.com/.test(u))                       return 'food';

  // Places — all Google Maps URL patterns
  if (/maps\.app\.goo\.gl/.test(u))                  return 'place';
  if (/maps\.google\.com/.test(u))                   return 'place';
  if (/goo\.gl\/maps/.test(u))                       return 'place';
  if (/tripadvisor\.com/.test(u))                    return 'place';
  if (/airbnb\.com\/experiences/.test(u))            return 'place';

  // Events
  if (/eventbrite\.com/.test(u))                     return 'event';
  if (/bookmyshow\.com/.test(u))                     return 'event';
  if (/meetup\.com/.test(u))                         return 'event';
  if (/ticketmaster\.com/.test(u))                   return 'event';

  return 'link';
}

// ─── SMART TITLE FALLBACK ──────────────────────────────────

function titleFromUrl(url) {
  try {
    const u    = new URL(url);
    const host = u.hostname.replace(/^www\./, '');
    const path = u.pathname;
    if (/themoviedb\.org/.test(host))                  return 'Title on TMDB';
    if (/letterboxd\.com/.test(host))                  return 'Movie on Letterboxd';
    if (/maps\.app\.goo\.gl|maps\.google/.test(url))   return 'Google Maps location';
    if (/zomato\.com/.test(host))                      return 'Restaurant on Zomato';
    if (/yelp\.com/.test(host))                        return 'Restaurant on Yelp';
    if (/swiggy\.com/.test(host))                      return 'Restaurant on Swiggy';
    if (/eventbrite\.com/.test(host))                  return 'Event on Eventbrite';
    if (/bookmyshow\.com/.test(host))                  return 'Event on BookMyShow';
    if (/tripadvisor\.com/.test(host))                 return 'Place on TripAdvisor';
    if (/youtube\.com|youtu\.be/.test(host))           return 'YouTube video';
    if (/netflix\.com/.test(host))                     return 'Netflix title';
    if (/hotstar\.com/.test(host))                     return 'Hotstar title';
    if (/primevideo\.com/.test(host))                  return 'Prime Video title';
    if (/imdb\.com/.test(host))                        return 'Movie (via TMDB)';
    const segments = path.split('/').filter(Boolean);
    if (segments.length) {
      const last    = segments[segments.length - 1];
      const cleaned = last.replace(/[-_]/g, ' ').replace(/\.\w+$/, '').replace(/\b\w/g, c => c.toUpperCase()).trim();
      if (cleaned.length > 2 && cleaned.length < 80) return cleaned;
    }
    return host;
  } catch (e) { return url; }
}

// ─── SHARED FETCH HELPER ───────────────────────────────────

const nodeFetch = (...a) => import('node-fetch').then(m => m.default(...a));
const tmdbHeaders = () => ({ 'Authorization': `Bearer ${process.env.TMDB_API_KEY}`, 'Accept': 'application/json' });

// ─── YOUTUBE oEMBED ────────────────────────────────────────
// Free, no API key needed. Always works for public videos.

async function fetchYoutubeMeta(url) {
  try {
    const endpoint = `https://www.youtube.com/oembed?url=${encodeURIComponent(url)}&format=json`;
    const r = await nodeFetch(endpoint, { signal: AbortSignal.timeout(8000) });
    if (!r.ok) { console.warn('[YouTube oEmbed] HTTP', r.status); return null; }
    const d = await r.json();
    if (!d.title) return null;
    console.log('[YouTube oEmbed] OK:', d.title);
    return {
      title:       d.title,
      description: d.author_name ? `by ${d.author_name}` : '',
      imageUrl:    d.thumbnail_url || '',
      sourceUrl:   url,
    };
  } catch (e) {
    console.warn('[YouTube oEmbed] Error:', e.message);
    return null;
  }
}

// ─── GOOGLE MAPS — short link expander ─────────────────────
// maps.app.goo.gl is a short URL that redirects to a full Maps URL.
// We follow the redirect and extract the place name from the path.

async function fetchGoogleMapsMeta(url) {
  try {
    const r = await nodeFetch(url, {
      redirect: 'follow',
      headers: {
        'User-Agent':      'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
        'Accept-Language': 'en-US,en;q=0.9',
      },
      signal: AbortSignal.timeout(10000),
    });

    const finalUrl = r.url;
    console.log('[GMaps] Resolved URL:', finalUrl.slice(0, 120));

    let placeName = '';

    // Pattern 1: /maps/place/Place+Name/@lat,lng
    const m1 = finalUrl.match(/\/maps\/(?:place|search)\/([^/@?&#]+)/i);
    if (m1) placeName = decodeURIComponent(m1[1].replace(/\+/g, ' ')).trim();

    // Pattern 2: ?q=Place+Name
    if (!placeName) {
      const m2 = finalUrl.match(/[?&]q=([^&&#]+)/i);
      if (m2) placeName = decodeURIComponent(m2[1].replace(/\+/g, ' ')).trim();
    }

    // Pattern 3: scrape og:title from page HTML
    if (!placeName && r.ok) {
      const html  = await r.text();
      const ogMatch = html.match(/<meta[^>]+property="og:title"[^>]+content="([^"]+)"/i)
                   || html.match(/<meta[^>]+content="([^"]+)"[^>]+property="og:title"/i);
      if (ogMatch) placeName = ogMatch[1].replace(/\s*[-–|]\s*Google Maps\s*$/i, '').trim();
    }

    if (!placeName) {
      return { title: 'Google Maps location', description: 'View on Google Maps', imageUrl: '', sourceUrl: url };
    }

    console.log('[GMaps] Place name:', placeName);
    return {
      title:       placeName,
      description: 'View on Google Maps',
      imageUrl:    '',   // no image without Maps API key — emoji fallback used
      sourceUrl:   url,
    };
  } catch (e) {
    console.warn('[GMaps] Error:', e.message);
    return { title: 'Google Maps location', description: 'View on Google Maps', imageUrl: '', sourceUrl: url };
  }
}

// ─── TMDB LOOKUP BY TMDB URL ────────────────────────────────

async function fetchTmdbByUrl(url) {
  if (!process.env.TMDB_API_KEY) return null;
  try {
    const movieM = url.match(/themoviedb\.org\/movie\/(\d+)/i);
    const tvM    = url.match(/themoviedb\.org\/tv\/(\d+)/i);
    const id   = (movieM && movieM[1]) || (tvM && tvM[1]);
    const type = movieM ? 'movie' : 'tv';
    if (!id) return null;

    const r = await nodeFetch(
      `https://api.themoviedb.org/3/${type}/${id}?language=en-US`,
      { headers: tmdbHeaders(), signal: AbortSignal.timeout(8000) }
    );
    if (!r.ok) return null;
    const d = await r.json();

    const title  = d.title || d.name || '';
    const year   = (d.release_date || d.first_air_date || '').slice(0, 4);
    const rating = d.vote_average ? `⭐ ${d.vote_average.toFixed(1)}` : '';
    const genres = (d.genres || []).slice(0, 2).map(g => g.name).join(', ');
    const imgUrl = d.poster_path ? `https://image.tmdb.org/t/p/w500${d.poster_path}` : '';
    const desc   = [d.overview?.slice(0, 150), year && `(${year})`, rating, genres].filter(Boolean).join(' · ');

    console.log('[TMDB URL] OK:', title);
    return { title, description: desc, imageUrl: imgUrl, sourceUrl: url };
  } catch (e) {
    console.warn('[TMDB URL] Error:', e.message);
    return null;
  }
}

// ─── TMDB LOOKUP BY IMDB ID ────────────────────────────────

async function fetchTmdbByImdbId(imdbId) {
  if (!process.env.TMDB_API_KEY) return null;
  try {
    const r = await nodeFetch(
      `https://api.themoviedb.org/3/find/${imdbId}?external_source=imdb_id`,
      { headers: tmdbHeaders(), signal: AbortSignal.timeout(8000) }
    );
    if (!r.ok) { console.warn('[TMDB/IMDB] HTTP', r.status); return null; }
    const d    = await r.json();
    const item = (d.movie_results && d.movie_results[0]) || (d.tv_results && d.tv_results[0]);
    if (!item) { console.warn('[TMDB/IMDB] No result for', imdbId); return null; }

    const title  = item.title || item.name || '';
    const year   = (item.release_date || item.first_air_date || '').slice(0, 4);
    const rating = item.vote_average ? `⭐ ${item.vote_average.toFixed(1)}` : '';
    const imgUrl = item.poster_path  ? `https://image.tmdb.org/t/p/w500${item.poster_path}` : '';
    const desc   = [item.overview?.slice(0, 150), year && `(${year})`, rating].filter(Boolean).join(' · ');

    console.log('[TMDB/IMDB] OK:', title, '| poster:', imgUrl ? 'yes' : 'no');
    return { title, description: desc, imageUrl: imgUrl, sourceUrl: null };
  } catch (e) {
    console.warn('[TMDB/IMDB] Error:', e.message);
    return null;
  }
}

// ─── TMDB SEARCH BY TITLE ──────────────────────────────────
// type: 'movie' | 'tv' | 'multi'
// Returns poster URL — used by scrapers for bulk enrichment

async function fetchTmdbByTitle(title, type = 'multi') {
  if (!process.env.TMDB_API_KEY || !title) return null;
  try {
    const q = encodeURIComponent(title.trim());
    const r = await nodeFetch(
      `https://api.themoviedb.org/3/search/${type}?query=${q}&include_adult=false&language=en-US&page=1`,
      { headers: tmdbHeaders(), signal: AbortSignal.timeout(8000) }
    );
    if (!r.ok) return null;
    const d    = await r.json();
    const item = d.results && d.results[0];
    if (!item || !item.poster_path) return null;
    return `https://image.tmdb.org/t/p/w500${item.poster_path}`;
  } catch (e) {
    return null;
  }
}

// ─── FACEBOOK SHARE URL HANDLER ────────────────────────────
// facebook.com/share/r/CODE is a short redirect link.
// We follow it using facebookexternalhit UA, scrape OG tags from the resolved page.

function decodeFbHtml(str) {
  return str
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&#x27;/g, "'");
}

function cleanFbTitle(raw) {
  if (!raw) return '';
  const decoded = decodeFbHtml(raw).trim();
  // Facebook OG titles often look like:
  //   "1.2K likes · Some Venue Name" (dot separator)
  //   "Some Post Title | Facebook"   (pipe separator with Facebook suffix)
  //   "3.4K followers, 1.1K following, 200 posts - See Instagram photos..."
  // Strategy: if there's a pipe/bullet/· separator, take the LAST segment
  // (the meaningful name is always after the stats/counts)
  const parts = decoded.split(/\s*[|·•]\s*/);
  if (parts.length >= 2) {
    // Take the last non-empty segment, strip trailing "Facebook"/"Instagram" etc.
    const meaningful = parts[parts.length - 1]
      .replace(/\s*[-–|]\s*(Facebook|Instagram|Twitter|TikTok)\s*$/i, '')
      .trim();
    if (meaningful.length > 2) return meaningful;
  }
  // If no separator: strip trailing "| Facebook" or "- Facebook"
  return decoded.replace(/\s*[-–|]\s*(Facebook|Instagram|Twitter|TikTok)\s*$/i, '').trim();
}

async function fetchFacebookMeta(url) {
  try {
    const r = await nodeFetch(url, {
      redirect: 'follow',
      headers: {
        'User-Agent':      'facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)',
        'Accept':          'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
      },
      signal: AbortSignal.timeout(12000),
    });
    const finalUrl = r.url;
    const html     = await r.text();

    // Extract OG meta tags — try both attribute orderings
    function extractMeta(prop) {
      const m = html.match(new RegExp(`<meta[^>]+property="${prop}"[^>]+content="([^"]+)"`, 'i'))
             || html.match(new RegExp(`<meta[^>]+content="([^"]+)"[^>]+property="${prop}"`, 'i'));
      return m ? decodeFbHtml(m[1]) : '';
    }

    const rawTitle = extractMeta('og:title');
    const rawDesc  = extractMeta('og:description');
    const rawImg   = extractMeta('og:image');

    const title = cleanFbTitle(rawTitle);
    const desc  = rawDesc ? rawDesc.replace(/\s+/g, ' ').slice(0, 100) : '';
    const img   = rawImg || '';

    if (title) {
      console.log('[Facebook] Resolved:', title, '| image:', img ? 'yes' : 'no');
      return { title, description: desc, imageUrl: img, sourceUrl: finalUrl || url };
    }

    console.warn('[Facebook] No OG title found — using fallback');
    return { title: 'Facebook post', description: 'View on Facebook', imageUrl: img, sourceUrl: finalUrl || url };
  } catch (e) {
    console.warn('[Facebook] Error:', e.message);
    return { title: 'Facebook post', description: 'View on Facebook', imageUrl: '', sourceUrl: url };
  }
}

// ─── SOCIAL MEDIA OGS HANDLER ──────────────────────────────
// For Instagram, TikTok, Twitter/X — try OGS with social bot UA

async function fetchSocialMeta(url) {
  try {
    const { result } = await ogs({
      url,
      timeout: 10000,
      fetchOptions: {
        headers: {
          'User-Agent': 'facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)',
          'Accept-Language': 'en-US,en;q=0.9',
        }
      }
    });
    const title = result.ogTitle || result.twitterTitle || '';
    if (title) {
      return {
        title:       title.trim(),
        description: result.ogDescription || result.twitterDescription || '',
        imageUrl:    result.ogImage?.[0]?.url || '',
        sourceUrl:   url,
      };
    }
  } catch(e) {}
  // Fallback with a descriptive title based on host
  const host = (() => { try { return new URL(url).hostname.replace('www.',''); } catch(e){ return 'social media'; } })();
  return { title: `Post on ${host}`, description: 'View on ' + host, imageUrl: '', sourceUrl: url };
}

// ─── FETCH METADATA FROM ANY URL ───────────────────────────

async function fetchMeta(url) {
  const u = url.toLowerCase();

  // YouTube: oEmbed API — reliable, no key needed
  if (/youtube\.com\/watch|youtu\.be\/|youtube\.com\/(shorts|live)/.test(u)) {
    const meta = await fetchYoutubeMeta(url);
    if (meta) return meta;
  }

  // Google Maps: follow redirect and extract place name
  if (/maps\.app\.goo\.gl|goo\.gl\/maps|maps\.google\.com/.test(u)) {
    return fetchGoogleMapsMeta(url);
  }

  // TMDB direct URL: fetch by ID
  if (/themoviedb\.org\/(movie|tv)\/\d+/.test(u)) {
    const meta = await fetchTmdbByUrl(url);
    if (meta) return meta;
  }

  // IMDB URL: resolve via TMDB using the tt ID
  if (/imdb\.com\/(title|name)/.test(u)) {
    const imdbId = url.match(/imdb\.com\/title\/(tt\d+)/i)?.[1];
    if (imdbId && process.env.TMDB_API_KEY) {
      const tmdb = await fetchTmdbByImdbId(imdbId);
      if (tmdb && tmdb.title) return { ...tmdb, sourceUrl: url };
    }
    console.warn('[fetchMeta] IMDB URL — TMDB lookup failed or no key');
  }

  // Facebook share URLs (facebook.com/share/r/... etc) — follow redirect then scrape OG
  if (/facebook\.com\/share\/|fb\.com\/|fb\.me\//.test(u)) {
    return fetchFacebookMeta(url);
  }

  // All other Facebook/Instagram/TikTok/Twitter URLs — try OGS with mobile UA
  if (/facebook\.com|instagram\.com|threads\.net|twitter\.com|x\.com|tiktok\.com/.test(u)) {
    return fetchSocialMeta(url);
  }
  try {
    const { result } = await ogs({
      url,
      timeout: 12000,
      fetchOptions: {
        headers: {
          'User-Agent':      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
          'Accept-Language': 'en-US,en;q=0.9',
        }
      }
    });
    const title = result.ogTitle || result.twitterTitle || result.dcTitle || '';
    if (title) {
      return {
        title:       title.trim(),
        description: result.ogDescription || result.twitterDescription || '',
        imageUrl:    result.ogImage?.[0]?.url || '',
        sourceUrl:   url,
      };
    }
    throw new Error('no title in ogs result');
  } catch (err) {
    console.warn('[fetchMeta] ogs failed for:', url.slice(0, 60), '-', err.message);
    return { title: titleFromUrl(url), description: '', imageUrl: '', sourceUrl: url };
  }
}

// ─── EXTRACT URLS FROM TEXT ─────────────────────────────────

function extractUrls(text) {
  return (text.match(/https?:\/\/[^\s]+/gi) || []);
}

// ─── TYPE LABELS ───────────────────────────────────────────

const TYPE_LABELS = {
  movie: '🎬 Movie',
  show:  '📺 Show',
  food:  '🍽 Restaurant',
  place: '📍 Place',
  event: '🎭 Event',
  video: '▶️ Video',
  link:  '🔗 Link',
};

function typeLabel(type) { return TYPE_LABELS[type] || '🔗 Link'; }

// ─── FORMAT PICK CARD (Telegram HTML) ──────────────────────

function formatCard(pick, votes) {
  const seen = votes.filter(v => v.status === 'seen').map(v => v.first_name || v.username || 'Someone');
  const want = votes.filter(v => v.status === 'want').map(v => v.first_name || v.username || 'Someone');
  const skip = votes.filter(v => v.status === 'skip').map(v => v.first_name || v.username || 'Someone');
  const groupOk = skip.length === 0 && (seen.length + want.length + skip.length) > 0;

  let text = `<b>${typeLabel(pick.type)}  |  ${escHtml(pick.title)}</b>\n`;
  if (pick.description) text += `<i>${escHtml(truncate(pick.description, 100))}</i>\n`;
  text += '\n';

  if (pick.reviewer_name) {
    text += `📺 <b>${escHtml(pick.reviewer_name)}</b>`;
    if (pick.reviewer_score) text += `  ⭐ <b>${escHtml(pick.reviewer_score)}</b>`;
    if (pick.reviewer_quote) text += `\n<i>"${escHtml(pick.reviewer_quote)}"</i>`;
    text += '\n\n';
  }

  if (seen.length) text += `✅ <b>Seen/Been:</b> ${escHtml(seen.join(', '))}\n`;
  if (want.length) text += `⭐ <b>Want to:</b>   ${escHtml(want.join(', '))}\n`;
  if (skip.length) text += `❌ <b>Not for me:</b> ${escHtml(skip.join(', '))}\n`;
  if (!seen.length && !want.length && !skip.length) text += `<i>No votes yet — be the first!</i>\n`;
  if (groupOk) text += `\n✅ <b>Group ok — everyone can do this together!</b>`;
  text += `\n\n<i>Added by ${escHtml(pick.added_by_name || 'someone')} · via SquadPicks</i>`;
  return text;
}

// ─── FORMAT SUMMARY ────────────────────────────────────────

function formatSummary(picks, allVotes) {
  const groupOk = [], hasSkip = [], pending = [];
  for (const pick of picks) {
    const pv = allVotes.filter(v => v.pick_id === pick.id);
    if (pv.filter(v => v.status === 'skip').length) hasSkip.push({ pick, votes: pv });
    else if (pv.length) groupOk.push({ pick, votes: pv });
    else pending.push({ pick });
  }
  let text = `📊 <b>SquadPicks Summary</b>\n\n`;
  if (groupOk.length) {
    text += `✅ <b>Group can do together (${groupOk.length})</b>\n`;
    groupOk.forEach(({ pick, votes }) => {
      text += `  • ${escHtml(pick.title)}`;
      if (pick.reviewer_score) text += ` · ⭐${pick.reviewer_score}`;
      const want = votes.filter(v => v.status === 'want').length;
      const seen = votes.filter(v => v.status === 'seen').length;
      if (want) text += ` · ${want} want`;
      if (seen) text += ` · ${seen} seen`;
      text += '\n';
    });
    text += '\n';
  }
  if (hasSkip.length) {
    text += `⚠️ <b>Someone said not for me (${hasSkip.length})</b>\n`;
    hasSkip.forEach(({ pick, votes }) => {
      const skipper = votes.filter(v => v.status === 'skip').map(v => v.first_name || 'Someone').join(', ');
      text += `  • ${escHtml(pick.title)} — ${escHtml(skipper)} skipped\n`;
    });
    text += '\n';
  }
  if (pending.length) {
    text += `⏳ <b>No votes yet (${pending.length})</b>\n`;
    pending.forEach(({ pick }) => { text += `  • ${escHtml(pick.title)}\n`; });
    text += '\n';
  }
  if (!picks.length) text += `<i>No picks yet! Paste any link to get started.</i>`;
  text += `\n<i>Type /pending to see what YOU still need to vote on.</i>`;
  return text;
}

// ─── FORMAT WEEKLY DIGEST ──────────────────────────────────

function formatDigest(newPicks, fcPicks, pendingCount) {
  let text = `📅 <b>SquadPicks — Weekly Digest</b>\n<i>Here's what happened this week</i>\n\n`;
  if (newPicks.length) {
    text += `🆕 <b>New picks (${newPicks.length})</b>\n`;
    newPicks.slice(0, 8).forEach(p => {
      text += `  ${typeLabel(p.type).split(' ')[0]} ${escHtml(p.title)} · by ${escHtml(p.added_by_name || 'someone')}\n`;
    });
    text += '\n';
  }
  if (fcPicks.length) {
    text += `📺 <b>Filmi Craft reviewed this week</b>\n`;
    fcPicks.forEach(p => {
      text += `  🎬 ${escHtml(p.title)}`;
      if (p.reviewer_score) text += ` · ⭐ ${p.reviewer_score}`;
      text += '\n';
    });
    text += '\n';
  }
  if (pendingCount > 0) {
    text += `⏳ <b>${pendingCount} pick${pendingCount > 1 ? 's' : ''} waiting for your vote</b>\nType /pending to see them.\n\n`;
  }
  text += `<i>Have a great week from SquadPicks! 🎬🍜📍</i>`;
  return text;
}

function formatFilmiCraftCard(pick, votes) { return formatCard(pick, votes); }

// ─── KEYBOARDS ─────────────────────────────────────────────

function buildVoteKeyboard(pickId, groupId) {
  const botUsername = process.env.BOT_USERNAME        || 'squadpicks_bot';
  const shortName   = process.env.MINI_APP_SHORT_NAME || 'Squadpicks';
  const startParam  = groupId ? `?startapp=${groupId}` : '';
  return {
    inline_keyboard: [
      [
        { text: '✅ Seen/Been',  callback_data: `vote_${pickId}_seen` },
        { text: '⭐ Want to',    callback_data: `vote_${pickId}_want` },
        { text: '❌ Not for me', callback_data: `vote_${pickId}_skip` },
      ],
      [{ text: '🚀 Open in SquadPicks', url: `https://t.me/${botUsername}/${shortName}${startParam}` }]
    ]
  };
}

function buildSummaryKeyboard() {
  return {
    inline_keyboard: [[
      { text: '📋 Pending',  callback_data: 'cmd_pending' },
      { text: '📺 FC Picks', callback_data: 'cmd_fcpicks' },
      { text: '💡 Suggest',  callback_data: 'cmd_suggest' },
    ]]
  };
}

// ─── HELPERS ───────────────────────────────────────────────

function escHtml(str) {
  if (!str) return '';
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function truncate(str, len) {
  if (!str) return '';
  return str.length > len ? str.slice(0, len) + '...' : str;
}

module.exports = {
  detectType, fetchMeta, extractUrls,
  fetchTmdbByTitle, fetchTmdbByImdbId,
  typeLabel, formatCard, formatSummary,
  formatDigest, formatFilmiCraftCard,
  buildVoteKeyboard, buildSummaryKeyboard,
  escHtml, truncate
};
