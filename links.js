// links.js — Link detection, metadata fetching, card formatting
const ogs = require('open-graph-scraper');

// ─── DETECT LINK TYPE FROM URL ─────────────────────────────

function detectType(url, meta = {}) {
  const u = url.toLowerCase();

  // Movies & Shows
  if (/imdb\.com\/(title|name)/.test(u))        return 'movie';
  if (/letterboxd\.com/.test(u))                 return 'movie';
  if (/rottentomatoes\.com/.test(u))             return 'movie';
  if (/justwatch\.com/.test(u))                  return 'show';
  if (/netflix\.com/.test(u))                    return 'show';
  if (/primevideo\.com/.test(u))                 return 'show';
  if (/hotstar\.com/.test(u))                    return 'show';
  if (/sonyliv\.com/.test(u))                    return 'show';

  // Food & Restaurants
  if (/yelp\.com/.test(u))                       return 'food';
  if (/zomato\.com/.test(u))                     return 'food';
  if (/swiggy\.com/.test(u))                     return 'food';
  if (/opentable\.com/.test(u))                  return 'food';
  if (/doordash\.com/.test(u))                   return 'food';
  if (/ubereats\.com/.test(u))                   return 'food';

  // Places & Attractions
  if (/maps\.google|goo\.gl\/maps|maps\.app\.goo\.gl/.test(u)) return 'place';
  if (/tripadvisor\.com/.test(u))                return 'place';
  if (/airbnb\.com\/experiences/.test(u))        return 'place';

  // Events
  if (/eventbrite\.com/.test(u))                 return 'event';
  if (/bookmyshow\.com/.test(u))                 return 'event';
  if (/meetup\.com/.test(u))                     return 'event';
  if (/ticketmaster\.com/.test(u))               return 'event';

  // YouTube (trailers / reviews)
  if (/youtube\.com|youtu\.be/.test(u))          return 'video';

  return 'link'; // fallback
}

// ─── SMART TITLE FALLBACK FROM URL ────────────────────────

function titleFromUrl(url) {
  try {
    const u = new URL(url);
    const host = u.hostname.replace(/^www\./, '');
    const path = u.pathname;
    if (/imdb\.com/.test(host))        return 'Movie on IMDB';
    if (/letterboxd\.com/.test(host))  return 'Movie on Letterboxd';
    if (/maps\.google|maps\.app\.goo\.gl/.test(url)) return 'Google Maps location';
    if (/zomato\.com/.test(host))      return 'Restaurant on Zomato';
    if (/yelp\.com/.test(host))        return 'Restaurant on Yelp';
    if (/swiggy\.com/.test(host))      return 'Restaurant on Swiggy';
    if (/eventbrite\.com/.test(host))  return 'Event on Eventbrite';
    if (/bookmyshow\.com/.test(host))  return 'Event on BookMyShow';
    if (/tripadvisor\.com/.test(host)) return 'Place on TripAdvisor';
    if (/youtube\.com|youtu\.be/.test(host)) return 'YouTube video';
    if (/netflix\.com/.test(host))     return 'Netflix title';
    if (/hotstar\.com/.test(host))     return 'Hotstar title';
    if (/primevideo\.com/.test(host))  return 'Prime Video title';
    const segments = path.split('/').filter(Boolean);
    if (segments.length) {
      const last = segments[segments.length - 1];
      const cleaned = last.replace(/[-_]/g, ' ').replace(/\.\w+$/, '').replace(/\b\w/g, c => c.toUpperCase()).trim();
      if (cleaned.length > 2 && cleaned.length < 80) return cleaned;
    }
    return host;
  } catch (e) { return url; }
}

// ─── IMDB ID EXTRACTOR ─────────────────────────────────────
function extractImdbId(url) {
  const m = url.match(/imdb\.com\/title\/(tt\d+)/i);
  return m ? m[1] : null;
}

// ─── TMDB LOOKUP ───────────────────────────────────────────
// Used by fetchMeta for IMDB URLs, and by the Netflix scraper for poster enrichment.
// Requires TMDB_API_KEY env var (free read-access token from themoviedb.org/settings/api).

async function fetchTmdbByImdbId(imdbId) {
  if (!process.env.TMDB_API_KEY) return null;
  try {
    const fetch = (...a) => import('node-fetch').then(m => m.default(...a));
    const r = await fetch(
      `https://api.themoviedb.org/3/find/${imdbId}?external_source=imdb_id`,
      {
        headers: { 'Authorization': `Bearer ${process.env.TMDB_API_KEY}`, 'Accept': 'application/json' },
        signal: AbortSignal.timeout(8000)
      }
    );
    if (!r.ok) { console.warn('[TMDB] HTTP', r.status); return null; }
    const d = await r.json();
    const item = (d.movie_results && d.movie_results[0]) || (d.tv_results && d.tv_results[0]);
    if (!item) { console.warn('[TMDB] No result for', imdbId); return null; }

    const title  = item.title || item.name || '';
    const year   = (item.release_date || item.first_air_date || '').slice(0, 4);
    const rating = item.vote_average ? `⭐ ${item.vote_average.toFixed(1)}` : '';
    const imgUrl = item.poster_path  ? `https://image.tmdb.org/t/p/w500${item.poster_path}` : '';
    const desc   = [item.overview?.slice(0, 150), year && `(${year})`, rating].filter(Boolean).join(' · ');

    console.log('[TMDB] OK:', title, '| poster:', imgUrl ? 'yes' : 'no');
    return { title, description: desc, imageUrl: imgUrl, sourceUrl: null };
  } catch (e) {
    console.warn('[TMDB] Error:', e.message);
    return null;
  }
}

// Search TMDB by title — used when we only have a title (no IMDB ID)
async function fetchTmdbByTitle(title, type = 'multi') {
  if (!process.env.TMDB_API_KEY || !title) return null;
  try {
    const fetch = (...a) => import('node-fetch').then(m => m.default(...a));
    const q = encodeURIComponent(title.trim());
    const r = await fetch(
      `https://api.themoviedb.org/3/search/${type}?query=${q}&include_adult=false&language=en-US&page=1`,
      {
        headers: { 'Authorization': `Bearer ${process.env.TMDB_API_KEY}`, 'Accept': 'application/json' },
        signal: AbortSignal.timeout(8000)
      }
    );
    if (!r.ok) return null;
    const d = await r.json();
    const item = d.results && d.results[0];
    if (!item) return null;
    return item.poster_path ? `https://image.tmdb.org/t/p/w500${item.poster_path}` : null;
  } catch (e) {
    return null;
  }
}

// ─── FETCH IMDB/MOVIE METADATA ─────────────────────────────
// Strategy order:
//   1. TMDB API (by IMDB ID)  — needs TMDB_API_KEY, reliable, good images
//   2. Cheerio scrape          — last resort, often blocked from cloud IPs

async function fetchImdbMeta(url) {
  const imdbId = extractImdbId(url);
  const fetch  = (...a) => import('node-fetch').then(m => m.default(...a));

  // ── Strategy 1: TMDB by IMDB ID ──────────────────────────
  if (imdbId) {
    const tmdb = await fetchTmdbByImdbId(imdbId);
    if (tmdb && tmdb.title) return { ...tmdb, sourceUrl: url };
  }

  // ── Strategy 2: Cheerio scrape (last resort) ──────────────
  try {
    const cheerio = require('cheerio');
    const res = await fetch(url, {
      headers: {
        'User-Agent':      'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
        'Accept':          'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
        'Cache-Control':   'no-cache',
        'Referer':         'https://www.google.com/',
      },
      redirect: 'follow',
      signal:   AbortSignal.timeout(12000),
    });

    if (!res.ok) { console.warn('[fetchImdbMeta] Scrape blocked: HTTP', res.status); return null; }

    const html = await res.text();
    if (html.includes('cf-browser-verification') || html.includes('Just a moment') || html.length < 5000) {
      console.warn('[fetchImdbMeta] Cloudflare challenge detected');
      return null;
    }

    const $ = cheerio.load(html);
    let title = '', image = '', description = '', year = '', rating = '';

    $('script[type="application/ld+json"]').each((_, el) => {
      try {
        const data = JSON.parse($(el).html() || '');
        const valid = ['Movie','TVSeries','TVEpisode','TVMovie','Short'];
        if (valid.includes(data['@type'])) {
          title       = title       || data.name || '';
          if (!image) {
            if (typeof data.image === 'string')    image = data.image;
            else if (Array.isArray(data.image))    image = data.image[0]?.url || data.image[0] || '';
            else if (data.image?.url)              image = data.image.url;
          }
          description = description || data.description || '';
          year        = year        || String(data.datePublished || '').slice(0, 4);
          rating      = rating      || String(data.aggregateRating?.ratingValue || '');
        }
      } catch(e) {}
    });

    if (!title) title = ($('meta[property="og:title"]').attr('content') || $('title').text() || '').replace(/\s*[-|]\s*IMDb\s*$/i, '').trim();
    if (!image) image = $('meta[property="og:image"]').attr('content') || $('meta[name="twitter:image"]').attr('content') || '';
    if (!description) description = $('meta[property="og:description"]').attr('content') || '';

    if (!title) { console.warn('[fetchImdbMeta] No title found in scraped page'); return null; }

    const descParts = [description.slice(0, 150), year && `(${year})`, rating && `⭐ ${rating}`].filter(Boolean);
    console.log('[fetchImdbMeta] Scraped OK:', title);
    return { title: title.trim(), description: descParts.join(' · '), imageUrl: image, sourceUrl: url };
  } catch (err) {
    console.error('[fetchImdbMeta] Scrape error:', err.message);
    return null;
  }
}

// ─── FETCH METADATA FROM ANY URL ───────────────────────────

async function fetchMeta(url) {
  // IMDB: use dedicated fetcher (TMDB first, then cheerio scrape)
  if (/imdb\.com\/(title|name|film)/.test(url)) {
    const imdbMeta = await fetchImdbMeta(url);
    if (imdbMeta && imdbMeta.title) return imdbMeta;
    console.warn('[fetchMeta] All IMDB strategies failed, using URL fallback');
    return { title: titleFromUrl(url), description: '', imageUrl: '', sourceUrl: url };
  }

  // All other URLs: use open-graph-scraper
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
        title:       title.replace(/\s*[-|]\s*IMDb\s*$/i, '').trim(),
        description: result.ogDescription || result.twitterDescription || '',
        imageUrl:    result.ogImage?.[0]?.url || '',
        sourceUrl:   url,
      };
    }
    throw new Error('no title in ogs result');
  } catch (err) {
    console.error('fetchMeta fallback for:', url, '-', err.message || err);
    return { title: titleFromUrl(url), description: '', imageUrl: '', sourceUrl: url };
  }
}

// ─── EXTRACT URL FROM MESSAGE ───────────────────────────────

function extractUrls(text) {
  const regex = /https?:\/\/[^\s]+/gi;
  return text.match(regex) || [];
}

// ─── TYPE LABELS & ICONS ───────────────────────────────────

const TYPE_LABELS = {
  movie: '🎬 Movie',
  show:  '📺 Show',
  food:  '🍽 Restaurant',
  place: '📍 Place',
  event: '🎭 Event',
  video: '▶️ Video',
  link:  '🔗 Link',
};

function typeLabel(type) {
  return TYPE_LABELS[type] || '🔗 Link';
}

// ─── FORMAT PICK CARD (Telegram HTML) ──────────────────────

function formatCard(pick, votes) {
  const seen  = votes.filter(v => v.status === 'seen').map(v => v.first_name || v.username || 'Someone');
  const want  = votes.filter(v => v.status === 'want').map(v => v.first_name || v.username || 'Someone');
  const skip  = votes.filter(v => v.status === 'skip').map(v => v.first_name || v.username || 'Someone');
  const allVoted = seen.length + want.length + skip.length;
  const groupOk  = skip.length === 0 && allVoted > 0;

  let text = '';

  // Header
  text += `<b>${typeLabel(pick.type)}  |  ${escHtml(pick.title)}</b>\n`;
  if (pick.description) {
    text += `<i>${escHtml(truncate(pick.description, 100))}</i>\n`;
  }
  text += '\n';

  // Filmi Craft review strip
  if (pick.reviewer_name) {
    text += `📺 <b>${escHtml(pick.reviewer_name)}</b>`;
    if (pick.reviewer_score) text += `  ⭐ <b>${escHtml(pick.reviewer_score)}</b>`;
    if (pick.reviewer_quote) text += `\n<i>"${escHtml(pick.reviewer_quote)}"</i>`;
    text += '\n\n';
  }

  // Votes
  if (seen.length)  text += `✅ <b>Seen/Been:</b> ${escHtml(seen.join(', '))}\n`;
  if (want.length)  text += `⭐ <b>Want to:</b>   ${escHtml(want.join(', '))}\n`;
  if (skip.length)  text += `❌ <b>Not for me:</b> ${escHtml(skip.join(', '))}\n`;
  if (!seen.length && !want.length && !skip.length) {
    text += `<i>No votes yet — be the first!</i>\n`;
  }

  // Group ok badge
  if (groupOk) {
    text += `\n✅ <b>Group ok — everyone can do this together!</b>`;
  }

  // Added by
  text += `\n\n<i>Added by ${escHtml(pick.added_by_name || 'someone')} · via SquadPicks</i>`;

  return text;
}

// ─── FORMAT SUMMARY ────────────────────────────────────────

function formatSummary(picks, allVotes) {
  const groupOk  = [];
  const hasSkip  = [];
  const pending  = [];

  for (const pick of picks) {
    const pv = allVotes.filter(v => v.pick_id === pick.id);
    const skips = pv.filter(v => v.status === 'skip');
    const total  = pv.length;
    if (skips.length > 0) hasSkip.push({ pick, votes: pv });
    else if (total > 0)   groupOk.push({ pick, votes: pv });
    else                  pending.push({ pick });
  }

  let text = `📊 <b>SquadPicks Summary</b>\n\n`;

  if (groupOk.length) {
    text += `✅ <b>Group can do together (${groupOk.length})</b>\n`;
    groupOk.forEach(({ pick, votes }) => {
      const want = votes.filter(v => v.status === 'want').length;
      const seen = votes.filter(v => v.status === 'seen').length;
      text += `  • ${escHtml(pick.title)}`;
      if (pick.reviewer_score) text += ` · ⭐${pick.reviewer_score}`;
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
    pending.forEach(({ pick }) => {
      text += `  • ${escHtml(pick.title)}\n`;
    });
    text += '\n';
  }

  if (!picks.length) {
    text += `<i>No picks yet! Paste any link in this chat to get started.</i>`;
  }

  text += `\n<i>Type /pending to see what YOU still need to vote on.</i>`;
  return text;
}

// ─── FORMAT WEEKLY DIGEST ──────────────────────────────────

function formatDigest(newPicks, fcPicks, pendingCount) {
  let text = `📅 <b>SquadPicks — Weekly Digest</b>\n`;
  text += `<i>Here's what happened in your group this week</i>\n\n`;

  if (newPicks.length) {
    text += `🆕 <b>New picks this week (${newPicks.length})</b>\n`;
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
    text += `⏳ <b>You still need to vote on ${pendingCount} pick${pendingCount > 1 ? 's' : ''}</b>\n`;
    text += `Type /pending to see them.\n\n`;
  }

  text += `<i>Have a great week from SquadPicks! 🎬🍜📍</i>`;
  return text;
}

// ─── FORMAT FILMI CRAFT CARD ───────────────────────────────

function formatFilmiCraftCard(pick, votes) {
  return formatCard(pick, votes);
}

// ─── KEYBOARD BUILDERS ─────────────────────────────────────

function buildVoteKeyboard(pickId, groupId) {
  const botUsername = process.env.BOT_USERNAME       || 'squadpicks_bot';
  const shortName   = process.env.MINI_APP_SHORT_NAME || 'Squadpicks';
  const startParam  = groupId ? `?startapp=${groupId}` : '';
  const miniAppUrl  = `https://t.me/${botUsername}/${shortName}${startParam}`;
  return {
    inline_keyboard: [
      [
        { text: '✅ Seen/Been',  callback_data: `vote_${pickId}_seen` },
        { text: '⭐ Want to',    callback_data: `vote_${pickId}_want` },
        { text: '❌ Not for me', callback_data: `vote_${pickId}_skip` },
      ],
      [
        { text: '🚀 Open in SquadPicks', url: miniAppUrl }
      ]
    ]
  };
}

function buildSummaryKeyboard() {
  return {
    inline_keyboard: [[
      { text: '📋 Pending',   callback_data: 'cmd_pending' },
      { text: '📺 FC Picks',  callback_data: 'cmd_fcpicks' },
      { text: '💡 Suggest',   callback_data: 'cmd_suggest' },
    ]]
  };
}

// ─── HELPERS ───────────────────────────────────────────────

function escHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
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
