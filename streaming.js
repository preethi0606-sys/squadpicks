// streaming.js — Real-time Top 10 from Netflix, Prime Video, Hotstar
// Uses RapidAPI streaming availability services
// Falls back to curated static data if API keys not set

const RAPIDAPI_KEY = process.env.RAPIDAPI_KEY || '';

// ── Streaming availability via Streaming Availability API (RapidAPI) ────────
// https://rapidapi.com/movie-of-the-night-movie-of-the-night-default/api/streaming-availability

async function fetchStreamingTop10(country = 'ca') {
  if (!RAPIDAPI_KEY) {
    console.log('[Streaming] No RAPIDAPI_KEY — using fallback data');
    return getFallbackData();
  }

  try {
    const results = { netflix: [], prime: [], hotstar: [] };

    // Fetch Netflix top shows/movies
    const nfRes = await fetch(
      `https://streaming-availability.p.rapidapi.com/shows/search/filters?country=${country}&catalogs=netflix&order_by=rating&order_direction=desc&genres_relation=and&show_type=series&rating_min=70&limit=10`,
      {
        headers: {
          'x-rapidapi-key': RAPIDAPI_KEY,
          'x-rapidapi-host': 'streaming-availability.p.rapidapi.com'
        }
      }
    );
    if (nfRes.ok) {
      const nfData = await nfRes.json();
      results.netflix = (nfData.shows || []).slice(0, 10).map(show => ({
        title:  show.title,
        score:  show.rating ? (show.rating / 10).toFixed(1) : null,
        emoji:  '📺',
        genre:  (show.genres || []).slice(0, 2).map(g => g.name).join(' · '),
        badge:  'N',
        badgeColor: '#E50914',
        url:    `https://www.netflix.com/search?q=${encodeURIComponent(show.title)}`,
        year:   show.releaseYear || ''
      }));
    }

    // Fetch Prime Video top shows
    const pvRes = await fetch(
      `https://streaming-availability.p.rapidapi.com/shows/search/filters?country=${country}&catalogs=prime&order_by=rating&order_direction=desc&genres_relation=and&show_type=series&rating_min=70&limit=10`,
      {
        headers: {
          'x-rapidapi-key': RAPIDAPI_KEY,
          'x-rapidapi-host': 'streaming-availability.p.rapidapi.com'
        }
      }
    );
    if (pvRes.ok) {
      const pvData = await pvRes.json();
      results.prime = (pvData.shows || []).slice(0, 10).map(show => ({
        title:  show.title,
        score:  show.rating ? (show.rating / 10).toFixed(1) : null,
        emoji:  '📺',
        genre:  (show.genres || []).slice(0, 2).map(g => g.name).join(' · '),
        badge:  'P',
        badgeColor: '#00A8E0',
        url:    `https://www.primevideo.com/search/ref=atv_nb_sr?phrase=${encodeURIComponent(show.title)}`,
        year:   show.releaseYear || ''
      }));
    }

    // Hotstar (Disney+) — use 'disney' catalog
    const hsRes = await fetch(
      `https://streaming-availability.p.rapidapi.com/shows/search/filters?country=in&catalogs=disney&order_by=rating&order_direction=desc&genres_relation=and&show_type=series&rating_min=60&limit=10`,
      {
        headers: {
          'x-rapidapi-key': RAPIDAPI_KEY,
          'x-rapidapi-host': 'streaming-availability.p.rapidapi.com'
        }
      }
    );
    if (hsRes.ok) {
      const hsData = await hsRes.json();
      results.hotstar = (hsData.shows || []).slice(0, 10).map(show => ({
        title:  show.title,
        score:  show.rating ? (show.rating / 10).toFixed(1) : null,
        emoji:  '📺',
        genre:  (show.genres || []).slice(0, 2).map(g => g.name).join(' · '),
        badge:  'H',
        badgeColor: '#1B51AA',
        url:    `https://www.hotstar.com/in/search?q=${encodeURIComponent(show.title)}`,
        year:   show.releaseYear || ''
      }));
    }

    // Merge all 3, sort by score descending, take top 10
    const all = [...results.netflix, ...results.prime, ...results.hotstar];
    all.sort((a, b) => parseFloat(b.score || 0) - parseFloat(a.score || 0));
    const top10 = all.slice(0, 10);

    // Cache the result for 6 hours
    streamingCache = { data: { all: top10, netflix: results.netflix, prime: results.prime, hotstar: results.hotstar }, ts: Date.now() };
    return streamingCache.data;

  } catch (err) {
    console.error('[Streaming API error]', err.message);
    return getFallbackData();
  }
}

// Simple in-memory cache (6 hours)
let streamingCache = null;
const CACHE_TTL = 6 * 60 * 60 * 1000;

async function getStreamingTop10(country = 'ca') {
  if (streamingCache && (Date.now() - streamingCache.ts) < CACHE_TTL) {
    return streamingCache.data;
  }
  return fetchStreamingTop10(country);
}

// ── Fallback curated data (used when no API key) ──────────────────────────
function getFallbackData() {
  const netflix = [
    { title:'Adolescence',       score:'4.8', emoji:'📺', genre:'British Drama',       badge:'N', badgeColor:'#E50914', url:'https://www.netflix.com/search?q=Adolescence' },
    { title:'The Diplomat S3',   score:'4.5', emoji:'📺', genre:'Political Thriller',  badge:'N', badgeColor:'#E50914', url:'https://www.netflix.com/search?q=The+Diplomat' },
    { title:'Squid Game S3',     score:'4.6', emoji:'📺', genre:'Korean Thriller',     badge:'N', badgeColor:'#E50914', url:'https://www.netflix.com/search?q=Squid+Game' },
    { title:'Kota Factory S3',   score:'4.7', emoji:'📺', genre:'Hindi Drama',         badge:'N', badgeColor:'#E50914', url:'https://www.netflix.com/search?q=Kota+Factory' },
    { title:'Stranger Things S5',score:'4.9', emoji:'📺', genre:'Sci-fi Horror',       badge:'N', badgeColor:'#E50914', url:'https://www.netflix.com/search?q=Stranger+Things' },
  ];
  const prime = [
    { title:'Panchayat S4',      score:'4.9', emoji:'📺', genre:'Hindi Comedy Drama',  badge:'P', badgeColor:'#00A8E0', url:'https://www.primevideo.com/search/ref=atv_nb_sr?phrase=Panchayat' },
    { title:'The Boys S5',       score:'4.7', emoji:'📺', genre:'Superhero Dark',      badge:'P', badgeColor:'#00A8E0', url:'https://www.primevideo.com/search/ref=atv_nb_sr?phrase=The+Boys' },
    { title:'Reacher S3',        score:'4.5', emoji:'📺', genre:'Action Thriller',     badge:'P', badgeColor:'#00A8E0', url:'https://www.primevideo.com/search/ref=atv_nb_sr?phrase=Reacher' },
    { title:'Fallout S2',        score:'4.8', emoji:'📺', genre:'Post-apocalyptic',    badge:'P', badgeColor:'#00A8E0', url:'https://www.primevideo.com/search/ref=atv_nb_sr?phrase=Fallout' },
    { title:'Invincible S3',     score:'4.7', emoji:'📺', genre:'Animated Superhero',  badge:'P', badgeColor:'#00A8E0', url:'https://www.primevideo.com/search/ref=atv_nb_sr?phrase=Invincible' },
  ];
  const hotstar = [
    { title:'Scam 2003',          score:'4.6', emoji:'📺', genre:'Hindi True Crime',    badge:'H', badgeColor:'#1B51AA', url:'https://www.hotstar.com/in/search?q=Scam+2003' },
    { title:'Farzi S2',           score:'4.5', emoji:'📺', genre:'Hindi Thriller',      badge:'H', badgeColor:'#1B51AA', url:'https://www.hotstar.com/in/search?q=Farzi' },
    { title:'Criminal Justice S4',score:'4.4', emoji:'📺', genre:'Legal Drama',         badge:'H', badgeColor:'#1B51AA', url:'https://www.hotstar.com/in/search?q=Criminal+Justice' },
    { title:'Aarya S3',           score:'4.3', emoji:'📺', genre:'Hindi Crime Drama',   badge:'H', badgeColor:'#1B51AA', url:'https://www.hotstar.com/in/search?q=Aarya' },
    { title:'IC 814',             score:'4.7', emoji:'📺', genre:'Hindi Thriller',      badge:'H', badgeColor:'#1B51AA', url:'https://www.hotstar.com/in/search?q=IC+814' },
  ];
  const all = [...netflix,...prime,...hotstar].sort((a,b)=>parseFloat(b.score||0)-parseFloat(a.score||0));
  return { all, netflix, prime, hotstar };
}

module.exports = { getStreamingTop10 };
