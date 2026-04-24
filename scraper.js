// scraper.js — Weekly cron: Netflix (XLSX), TMDB trending, places, events
// Netflix cron: every Monday 10:00 UTC
// Full scrape:  every Thursday 20:30 UTC = Friday 2:00 AM IST
'use strict';

const cron    = require('node-cron');
const XLSX    = require('xlsx');
const fetch   = (...args) => import('node-fetch').then(m => m.default(...args));
const db      = require('./db');
const { fetchTmdbByTitle } = require('./links');

const sleep = ms => new Promise(r => setTimeout(r, ms));

// ── TMDB poster lookup ────────────────────────────────────────────────────────
async function tmdbPoster(title, type = 'multi') {
  return fetchTmdbByTitle(title, type === 'show' ? 'tv' : type === 'movie' ? 'movie' : 'multi');
}

// ── TMDB auth headers ─────────────────────────────────────────────────────────
function tmdbH() {
  return { 'Authorization': `Bearer ${process.env.TMDB_API_KEY}`, 'Accept': 'application/json' };
}

// ── Safe fetch with retries ───────────────────────────────────────────────────
async function safeFetch(url, opts = {}, retries = 2) {
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const ctrl  = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 20000);
      const res   = await fetch(url, { ...opts, signal: ctrl.signal });
      clearTimeout(timer);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res;
    } catch (err) {
      console.warn(`[safeFetch] Attempt ${attempt + 1} failed: ${err.message}`);
      if (attempt < retries) await sleep(2000 * (attempt + 1));
    }
  }
  return null;
}

// =============================================================================
// NETFLIX TOP 10 — Official XLSX from Netflix Tudum
// https://www.netflix.com/tudum/top10/data/all-weeks-global.xlsx
// Filters to Canada, United States, India for the most recent week.
// =============================================================================

const NETFLIX_XLSX_URL          = 'https://www.netflix.com/tudum/top10/data/all-weeks-global.xlsx';
const NETFLIX_COUNTRIES         = new Set(['canada', 'united states', 'india']);
const NETFLIX_COUNTRY_TO_REGION = { 'canada': 'canada', 'united states': 'us', 'india': 'india' };

async function scrapeNetflixXlsx() {
  console.log('[Netflix] Downloading XLSX...');
  const res = await safeFetch(NETFLIX_XLSX_URL, {
    headers: { 'Accept': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet, */*' }
  });
  if (!res) { console.warn('[Netflix] Could not download XLSX'); return; }

  const arrayBuf = await res.arrayBuffer();
  const buffer   = Buffer.from(arrayBuf);
  console.log('[Netflix] XLSX downloaded, size:', buffer.length, 'bytes');

  let workbook;
  try { workbook = XLSX.read(buffer, { type: 'buffer', cellDates: true }); }
  catch (e) { console.error('[Netflix] XLSX parse failed:', e.message); return; }

  const sheet = workbook.Sheets[workbook.SheetNames[0]];
  const rows  = XLSX.utils.sheet_to_json(sheet, { defval: '' });
  if (!rows.length) { console.warn('[Netflix] XLSX has no rows'); return; }

  const keys = Object.keys(rows[0]);
  function findCol(candidates) {
    for (const c of candidates) {
      const found = keys.find(k => k.toLowerCase().trim() === c.toLowerCase());
      if (found) return found;
    }
    return null;
  }

  const colWeek     = findCol(['week', 'week_as_of', 'as_of_date', 'week_of']);
  const colCountry  = findCol(['country_name', 'country', 'region', 'territory']);
  const colCategory = findCol(['category', 'content_type', 'type', 'show_type']);
  const colRank     = findCol(['weekly_rank', 'rank', 'weekly rank']);
  const colTitle    = findCol(['show_title', 'title', 'series_title', 'film_title', 'show title']);

  if (!colCountry || !colTitle || !colRank) {
    console.error('[Netflix] Required columns not found. Keys:', keys.join(', '));
    return;
  }

  // Find the most recent week
  let latestWeek = null;
  if (colWeek) {
    const weeks = rows.map(r => {
      const w = r[colWeek];
      if (w instanceof Date) return w;
      const d = new Date(w); return isNaN(d.getTime()) ? null : d;
    }).filter(Boolean);
    if (weeks.length) {
      latestWeek = new Date(Math.max(...weeks.map(d => d.getTime())));
      console.log('[Netflix] Most recent week:', latestWeek.toISOString().slice(0, 10));
    }
  }

  // Filter to our countries + latest week
  const filtered = rows.filter(row => {
    const country = String(row[colCountry] || '').toLowerCase().trim();
    if (!NETFLIX_COUNTRIES.has(country)) return false;
    if (latestWeek && colWeek) {
      const rw = row[colWeek] instanceof Date ? row[colWeek] : new Date(row[colWeek]);
      if (!isNaN(rw.getTime()) && Math.abs(rw.getTime() - latestWeek.getTime()) > 2 * 864e5) return false;
    }
    return true;
  });

  console.log(`[Netflix] ${filtered.length} rows after filter`);

  // Group by region, sort by rank, take top 10, enrich with TMDB poster
  const byRegion = {};
  filtered.forEach(row => {
    const country = String(row[colCountry] || '').toLowerCase().trim();
    const region  = NETFLIX_COUNTRY_TO_REGION[country];
    if (!region) return;
    if (!byRegion[region]) byRegion[region] = [];
    byRegion[region].push({
      rank:   parseInt(row[colRank]) || 99,
      title:  cleanNetflixTitle(String(row[colTitle] || '').trim()),
      type:   normaliseCategory(colCategory ? String(row[colCategory] || '') : ''),
      region
    });
  });

  for (const region of Object.keys(byRegion)) {
    const seen  = new Set();
    const top10 = byRegion[region]
      .filter(r => r.title && r.title.length > 1)
      .sort((a, b) => a.rank - b.rank)
      .filter(r => { const k = r.title.toLowerCase(); if (seen.has(k)) return false; seen.add(k); return true; })
      .slice(0, 10);

    console.log(`[Netflix] ${region}: ${top10.length} titles — enriching with TMDB...`);
    const enriched = [];
    for (let i = 0; i < top10.length; i++) {
      const item = top10[i];
      item.rank        = i + 1;
      item.image_url   = await tmdbPoster(item.title, item.type) || null;
      item.netflix_url = `https://www.netflix.com/search?q=${encodeURIComponent(item.title)}`;
      item.badge       = 'N';
      item.badge_color = '#E50914';
      enriched.push(item);
      if (i < top10.length - 1) await sleep(300);
    }
    if (enriched.length) {
      await db.upsertTrendingNetflix(enriched);
      console.log(`[Netflix] ${region}: saved ${enriched.length} rows`);
    }
  }
}

// Netflix XLSX sometimes encodes rank into the title: "01Thrash" → "Thrash"
function cleanNetflixTitle(t) {
  return String(t || '')
    .replace(/^\d{1,3}[\s.\-_)]*/, '')   // strip leading "01" or "1. " or "01-"
    .replace(/\s+/g, ' ')
    .trim();
}

function normaliseCategory(cat) {
  cat = String(cat).toLowerCase();
  if (/film|movie/.test(cat)) return 'movie';
  return 'show';
}

// =============================================================================
// TMDB TRENDING — replaces IMDb scraping (official API, no ToS violation)
// Uses TMDB /trending and /movie/top_rated endpoints
// Stored in trending_imdb table (reusing existing schema)
// =============================================================================

async function fetchTmdbTrending() {
  if (!process.env.TMDB_API_KEY) {
    console.warn('[TMDB] No TMDB_API_KEY — skipping');
    return;
  }

  const endpoints = [
    { url: 'https://api.themoviedb.org/3/trending/movie/week?language=en-US',    category: 'top_movies',    type: 'movie', label: 'TMDB Trending Movies' },
    { url: 'https://api.themoviedb.org/3/trending/tv/week?language=en-US',       category: 'popular_shows', type: 'show',  label: 'TMDB Trending TV'     },
    { url: 'https://api.themoviedb.org/3/movie/top_rated?language=en-US&page=1', category: 'popular_movies',type: 'movie', label: 'TMDB Top Rated'       },
  ];

  for (const ep of endpoints) {
    try {
      console.log(`[TMDB] Fetching ${ep.label}...`);
      const res = await safeFetch(ep.url, { headers: tmdbH() });
      if (!res) continue;
      const data = await res.json();
      const rows = (data.results || []).slice(0, 10).map((item, i) => ({
        rank:      i + 1,
        title:     item.title || item.name || '',
        type:      ep.type,
        year:      (item.release_date || item.first_air_date || '').slice(0, 4) || null,
        rating:    item.vote_average ? item.vote_average.toFixed(1) : null,
        image_url: item.poster_path ? `https://image.tmdb.org/t/p/w500${item.poster_path}` : null,
        tmdb_url:  `https://www.themoviedb.org/${ep.type === 'movie' ? 'movie' : 'tv'}/${item.id}`,
        imdb_url:  null,
        category:  ep.category,
      })).filter(r => r.title);

      await db.upsertTrendingImdb(rows);
      console.log(`[TMDB] ${ep.label}: saved ${rows.length} rows`);
    } catch (e) {
      console.error(`[TMDB] ${ep.label} error:`, e.message);
    }
    await sleep(300);
  }
}

// =============================================================================
// TMDB STREAMING — What's on Prime Video via TMDB discover API
// (Netflix is handled by the official XLSX above — more accurate)
// Uses TMDB /discover with watch_provider filtering (no scraping)
// Provider IDs: Netflix=8, Prime Video=9
// =============================================================================

async function fetchTmdbStreaming() {
  if (!process.env.TMDB_API_KEY) {
    console.warn('[TMDB Streaming] No TMDB_API_KEY — skipping');
    return;
  }

  const providers = [
    { id: 9, name: 'Prime', badge: 'P', badgeColor: '#00A8E0', dbFn: 'upsertTrendingPrime', searchBase: 'https://www.primevideo.com/search/?phrase=' },
  ];

  for (const src of providers) {
    try {
      console.log(`[TMDB Streaming] Fetching ${src.name}...`);
      const [tvRes, movieRes] = await Promise.all([
        safeFetch(`https://api.themoviedb.org/3/discover/tv?watch_region=US&with_watch_providers=${src.id}&sort_by=popularity.desc&language=en-US&page=1`,    { headers: tmdbH() }),
        safeFetch(`https://api.themoviedb.org/3/discover/movie?watch_region=US&with_watch_providers=${src.id}&sort_by=popularity.desc&language=en-US&page=1`, { headers: tmdbH() }),
      ]);

      const tvData    = tvRes    ? await tvRes.json()    : { results: [] };
      const movieData = movieRes ? await movieRes.json() : { results: [] };

      const combined = [
        ...(tvData.results    || []).slice(0, 8).map(i => ({ ...i, _media: 'tv' })),
        ...(movieData.results || []).slice(0, 6).map(i => ({ ...i, _media: 'movie' })),
      ].sort((a, b) => (b.popularity || 0) - (a.popularity || 0)).slice(0, 10);

      const rows = combined.map((item, i) => ({
        rank:       i + 1,
        title:      item.title || item.name || '',
        type:       item._media === 'movie' ? 'movie' : 'show',
        image_url:  item.poster_path ? `https://image.tmdb.org/t/p/w500${item.poster_path}` : null,
        badge:      src.badge,
        badge_color: src.badgeColor,
        url:        `${src.searchBase}${encodeURIComponent(item.title || item.name || '')}`,
        score:      item.vote_average ? item.vote_average.toFixed(1) : null,
        region:     'us',
        genre:      null,
      })).filter(r => r.title);

      await db[src.dbFn](rows);
      console.log(`[TMDB Streaming] ${src.name}: saved ${rows.length} rows`);
    } catch (e) {
      console.error(`[TMDB Streaming] ${src.name} error:`, e.message);
    }
    await sleep(500);
  }
}

// =============================================================================
// PLACES — OpenTripMap API (free, 5000 req/day, no billing required)
// Get a free key at: https://opentripmap.io/product
// Env var: OPENTRIPMAP_API_KEY
// Falls back to empty (dashboard uses static data when table is empty)
// =============================================================================

const PLACES_REGIONS = [
  { name: 'canada', lat: 51.0447,  lon: -114.0719, label: 'Canada'        },
  { name: 'us',     lat: 40.7128,  lon: -74.0060,  label: 'United States' },
  { name: 'india',  lat: 28.6139,  lon: 77.2090,   label: 'India'         },
];

async function fetchPlaces() {
  const apiKey = process.env.OPENTRIPMAP_API_KEY;
  if (!apiKey) {
    console.warn('[Places] No OPENTRIPMAP_API_KEY set — skipping (dashboard uses static fallback)');
    console.warn('[Places] Get a free key at https://opentripmap.io/product');
    return;
  }

  for (const region of PLACES_REGIONS) {
    try {
      console.log(`[Places] Fetching top attractions for ${region.label}...`);
      const url = `https://api.opentripmap.com/0.1/en/places/radius?radius=300000&lon=${region.lon}&lat=${region.lat}&kinds=interesting_places&rate=3h&format=json&limit=15&apikey=${apiKey}`;
      const res = await safeFetch(url);
      if (!res) continue;
      const data = await res.json();

      const places = (Array.isArray(data) ? data : [])
        .filter(p => p.name && p.name.trim())
        .slice(0, 10)
        .map((p, i) => ({
          rank:        i + 1,
          title:       p.name.trim(),
          description: (p.kinds || '').split(',').slice(0, 2).map(k => k.replace(/_/g, ' ')).join(', '),
          image_url:   p.preview?.source || null,
          url:         `https://maps.google.com/?q=${encodeURIComponent(p.name)}`,
          region:      region.name,
          type:        'place',
        }));

      if (places.length) {
        await db.upsertTrendingPlaces(places);
        console.log(`[Places] ${region.name}: saved ${places.length} places`);
      }
    } catch (e) {
      console.error(`[Places] ${region.name} error:`, e.message);
    }
    await sleep(500);
  }
}

// =============================================================================
// EVENTS — Ticketmaster Discovery API (free, 5000 calls/day, no billing)
// Get a free API key at: https://developer.ticketmaster.com
// Env var: TICKETMASTER_API_KEY
// Falls back to empty (dashboard uses static data when table is empty)
// =============================================================================

const EVENTS_REGIONS = [
  { name: 'canada', countryCode: 'CA', city: 'Vancouver' },
  { name: 'us',     countryCode: 'US', city: 'New York'  },
  { name: 'india',  countryCode: 'IN', city: 'Mumbai'    },
];

async function fetchEvents() {
  const apiKey = process.env.TICKETMASTER_API_KEY;
  if (!apiKey) {
    console.warn('[Events] No TICKETMASTER_API_KEY set — skipping (dashboard uses static fallback)');
    console.warn('[Events] Get a free key at https://developer.ticketmaster.com');
    return;
  }

  for (const region of EVENTS_REGIONS) {
    try {
      console.log(`[Events] Fetching events for ${region.city}...`);
      const url = `https://app.ticketmaster.com/discovery/v2/events.json?apikey=${apiKey}&countryCode=${region.countryCode}&city=${encodeURIComponent(region.city)}&size=10&sort=relevance,desc`;
      const res = await safeFetch(url);
      if (!res) continue;
      const data = await res.json();

      const events = ((data._embedded || {}).events || []).slice(0, 10).map((ev, i) => ({
        rank:        i + 1,
        title:       ev.name || 'Upcoming Event',
        description: [
          ev.dates?.start?.localDate,
          ev._embedded?.venues?.[0]?.name,
          ev.priceRanges?.[0] ? `From $${Math.round(ev.priceRanges[0].min)}` : 'Check prices',
        ].filter(Boolean).join(' · '),
        image_url:   ev.images?.find(img => img.ratio === '16_9' && img.width >= 300)?.url || ev.images?.[0]?.url || null,
        url:         ev.url || null,
        region:      region.name,
        type:        'event',
      })).filter(e => e.title);

      if (events.length) {
        await db.upsertTrendingEvents(events);
        console.log(`[Events] ${region.name}: saved ${events.length} events`);
      }
    } catch (e) {
      console.error(`[Events] ${region.name} error:`, e.message);
    }
    await sleep(500);
  }
}

// =============================================================================
// MAIN SCRAPE RUNS
// =============================================================================

async function runNetflixScrape() {
  console.log('[Scraper] Netflix XLSX scrape...');
  const t0 = Date.now();
  await scrapeNetflixXlsx();
  console.log(`[Scraper] Netflix done in ${((Date.now()-t0)/1000).toFixed(1)}s`);
}

async function runAllScrapers() {
  console.log('[Scraper] Full weekly scrape starting...');
  const t0 = Date.now();
  await scrapeNetflixXlsx();
  await fetchTmdbTrending();
  await fetchTmdbStreaming();
  await fetchPlaces();
  await fetchEvents();
  console.log(`[Scraper] All done in ${((Date.now()-t0)/1000).toFixed(1)}s`);
}

// =============================================================================
// CRON SCHEDULE
// =============================================================================

function startScraperCron() {
  if (!process.env.TMDB_API_KEY) {
    console.warn('[Scraper] ⚠️  TMDB_API_KEY not set — movie/TV trending data will be empty');
  }

  // Netflix XLSX: every Monday 10:00 UTC
  cron.schedule('0 10 * * 1', async () => {
    console.log('[Scraper] Monday cron: Netflix XLSX');
    try { await runNetflixScrape(); }
    catch (e) { console.error('[Scraper] Netflix cron error:', e.message); }
  }, { timezone: 'UTC' });

  // Full scrape: every Thursday 20:30 UTC
  cron.schedule('30 20 * * 3', async () => {
    console.log('[Scraper] Thursday cron: full scrape');
    try { await runAllScrapers(); }
    catch (e) { console.error('[Scraper] Full scrape cron error:', e.message); }
  }, { timezone: 'UTC' });

  console.log('[Scraper] Crons scheduled:');
  console.log('  Monday    10:00 UTC — Netflix XLSX');
  console.log('  Thursday  20:30 UTC — TMDB trending + Prime + Places + Events');

  // Auto-run on first deploy if DB is empty
  setTimeout(async () => {
    try {
      const existing = await db.getLatestNetflixTop10('canada');
      if (!existing || !existing.length) {
        console.log('[Scraper] Empty DB — running initial scrape...');
        await runAllScrapers();
      } else {
        console.log('[Scraper] DB has data — skipping initial scrape');
      }
    } catch (e) { console.error('[Scraper] Initial check error:', e.message); }
  }, 12000);
}

module.exports = { startScraperCron, runAllScrapers, runNetflixScrape };
