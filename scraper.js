// scraper.js — Weekly Thursday cron to scrape Netflix, Prime, IMDb top 10s
// Runs every Thursday at 2:00 AM IST (20:30 UTC Wednesday)
// Stores results in Supabase trending tables
// Falls back gracefully — never crashes the main bot

'use strict';

const cron    = require('node-cron');
const fetch   = (...args) => import('node-fetch').then(m => m.default(...args));
const cheerio = require('cheerio');
const db      = require('./db');

// ─── HEADERS — mimic a real browser to avoid basic blocks ───────────────────
const HEADERS = {
  'User-Agent':      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36',
  'Accept':          'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
  'Accept-Encoding': 'gzip, deflate, br',
  'Cache-Control':   'no-cache',
  'Pragma':          'no-cache',
  'Sec-Fetch-Dest':  'document',
  'Sec-Fetch-Mode':  'navigate',
  'Sec-Fetch-Site':  'none',
  'Upgrade-Insecure-Requests': '1'
};

// Safe fetch with timeout and retry
async function safeFetch(url, retries = 2) {
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 20000);
      const res = await fetch(url, { headers: HEADERS, signal: controller.signal, redirect: 'follow' });
      clearTimeout(timeout);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const text = await res.text();
      return text;
    } catch (err) {
      console.warn(`[Scraper] Attempt ${attempt + 1} failed for ${url}: ${err.message}`);
      if (attempt < retries) await new Promise(r => setTimeout(r, 3000 * (attempt + 1)));
    }
  }
  return null;
}

// ═══════════════════════════════════════════════════════════════
// NETFLIX — https://www.netflix.com/tudum/top10/
// Netflix publishes an official weekly Top 10 list on Tudum.
// The page contains JSON-LD data and structured HTML we can parse.
// ═══════════════════════════════════════════════════════════════

const NETFLIX_REGIONS = [
  { region: 'canada', url: 'https://www.netflix.com/tudum/top10/canada' },
  { region: 'us',     url: 'https://www.netflix.com/tudum/top10/united-states' },
  { region: 'india',  url: 'https://www.netflix.com/tudum/top10/india' }
];

async function scrapeNetflixRegion({ region, url }) {
  console.log(`[Netflix] Scraping ${region}...`);
  const html = await safeFetch(url);
  if (!html) { console.warn(`[Netflix] No response for ${region}`); return []; }

  const $ = cheerio.load(html);
  const results = [];

  // Netflix Tudum top 10 — try to extract structured data from JSON-LD or page JSON
  // Method 1: Look for __NEXT_DATA__ or window.__data JSON
  let jsonData = null;
  $('script').each((_, el) => {
    const src = $(el).html() || '';
    if (src.includes('"top10"') || src.includes('"topTen"') || src.includes('"weeklyTop10"')) {
      try {
        // Try to extract JSON blob
        const match = src.match(/\{[\s\S]{100,}\}/);
        if (match) jsonData = JSON.parse(match[0]);
      } catch (e) { /* ignore */ }
    }
    // __NEXT_DATA__ is a reliable source
    if (src.includes('__NEXT_DATA__')) {
      try {
        const match = src.match(/__NEXT_DATA__\s*=\s*(\{[\s\S]+?\})\s*;?\s*<\/script>/);
        if (match) jsonData = JSON.parse(match[1]);
      } catch (e) { /* ignore */ }
    }
  });

  // Method 2: If JSON found, walk it for top 10 items
  if (jsonData) {
    const titles = extractFromNestedJSON(jsonData, ['title', 'name'], ['rank', 'position']);
    titles.slice(0, 10).forEach((item, i) => {
      if (item.title) {
        results.push({
          rank:        i + 1,
          title:       cleanTitle(item.title),
          type:        item.type || guessType(item.title),
          genre:       item.genre || item.genres || null,
          image_url:   item.image || item.imageUrl || item.poster || null,
          netflix_url: item.url || `https://www.netflix.com/search?q=${encodeURIComponent(item.title)}`,
          region
        });
      }
    });
  }

  // Method 3: HTML parsing fallback — Netflix Tudum uses article/card elements
  if (!results.length) {
    // Look for numbered list items or ranking cards
    const rankSelectors = [
      '[class*="RankTitle"]', '[class*="rank-title"]', '[class*="TitleCard"]',
      '[class*="top10"]  h3', '[data-testid*="title"]', '.top10-title',
      'article h2', 'article h3', '[class*="rowTitle"]'
    ];
    for (const sel of rankSelectors) {
      $(sel).slice(0, 10).each((i, el) => {
        const text = $(el).text().trim();
        if (text && text.length > 1 && text.length < 120) {
          results.push({
            rank:        i + 1,
            title:       cleanTitle(text),
            type:        guessType(text),
            genre:       null,
            image_url:   null,
            netflix_url: `https://www.netflix.com/search?q=${encodeURIComponent(text)}`,
            region
          });
        }
      });
      if (results.length >= 5) break;
    }
  }

  // Method 4: Parse table rows (Netflix Tudum uses tables on some regions)
  if (!results.length) {
    $('table tr, [role="row"]').each((i, row) => {
      if (i === 0) return; // skip header
      const cells = $(row).find('td, [role="cell"]');
      if (cells.length >= 2) {
        const rankTxt  = $(cells[0]).text().trim();
        const titleTxt = $(cells[1]).text().trim() || $(row).find('h3, h2, strong').first().text().trim();
        const rank     = parseInt(rankTxt) || (i);
        if (titleTxt && rank >= 1 && rank <= 10) {
          results.push({
            rank,
            title:       cleanTitle(titleTxt),
            type:        guessType(titleTxt),
            genre:       null,
            image_url:   null,
            netflix_url: `https://www.netflix.com/search?q=${encodeURIComponent(titleTxt)}`,
            region
          });
        }
      }
    });
  }

  // Deduplicate by title, keep top 10
  const seen = new Set();
  const deduped = results.filter(r => {
    const key = r.title.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).slice(0, 10);

  // Re-assign ranks 1-10
  deduped.forEach((r, i) => { r.rank = i + 1; });

  console.log(`[Netflix] ${region}: scraped ${deduped.length} titles`);
  return deduped;
}

async function scrapeAllNetflix() {
  for (const regionConfig of NETFLIX_REGIONS) {
    try {
      const rows = await scrapeNetflixRegion(regionConfig);
      if (rows.length > 0) {
        await db.upsertTrendingNetflix(rows);
      } else {
        console.warn(`[Netflix] Got 0 results for ${regionConfig.region} — keeping existing DB data`);
      }
      // Small delay between regions
      await new Promise(r => setTimeout(r, 2000));
    } catch (err) {
      console.error(`[Netflix] Error for ${regionConfig.region}:`, err.message);
    }
  }
}

// ═══════════════════════════════════════════════════════════════
// PRIME VIDEO — 
// Canada: https://www.primevideo.com/collection/SVODTop10
// India:  https://www.primevideo.com/in/collection/SVODTop10
// Prime embeds JSON data in script tags we can extract
// ═══════════════════════════════════════════════════════════════

const PRIME_REGIONS = [
  { region: 'ca', url: 'https://www.primevideo.com/collection/SVODTop10' },
  { region: 'in', url: 'https://www.primevideo.com/in/collection/SVODTop10' }
];

async function scrapePrimeRegion({ region, url }) {
  console.log(`[Prime] Scraping ${region}...`);
  const html = await safeFetch(url);
  if (!html) { console.warn(`[Prime] No response for ${region}`); return []; }

  const $ = cheerio.load(html);
  const results = [];

  // Method 1: Extract from embedded JSON (Prime Video embeds state in script tags)
  $('script').each((_, el) => {
    const src = $(el).html() || '';
    if ((src.includes('"heroCarousel"') || src.includes('"collections"') || src.includes('"catalogItems"'))
        && src.length > 500) {
      try {
        // Find JSON blobs
        const jsonMatches = src.match(/\{[\s\S]{200,}\}/g) || [];
        for (const jsonStr of jsonMatches.slice(0, 3)) {
          try {
            const obj = JSON.parse(jsonStr);
            const items = extractFromNestedJSON(obj, ['title', 'titleText', 'label'], ['rank', 'index', 'position']);
            items.slice(0, 10).forEach((item, i) => {
              const t = item.title || item.titleText || item.label;
              if (t && t.length > 1 && t.length < 120) {
                results.push({
                  rank: item.rank || (i + 1),
                  title: cleanTitle(t),
                  type: item.contentType || guessType(t),
                  genre: item.genre || null,
                  image_url: item.image || item.src || null,
                  prime_url: item.url || `https://www.primevideo.com/search/ref=atv_nb_sr?phrase=${encodeURIComponent(t)}`,
                  region
                });
              }
            });
          } catch(e) { /* ignore */ }
        }
      } catch(e) { /* ignore */ }
    }
  });

  // Method 2: HTML selectors — Prime uses image+title card pattern
  if (!results.length) {
    const titleSelectors = [
      '[class*="_title_"]', '[data-testid*="title"]', '[class*="TitleText"]',
      '[class*="title-name"]', 'h3[class*="title"]', 'h2[class*="title"]',
      '[class*="Card"] span', '[class*="card"] h3'
    ];
    for (const sel of titleSelectors) {
      $(sel).slice(0, 10).each((i, el) => {
        const text = $(el).text().trim();
        if (text && text.length > 1 && text.length < 120 && !/^\d+$/.test(text)) {
          results.push({
            rank: i + 1,
            title: cleanTitle(text),
            type: guessType(text),
            genre: null,
            image_url: null,
            prime_url: `https://www.primevideo.com/search/ref=atv_nb_sr?phrase=${encodeURIComponent(text)}`,
            region
          });
        }
      });
      if (results.length >= 5) break;
    }
  }

  // Deduplicate and trim to top 10
  const seen = new Set();
  const deduped = results.filter(r => {
    const key = r.title.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return r.title.length > 2; // filter junk
  }).slice(0, 10);
  deduped.forEach((r, i) => { r.rank = i + 1; });

  console.log(`[Prime] ${region}: scraped ${deduped.length} titles`);
  return deduped;
}

async function scrapeAllPrime() {
  for (const regionConfig of PRIME_REGIONS) {
    try {
      const rows = await scrapePrimeRegion(regionConfig);
      if (rows.length > 0) {
        await db.upsertTrendingPrime(rows);
      } else {
        console.warn(`[Prime] Got 0 results for ${regionConfig.region} — keeping existing DB data`);
      }
      await new Promise(r => setTimeout(r, 2000));
    } catch (err) {
      console.error(`[Prime] Error for ${regionConfig.region}:`, err.message);
    }
  }
}

// ═══════════════════════════════════════════════════════════════
// IMDb — https://www.imdb.com/?ref_=ls_nv_home
// IMDb homepage shows "Fan Picks", "Top Box Office", "What to Watch"
// Also scrape https://www.imdb.com/chart/top/ for Top 250 top 10
// and https://www.imdb.com/chart/toptv/ for Top TV shows
// ═══════════════════════════════════════════════════════════════

const IMDB_SOURCES = [
  { category: 'fan_picks',  url: 'https://www.imdb.com/' },
  { category: 'top_movies', url: 'https://www.imdb.com/chart/top/' },
  { category: 'top_shows',  url: 'https://www.imdb.com/chart/toptv/' }
];

async function scrapeImdbSource({ category, url }) {
  console.log(`[IMDb] Scraping ${category}...`);
  const html = await safeFetch(url);
  if (!html) { console.warn(`[IMDb] No response for ${category}`); return []; }

  const $ = cheerio.load(html);
  const results = [];

  // IMDb homepage and chart pages both embed JSON-LD with structured data
  $('script[type="application/ld+json"]').each((_, el) => {
    try {
      const obj = JSON.parse($(el).html() || '{}');
      const items = obj.item || obj.itemListElement || obj.containedInPlace || [];
      (Array.isArray(items) ? items : []).slice(0, 10).forEach((item, i) => {
        const name = item.name || item.item?.name;
        const url  = item.url  || item.item?.url || '';
        const rating = item.aggregateRating?.ratingValue || item.item?.aggregateRating?.ratingValue || null;
        if (name) {
          results.push({
            rank:     i + 1,
            title:    cleanTitle(name),
            type:     category.includes('show') ? 'show' : 'movie',
            year:     item.datePublished?.slice(0, 4) || item.item?.datePublished?.slice(0, 4) || null,
            rating:   rating ? String(rating) : null,
            votes:    null,
            genre:    Array.isArray(item.genre) ? item.genre.join(', ') : (item.genre || null),
            image_url: item.image || item.item?.image || null,
            imdb_url:  url.startsWith('http') ? url : ('https://www.imdb.com' + url),
            category
          });
        }
      });
    } catch(e) { /* ignore */ }
  });

  // Fallback: IMDb chart HTML — they use a predictable list structure
  if (!results.length) {
    // Chart pages: list items with rank, title, year, rating
    $('li.ipc-metadata-list-summary-item, [class*="cli-children"], tr.lister-item').each((i, el) => {
      if (i >= 10) return;
      const titleEl = $(el).find('[class*="titleColumn"] a, [class*="title"] a, .lister-item-header a').first();
      const title   = titleEl.text().trim() || $(el).find('h3').first().text().trim();
      const href    = titleEl.attr('href') || '';
      const rating  = $(el).find('[class*="ratingColumn"], [class*="ipc-rating-star--imdb"]').first().text().trim().replace(/[^0-9.]/g, '').slice(0, 4);
      const year    = $(el).find('.secondaryInfo, [class*="year"]').first().text().trim().replace(/[()]/g, '');

      if (title && title.length > 1 && title.length < 120 && !/^\d+$/.test(title)) {
        results.push({
          rank:      i + 1,
          title:     cleanTitle(title),
          type:      category.includes('show') ? 'show' : 'movie',
          year:      year || null,
          rating:    rating || null,
          votes:     null,
          genre:     null,
          image_url: null,
          imdb_url:  href ? ('https://www.imdb.com' + href.split('?')[0]) : `https://www.imdb.com/search/title/?title=${encodeURIComponent(title)}`,
          category
        });
      }
    });
  }

  // IMDb homepage fan picks — different structure
  if (!results.length && category === 'fan_picks') {
    // IMDb homepage uses various widget cards
    const widgetSelectors = [
      '[data-testid="hero-promotion-title"]',
      '[class*="ipc-slate-card"] [class*="titleColumn"]',
      '.lister-item-header a',
      '[class*="MediaStrip"] [class*="title"]',
      '[class*="fan-picks"] a', 
      '[class*="fanpicks"] a',
      '[data-testid*="title"]'
    ];
    for (const sel of widgetSelectors) {
      $(sel).slice(0, 10).each((i, el) => {
        const text = $(el).text().trim();
        const href = $(el).attr('href') || '';
        if (text && text.length > 2 && text.length < 120 && !/^\d+$/.test(text)) {
          results.push({
            rank:      i + 1,
            title:     cleanTitle(text),
            type:      'movie',
            year:      null,
            rating:    null,
            votes:     null,
            genre:     null,
            image_url: null,
            imdb_url:  href ? ('https://www.imdb.com' + href.split('?')[0]) : `https://www.imdb.com/search/title/?title=${encodeURIComponent(text)}`,
            category
          });
        }
      });
      if (results.length >= 5) break;
    }
  }

  const seen = new Set();
  const deduped = results.filter(r => {
    const key = r.title.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return r.title.length > 2;
  }).slice(0, 10);
  deduped.forEach((r, i) => { r.rank = i + 1; });

  console.log(`[IMDb] ${category}: scraped ${deduped.length} titles`);
  return deduped;
}

async function scrapeAllImdb() {
  for (const source of IMDB_SOURCES) {
    try {
      const rows = await scrapeImdbSource(source);
      if (rows.length > 0) {
        await db.upsertTrendingImdb(rows);
      } else {
        console.warn(`[IMDb] Got 0 results for ${source.category} — keeping existing DB data`);
      }
      await new Promise(r => setTimeout(r, 2000));
    } catch (err) {
      console.error(`[IMDb] Error for ${source.category}:`, err.message);
    }
  }
}

// ═══════════════════════════════════════════════════════════════
// HELPERS
// ═══════════════════════════════════════════════════════════════

function cleanTitle(t) {
  return String(t || '')
    .replace(/\s+/g, ' ')
    .replace(/^\d+\.\s*/, '')   // remove leading "1. "
    .replace(/\(TV Series\)/gi, '')
    .replace(/\(TV Mini Series\)/gi, '')
    .trim();
}

function guessType(title) {
  // Simple heuristic — if title ends with S1/S2/Season etc, it's a show
  if (/\bS\d+\b|Season \d|Episode \d|\bSeries\b/i.test(title)) return 'show';
  return 'movie';
}

// Walk a nested JSON object looking for title-like fields
function extractFromNestedJSON(obj, titleFields, rankFields, depth = 0) {
  if (depth > 8 || !obj || typeof obj !== 'object') return [];
  const results = [];

  if (Array.isArray(obj)) {
    for (const item of obj) {
      results.push(...extractFromNestedJSON(item, titleFields, rankFields, depth + 1));
    }
    return results;
  }

  // Check if this object looks like a title entry
  const hasTitle = titleFields.some(f => typeof obj[f] === 'string' && obj[f].length > 1 && obj[f].length < 150);
  if (hasTitle) {
    const entry = {};
    for (const f of titleFields) { if (typeof obj[f] === 'string') { entry.title = obj[f]; break; } }
    for (const f of rankFields)  { if (typeof obj[f] === 'number') { entry.rank  = obj[f]; break; } }
    entry.type     = obj.type || obj.contentType || obj.titleType || null;
    entry.genre    = Array.isArray(obj.genres) ? obj.genres[0]?.name || obj.genres.join(', ') : (obj.genre || null);
    entry.image    = obj.image?.src || obj.imageSrc || obj.thumbnailUrl || obj.posterUrl || null;
    entry.url      = obj.url || obj.href || obj.deeplink || null;
    results.push(entry);
  }

  // Recurse into object values
  for (const key of Object.keys(obj)) {
    if (['props', 'pageProps', 'items', 'titles', 'list', 'entries', 'result',
         'data', 'payload', 'catalogItems', 'trendingItems', 'weeklyTop10'].includes(key)) {
      results.push(...extractFromNestedJSON(obj[key], titleFields, rankFields, depth + 1));
    }
  }
  return results;
}

// ═══════════════════════════════════════════════════════════════
// MAIN SCRAPE RUN — called by cron or manually
// ═══════════════════════════════════════════════════════════════

async function runAllScrapers() {
  console.log('[Scraper] Starting weekly scrape run...');
  const start = Date.now();

  await scrapeAllNetflix();
  await scrapeAllPrime();
  await scrapeAllImdb();

  const elapsed = ((Date.now() - start) / 1000).toFixed(1);
  console.log(`[Scraper] Weekly scrape complete in ${elapsed}s`);
}

// ═══════════════════════════════════════════════════════════════
// CRON — every Thursday at 2:00 AM IST = 20:30 UTC Wednesday
// node-cron syntax: minute hour day-of-month month day-of-week
// ═══════════════════════════════════════════════════════════════

function startScraperCron() {
  // Thursday 2:00 AM IST = Wednesday 20:30 UTC
  cron.schedule('30 20 * * 3', async () => {
    console.log('[Scraper] Thursday cron triggered (20:30 UTC)');
    try {
      await runAllScrapers();
    } catch (err) {
      console.error('[Scraper] Cron run failed:', err.message);
    }
  }, { timezone: 'UTC' });

  console.log('[Scraper] Thursday cron scheduled (20:30 UTC = 2am IST Thursday)');

  // Run once at startup if DB is empty (first deploy)
  setTimeout(async () => {
    try {
      // Check if we have any data at all
      const db2 = require('./db');
      const existing = await db2.getLatestNetflixTop10('canada');
      if (!existing.length) {
        console.log('[Scraper] No data in DB — running initial scrape...');
        await runAllScrapers();
      } else {
        console.log('[Scraper] Existing data found, skipping initial scrape');
      }
    } catch (err) {
      console.error('[Scraper] Initial check failed:', err.message);
    }
  }, 10000); // 10s after startup
}

module.exports = { startScraperCron, runAllScrapers };
