const https = require('https');
const http = require('http');
const { URL } = require('url');

// Expand shortened URLs (goo.gl/maps, bit.ly, etc.)
async function expandUrl(url) {
  return new Promise((resolve) => {
    try {
      const parsed = new URL(url);
      const lib = parsed.protocol === 'https:' ? https : http;
      const req = lib.request(url, { method: 'HEAD', timeout: 5000 }, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          resolve(res.headers.location);
        } else {
          resolve(url);
        }
      });
      req.on('error', () => resolve(url));
      req.on('timeout', () => { req.destroy(); resolve(url); });
      req.end();
    } catch {
      resolve(url);
    }
  });
}

// Fetch raw HTML with a browser-like User-Agent
async function fetchHtml(url) {
  return new Promise((resolve, reject) => {
    try {
      const parsed = new URL(url);
      const lib = parsed.protocol === 'https:' ? https : http;
      const options = {
        hostname: parsed.hostname,
        path: parsed.pathname + parsed.search,
        headers: {
          'User-Agent': 'Mozilla/5.0 (compatible; SquadPicksBot/1.0)',
          'Accept': 'text/html,application/xhtml+xml',
          'Accept-Language': 'en-US,en;q=0.9',
        },
        timeout: 8000,
      };
      const req = lib.request(options, (res) => {
        // Follow one redirect
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          fetchHtml(res.headers.location).then(resolve).catch(reject);
          return;
        }
        let data = '';
        res.setEncoding('utf8');
        res.on('data', chunk => { data += chunk; if (data.length > 200000) req.destroy(); });
        res.on('end', () => resolve(data));
      });
      req.on('error', reject);
      req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
      req.end();
    } catch (e) { reject(e); }
  });
}

// Extract OG / meta tags from HTML
function parseMetaTags(html) {
  const meta = {};

  const ogTitle    = html.match(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i);
  const ogDesc     = html.match(/<meta[^>]+property=["']og:description["'][^>]+content=["']([^"']+)["']/i);
  const ogImage    = html.match(/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i);
  const titleTag   = html.match(/<title[^>]*>([^<]+)<\/title>/i);
  const metaDesc   = html.match(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']+)["']/i);

  // Also try reversed attribute order
  const ogTitle2   = html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:title["']/i);
  const ogDesc2    = html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:description["']/i);
  const ogImage2   = html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image["']/i);

  meta.title       = (ogTitle || ogTitle2)?.[1] || titleTag?.[1] || '';
  meta.description = (ogDesc || ogDesc2)?.[1]   || metaDesc?.[1] || '';
  meta.image       = (ogImage || ogImage2)?.[1] || '';

  // Clean up HTML entities
  meta.title       = decodeEntities(meta.title.trim());
  meta.description = decodeEntities(meta.description.trim());

  return meta;
}

function decodeEntities(str) {
  return str
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#039;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(parseInt(code)));
}

// Special parser for Google Maps URLs
function parseGoogleMaps(url) {
  // Extract place name from various Maps URL formats
  const placeMatch = url.match(/place\/([^/@]+)/);
  if (placeMatch) {
    const name = decodeURIComponent(placeMatch[1].replace(/\+/g, ' '));
    return { title: name, description: 'Google Maps location', image: '' };
  }
  const qMatch = url.match(/[?&]q=([^&]+)/);
  if (qMatch) {
    const name = decodeURIComponent(qMatch[1].replace(/\+/g, ' '));
    return { title: name, description: 'Google Maps location', image: '' };
  }
  return null;
}

// Main export
async function extractMetadata(rawUrl) {
  // Expand shortened URLs first
  let url = rawUrl;
  if (/goo\.gl|bit\.ly|tinyurl|t\.co|maps\.app\.goo/i.test(rawUrl)) {
    url = await expandUrl(rawUrl);
  }

  // Google Maps special handling
  if (/maps\.google|google\.[a-z]+\/maps|maps\.app\.goo/i.test(url)) {
    const mapsMeta = parseGoogleMaps(url);
    if (mapsMeta && mapsMeta.title) return mapsMeta;
  }

  // Generic OG/meta scrape
  const html = await fetchHtml(url);
  const meta = parseMetaTags(html);

  if (!meta.title) meta.title = new URL(url).hostname.replace('www.', '');
  return meta;
}

module.exports = { extractMetadata };
