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

// ─── DEDICATED IMDB SCRAPER ────────────────────────────────
// IMDB blocks open-graph-scraper. We fetch directly with browser headers
// and parse the page HTML using cheerio.

async function fetchImdbMeta(url) {
  try {
    const fetch   = (...a) => import('node-fetch').then(m => m.default(...a));
    const cheerio = require('cheerio');
    const res = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        'Accept-Language': 'en-US,en;q=0.9',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      },
      redirect: 'follow',
      signal: AbortSignal.timeout(12000),
    });
    const html = await res.text();
    const $ = cheerio.load(html);

    // ── Method 1: JSON-LD structured data (most reliable) ──
    let title = '', image = '', description = '', year = '', rating = '';
    $('script[type="application/ld+json"]').each((_, el) => {
      try {
        const data = JSON.parse($(el).html() || '');
        if (data['@type'] === 'Movie' || data['@type'] === 'TVSeries' || data['@type'] === 'TVEpisode') {
          title       = title       || data.name || '';
          image       = image       || (Array.isArray(data.image) ? data.image[0]?.url : data.image?.url || data.image) || '';
          description = description || data.description || '';
          year        = year        || (data.datePublished || '').slice(0, 4) || '';
          rating      = rating      || data.aggregateRating?.ratingValue || '';
        }
      } catch(e) {}
    });

    // ── Method 2: og/meta tags ──
    if (!title) {
      title = $('meta[property="og:title"]').attr('content') ||
              $('meta[name="twitter:title"]').attr('content') ||
              $('title').text() || '';
      // IMDB og:title includes " - IMDb" — strip it
      title = title.replace(/\s*[-|]\s*IMDb\s*$/i, '').trim();
    }
    if (!image) {
      image = $('meta[property="og:image"]').attr('content') ||
              $('meta[name="twitter:image"]').attr('content') || '';
    }
    if (!description) {
      description = $('meta[property="og:description"]').attr('content') ||
                    $('meta[name="description"]').attr('content') || '';
    }

    // ── Method 3: DOM selectors ──
    if (!title) {
      title = $('[data-testid="hero__pageTitle"] span').first().text() ||
              $('h1[data-testid="hero-title-block__title"]').text() ||
              $('h1.sc-afe43def').text() || '';
    }
    if (!image) {
      image = $('[data-testid="hero-media__poster"] img').attr('src') ||
              $('img.ipc-image').first().attr('src') || '';
    }
    if (!year) {
      year = $('[data-testid="hero-title-block__metadata"] a').first().text().trim() || '';
    }
    if (!rating) {
      rating = $('[data-testid="hero-rating-bar__aggregate-rating__score"] span').first().text() || '';
    }

    if (!title) throw new Error('IMDB: could not parse title');

    const desc = [description, year ? `(${year})` : '', rating ? `⭐ ${rating}` : ''].filter(Boolean).join(' · ');
    return { title: title.trim(), description: desc, imageUrl: image, sourceUrl: url };
  } catch (err) {
    console.error('[fetchImdbMeta] error:', err.message);
    return null; // caller will fall back to ogs
  }
}

// ─── FETCH METADATA FROM ANY URL ───────────────────────────

async function fetchMeta(url) {
  // Use dedicated IMDB scraper for IMDB URLs — ogs gets blocked
  if (/imdb\.com\/(title|name|film)/.test(url)) {
    const imdbMeta = await fetchImdbMeta(url);
    if (imdbMeta && imdbMeta.title && imdbMeta.title !== 'Movie on IMDB') {
      console.log('[fetchMeta] IMDB direct scrape OK:', imdbMeta.title);
      return imdbMeta;
    }
  }

  try {
    const { result } = await ogs({ url, timeout: 10000 });
    const title = result.ogTitle || result.twitterTitle || result.dcTitle || '';
    if (title) {
      return {
        title:       title.replace(/\s*[-|]\s*IMDb\s*$/i, '').trim(),
        description: result.ogDescription || result.twitterDescription || '',
        imageUrl:    result.ogImage?.[0]?.url || '',
        sourceUrl:   url,
      };
    }
    throw new Error('no title in result');
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
  typeLabel, formatCard, formatSummary,
  formatDigest, formatFilmiCraftCard,
  buildVoteKeyboard, buildSummaryKeyboard,
  escHtml, truncate
};
