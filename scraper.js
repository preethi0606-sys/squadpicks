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

function tmdbH() {
  return { 'Authorization': `Bearer ${process.env.TMDB_API_KEY}`, 'Accept': 'application/json' };
}

async function tmdbPoster(title, type = 'multi') {
  return fetchTmdbByTitle(title, type === 'show' ? 'tv' : type === 'movie' ? 'movie' : 'multi');
}

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
// =============================================================================

const NETFLIX_XLSX_URL          = 'https://www.netflix.com/tudum/top10/data/all-weeks-global.xlsx';
const NETFLIX_COUNTRIES         = new Set(['canada', 'united states', 'india']);
const NETFLIX_COUNTRY_TO_REGION = { 'canada': 'canada', 'united states': 'us', 'india': 'india' };

// Netflix XLSX title cleaning.
// The XLSX sometimes encodes rank directly into the title field:
//   "01Thrash"  → "Thrash"  (no separator between rank and title)
//   "1. Thrash" → "Thrash"  (dot+space separator)
//   "10-Thrash" → "Thrash"  (hyphen separator)
// Strategy: strip any leading sequence that is ONLY digits (optionally followed by
// a non-alpha separator), then verify the remainder starts with a capital letter or
// known non-latin char. If the full string starts with digits+uppercase, strip digits.
function cleanNetflixTitle(t) {
  t = String(t || '').trim();

  // Case 1: digits followed by a clear separator char, then the real title
  // e.g. "1. Title", "01 Title", "10-Title", "3) Title"
  const withSep = t.replace(/^\d{1,3}[\s.\-_)\u00b7:]+/, '').trim();
  if (withSep && withSep !== t) return withSep.replace(/\s+/g, ' ').trim();

  // Case 2: digits directly glued to an uppercase letter (no separator)
  // e.g. "01Thrash", "1Cobra", "10Adolescence"
  const noSepMatch = t.match(/^\d{1,3}([A-Z\u00C0-\u024F\u4E00-\u9FFF].*)$/);
  if (noSepMatch) return noSepMatch[1].replace(/\s+/g, ' ').trim();

  return t.replace(/\s+/g, ' ').trim();
}

function normaliseCategory(cat) {
  cat = String(cat).toLowerCase();
  if (/film|movie/.test(cat)) return 'movie';
  return 'show';
}

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
      const found = keys.find(k => k.toLowerCase().replace(/\s+/g,'_').trim() === c.toLowerCase().replace(/\s+/g,'_'));
      if (found) return found;
      // also try partial match
      const partial = keys.find(k => k.toLowerCase().includes(c.toLowerCase()));
      if (partial) return partial;
    }
    return null;
  }

  const colWeek     = findCol(['week', 'week_as_of', 'as_of_date', 'week_of', 'week as of', 'as of date']);
  const colCountry  = findCol(['country_name', 'country', 'region', 'territory', 'country name']);
  const colCategory = findCol(['category', 'content_type', 'type', 'show_type', 'content type']);
  const colRank     = findCol(['weekly_rank', 'rank', 'weekly rank', 'position']);
  const colTitle    = findCol(['show_title', 'title', 'series_title', 'film_title', 'show title', 'name']);

  console.log('[Netflix] Columns found:', { colWeek, colCountry, colCategory, colRank, colTitle });

  if (!colCountry || !colTitle || !colRank) {
    console.error('[Netflix] Required columns not found. Available keys:', keys.slice(0, 10).join(', '));
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

  console.log(`[Netflix] ${filtered.length} rows match CA/US/IN latest week`);

  // Group by region → sort by rank → top 10 → enrich with TMDB
  const byRegion = {};
  filtered.forEach(row => {
    const country = String(row[colCountry] || '').toLowerCase().trim();
    const region  = NETFLIX_COUNTRY_TO_REGION[country];
    if (!region) return;
    if (!byRegion[region]) byRegion[region] = [];
    const rawTitle = String(row[colTitle] || '').trim();
    const cleaned  = cleanNetflixTitle(rawTitle);
    if (!cleaned || cleaned.length < 2) return;
    byRegion[region].push({
      rank:   parseInt(row[colRank]) || 99,
      title:  cleaned,
      type:   normaliseCategory(colCategory ? String(row[colCategory] || '') : ''),
      region,
    });
  });

  for (const region of Object.keys(byRegion)) {
    const seen  = new Set();
    const top10 = byRegion[region]
      .sort((a, b) => a.rank - b.rank)
      .filter(r => { const k = r.title.toLowerCase(); if (seen.has(k)) return false; seen.add(k); return true; })
      .slice(0, 10);

    console.log(`[Netflix] ${region}: ${top10.length} titles — ${top10.slice(0,3).map(t=>t.title).join(', ')}`);

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
      // Clear stale data for this region first, then insert fresh
      await db.clearTrendingNetflixRegion(region);
      await db.upsertTrendingNetflix(enriched);
      console.log(`[Netflix] ${region}: saved ${enriched.length} rows`);
    }
  }
}

// =============================================================================
// TMDB TRENDING — Official TMDB API
// /movie/popular gives the most-watched movies right now (updated daily)
// /tv/popular gives currently popular shows
// =============================================================================

async function fetchTmdbTrending() {
  if (!process.env.TMDB_API_KEY) {
    console.warn('[TMDB] No TMDB_API_KEY — skipping');
    return;
  }

  const endpoints = [
    { url: 'https://api.themoviedb.org/3/movie/popular?language=en-US&page=1',  category: 'top_movies',    type: 'movie', label: 'TMDB Popular Movies' },
    { url: 'https://api.themoviedb.org/3/tv/popular?language=en-US&page=1',     category: 'popular_shows', type: 'show',  label: 'TMDB Popular TV'     },
    { url: 'https://api.themoviedb.org/3/movie/now_playing?language=en-US&page=1', category: 'popular_movies', type: 'movie', label: 'TMDB Now Playing' },
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

      await db.clearTrendingImdbCategory(ep.category);
      await db.upsertTrendingImdb(rows);
      console.log(`[TMDB] ${ep.label}: saved ${rows.length} — top: ${rows.slice(0,3).map(r=>r.title).join(', ')}`);
    } catch (e) {
      console.error(`[TMDB] ${ep.label} error:`, e.message);
    }
    await sleep(300);
  }
}

// =============================================================================
// TMDB STREAMING — Prime Video via TMDB discover API
// Strategy: fetch trending/week then cross-check watch providers for Prime (id=9)
// This gives truly currently trending titles that are on Prime — not just library.
// =============================================================================

async function fetchTmdbStreaming() {
  if (!process.env.TMDB_API_KEY) {
    console.warn('[TMDB Streaming] No TMDB_API_KEY — skipping');
    return;
  }

  try {
    console.log('[TMDB Prime] Fetching trending + Prime provider check...');

    // Get trending this week (mix of movies and TV)
    const [trendMovieRes, trendTvRes] = await Promise.all([
      safeFetch('https://api.themoviedb.org/3/trending/movie/week?language=en-US', { headers: tmdbH() }),
      safeFetch('https://api.themoviedb.org/3/trending/tv/week?language=en-US',    { headers: tmdbH() }),
    ]);

    const trendMovies = trendMovieRes ? (await trendMovieRes.json()).results || [] : [];
    const trendTv     = trendTvRes    ? (await trendTvRes.json()).results    || [] : [];

    console.log(`[TMDB Prime] Trending pool: ${trendMovies.length} movies, ${trendTv.length} TV`);

    // Merge and sort by popularity, take top 30 candidates
    const candidates = [
      ...trendMovies.slice(0, 15).map(i => ({ ...i, _media: 'movie' })),
      ...trendTv.slice(0, 15).map(i => ({ ...i, _media: 'tv' })),
    ].sort((a, b) => (b.popularity || 0) - (a.popularity || 0)).slice(0, 30);

    // Check each candidate's watch providers for Prime (id=9) in US
    const primeItems = [];
    for (const item of candidates) {
      if (primeItems.length >= 10) break;
      try {
        const endpoint = item._media === 'movie'
          ? `https://api.themoviedb.org/3/movie/${item.id}/watch/providers`
          : `https://api.themoviedb.org/3/tv/${item.id}/watch/providers`;
        const pRes  = await safeFetch(endpoint, { headers: tmdbH() });
        if (!pRes) continue;
        const pd    = await pRes.json();
        const usProviders = pd.results?.US;
        const providers   = [
          ...(usProviders?.flatrate || []),
          ...(usProviders?.free     || []),
        ];
        const onPrime = providers.some(p => p.provider_id === 9);
        if (onPrime) {
          console.log(`[TMDB Prime] ✓ ${item.title || item.name} is on Prime`);
          primeItems.push(item);
        }
        await sleep(120); // respect TMDB rate limit: 40 req/10s
      } catch (_) {}
    }

    console.log(`[TMDB Prime] Found ${primeItems.length} confirmed Prime titles`);

    // If provider check returns too few, fall back to discover/sort
    let finalItems = primeItems;
    if (finalItems.length < 5) {
      console.log('[TMDB Prime] Fewer than 5 from provider check — using discover fallback');
      const [fbTv, fbMovie] = await Promise.all([
        safeFetch('https://api.themoviedb.org/3/discover/tv?watch_region=US&with_watch_providers=9&sort_by=popularity.desc&language=en-US&page=1', { headers: tmdbH() }),
        safeFetch('https://api.themoviedb.org/3/discover/movie?watch_region=US&with_watch_providers=9&sort_by=popularity.desc&language=en-US&page=1', { headers: tmdbH() }),
      ]);
      const fbTvData    = fbTv    ? (await fbTv.json()).results    || [] : [];
      const fbMovieData = fbMovie ? (await fbMovie.json()).results || [] : [];
      finalItems = [
        ...fbTvData.slice(0, 8).map(i => ({ ...i, _media: 'tv' })),
        ...fbMovieData.slice(0, 6).map(i => ({ ...i, _media: 'movie' })),
      ].sort((a, b) => (b.popularity || 0) - (a.popularity || 0)).slice(0, 10);
    }

    const rows = finalItems.slice(0, 10).map((item, i) => ({
      rank:        i + 1,
      title:       item.title || item.name || '',
      type:        item._media === 'movie' ? 'movie' : 'show',
      image_url:   item.poster_path ? `https://image.tmdb.org/t/p/w500${item.poster_path}` : null,
      badge:       'P',
      badge_color: '#00A8E0',
      prime_url:   `https://www.primevideo.com/search/?phrase=${encodeURIComponent(item.title || item.name || '')}`,
      tmdb_url:    `https://www.themoviedb.org/${item._media === 'movie' ? 'movie' : 'tv'}/${item.id}`,
      score:       item.vote_average ? item.vote_average.toFixed(1) : null,
      region:      'us',
      genre:       null,
    })).filter(r => r.title);

    console.log(`[TMDB Prime] Saving ${rows.length}: ${rows.map(r=>r.title).join(', ')}`);
    await db.clearTrendingPrimeRegion('us');
    await db.upsertTrendingPrime(rows);
    console.log(`[TMDB Prime] Saved ${rows.length} rows`);
  } catch (e) {
    console.error('[TMDB Prime] Error:', e.message);
  }
}

// =============================================================================
// PLACES — Wikivoyage REST API (free, no key, Wikipedia Foundation)
// Returns top attractions for a given city from Wikivoyage travel guides.
// No API key needed. Completely free and legal.
// =============================================================================

// =============================================================================
// PLACES — TripAdvisor Content API (free tier: 5000 calls/month, no billing)
// https://tripadvisor.com/developers — get a free key
// Falls back to curated static lists when no key is set.
// =============================================================================

const PLACES_CURATED = [
  {
    name: 'canada',
    items: [
      { title: 'Banff National Park',        description: 'Alberta · Rocky Mountains',          url: 'https://maps.google.com/?q=Banff+National+Park',         image_url: 'https://upload.wikimedia.org/wikipedia/commons/thumb/9/9f/Banff_NP_Canada.jpg/640px-Banff_NP_Canada.jpg' },
      { title: 'CN Tower',                   description: 'Toronto · Iconic observation tower',  url: 'https://maps.google.com/?q=CN+Tower+Toronto',             image_url: 'https://upload.wikimedia.org/wikipedia/commons/thumb/3/3d/Toronto_-_ON_-_CN_Tower_%2841417699282%29.jpg/480px-Toronto_-_ON_-_CN_Tower_%2841417699282%29.jpg' },
      { title: 'Niagara Falls',              description: 'Ontario · Natural wonder',            url: 'https://maps.google.com/?q=Niagara+Falls+Canada',         image_url: 'https://upload.wikimedia.org/wikipedia/commons/thumb/a/a5/Niagara_Falls%2C_from_the_Canadian_side.jpg/640px-Niagara_Falls%2C_from_the_Canadian_side.jpg' },
      { title: 'Stanley Park',               description: 'Vancouver · Seawall & old-growth',   url: 'https://maps.google.com/?q=Stanley+Park+Vancouver',        image_url: 'https://upload.wikimedia.org/wikipedia/commons/thumb/5/50/Stanley_Park_Coal_Harbour.jpg/640px-Stanley_Park_Coal_Harbour.jpg' },
      { title: 'Old Quebec City',            description: 'UNESCO World Heritage Site',          url: 'https://maps.google.com/?q=Old+Quebec+City',              image_url: 'https://upload.wikimedia.org/wikipedia/commons/thumb/3/35/Vieux-Quebec-Basse-Ville.jpg/640px-Vieux-Quebec-Basse-Ville.jpg' },
      { title: 'Whistler Village',           description: 'BC · Skiing & mountain culture',      url: 'https://maps.google.com/?q=Whistler+Village+BC',           image_url: 'https://upload.wikimedia.org/wikipedia/commons/thumb/7/75/Whistler_Village_from_Whistler_Mountain.jpg/640px-Whistler_Village_from_Whistler_Mountain.jpg' },
      { title: 'Capilano Suspension Bridge', description: 'North Vancouver · Rainforest walk',   url: 'https://maps.google.com/?q=Capilano+Suspension+Bridge',    image_url: 'https://upload.wikimedia.org/wikipedia/commons/thumb/a/a1/Capilano_Suspension_Bridge.jpg/640px-Capilano_Suspension_Bridge.jpg' },
      { title: 'Parliament Hill',            description: 'Ottawa · National landmark',          url: 'https://maps.google.com/?q=Parliament+Hill+Ottawa',       image_url: 'https://upload.wikimedia.org/wikipedia/commons/thumb/7/7a/Parliament_Hill%2C_Ottawa%2C_Canada.jpg/640px-Parliament_Hill%2C_Ottawa%2C_Canada.jpg' },
      { title: 'Rideau Canal',               description: 'Ottawa · UNESCO Heritage waterway',   url: 'https://maps.google.com/?q=Rideau+Canal+Ottawa',          image_url: 'https://upload.wikimedia.org/wikipedia/commons/thumb/6/61/Rideau_Canal_Ottawa.jpg/640px-Rideau_Canal_Ottawa.jpg' },
      { title: "Peggy's Cove",               description: 'Nova Scotia · Iconic lighthouse',     url: 'https://maps.google.com/?q=Peggys+Cove+Nova+Scotia',      image_url: 'https://upload.wikimedia.org/wikipedia/commons/thumb/8/82/Peggy%27s_Point_Lighthouse.jpg/640px-Peggy%27s_Point_Lighthouse.jpg' },
    ]
  },
  {
    name: 'us',
    items: [
      { title: 'Grand Canyon',               description: 'Arizona · One of the 7 natural wonders', url: 'https://maps.google.com/?q=Grand+Canyon',              image_url: 'https://upload.wikimedia.org/wikipedia/commons/thumb/f/f9/USA_09649_Grand_Canyon_Luca_Galuzzi_2007.jpg/640px-USA_09649_Grand_Canyon_Luca_Galuzzi_2007.jpg' },
      { title: 'Yellowstone National Park',  description: 'Wyoming · Geysers & wildlife',           url: 'https://maps.google.com/?q=Yellowstone+National+Park', image_url: 'https://upload.wikimedia.org/wikipedia/commons/thumb/b/be/Yellowstone_np_grand_prismatic_spring.jpg/640px-Yellowstone_np_grand_prismatic_spring.jpg' },
      { title: 'Golden Gate Bridge',         description: 'San Francisco · Iconic suspension bridge', url: 'https://maps.google.com/?q=Golden+Gate+Bridge',       image_url: 'https://upload.wikimedia.org/wikipedia/commons/thumb/0/0c/GoldenGateBridge-001.jpg/640px-GoldenGateBridge-001.jpg' },
      { title: 'Times Square',               description: 'New York City · The crossroads',        url: 'https://maps.google.com/?q=Times+Square+NYC',           image_url: 'https://upload.wikimedia.org/wikipedia/commons/thumb/4/47/New_york_times_square-terabass.jpg/480px-New_york_times_square-terabass.jpg' },
      { title: 'Zion National Park',         description: 'Utah · Canyons & hiking',               url: 'https://maps.google.com/?q=Zion+National+Park',         image_url: 'https://upload.wikimedia.org/wikipedia/commons/thumb/1/10/Zion_angels_landing_view.jpg/640px-Zion_angels_landing_view.jpg' },
      { title: 'Yosemite Valley',            description: 'California · Waterfalls & granite',     url: 'https://maps.google.com/?q=Yosemite+Valley',            image_url: 'https://upload.wikimedia.org/wikipedia/commons/thumb/d/d6/Yosemite_Valley_from_Tunnel_View.jpg/640px-Yosemite_Valley_from_Tunnel_View.jpg' },
      { title: 'Statue of Liberty',          description: 'New York · National monument',          url: 'https://maps.google.com/?q=Statue+of+Liberty',          image_url: 'https://upload.wikimedia.org/wikipedia/commons/thumb/a/a1/Statue_of_Liberty_7.jpg/480px-Statue_of_Liberty_7.jpg' },
      { title: 'Antelope Canyon',            description: 'Arizona · Stunning slot canyon',        url: 'https://maps.google.com/?q=Antelope+Canyon',            image_url: 'https://upload.wikimedia.org/wikipedia/commons/thumb/7/73/Upper_antelope_canyon.jpg/640px-Upper_antelope_canyon.jpg' },
      { title: 'Waikiki Beach',              description: 'Hawaii · Surfing & sunsets',            url: 'https://maps.google.com/?q=Waikiki+Beach+Hawaii',       image_url: 'https://upload.wikimedia.org/wikipedia/commons/thumb/2/23/Waikiki_Beach.jpg/640px-Waikiki_Beach.jpg' },
      { title: 'Las Vegas Strip',            description: 'Nevada · Entertainment & casinos',      url: 'https://maps.google.com/?q=Las+Vegas+Strip',            image_url: 'https://upload.wikimedia.org/wikipedia/commons/thumb/5/5c/Vegas_collage2.jpg/480px-Vegas_collage2.jpg' },
    ]
  },
  {
    name: 'india',
    items: [
      { title: 'Taj Mahal',                  description: 'Agra · UNESCO Heritage wonder',         url: 'https://maps.google.com/?q=Taj+Mahal+Agra',             image_url: 'https://upload.wikimedia.org/wikipedia/commons/thumb/b/bd/Taj_Mahal%2C_Agra%2C_India_edit3.jpg/640px-Taj_Mahal%2C_Agra%2C_India_edit3.jpg' },
      { title: 'Jaipur — Pink City',         description: 'Rajasthan · Forts & palaces',           url: 'https://maps.google.com/?q=Jaipur+Pink+City',           image_url: 'https://upload.wikimedia.org/wikipedia/commons/thumb/9/9e/Hawa_Mahal_in_Jaipur_%28high_res%29.jpg/480px-Hawa_Mahal_in_Jaipur_%28high_res%29.jpg' },
      { title: 'Kerala Backwaters',          description: 'Kerala · Houseboats & palm trees',      url: 'https://maps.google.com/?q=Kerala+Backwaters',          image_url: 'https://upload.wikimedia.org/wikipedia/commons/thumb/0/02/Backwater_Kerala.jpg/640px-Backwater_Kerala.jpg' },
      { title: 'Varanasi Ghats',             description: 'UP · Spiritual & cultural heart',       url: 'https://maps.google.com/?q=Varanasi+Ghats',             image_url: 'https://upload.wikimedia.org/wikipedia/commons/thumb/c/ca/Varanasi%2C_India.jpg/640px-Varanasi%2C_India.jpg' },
      { title: 'Goa Beaches',               description: 'Goa · Sun, sea & seafood',               url: 'https://maps.google.com/?q=Goa+Beaches',               image_url: 'https://upload.wikimedia.org/wikipedia/commons/thumb/4/42/Goa_beach.jpg/640px-Goa_beach.jpg' },
      { title: 'Hampi Ruins',               description: 'Karnataka · UNESCO Heritage',             url: 'https://maps.google.com/?q=Hampi+Karnataka',           image_url: 'https://upload.wikimedia.org/wikipedia/commons/thumb/0/07/Hampi1.jpg/640px-Hampi1.jpg' },
      { title: 'Darjeeling',                description: 'West Bengal · Tea gardens & Himalayas',   url: 'https://maps.google.com/?q=Darjeeling+West+Bengal',    image_url: 'https://upload.wikimedia.org/wikipedia/commons/thumb/d/d6/Kanchenjunga_from_Tiger_Hill.jpg/640px-Kanchenjunga_from_Tiger_Hill.jpg' },
      { title: 'Ranthambore Tiger Reserve',  description: 'Rajasthan · Wildlife safari',            url: 'https://maps.google.com/?q=Ranthambore+National+Park', image_url: 'https://upload.wikimedia.org/wikipedia/commons/thumb/2/2f/Ranthambhore_Rajasthan_Tiger.jpg/640px-Ranthambhore_Rajasthan_Tiger.jpg' },
      { title: 'Mysore Palace',             description: 'Karnataka · Heritage palace',              url: 'https://maps.google.com/?q=Mysore+Palace',             image_url: 'https://upload.wikimedia.org/wikipedia/commons/thumb/8/8c/Mysore_Palace_Morning.jpg/640px-Mysore_Palace_Morning.jpg' },
      { title: 'Munnar Hills',              description: 'Kerala · Tea plantations & mist',          url: 'https://maps.google.com/?q=Munnar+Kerala',             image_url: 'https://upload.wikimedia.org/wikipedia/commons/thumb/8/84/Munnar_Kerala_India_%28cropped%29.jpg/640px-Munnar_Kerala_India_%28cropped%29.jpg' },
    ]
  },
];

// TripAdvisor Content API — used when TRIPADVISOR_API_KEY is set.
// Without the key, curated static data with Wikimedia images is used.
async function fetchPlacesTripAdvisor(lat, lng, region) {
  const key = process.env.TRIPADVISOR_API_KEY;
  if (!key) return null;
  try {
    const searchUrl =
      `https://api.content.tripadvisor.com/api/v1/location/nearby_search` +
      `?latLong=${lat},${lng}` +
      `&category=attractions` +
      `&radius=50&radiusUnit=km` +
      `&language=en&key=${key}`;
    const res = await safeFetch(searchUrl, {
      headers: { 'Accept': 'application/json', 'Referer': 'https://squadpicks.app' }
    });
    if (!res) return null;
    const d    = await res.json();
    const locs = (d.data || []).slice(0, 10);
    if (!locs.length) return null;

    const enriched = [];
    for (const loc of locs) {
      let imgUrl = null;
      // Fetch one photo per location
      try {
        const photoRes = await safeFetch(
          `https://api.content.tripadvisor.com/api/v1/location/${loc.location_id}/photos?language=en&limit=1&key=${key}`,
          { headers: { 'Accept': 'application/json' } }
        );
        if (photoRes) {
          const pd = await photoRes.json();
          imgUrl = pd.data?.[0]?.images?.large?.url
                || pd.data?.[0]?.images?.medium?.url
                || pd.data?.[0]?.images?.small?.url
                || null;
        }
      } catch(_) {}

      const city = loc.address_obj?.city || loc.address_obj?.state || '';
      enriched.push({
        title:           loc.name,
        description:     [city, loc.address_obj?.country].filter(Boolean).join(' · '),
        image_url:       imgUrl,
        url:             `https://maps.google.com/?q=${encodeURIComponent(loc.name + (city ? ' ' + city : ''))}`,
        tripadvisor_url: `https://www.tripadvisor.com/Attraction_Review-g-d${loc.location_id}`,
        region,
        type:            'place',
      });
      await sleep(200);
    }
    console.log(`[TripAdvisor] ${region}: ${enriched.filter(e=>e.image_url).length}/${enriched.length} have images`);
    return enriched;
  } catch (e) {
    console.warn('[TripAdvisor] Error:', e.message);
    return null;
  }
}

const PLACES_LAT_LNG = {
  canada: { lat: 43.6532, lng: -79.3832 },   // Toronto
  us:     { lat: 37.7749, lng: -122.4194 },   // San Francisco
  india:  { lat: 28.6139, lng: 77.2090 },     // Delhi
};

async function fetchPlaces() {
  console.log('[Places] Loading places data...');
  for (const region of PLACES_CURATED) {
    try {
      const coords = PLACES_LAT_LNG[region.name];

      // Try TripAdvisor API first if key is set
      let rows = null;
      if (process.env.TRIPADVISOR_API_KEY && coords) {
        rows = await fetchPlacesTripAdvisor(coords.lat, coords.lng, region.name);
        if (rows && rows.length) {
          console.log(`[Places] ${region.name}: TripAdvisor returned ${rows.length} places`);
        }
      }

      // Fall back to curated static data (now includes Wikimedia image URLs)
      if (!rows || !rows.length) {
        if (!process.env.TRIPADVISOR_API_KEY) {
          console.log(`[Places] ${region.name}: No TRIPADVISOR_API_KEY — using curated static data with images`);
        }
        rows = region.items.map(p => ({
          title:           p.title,
          description:     p.description,
          image_url:       p.image_url || null,
          url:             p.url,
          tripadvisor_url: p.tripadvisor_url || `https://www.tripadvisor.com/Search?q=${encodeURIComponent(p.title)}`,
          region:          region.name,
          type:            'place',
        }));
      }

      const ranked = rows.map((p, i) => ({ ...p, rank: i + 1 }));
      await db.clearTrendingPlacesRegion(region.name);
      await db.upsertTrendingPlaces(ranked);
      console.log(`[Places] ${region.name}: saved ${ranked.length} places`);
    } catch (e) {
      console.error(`[Places] ${region.name} error:`, e.message);
    }
  }
}

// =============================================================================
// EVENTS — Ticketmaster Discovery API (Music, Sports, Arts, Family)
// For India: Paytm Insider API (free, no key needed)
// Events are fetched by lat/lng — client sends location, server queries by coords
// =============================================================================

// Ticketmaster classification IDs
const TM_CAT_IDS = {
  concerts: 'KZFzniwnSyZfZ7v7nJ',
  sports:   'KZFzniwnSyZfZ7v7nE',
  arts:     'KZFzniwnSyZfZ7v7na',
  family:   'KZFzniwnSyZfZ7v7n1',
};

const EVENTS_DEFAULTS = [
  { name: 'canada', lat: 43.6532,  lng: -79.3832,  countryCode: 'CA', label: 'Toronto'      },
  { name: 'us',     lat: 37.7749,  lng: -122.4194, countryCode: 'US', label: 'San Francisco' },
  { name: 'india',  lat: 19.0760,  lng: 72.8777,   countryCode: null, label: 'Mumbai', useInsider: true },
];

async function fetchEventsByLatLng(lat, lng, countryCode, region) {
  const tmKey = process.env.TICKETMASTER_API_KEY;
  if (!tmKey) {
    console.warn('[Events] No TICKETMASTER_API_KEY');
    return [];
  }

  const allEvents = [];

  for (const [catKey, catId] of Object.entries(TM_CAT_IDS)) {
    try {
      const url =
        `https://app.ticketmaster.com/discovery/v2/events.json` +
        `?apikey=${tmKey}` +
        `&latlong=${lat},${lng}` +
        `&radius=50&unit=miles` +
        `&classificationId=${catId}` +
        `&sort=date,asc` +
        `&size=5` +
        (countryCode ? `&countryCode=${countryCode}` : '');

      const res = await safeFetch(url);
      if (!res) continue;
      const data = await res.json();
      const rawEvents = (data._embedded || {}).events || [];
      const now = new Date();

      const catEvents = rawEvents
        .filter(ev => {
          const d = new Date(ev.dates?.start?.dateTime || ev.dates?.start?.localDate || '');
          return !isNaN(d.getTime()) && d > now;
        })
        .slice(0, 5)
        .map((ev, i) => {
          const venue   = ev._embedded?.venues?.[0];
          const dateStr = ev.dates?.start?.localDate || '';
          const timeStr = ev.dates?.start?.localTime ? ev.dates.start.localTime.slice(0, 5) : '';
          const price   = ev.priceRanges?.[0] ? `From $${Math.round(ev.priceRanges[0].min)}` : '';
          return {
            rank:        i + 1,
            title:       ev.name,
            category:    catKey,   // concerts / sports / arts / family
            description: [dateStr + (timeStr ? ' ' + timeStr : ''), venue?.name, price].filter(Boolean).join(' · '),
            image_url:   ev.images?.find(img => img.ratio === '16_9' && img.width >= 500)?.url || ev.images?.[0]?.url || null,
            url:         ev.url || null,
            region,
            type:        'event',
          };
        });

      allEvents.push(...catEvents);
      await sleep(200); // respect Ticketmaster rate limit
    } catch (e) {
      console.warn(`[Events] Category ${catKey} error:`, e.message);
    }
  }

  return allEvents;
}

async function fetchEventsInsiderIndia() {
  // Paytm Insider public API — no key required
  try {
    console.log('[Events India] Fetching from Insider.in...');
    const cities = ['mumbai', 'delhi', 'bangalore'];
    const allEvents = [];
    for (const city of cities) {
      const res = await safeFetch(
        `https://api.insider.in/v1/events?city=${city}&type=upcoming&category=music,comedy,arts&page_size=8`,
        { headers: { 'Accept': 'application/json' } }
      );
      if (!res) continue;
      const data = await res.json();
      (data.data?.items || data.events || []).slice(0, 5).forEach(ev => {
        const name = ev.name || ev.title || '';
        if (!name || allEvents.length >= 10) return;
        allEvents.push({
          title:       name,
          description: [
            ev.start_date ? new Date(ev.start_date * 1000).toLocaleDateString('en-IN', { day:'numeric', month:'short' }) : '',
            ev.venue?.name || city.charAt(0).toUpperCase() + city.slice(1),
          ].filter(Boolean).join(' · '),
          image_url:   ev.horizontal_cover_image?.url || ev.cover_image?.url || null,
          url:         ev.slug ? `https://insider.in/e/${ev.slug}` : null,
          region:      'india',
          type:        'event',
        });
      });
      await sleep(200);
    }
    return allEvents.slice(0, 10).map((e, i) => ({ ...e, rank: i + 1 }));
  } catch (e) {
    console.error('[Events India] Insider error:', e.message);
    return [];
  }
}

async function fetchEvents() {
  for (const region of EVENTS_DEFAULTS) {
    try {
      let events = [];
      if (region.useInsider) {
        events = await fetchEventsInsiderIndia();
      } else {
        events = await fetchEventsByLatLng(region.lat, region.lng, region.countryCode, region.name);
        if (!events.length) {
          console.warn(`[Events] ${region.name}: 0 events from Ticketmaster`);
        }
      }
      if (events.length) {
        await db.clearTrendingEventsRegion(region.name);
        await db.upsertTrendingEvents(events);
        console.log(`[Events] ${region.name}: saved ${events.length} events`);
      }
    } catch (e) {
      console.error(`[Events] ${region.name} error:`, e.message);
    }
    await sleep(600);
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
    console.warn('[Scraper] ⚠️  TMDB_API_KEY not set — trending data will be empty');
  }

  // Netflix XLSX: every Monday 10:00 UTC
  cron.schedule('0 10 * * 1', async () => {
    try { await runNetflixScrape(); }
    catch (e) { console.error('[Scraper] Netflix cron error:', e.message); }
  }, { timezone: 'UTC' });

  // Full scrape: every Thursday 20:30 UTC
  cron.schedule('30 20 * * 3', async () => {
    try { await runAllScrapers(); }
    catch (e) { console.error('[Scraper] Full scrape error:', e.message); }
  }, { timezone: 'UTC' });

  console.log('[Scraper] Crons scheduled: Mon 10:00 UTC (Netflix) | Thu 20:30 UTC (full)');

  // Always run on startup — ensures fresh data with latest code fixes
  setTimeout(async () => {
    console.log('[Scraper] Startup: running full scrape to ensure fresh data...');
    try { await runAllScrapers(); }
    catch (e) { console.error('[Scraper] Startup scrape error:', e.message); }
  }, 15000);
}

// Export for server.js /api/trending/events?lat=&lng= endpoint
module.exports = { startScraperCron, runAllScrapers, runNetflixScrape, fetchEventsByLatLng };
