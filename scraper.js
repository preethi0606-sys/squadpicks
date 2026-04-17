// scraper.js — Weekly Thursday cron: Netflix, Prime Video, IMDb
// Runs every Thursday at 2:00 AM IST (20:30 UTC Wednesday)
// Stores results in Supabase trending tables, refreshes each week
'use strict';

const cron    = require('node-cron');
const fetch   = (...args) => import('node-fetch').then(m => m.default(...args));
const cheerio = require('cheerio');
const db      = require('./db');

// ── Browser-like headers to avoid bot blocking ────────────────────────────
const HEADERS = {
  'User-Agent':                'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Accept':                    'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
  'Accept-Language':           'en-US,en;q=0.9',
  'Accept-Encoding':           'gzip, deflate, br',
  'Cache-Control':             'no-cache',
  'Pragma':                    'no-cache',
  'Sec-Fetch-Dest':            'document',
  'Sec-Fetch-Mode':            'navigate',
  'Sec-Fetch-Site':            'none',
  'Upgrade-Insecure-Requests': '1'
};

async function safeFetch(url, retries = 2) {
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const ctrl   = new AbortController();
      const timer  = setTimeout(() => ctrl.abort(), 25000);
      const res    = await fetch(url, { headers: HEADERS, signal: ctrl.signal, redirect: 'follow' });
      clearTimeout(timer);
      if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
      return await res.text();
    } catch (err) {
      console.warn(`[Scraper] Attempt ${attempt+1} failed: ${err.message}`);
      if (attempt < retries) await sleep(3000 * (attempt + 1));
    }
  }
  return null;
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

// ─────────────────────────────────────────────────────────────────────────────
// NETFLIX TOP 10 — https://www.netflix.com/tudum/top10/{region}
//
// Netflix Tudum pages are Next.js apps. The page HTML contains a
// <script id="__NEXT_DATA__"> tag with all the page props as JSON.
// We parse that JSON to extract the ranked title list.
//
// Fallback: parse the visible HTML table/list which Netflix also renders
// server-side for SEO.
// ─────────────────────────────────────────────────────────────────────────────

const NETFLIX_REGIONS = [
  { region: 'canada', url: 'https://www.netflix.com/tudum/top10/canada' },
  { region: 'us',     url: 'https://www.netflix.com/tudum/top10/united-states' },
  { region: 'india',  url: 'https://www.netflix.com/tudum/top10/india' }
];

async function scrapeNetflixRegion({ region, url }) {
  console.log(`[Netflix] Scraping ${region} from ${url}`);
  const html = await safeFetch(url);
  if (!html) { console.warn(`[Netflix] No HTML for ${region}`); return []; }

  const $ = cheerio.load(html);
  const results = [];

  // ── Method 1: __NEXT_DATA__ JSON (most reliable) ──────────────────────────
  const nextScript = $('script#__NEXT_DATA__').html() ||
                     $('script[type="application/json"]').first().html() || '';
  if (nextScript) {
    try {
      const pageData = JSON.parse(nextScript);
      // Walk the props tree — Netflix stores rows under
      // props.pageProps.pageData or similar nested paths
      const titles = findNetflixTitles(pageData);
      titles.forEach((item, i) => {
        if (results.length >= 10) return;
        const t = cleanTitle(item.title || item.name || item.titleText || '');
        if (!t) return;
        results.push({
          rank:        item.rank || (i + 1),
          title:       t,
          type:        normaliseType(item.type || item.contentType || ''),
          genre:       extractGenre(item),
          image_url:   extractNetflixImage(item),
          netflix_url: buildNetflixUrl(item, t),
          region
        });
      });
    } catch (e) {
      console.warn(`[Netflix] __NEXT_DATA__ parse error for ${region}: ${e.message}`);
    }
  }

  // ── Method 2: look for any script with rankingTitle / titleText ───────────
  if (!results.length) {
    $('script').each((_, el) => {
      if (results.length >= 10) return;
      const src = $(el).html() || '';
      if (src.length < 100) return;
      if (!src.includes('rankingTitle') && !src.includes('titleText') && !src.includes('top10')) return;
      try {
        // Extract the first sizeable JSON object
        const match = src.match(/\{[\s\S]{500,}\}/);
        if (!match) return;
        const obj = JSON.parse(match[0]);
        const titles = findNetflixTitles(obj);
        titles.forEach((item, i) => {
          if (results.length >= 10) return;
          const t = cleanTitle(item.title || item.name || item.titleText || '');
          if (!t) return;
          results.push({
            rank:        item.rank || (i + 1),
            title:       t,
            type:        normaliseType(item.type || ''),
            genre:       extractGenre(item),
            image_url:   extractNetflixImage(item),
            netflix_url: buildNetflixUrl(item, t),
            region
          });
        });
      } catch (_) {}
    });
  }

  // ── Method 3: HTML table fallback (Netflix renders a table for SEO) ───────
  if (!results.length) {
    // Netflix Tudum top 10 tables have a rank column and a title column
    $('tr').each((_, row) => {
      if (results.length >= 10) return;
      const cells = $(row).find('td');
      if (cells.length < 2) return;
      const rankTxt  = $(cells[0]).text().trim();
      const rank     = parseInt(rankTxt);
      if (!rank || rank < 1 || rank > 10) return;
      // Title is usually in cell 1 or 2
      let title = '';
      cells.each((ci, cell) => {
        if (title) return;
        const t = $(cell).find('a, h2, h3, strong, [class*="title"]').first().text().trim()
               || $(cell).text().trim();
        if (t && t.length > 1 && t.length < 120 && !/^\d+$/.test(t)) title = t;
      });
      if (!title) return;
      // Image from the row or nearby
      const img = $(row).find('img').first().attr('src') || null;
      const href = $(row).find('a').first().attr('href') || '';
      results.push({
        rank,
        title:       cleanTitle(title),
        type:        'show',
        genre:       null,
        image_url:   img,
        netflix_url: href.startsWith('http') ? href : href ? ('https://www.netflix.com' + href)
                     : `https://www.netflix.com/search?q=${encodeURIComponent(title)}`,
        region
      });
    });
  }

  // ── Method 4: List items with rank markers ─────────────────────────────────
  if (!results.length) {
    const selectors = [
      '[class*="top10-title"]', '[class*="RankTitle"]', '[class*="rank"] h3',
      '[data-testid*="title"]', 'article h2', 'article h3', 'li h2', 'li h3'
    ];
    for (const sel of selectors) {
      if (results.length >= 5) break;
      $(sel).slice(0, 10).each((i, el) => {
        const t = $(el).text().trim();
        if (!t || t.length < 2 || t.length > 120 || /^\d+$/.test(t)) return;
        const img  = $(el).closest('article, li, div').find('img').first().attr('src') || null;
        const href = $(el).closest('a').attr('href') || $(el).find('a').first().attr('href') || '';
        results.push({
          rank:        i + 1,
          title:       cleanTitle(t),
          type:        'show',
          genre:       null,
          image_url:   img,
          netflix_url: href ? (href.startsWith('http') ? href : 'https://www.netflix.com' + href)
                             : `https://www.netflix.com/search?q=${encodeURIComponent(t)}`,
          region
        });
      });
    }
  }

  const deduped = dedup(results).slice(0, 10);
  deduped.forEach((r, i) => { r.rank = i + 1; });
  console.log(`[Netflix] ${region}: ${deduped.length} titles`);
  return deduped;
}

// Walk nested JSON looking for Netflix title objects
function findNetflixTitles(obj, depth = 0) {
  if (depth > 10 || !obj || typeof obj !== 'object') return [];
  const results = [];
  if (Array.isArray(obj)) {
    for (const item of obj) results.push(...findNetflixTitles(item, depth + 1));
    return results;
  }
  // Netflix title objects have rankingTitle or titleText + rank/rankNum
  const hasTitle = typeof obj.rankingTitle === 'string' || typeof obj.titleText === 'string' || typeof obj.title === 'string';
  const hasRank  = typeof obj.rank === 'number' || typeof obj.rankNum === 'number' || typeof obj.position === 'number';
  if (hasTitle) {
    const entry = {
      title:     obj.rankingTitle || obj.titleText || obj.title || obj.name,
      rank:      obj.rank || obj.rankNum || obj.position || null,
      type:      obj.type || obj.contentType || obj.titleType || null,
      genreList: obj.genreList || obj.genres || null,
      // Images
      boxart:    obj.boxArt || obj.boxart || null,
      image:     (obj.images && (obj.images.boxArt || obj.images.poster)) || obj.imageUrl || null,
      // Netflix direct link
      href:      obj.href || obj.watchUrl || obj.url || null,
      titleId:   obj.titleId || obj.id || null
    };
    results.push(entry);
    if (results.length >= 10 && hasRank) return results;
  }
  // Recurse into known key names
  const keys = ['items', 'titles', 'ranks', 'weeklyTop10', 'top10', 'topTen', 'list',
                 'data', 'result', 'pageProps', 'props', 'payload', 'rows', 'cards',
                 'topTitles', 'tvTopTitles', 'filmTopTitles'];
  for (const key of keys) {
    if (obj[key]) results.push(...findNetflixTitles(obj[key], depth + 1));
  }
  return results;
}

function extractNetflixImage(item) {
  if (!item) return null;
  if (item.boxart?.url)  return item.boxart.url;
  if (item.image?.url)   return item.image.url;
  if (typeof item.boxart === 'string') return item.boxart;
  if (typeof item.image  === 'string') return item.image;
  if (item.imageUrl)     return item.imageUrl;
  return null;
}

function buildNetflixUrl(item, title) {
  if (item.href) return item.href.startsWith('http') ? item.href : 'https://www.netflix.com' + item.href;
  if (item.watchUrl) return item.watchUrl;
  if (item.titleId) return `https://www.netflix.com/watch/${item.titleId}`;
  return `https://www.netflix.com/search?q=${encodeURIComponent(title)}`;
}

function extractGenre(item) {
  if (!item) return null;
  if (Array.isArray(item.genreList)) return item.genreList.slice(0, 2).map(g => (typeof g === 'string' ? g : g.name || '')).filter(Boolean).join(', ');
  if (Array.isArray(item.genres))    return item.genres.slice(0, 2).map(g => (typeof g === 'string' ? g : g.name || '')).filter(Boolean).join(', ');
  if (typeof item.genre === 'string') return item.genre;
  return null;
}

async function scrapeAllNetflix() {
  for (const cfg of NETFLIX_REGIONS) {
    try {
      const rows = await scrapeNetflixRegion(cfg);
      if (rows.length) await db.upsertTrendingNetflix(rows);
      else console.warn(`[Netflix] 0 results for ${cfg.region} — keeping existing data`);
    } catch (e) { console.error(`[Netflix] ${cfg.region} error:`, e.message); }
    await sleep(2000);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// PRIME VIDEO TOP 10 — Canada only
// URL: https://www.primevideo.com/collection/SVODTop10
//
// Prime Video renders a grid of title cards under a "Top 10 in Canada" heading.
// We need the INDIVIDUAL TITLES under that heading, NOT the heading itself.
// The page embeds state JSON and also server-renders title cards.
// ─────────────────────────────────────────────────────────────────────────────

async function scrapePrimeCanada() {
  const url = 'https://www.primevideo.com/collection/SVODTop10';
  console.log(`[Prime] Scraping Canada from ${url}`);
  const html = await safeFetch(url);
  if (!html) { console.warn('[Prime] No HTML'); return []; }

  const $ = cheerio.load(html);
  const results = [];

  // ── Method 1: Embedded state JSON ─────────────────────────────────────────
  $('script').each((_, el) => {
    if (results.length >= 10) return;
    const src = $(el).html() || '';
    if (src.length < 200) return;
    // Prime embeds catalog data in window.__STORE__ or similar
    const jsonPatterns = [
      /"catalogItems"\s*:\s*(\[[\s\S]{100,}\])/,
      /"heroCarousel"\s*:\s*(\{[\s\S]{100,}\})/,
      /window\.__STORE__\s*=\s*(\{[\s\S]{100,}\});/,
      /__INITIAL_DATA__\s*=\s*(\{[\s\S]{100,}\});/
    ];
    for (const pattern of jsonPatterns) {
      if (results.length >= 10) break;
      try {
        const match = src.match(pattern);
        if (!match) continue;
        const obj = JSON.parse(match[1]);
        extractPrimeTitles(obj).forEach(item => {
          if (results.length >= 10) return;
          const t = cleanTitle(item.title || '');
          if (!t || t.length < 2) return;
          // Skip headings like "Top 10 in Canada"
          if (/^top\s*10/i.test(t) || /in\s+canada/i.test(t) || /in\s+india/i.test(t)) return;
          results.push({
            rank:      item.rank || (results.length + 1),
            title:     t,
            type:      normaliseType(item.type || ''),
            genre:     item.genre || null,
            image_url: item.image || null,
            prime_url: item.url || `https://www.primevideo.com/search/ref=atv_nb_sr?phrase=${encodeURIComponent(t)}`,
            region:    'ca'
          });
        });
      } catch (_) {}
    }
  });

  // ── Method 2: HTML title cards ─────────────────────────────────────────────
  if (results.length < 5) {
    // Prime renders cards with title text and images
    // Each card usually has a nested structure like: div > img + div > span (title)
    const titleSelectors = [
      '[data-automation-id="title"]',
      '[class*="_titleText_"]',
      '[class*="DmTitleLink"]',
      '[class*="aok-overflow-hidden"] span',
      '[class*="TitleCard"] span',
      '[class*="title-text"]',
      'span[class*="title"]'
    ];
    for (const sel of titleSelectors) {
      if (results.length >= 10) break;
      $(sel).each((_, el) => {
        if (results.length >= 10) return;
        const t = $(el).text().trim();
        if (!t || t.length < 2 || t.length > 120) return;
        if (/^\d+$/.test(t)) return; // skip pure numbers
        // Skip section headings
        if (/^top\s*10/i.test(t) || /in\s+canada/i.test(t) || /prime\s+video/i.test(t)) return;
        const card = $(el).closest('[class*="Card"], [class*="card"], li, article');
        const img  = card.find('img').first().attr('src')
                  || card.find('img').first().attr('data-src') || null;
        const href = card.find('a').first().attr('href') || '';
        const fullUrl = href.startsWith('http') ? href
                      : href ? 'https://www.primevideo.com' + href
                      : `https://www.primevideo.com/search/ref=atv_nb_sr?phrase=${encodeURIComponent(t)}`;
        results.push({
          rank:      results.length + 1,
          title:     cleanTitle(t),
          type:      'show',
          genre:     null,
          image_url: img,
          prime_url: fullUrl,
          region:    'ca'
        });
      });
    }
  }

  // ── Method 3: Any numbered list ───────────────────────────────────────────
  if (results.length < 5) {
    $('[class*="rank"], [class*="position"]').each((_, el) => {
      if (results.length >= 10) return;
      const rankTxt = $(el).text().trim();
      const rank    = parseInt(rankTxt);
      if (!rank || rank > 10) return;
      const container = $(el).closest('li, article, [class*="item"]');
      const titleEl   = container.find('h2, h3, [class*="title"]').first();
      const t = titleEl.text().trim() || container.find('span').first().text().trim();
      if (!t || t.length < 2 || /^top\s*10/i.test(t)) return;
      const img  = container.find('img').first().attr('src') || null;
      const href = container.find('a').first().attr('href') || '';
      results.push({
        rank,
        title:     cleanTitle(t),
        type:      'show',
        genre:     null,
        image_url: img,
        prime_url: href ? (href.startsWith('http') ? href : 'https://www.primevideo.com' + href)
                        : `https://www.primevideo.com/search/ref=atv_nb_sr?phrase=${encodeURIComponent(t)}`,
        region:    'ca'
      });
    });
  }

  const deduped = dedup(results).filter(r => {
    // Final filter: remove headings that slipped through
    return !/^top\s*10/i.test(r.title) && !/in\s+canada/i.test(r.title) && r.title.length > 2;
  }).slice(0, 10);
  deduped.forEach((r, i) => { r.rank = i + 1; });
  console.log(`[Prime] ca: ${deduped.length} titles`);
  return deduped;
}

function extractPrimeTitles(obj, depth = 0) {
  if (depth > 8 || !obj || typeof obj !== 'object') return [];
  const results = [];
  if (Array.isArray(obj)) {
    for (const item of obj) results.push(...extractPrimeTitles(item, depth + 1));
    return results;
  }
  // A Prime title object has title + asin or id
  const hasTitle = typeof obj.title === 'string' && obj.title.length > 1 && obj.title.length < 120;
  const hasId    = obj.asin || obj.gti || obj.id;
  if (hasTitle && hasId) {
    results.push({
      title: obj.title,
      rank:  obj.rank || obj.position || null,
      type:  obj.contentType || obj.titleType || null,
      genre: Array.isArray(obj.genres) ? obj.genres[0] : (obj.genre || null),
      image: obj.image?.src || obj.imageSrc || obj.coverImageUrl || null,
      url:   obj.url || (obj.asin ? `https://www.primevideo.com/dp/${obj.asin}` : null)
    });
  }
  const descend = ['items', 'titles', 'entries', 'catalogItems', 'collections',
                   'data', 'result', 'payload', 'props', 'rows', 'cards', 'content'];
  for (const key of descend) {
    if (obj[key]) results.push(...extractPrimeTitles(obj[key], depth + 1));
  }
  return results;
}

async function scrapeAllPrime() {
  try {
    const rows = await scrapePrimeCanada();
    if (rows.length) await db.upsertTrendingPrime(rows);
    else console.warn('[Prime] 0 results for ca — keeping existing data');
  } catch (e) { console.error('[Prime] error:', e.message); }
}

// ─────────────────────────────────────────────────────────────────────────────
// IMDb — Homepage + Chart pages
//
// IMDb chart pages (top 250, top TV) render their lists server-side in a
// <ul class="ipc-metadata-list"> with structured list items.
// The homepage has fan-picks widgets.
// ─────────────────────────────────────────────────────────────────────────────

const IMDB_SOURCES = [
  { category: 'fan_picks',  url: 'https://www.imdb.com/'             },
  { category: 'top_movies', url: 'https://www.imdb.com/chart/top/'   },
  { category: 'top_shows',  url: 'https://www.imdb.com/chart/toptv/' }
];

async function scrapeImdbSource({ category, url }) {
  console.log(`[IMDb] Scraping ${category} from ${url}`);
  const html = await safeFetch(url);
  if (!html) { console.warn(`[IMDb] No HTML for ${category}`); return []; }

  const $ = cheerio.load(html);
  const results = [];

  // ── Method 1: JSON-LD structured data (IMDb embeds this for SEO) ──────────
  $('script[type="application/ld+json"]').each((_, el) => {
    if (results.length >= 10) return;
    try {
      const obj = JSON.parse($(el).html() || '{}');
      const items = obj.item || obj.itemListElement || [];
      (Array.isArray(items) ? items : []).forEach((item, i) => {
        if (results.length >= 10) return;
        const name   = item.name || item.item?.name || '';
        const href   = item.url  || item.item?.url  || '';
        const rating = item.aggregateRating?.ratingValue
                    || item.item?.aggregateRating?.ratingValue || null;
        const img    = item.image || item.item?.image || null;
        if (!name || name.length < 1) return;
        results.push({
          rank:      i + 1,
          title:     cleanTitle(name),
          type:      category.includes('show') ? 'show' : 'movie',
          year:      item.datePublished?.slice(0,4) || item.item?.datePublished?.slice(0,4) || null,
          rating:    rating ? String(parseFloat(rating).toFixed(1)) : null,
          votes:     null,
          genre:     Array.isArray(item.genre) ? item.genre.join(', ') : (item.genre || null),
          image_url: typeof img === 'string' ? img : (img?.url || null),
          imdb_url:  href.startsWith('http') ? href.split('?')[0] : href ? 'https://www.imdb.com' + href.split('?')[0] : null,
          category
        });
      });
    } catch (_) {}
  });

  // ── Method 2: IMDb chart list (ipc-metadata-list items) ───────────────────
  if (!results.length) {
    // IMDb chart pages use a <ul class="ipc-metadata-list"> with <li> items
    $('li.ipc-metadata-list-summary-item, li[class*="cli-parent"]').each((i, el) => {
      if (results.length >= 10) return;
      const titleEl  = $(el).find('[class*="titleColumn"] a, [class*="title"] a, h3.ipc-title__text').first();
      const title    = titleEl.text().trim().replace(/^\d+\.\s*/, '');
      const href     = titleEl.attr('href') || $(el).find('a').first().attr('href') || '';
      const rating   = $(el).find('[class*="ipc-rating-star--imdb"], [class*="ratingNumber"]').first()
                       .text().trim().replace(/[^0-9.]/g,'').slice(0,4);
      const year     = $(el).find('[class*="secondaryInfo"], span[class*="year"]').first().text().replace(/[()]/g,'').trim();
      const img      = $(el).find('img').first().attr('src') || null;

      if (!title || title.length < 2 || title.length > 120) return;
      results.push({
        rank:      i + 1,
        title:     cleanTitle(title),
        type:      category.includes('show') ? 'show' : 'movie',
        year:      year || null,
        rating:    rating || null,
        votes:     null,
        genre:     null,
        image_url: img,
        imdb_url:  href ? 'https://www.imdb.com' + href.split('?')[0] : null,
        category
      });
    });
  }

  // ── Method 3: IMDb homepage — fan picks widget ───────────────────────────
  if (!results.length && category === 'fan_picks') {
    // IMDb homepage has multiple carousels. Look for title cards.
    $('[data-testid="title-card"], [class*="TitleCard"], [class*="ipc-sub-grid-item"]').each((i, el) => {
      if (results.length >= 10) return;
      const title    = $(el).find('[class*="title"], [class*="titleText"], h3, h4').first().text().trim();
      const href     = $(el).find('a').first().attr('href') || '';
      const rating   = $(el).find('[class*="rating"], [class*="star"]').first().text().trim().replace(/[^0-9.]/g,'').slice(0,4);
      const img      = $(el).find('img').first().attr('src') || null;

      if (!title || title.length < 2 || title.length > 120 || /^\d+$/.test(title)) return;
      results.push({
        rank:      i + 1,
        title:     cleanTitle(title),
        type:      'movie',
        year:      null,
        rating:    rating || null,
        votes:     null,
        genre:     null,
        image_url: img,
        imdb_url:  href ? 'https://www.imdb.com' + href.split('?')[0] : `https://www.imdb.com/search/title/?title=${encodeURIComponent(title)}`,
        category
      });
    });
  }

  // ── Method 4: simple link parsing for chart pages ─────────────────────────
  if (!results.length) {
    $('a[href*="/title/tt"]').each((_, el) => {
      if (results.length >= 10) return;
      const title = $(el).text().trim().replace(/^\d+\.\s*/, '');
      const href  = $(el).attr('href') || '';
      if (!title || title.length < 2 || title.length > 120) return;
      const img = $(el).closest('li, tr, div').find('img').first().attr('src') || null;
      results.push({
        rank:      results.length + 1,
        title:     cleanTitle(title),
        type:      category.includes('show') ? 'show' : 'movie',
        year:      null,
        rating:    null,
        votes:     null,
        genre:     null,
        image_url: img,
        imdb_url:  'https://www.imdb.com' + href.split('?')[0],
        category
      });
    });
  }

  const deduped = dedup(results).slice(0, 10);
  deduped.forEach((r, i) => { r.rank = i + 1; });
  console.log(`[IMDb] ${category}: ${deduped.length} titles`);
  return deduped;
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
    .replace(/^\d+[\.\)]\s*/,'')       // remove leading "1. " or "1) "
    .replace(/\(TV (Series|Mini.Series|Movie)\)/gi,'')
    .replace(/^\s*[\u2013\u2014-]\s*/,'')  // remove leading dash
    .trim();
}

function normaliseType(t) {
  t = String(t || '').toLowerCase();
  if (/movie|film/.test(t)) return 'movie';
  if (/show|series|tv|episode/.test(t)) return 'show';
  return 'show'; // default for streaming
}

function guessType(title) {
  if (/\bS\d+\b|Season \d|Episode \d|\bSeries\b/i.test(title)) return 'show';
  return 'movie';
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
// MAIN SCRAPE RUN
// ─────────────────────────────────────────────────────────────────────────────

async function runAllScrapers() {
  console.log('[Scraper] Starting weekly scrape run...');
  const t0 = Date.now();
  await scrapeAllNetflix();
  await scrapeAllPrime();
  await scrapeAllImdb();
  console.log(`[Scraper] Done in ${((Date.now()-t0)/1000).toFixed(1)}s`);
}

// ─────────────────────────────────────────────────────────────────────────────
// CRON — every Thursday 20:30 UTC = Friday 2:00 AM IST
// ─────────────────────────────────────────────────────────────────────────────

function startScraperCron() {
  cron.schedule('30 20 * * 3', async () => {
    console.log('[Scraper] Thursday cron fired');
    try { await runAllScrapers(); }
    catch (e) { console.error('[Scraper] cron error:', e.message); }
  }, { timezone: 'UTC' });

  console.log('[Scraper] Cron scheduled: Thu 20:30 UTC (= Fri 2:00 AM IST)');

  // Auto-run on first deploy if DB is empty
  setTimeout(async () => {
    try {
      const existing = await db.getLatestNetflixTop10('canada');
      if (!existing.length) {
        console.log('[Scraper] Empty DB — running initial scrape now...');
        await runAllScrapers();
      } else {
        console.log(`[Scraper] DB has ${existing.length} Netflix rows — skipping initial scrape`);
      }
    } catch (e) { console.error('[Scraper] Initial check error:', e.message); }
  }, 12000);
}

module.exports = { startScraperCron, runAllScrapers };
