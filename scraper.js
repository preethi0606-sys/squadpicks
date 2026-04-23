// scraper.js — Weekly cron: Netflix (XLSX), Prime Video, IMDb
// Netflix cron: every Monday 10:00 UTC (Netflix publishes Top 10 on Tuesdays, XLSX updates Mon/Tue)
// Full scrape:  every Thursday 20:30 UTC = Friday 2:00 AM IST
'use strict';

const cron    = require('node-cron');
const XLSX    = require('xlsx');
const fetch   = (...args) => import('node-fetch').then(m => m.default(...args));
const cheerio = require('cheerio');
const db      = require('./db');
const { fetchTmdbByTitle } = require('./links');

const sleep = ms => new Promise(r => setTimeout(r, ms));

// ── Browser headers ───────────────────────────────────────────────────────────
const HEADERS = {
  'User-Agent':      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Accept':          'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
  'Cache-Control':   'no-cache',
};

async function safeFetch(url, retries = 2, extraHeaders = {}) {
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const ctrl  = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 30000);
      const res   = await fetch(url, { headers: { ...HEADERS, ...extraHeaders }, signal: ctrl.signal, redirect: 'follow' });
      clearTimeout(timer);
      if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
      return res;
    } catch (err) {
      console.warn(`[Scraper] Attempt ${attempt + 1} failed: ${err.message}`);
      if (attempt < retries) await sleep(3000 * (attempt + 1));
    }
  }
  return null;
}

// ── TMDB poster lookup — thin wrapper around shared fetchTmdbByTitle ──────────
// type: 'movie' | 'show' | 'multi'
async function tmdbPoster(title, type = 'multi') {
  return fetchTmdbByTitle(title, type === 'show' ? 'tv' : type === 'movie' ? 'movie' : 'multi');
}

// ─────────────────────────────────────────────────────────────────────────────
// NETFLIX TOP 10 — Official XLSX from Netflix Tudum
//
// Netflix publishes a global XLSX every week at:
// https://www.netflix.com/tudum/top10/data/all-weeks-global.xlsx
//
// Sheet structure (most-recent sheet or "all-weeks" sheet):
//   Columns: week_as_of | country | category | weekly_rank | show_title |
//            cumulative_weeks_in_top_10 | is_staggered_launch | ...
//
// We download this file, parse the most recent week for Canada, US, India,
// then enrich each row with a TMDB poster image.
// ─────────────────────────────────────────────────────────────────────────────

const NETFLIX_XLSX_URL = 'https://www.netflix.com/tudum/top10/data/all-weeks-global.xlsx';
const NETFLIX_COUNTRIES = new Set(['canada', 'united states', 'india']);
const NETFLIX_COUNTRY_TO_REGION = {
  'canada':        'canada',
  'united states': 'us',
  'india':         'india'
};

async function scrapeNetflixXlsx() {
  console.log('[Netflix] Downloading XLSX from', NETFLIX_XLSX_URL);
  const res = await safeFetch(NETFLIX_XLSX_URL, 2, { 'Accept': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet, application/octet-stream, */*' });
  if (!res) { console.warn('[Netflix] Could not download XLSX'); return; }

  const arrayBuf = await res.arrayBuffer();
  const buffer   = Buffer.from(arrayBuf);
  console.log('[Netflix] XLSX downloaded, size:', buffer.length, 'bytes');

  let workbook;
  try {
    workbook = XLSX.read(buffer, { type: 'buffer', cellDates: true });
  } catch (e) {
    console.error('[Netflix] Failed to parse XLSX:', e.message);
    return;
  }

  // Use the first sheet (usually the most current / all-weeks-global)
  const sheetName = workbook.SheetNames[0];
  const sheet     = workbook.Sheets[sheetName];
  const rows      = XLSX.utils.sheet_to_json(sheet, { defval: '' });

  console.log(`[Netflix] XLSX sheet "${sheetName}": ${rows.length} rows`);
  if (!rows.length) { console.warn('[Netflix] XLSX has no rows'); return; }

  // ── Detect column names ───────────────────────────────────────────────────
  // Netflix has changed column names over time; detect robustly
  const sampleRow = rows[0];
  const keys      = Object.keys(sampleRow).map(k => k.toLowerCase().trim());
  console.log('[Netflix] Columns detected:', keys.join(', '));

  function findCol(candidates) {
    for (const c of candidates) {
      const found = Object.keys(sampleRow).find(k => k.toLowerCase().trim() === c.toLowerCase());
      if (found) return found;
    }
    return null;
  }

  const colWeek     = findCol(['week', 'week_as_of', 'as_of_date', 'week_of', 'weekas of', 'week as of']);
  const colCountry  = findCol(['country_name', 'country', 'region', 'territory']);
  const colCategory = findCol(['category', 'content_type', 'type', 'show_type']);
  const colRank     = findCol(['weekly_rank', 'rank', 'weekly rank']);
  const colTitle    = findCol(['show_title', 'title', 'series_title', 'film_title', 'show title']);

  if (!colCountry || !colTitle || !colRank) {
    console.error('[Netflix] Cannot find required columns in XLSX. Keys found:', keys.join(', '));
    return;
  }

  console.log(`[Netflix] Using columns: week="${colWeek}" country="${colCountry}" rank="${colRank}" title="${colTitle}" category="${colCategory}"`);

  // ── Find the most recent week in the data ────────────────────────────────
  let latestWeek = null;
  if (colWeek) {
    const weeks = rows
      .map(r => r[colWeek])
      .filter(Boolean)
      .map(w => {
        // Handle both Date objects and strings like "2025-04-20"
        if (w instanceof Date) return w;
        const d = new Date(w);
        return isNaN(d.getTime()) ? null : d;
      })
      .filter(Boolean);
    if (weeks.length) {
      latestWeek = new Date(Math.max(...weeks.map(d => d.getTime())));
      console.log('[Netflix] Most recent week in XLSX:', latestWeek.toISOString().slice(0, 10));
    }
  }

  // ── Filter rows: latest week + our 3 countries ───────────────────────────
  const filtered = rows.filter(row => {
    const country = String(row[colCountry] || '').toLowerCase().trim();
    if (!NETFLIX_COUNTRIES.has(country)) return false;
    if (latestWeek && colWeek) {
      const rowWeek = row[colWeek] instanceof Date ? row[colWeek] : new Date(row[colWeek]);
      if (!isNaN(rowWeek.getTime())) {
        // Allow rows from the latest week only (within ±2 days tolerance)
        const diff = Math.abs(rowWeek.getTime() - latestWeek.getTime());
        if (diff > 2 * 24 * 60 * 60 * 1000) return false;
      }
    }
    return true;
  });

  console.log(`[Netflix] ${filtered.length} rows after filtering for CA/US/IN latest week`);

  if (!filtered.length) {
    console.warn('[Netflix] No rows found for Canada/US/India in most recent week — trying all weeks, taking most recent per country');
    // Fallback: take top 10 most recent rows per country
    const byCountry = {};
    rows.forEach(row => {
      const country = String(row[colCountry] || '').toLowerCase().trim();
      if (!NETFLIX_COUNTRIES.has(country)) return;
      if (!byCountry[country]) byCountry[country] = [];
      byCountry[country].push(row);
    });
    Object.keys(byCountry).forEach(c => {
      byCountry[c].slice(-30).forEach(r => filtered.push(r));
    });
  }

  // ── Group by country → top 10 by rank ────────────────────────────────────
  const byCountry = {};
  filtered.forEach(row => {
    const country  = String(row[colCountry] || '').toLowerCase().trim();
    const region   = NETFLIX_COUNTRY_TO_REGION[country];
    if (!region) return;
    if (!byCountry[region]) byCountry[region] = [];
    byCountry[region].push({
      rank:     parseInt(row[colRank]) || 99,
      title:    String(row[colTitle] || '').trim(),
      type:     normaliseCategory(colCategory ? String(row[colCategory] || '') : ''),
      region
    });
  });

  // ── For each region: sort by rank, take top 10, enrich with TMDB poster ──
  for (const region of Object.keys(byCountry)) {
    const sorted = byCountry[region]
      .filter(r => r.title && r.title.length > 1)
      .sort((a, b) => a.rank - b.rank);

    // Deduplicate by title
    const seen  = new Set();
    const top10 = sorted.filter(r => {
      const key = r.title.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    }).slice(0, 10);

    console.log(`[Netflix] ${region}: ${top10.length} titles — enriching with TMDB posters...`);

    const enriched = [];
    for (let i = 0; i < top10.length; i++) {
      const item = top10[i];
      item.rank = i + 1;
      // Get TMDB poster — rate-limit: 300ms between requests
      const poster = await tmdbPoster(item.title, item.type);
      item.image_url  = poster || null;
      item.netflix_url = `https://www.netflix.com/search?q=${encodeURIComponent(item.title)}`;
      item.badge      = 'N';
      item.badge_color = '#E50914';
      enriched.push(item);
      if (i < top10.length - 1) await sleep(300);
    }

    if (enriched.length) {
      await db.upsertTrendingNetflix(enriched);
      console.log(`[Netflix] ${region}: saved ${enriched.length} rows to DB`);
    }
  }
}

function normaliseCategory(cat) {
  cat = String(cat).toLowerCase();
  if (/film|movie/.test(cat)) return 'movie';
  if (/tv|show|series/.test(cat)) return 'show';
  return 'show'; // Netflix default
}

// ─────────────────────────────────────────────────────────────────────────────
// PRIME VIDEO TOP 10 — Canada (web scrape fallback)
// ─────────────────────────────────────────────────────────────────────────────

async function scrapePrimeCanada() {
  const url = 'https://www.primevideo.com/collection/SVODTop10';
  console.log('[Prime] Scraping Canada from', url);
  const res = await safeFetch(url);
  if (!res) { console.warn('[Prime] No response'); return []; }
  const html = await res.text();
  const $    = cheerio.load(html);
  const results = [];

  // Method 1: embedded state JSON
  $('script').each((_, el) => {
    if (results.length >= 10) return;
    const src = $(el).html() || '';
    if (src.length < 200) return;
    const patterns = [
      /"catalogItems"\s*:\s*(\[[\s\S]{100,}\])/,
      /window\.__STORE__\s*=\s*(\{[\s\S]{100,}\});/
    ];
    for (const pattern of patterns) {
      try {
        const match = src.match(pattern);
        if (!match) continue;
        const obj = JSON.parse(match[1]);
        extractPrimeTitles(obj).forEach(item => {
          if (results.length >= 10) return;
          const t = cleanTitle(item.title || '');
          if (!t || /^top\s*10/i.test(t)) return;
          results.push({ rank: results.length + 1, title: t, type: 'show', genre: item.genre || null, image_url: item.image || null, prime_url: item.url || null, region: 'ca' });
        });
      } catch (_) {}
    }
  });

  // Method 2: HTML card selectors
  if (results.length < 5) {
    const selectors = ['[data-automation-id="title"]', '[class*="_titleText_"]', '[class*="title-text"]'];
    for (const sel of selectors) {
      if (results.length >= 10) break;
      $(sel).each((_, el) => {
        if (results.length >= 10) return;
        const t = $(el).text().trim();
        if (!t || t.length < 2 || t.length > 120 || /^top\s*10/i.test(t) || /^\d+$/.test(t)) return;
        const card   = $(el).closest('[class*="Card"], [class*="card"], article, li');
        const img    = card.find('img').first().attr('src') || null;
        const href   = card.find('a').first().attr('href') || '';
        const primeUrl = href ? (href.startsWith('http') ? href : 'https://www.primevideo.com' + href) : null;
        results.push({ rank: results.length + 1, title: cleanTitle(t), type: 'show', genre: null, image_url: img, prime_url: primeUrl, region: 'ca' });
      });
    }
  }

  const deduped = dedup(results).slice(0, 10);
  deduped.forEach((r, i) => { r.rank = i + 1; });
  console.log(`[Prime] ca: ${deduped.length} titles`);
  return deduped;
}

function extractPrimeTitles(obj, depth = 0, out = []) {
  if (depth > 8 || !obj || typeof obj !== 'object' || out.length >= 10) return out;
  if (Array.isArray(obj)) { obj.forEach(i => extractPrimeTitles(i, depth + 1, out)); return out; }
  const t = obj.title || obj.titleText || obj.label || '';
  if (t && t.length > 1 && t.length < 120 && !/^top\s*10/i.test(t)) {
    out.push({ title: t, type: obj.type || 'show', genre: obj.genre || null, image: obj.image || obj.imageUrl || null, url: obj.href || obj.url || null });
  }
  ['items','titles','catalog','cards','content','carouselItems','titleCards'].forEach(k => {
    if (obj[k]) extractPrimeTitles(obj[k], depth + 1, out);
  });
  return out;
}

async function scrapeAllPrime() {
  try {
    const rows = await scrapePrimeCanada();
    if (rows.length) {
      // Enrich with TMDB posters
      for (let i = 0; i < rows.length; i++) {
        if (!rows[i].image_url) {
          rows[i].image_url = await tmdbPoster(rows[i].title, rows[i].type);
          if (i < rows.length - 1) await sleep(300);
        }
      }
      await db.upsertTrendingPrime(rows);
    } else {
      console.warn('[Prime] 0 results — keeping existing data');
    }
  } catch (e) { console.error('[Prime] error:', e.message); }
}

// ─────────────────────────────────────────────────────────────────────────────
// IMDB TOP PICKS — web scrape
// ─────────────────────────────────────────────────────────────────────────────

const IMDB_SOURCES = [
  { url: 'https://www.imdb.com/chart/top/', category: 'top_movies', label: 'IMDb Top 250' },
  { url: 'https://www.imdb.com/chart/tvmeter/', category: 'popular_shows', label: 'IMDb Popular Shows' },
  { url: 'https://www.imdb.com/chart/moviemeter/', category: 'popular_movies', label: 'IMDb Popular Movies' },
];

async function scrapeImdbSource({ url, category, label }) {
  console.log(`[IMDb] Scraping ${label}`);
  const res = await safeFetch(url);
  if (!res) { console.warn(`[IMDb] No response for ${label}`); return []; }
  const html    = await res.text();
  const $       = cheerio.load(html);
  const results = [];

  // JSON-LD list items
  $('script[type="application/ld+json"]').each((_, el) => {
    try {
      const obj   = JSON.parse($(el).html() || '{}');
      const items = obj.item || obj.itemListElement || [];
      (Array.isArray(items) ? items : []).forEach((item, i) => {
        if (results.length >= 10) return;
        const name   = item.name || item.item?.name || '';
        const href   = item.url  || item.item?.url  || '';
        const rating = item.aggregateRating?.ratingValue || item.item?.aggregateRating?.ratingValue || null;
        if (!name) return;
        results.push({
          rank:      i + 1,
          title:     cleanTitle(name),
          type:      category.includes('show') ? 'show' : 'movie',
          year:      item.datePublished?.slice(0,4) || null,
          rating:    rating ? String(parseFloat(rating).toFixed(1)) : null,
          image_url: null, // enriched by TMDB below
          imdb_url:  href.startsWith('http') ? href.split('?')[0] : href ? 'https://www.imdb.com' + href.split('?')[0] : null,
          category
        });
      });
    } catch (_) {}
  });

  // Fallback: IMDb chart list items
  if (!results.length) {
    $('li.ipc-metadata-list-summary-item, li[class*="cli-parent"]').each((i, el) => {
      if (results.length >= 10) return;
      const titleEl = $(el).find('[class*="titleColumn"] a, h3.ipc-title__text').first();
      const title   = titleEl.text().trim().replace(/^\d+\.\s*/, '');
      const href    = titleEl.attr('href') || $(el).find('a').first().attr('href') || '';
      const rating  = $(el).find('[class*="ipc-rating-star"]').first().text().trim().replace(/[^0-9.]/g,'').slice(0,4);
      if (!title || title.length < 2) return;
      results.push({
        rank:      i + 1,
        title:     cleanTitle(title),
        type:      category.includes('show') ? 'show' : 'movie',
        year:      null, rating: rating || null, image_url: null,
        imdb_url:  href ? 'https://www.imdb.com' + href.split('?')[0] : null,
        category
      });
    });
  }

  const top10 = dedup(results).slice(0, 10);
  top10.forEach((r, i) => { r.rank = i + 1; });

  // Enrich with TMDB posters
  console.log(`[IMDb] ${label}: ${top10.length} titles — enriching with TMDB...`);
  for (let i = 0; i < top10.length; i++) {
    top10[i].image_url = await tmdbPoster(top10[i].title, top10[i].type);
    if (i < top10.length - 1) await sleep(300);
  }

  console.log(`[IMDb] ${label}: ${top10.filter(r => r.image_url).length}/${top10.length} with TMDB poster`);
  return top10;
}

async function scrapeAllImdb() {
  for (const src of IMDB_SOURCES) {
    try {
      const rows = await scrapeImdbSource(src);
      if (rows.length) await db.upsertTrendingImdb(rows);
      else console.warn(`[IMDb] 0 results for ${src.category} — keeping existing data`);
    } catch (e) { console.error(`[IMDb] ${src.category} error:`, e.message); }
    await sleep(2000);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// SHARED HELPERS
// ─────────────────────────────────────────────────────────────────────────────

function cleanTitle(t) {
  return String(t || '')
    .replace(/\s+/g, ' ')
    .replace(/^\d+[\.\)]\s*/, '')
    .replace(/\(TV (Series|Mini.Series|Movie)\)/gi, '')
    .replace(/^\s*[\u2013\u2014-]\s*/, '')
    .trim();
}

function dedup(arr) {
  const seen = new Set();
  return arr.filter(r => {
    const key = (r.title || '').toLowerCase().trim();
    if (!key || key.length < 2 || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// MAIN SCRAPE RUNS
// ─────────────────────────────────────────────────────────────────────────────

async function runNetflixScrape() {
  console.log('[Scraper] Starting Netflix XLSX scrape...');
  const t0 = Date.now();
  await scrapeNetflixXlsx();
  console.log(`[Scraper] Netflix done in ${((Date.now()-t0)/1000).toFixed(1)}s`);
}

async function runAllScrapers() {
  console.log('[Scraper] Starting full weekly scrape...');
  const t0 = Date.now();
  await scrapeNetflixXlsx();
  await scrapeAllPrime();
  await scrapeAllImdb();
  console.log(`[Scraper] Full scrape done in ${((Date.now()-t0)/1000).toFixed(1)}s`);
}

// ─────────────────────────────────────────────────────────────────────────────
// CRON SCHEDULE
//   Netflix XLSX: every Monday 10:00 UTC (Netflix publishes new data Mon/Tue)
//   Full scrape:  every Thursday 20:30 UTC = Friday 2:00 AM IST
// ─────────────────────────────────────────────────────────────────────────────

function startScraperCron() {
  if (!process.env.TMDB_API_KEY) {
    console.warn('[Scraper] ⚠️  TMDB_API_KEY not set — Netflix/IMDb poster images will be blank.');
    console.warn('[Scraper]    Get a free Read Access Token at https://www.themoviedb.org/settings/api');
  }
  // Netflix-only cron: every Monday at 10:00 UTC
  cron.schedule('0 10 * * 1', async () => {
    console.log('[Scraper] Monday cron: Netflix XLSX');
    try { await runNetflixScrape(); }
    catch (e) { console.error('[Scraper] Netflix cron error:', e.message); }
  }, { timezone: 'UTC' });

  // Full scrape cron: every Thursday 20:30 UTC
  cron.schedule('30 20 * * 3', async () => {
    console.log('[Scraper] Thursday cron: full scrape');
    try { await runAllScrapers(); }
    catch (e) { console.error('[Scraper] Full scrape cron error:', e.message); }
  }, { timezone: 'UTC' });

  console.log('[Scraper] Crons scheduled:');
  console.log('  Monday    10:00 UTC — Netflix XLSX + TMDB enrichment');
  console.log('  Thursday  20:30 UTC — Full scrape (Netflix + Prime + IMDb)');

  // Auto-run on first deploy if DB is empty
  setTimeout(async () => {
    try {
      const existing = await db.getLatestNetflixTop10('canada');
      if (!existing || !existing.length) {
        console.log('[Scraper] Empty DB — running initial scrape...');
        await runAllScrapers();
      } else {
        console.log(`[Scraper] DB already has ${existing.length} Netflix rows — skipping initial scrape`);
      }
    } catch (e) { console.error('[Scraper] Initial check error:', e.message); }
  }, 12000);
}

module.exports = { startScraperCron, runAllScrapers, runNetflixScrape };
