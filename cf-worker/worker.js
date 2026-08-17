/* ============================================================================
   SHOWMUST — Cloudflare Worker (production)

   Pre-scrapes theatre/cinema/music listings from 7 sources, merges them into
   one JSON payload, and caches it in KV (refreshed by a cron trigger every
   3h). The client fetches this once and does all filtering locally.

   IMDb ratings are intentionally NOT resolved here. Each visitor supplies
   their own free OMDb API key client-side (stored in their own browser's
   localStorage) - so there is no OMDB_API_KEY secret and no server-side OMDb
   traffic. Cinema events still carry `imdbHint` (an English-title hint
   scraped alongside the showtime, e.g. from Rav-Hen's URL slug or Lev's
   English title) purely to make the client's own OMDb search more accurate -
   the server never calls OMDb itself.
   ============================================================================ */

// ============================================================================
// Shared utilities
// ============================================================================

const BROWSER_HEADERS_HTML = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'he-IL,he;q=0.9,en-US;q=0.8,en;q=0.7',
};

const BROWSER_HEADERS_JSON = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Accept': 'application/json, text/plain, */*',
  'Accept-Language': 'he-IL,he;q=0.9,en-US;q=0.8,en;q=0.7',
};

function makeId(source, title, date) {
  const t = (title || '').replace(/\s+/g, '_').slice(0, 40);
  const d = date instanceof Date && !isNaN(date) ? date.toISOString().slice(0, 16) : 'na';
  return `${source}-${t}-${d}`;
}

/* Workers always run in UTC - there is no "local timezone" the way a visitor's browser has
   one. Scraped day/month/hour/minute values are Israel wall-clock time, so naively doing
   new Date(year, month-1, day, hour, minute) here would silently shift every event by
   2-3 hours (the Worker would interpret those fields as UTC). This round-trips a UTC guess
   through Intl's Asia/Jerusalem formatter to find the real offset (DST-safe) and corrects. */
function israelWallTimeToUTC(year, month, day, hour = 0, minute = 0, second = 0) {
  const guess = new Date(Date.UTC(year, month - 1, day, hour, minute, second));
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Jerusalem', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  });
  const p = Object.fromEntries(dtf.formatToParts(guess).map((x) => [x.type, x.value]));
  const asIfUTC = Date.UTC(+p.year, +p.month - 1, +p.day, p.hour === '24' ? 0 : +p.hour, +p.minute, +p.second);
  const offsetMs = asIfUTC - guess.getTime();
  return new Date(guess.getTime() - offsetMs);
}

function nowIsraelParts() {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Jerusalem', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  });
  const p = Object.fromEntries(dtf.formatToParts(new Date()).map((x) => [x.type, x.value]));
  return { year: +p.year, month: +p.month, day: +p.day, hour: p.hour === '24' ? 0 : +p.hour, minute: +p.minute, second: +p.second };
}

/* Ports the original client's inferDate(): sources like Barby/Hatarbut only give day+month,
   no year. Assumes the current Israel year, but rolls forward to next year if that lands
   more than 3 days in the past (handles listings that span a Dec->Jan boundary). */
function inferDate(day, month, hour = 0, minute = 0) {
  const now = nowIsraelParts();
  let d = israelWallTimeToUTC(now.year, month, day, hour, minute);
  const cutoff = israelWallTimeToUTC(now.year, now.month, now.day, 0, 0, 0);
  cutoff.setUTCDate(cutoff.getUTCDate() - 3);
  if (d < cutoff) d = israelWallTimeToUTC(now.year + 1, month, day, hour, minute);
  return d;
}

/* Drives an HTMLRewriter over a raw HTML string. HTMLRewriter is a streaming transformer,
   not a queryable DOM - it only actually runs when the resulting body is consumed, hence
   the arrayBuffer() call (result itself is discarded; handlers already captured what they
   needed into the closures passed via `register`). */
async function runRewriter(html, register) {
  const rewriter = new HTMLRewriter();
  register(rewriter);
  const res = new Response(html, { headers: { 'content-type': 'text/html; charset=utf-8' } });
  await rewriter.transform(res).arrayBuffer();
}

// ============================================================================
// Lessin Theatre
// ============================================================================

const LESSIN_URL = 'https://www.lessin.co.il/%D7%94%D7%A6%D7%92%D7%95%D7%AA/';

/* Verified against live markup: each row is
   <tr class="showlistitem" data-date="DD-MM-YYYY"><td>day</td><td>date</td><td>time</td>
   <td class="hidemobile">hall</td><td class="showmobile">hall (dup)</td>
   <td style="width:100%"><a href=showPage>title</a></td><td class="sec"/><td class="last"/>
   <td>"אזל" or <a class="orderbtn" href=buyLink>לרכישה</a></td></tr>
   The month-title row (colspan=8, no data-date) only has one <td>, so the nth-child
   selectors below simply never match it - no special-casing needed. */
async function parseLessin(html) {
  const rows = [];
  let current = null;

  await runRewriter(html, (rewriter) => {
    rewriter
      .on('tr.showlistitem', {
        element(el) {
          const dateAttr = el.getAttribute('data-date');
          current = null;
          if (!dateAttr) return;
          current = { dateAttr, time: '', hall: '', titleHref: null, titleText: '', orderHref: null };
          const row = current;
          rows.push(row);
          el.onEndTag(() => { if (current === row) current = null; });
        },
      })
      .on('tr.showlistitem td:nth-child(3)', { text(t) { if (current) current.time += t.text; } })
      .on('tr.showlistitem td:nth-child(4)', { text(t) { if (current) current.hall += t.text; } })
      .on('tr.showlistitem td:nth-child(6) a', {
        element(el) { if (current && !current.titleHref) current.titleHref = el.getAttribute('href'); },
        text(t) { if (current) current.titleText += t.text; },
      })
      .on('tr.showlistitem a.orderbtn', {
        element(el) { if (current) current.orderHref = el.getAttribute('href'); },
      });
  });

  const events = [];
  for (const row of rows) {
    const parts = row.dateAttr.split('-');
    if (parts.length !== 3) continue;
    const [dd, mm, yyyy] = parts.map(Number);
    const tm = row.time.match(/(\d{1,2}):(\d{2})/);
    if (!tm) continue;
    const title = row.titleText.replace(/\s+/g, ' ').trim();
    if (!title || !row.titleHref) continue;
    const date = israelWallTimeToUTC(yyyy, mm, dd, Number(tm[1]), Number(tm[2]));
    events.push({
      id: makeId('lessin', title, date), source: 'lessin', venue: 'בית ליסין', type: 'theatre',
      title, date, link: row.orderHref || row.titleHref, extra: row.hall.replace(/\s+/g, ' ').trim(), image: null,
    });
  }
  return events;
}

async function fetchLessin() {
  const res = await fetch(LESSIN_URL, { headers: BROWSER_HEADERS_HTML });
  if (!res.ok) throw new Error('lessin HTTP ' + res.status);
  return parseLessin(await res.text());
}

// ============================================================================
// Habima Theatre
// ============================================================================

const HABIMA_URL = 'https://www.habima.co.il/wp-content/themes/tyco-wp/cache/allData.json';

async function fetchHabima() {
  const res = await fetch(HABIMA_URL, { headers: BROWSER_HEADERS_JSON });
  if (!res.ok) throw new Error('habima HTTP ' + res.status);
  const data = await res.json();

  const shows = (data.shows && data.shows.he) || {};
  const venues = (data.venues && data.venues.he) || {};
  const presentations = (data.presentations && data.presentations.he) || {};

  const events = [];
  Object.keys(presentations).forEach((showKey) => {
    const show = shows[showKey];
    if (!show || !show.title) return;
    (presentations[showKey] || []).forEach((perf) => {
      if (!perf.time) return;
      // perf.time is a Unix timestamp - already an absolute instant, no timezone conversion needed.
      const date = new Date(perf.time * 1000);
      if (isNaN(date)) return;
      const venueName = venues[perf.venue_id] || 'תיאטרון הבימה';
      events.push({
        id: makeId('habima', show.title, date), source: 'habima', venue: 'הבימה', type: 'theatre',
        title: show.title, date, link: `https://tickets.habima.co.il/order/${perf.id}`,
        extra: venueName, image: show.img || null,
      });
    });
  });
  return events;
}

// ============================================================================
// Rav-Hen / Planet Ayalon (shared Vista booking platform)
// ============================================================================

/* Rav-Hen and Planet Ayalon run the same Vista booking platform (same asset build,
   identical API shape) - only tenantId/cinemaId/domain/prefix differ per chain. */
const VISTA_CINEMAS = {
  ravhen: { tenantId: '10104', cinemaId: '1071', domain: 'www.rav-hen.co.il', apiPrefix: 'rh', venue: 'רב חן', extra: 'רב חן דיזנגוף' },
  planet: { tenantId: '10100', cinemaId: '1025', domain: 'www.planetcinema.co.il', apiPrefix: 'il', venue: 'פלאנט איילון', extra: 'פלאנט איילון, רמת גן' },
};

/* Rav-Hen exposes an English slug in film.link (.../films/hill-338/8403s2r) - useful as an
   OMDb search hint for the client since the displayed title is Hebrew but OMDb is indexed
   mostly in English. */
function slugToImdbHint(url) {
  if (!url) return null;
  const m = url.match(/\/films\/([a-z0-9-]+)\//i);
  if (!m || !m[1]) return null;
  const slug = m[1];
  if (/^\d+$/.test(slug)) return null;
  return slug.replace(/-/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

async function fetchVistaDay(sourceKey, dateStr) {
  const cfg = VISTA_CINEMAS[sourceKey];
  const url = `https://${cfg.domain}/${cfg.apiPrefix}/data-api-service/v1/quickbook/${cfg.tenantId}/film-events/in-cinema/${cfg.cinemaId}/at-date/${dateStr}?attr=&lang=he_IL`;
  const res = await fetch(url, { headers: BROWSER_HEADERS_JSON });
  if (!res.ok) throw new Error(`${sourceKey} HTTP ${res.status} (${dateStr})`);
  const data = await res.json();
  if (!data || !data.body) return [];

  const films = {};
  (data.body.films || []).forEach((f) => { films[f.id] = f; });

  const events = [];
  (data.body.events || []).forEach((ev) => {
    const film = films[ev.filmId];
    if (!film || !ev.eventDateTime) return;
    // Vista embeds its own UTC offset in eventDateTime, so this parses to the correct instant as-is.
    const date = new Date(ev.eventDateTime);
    if (isNaN(date)) return;
    events.push({
      id: makeId(sourceKey, film.name, date), source: sourceKey, venue: cfg.venue, type: 'cinema',
      title: film.name, date, link: ev.bookingLink || film.link, extra: cfg.extra,
      image: film.posterLink || null, imdbHint: slugToImdbHint(film.link),
      trailerUrl: film.videoLink || null,
    });
  });
  return events;
}

async function fetchVistaCinema(sourceKey, dateStrs) {
  const results = await Promise.allSettled(dateStrs.map((d) => fetchVistaDay(sourceKey, d)));
  const events = [];
  results.forEach((r) => {
    if (r.status === 'fulfilled') events.push(...r.value);
    else console.error(sourceKey, 'day failed:', r.reason);
  });
  return events;
}

// ============================================================================
// Lev Cinema
// ============================================================================

const LEV_LIST_URL = 'https://www.lev.co.il/location/telaviv/';
const LEV_MOVIE_CAP = 18;
const LEV_CONCURRENCY = 3;

/* The Tel Aviv branch page only lists movies actually screening there (not the whole
   national chain), and each entry includes an English title - a useful OMDb search hint
   for the client. */
async function fetchLevMovieList() {
  const res = await fetch(LEV_LIST_URL, { headers: BROWSER_HEADERS_HTML });
  if (!res.ok) throw new Error('lev HTTP ' + res.status);
  const html = await res.text();

  const movies = [];
  const seen = new Set();
  let current = null;

  await runRewriter(html, (rewriter) => {
    rewriter
      .on('#categoryfeatures_portfolio a.movieLink', {
        element(el) {
          current = null;
          const href = el.getAttribute('href');
          if (!href || seen.has(href)) return;
          seen.add(href);
          current = { href, title: '', english: '', altTitle: '', image: null };
          const movie = current;
          movies.push(movie);
          el.onEndTag(() => { if (current === movie) current = null; });
        },
      })
      .on('#categoryfeatures_portfolio a.movieLink .movieName', {
        text(t) { if (current) current.title += t.text; },
      })
      .on('#categoryfeatures_portfolio a.movieLink .englishName', {
        text(t) { if (current) current.english += t.text; },
      })
      .on('#categoryfeatures_portfolio a.movieLink img', {
        // The <img> is followed by a duplicate inside <noscript> (HTMLRewriter parses noscript
        // contents structurally, unlike a real browser) - the `current.image` guard keeps only
        // the first, real match; data-src (lazy-load target) is the actual poster, src is a
        // 1x1 placeholder until JS runs.
        element(el) {
          if (!current || current.image) return;
          const src = el.getAttribute('data-src') || el.getAttribute('src') || '';
          if (src && !src.startsWith('data:') && !/placeholder/i.test(src)) { current.image = src; return; }
          if (!current.altTitle) current.altTitle = el.getAttribute('alt') || '';
        },
      });
  });

  return movies
    .map((m) => ({
      href: m.href,
      title: (m.title || m.altTitle || '').replace(/\s+/g, ' ').trim(),
      image: m.image,
      imdbHint: m.english.replace(/\s+/g, ' ').trim() || null,
    }))
    .filter((m) => m.title);
}

/* Verified against a live movie page: trailer iframe carries class featureTrailerLinkVisible;
   each .movie_shows block (some display:none - alternate views, skipped) contains .forloc
   divs per physical location, each with an <h3> location name and .showlist blocks (date
   <span> + one or more <a class="mobilelink"> showtimes). Only the "לב תל אביב" location is
   kept - the app only covers the Tel Aviv branch. */
async function fetchLevMovieShowtimes(movie) {
  const res = await fetch(movie.href, { headers: BROWSER_HEADERS_HTML });
  if (!res.ok) throw new Error('lev movie HTTP ' + res.status);
  const html = await res.text();

  let synopsis = null;
  let trailerUrl = null;
  const rawEvents = [];

  let blockVisible = true;
  let currentLoc = null;
  let currentDateText = '';
  let currentMobilelink = null;

  await runRewriter(html, (rewriter) => {
    rewriter
      .on('meta[property="og:description"]', {
        element(el) {
          const content = (el.getAttribute('content') || '').replace(/\s+/g, ' ').trim();
          if (content) synopsis = content.length > 320 ? content.slice(0, 320).trim() + '…' : content;
        },
      })
      .on('iframe.featureTrailerLinkVisible', {
        element(el) {
          const src = el.getAttribute('src') || '';
          const m = src.match(/embed\/([a-zA-Z0-9_-]{6,})/);
          if (m) trailerUrl = `https://www.youtube.com/watch?v=${m[1]}`;
        },
      })
      .on('.movie_shows', {
        element(el) {
          const style = el.getAttribute('style') || '';
          blockVisible = !/display\s*:\s*none/i.test(style);
        },
      })
      .on('.movie_shows .forloc h3', {
        element() { currentLoc = ''; },
        text(t) { if (currentLoc !== null) currentLoc += t.text; },
      })
      .on('.movie_shows .forloc .showlist span', {
        element() { currentDateText = ''; },
        text(t) { currentDateText += t.text; },
      })
      .on('.movie_shows .forloc .showlist a.mobilelink', {
        element(el) {
          currentMobilelink = null;
          if (!blockVisible) return;
          if ((currentLoc || '').trim() !== 'לב תל אביב') return;
          const href = el.getAttribute('href');
          const dm = currentDateText.match(/(\d{1,2})\/(\d{1,2})/);
          if (!href || !dm) return;
          const rec = { href, dd: dm[1], mm: dm[2], time: '' };
          currentMobilelink = rec;
          el.onEndTag(() => {
            const tm = rec.time.match(/(\d{1,2}):(\d{2})/);
            if (tm) rawEvents.push({ href: rec.href, dd: rec.dd, mm: rec.mm, hh: tm[1], min: tm[2] });
            currentMobilelink = null;
          });
        },
        text(t) { if (currentMobilelink) currentMobilelink.time += t.text; },
      });
  });

  const events = [];
  rawEvents.forEach((r) => {
    const date = inferDate(r.dd, r.mm, r.hh, r.min);
    events.push({
      id: makeId('lev', movie.title + '-לב תל אביב', date), source: 'lev', venue: 'קולנוע לב', type: 'cinema',
      title: movie.title, date, link: r.href, extra: 'לב תל אביב', image: movie.image || null,
      imdbHint: movie.imdbHint || null, trailerUrl, synopsis,
    });
  });
  return events;
}

async function fetchLev() {
  const movies = (await fetchLevMovieList()).slice(0, LEV_MOVIE_CAP);
  const events = [];
  let idx = 0;
  async function worker() {
    while (idx < movies.length) {
      const movie = movies[idx++];
      try { events.push(...await fetchLevMovieShowtimes(movie)); }
      catch (e) { console.error('lev movie failed:', movie.title, e); }
    }
  }
  await Promise.all(Array.from({ length: Math.min(LEV_CONCURRENCY, movies.length || 1) }, worker));
  return events;
}

// ============================================================================
// Barby Club (Jina fallback)
// ============================================================================

/* Barby is a client-rendered React SPA - native fetch only gets an empty <div id="root">
   shell (verified: 3.6KB raw HTML, no server-side rendering at all). Its internal
   /api/shows/find endpoint exists but sits behind a Cloudflare WAF rule that blocks direct
   requests. Jina (which headless-renders the page before returning it) is the only viable
   path for this one source - all 6 other sources use native fetch. Parsing logic below is
   unchanged from the original client-side implementation, which was already built against
   Jina's markdown output. */
const BARBY_URL = 'https://www.barby.co.il/';
const JINA_BASE = 'https://r.jina.ai/';

function parseBarbyMarkdown(text) {
  const lines = text.split('\n').map((l) => l.trim());
  const events = [];
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^דלתות:\s*(\d{1,2}):(\d{2})\s*\|\s*(\d{1,2})\/(\d{1,2})/);
    if (!m) continue;
    const [, hh, min, dd, mm] = m;

    let title = null;
    for (let j = i - 1; j >= Math.max(0, i - 5); j--) {
      const cand = lines[j];
      if (!cand) continue;
      if (/^!|כרטיסים|לרכישת|^Image \d|^\[?Image/.test(cand)) continue;
      title = cand.replace(/^\[|\]$/g, '').trim();
      break;
    }
    if (!title) continue;

    let image = null;
    for (let j = i - 1; j >= Math.max(0, i - 8); j--) {
      const imgm = lines[j] && lines[j].match(/!\[[^\]]*\]\((https?:\/\/[^)\s]+)\)/);
      if (imgm) { image = imgm[1]; break; }
    }

    const date = inferDate(dd, mm, hh, min);
    events.push({
      id: makeId('barby', title, date), source: 'barby', venue: 'בארבי', type: 'music',
      title, date, link: BARBY_URL, extra: 'מועדון הבארבי', image,
    });
  }
  return events;
}

/* Jina's free ANONYMOUS tier is rate-limited by IP - and Cloudflare Workers' outbound IPs
   are shared across many unrelated Workers, so a 429 here can happen even though this app
   only makes one Jina request per 3h cron cycle; it's someone else's traffic exhausting the
   shared quota, not ours, and it can stay exhausted for longer than any reasonable retry
   window (observed: still 429 after 3 retries spanning ~30s). The original client-side
   jinaFetch() retried on 429 using the Retry-After header - kept below for genuinely brief
   blips - but the real fix is authenticating: passing JINA_API_KEY (a free key from
   https://jina.ai, set via `wrangler secret put JINA_API_KEY`) moves the quota off the
   shared-IP pool and onto the key's own account allowance. Works fine without a key too,
   just as unreliably as before. */
async function fetchBarbyMarkdown(env, attempt = 0) {
  const headers = env.JINA_API_KEY ? { Authorization: `Bearer ${env.JINA_API_KEY}` } : {};
  const res = await fetch(JINA_BASE + BARBY_URL, { headers });
  if (res.status === 429 && attempt < 3) {
    const retryAfter = Number(res.headers.get('retry-after')) || (5 + attempt * 5);
    await new Promise((r) => setTimeout(r, retryAfter * 1000));
    return fetchBarbyMarkdown(env, attempt + 1);
  }
  if (!res.ok) throw new Error('barby (jina) HTTP ' + res.status);
  return res.text();
}

async function fetchBarby(env) {
  return parseBarbyMarkdown(await fetchBarbyMarkdown(env));
}

// ============================================================================
// Hatarbut Hall
// ============================================================================

const TARBUT_CALENDAR_URL = 'https://www.hatarbut.co.il/%D7%9C%D7%95%D7%97-%D7%94%D7%95%D7%A4%D7%A2%D7%95%D7%AA/calendar/';
const TARBUT_SHOW_FETCH_CAP = 10;
const TARBUT_CONCURRENCY = 3;

async function fetchTarbutShowList() {
  const res = await fetch(TARBUT_CALENDAR_URL, { headers: BROWSER_HEADERS_HTML });
  if (!res.ok) throw new Error('hatarbut HTTP ' + res.status);
  const html = await res.text();

  const shows = [];
  const seen = new Set();
  let current = null;

  await runRewriter(html, (rewriter) => {
    rewriter
      .on('ul.eo-events li article', {
        element(el) {
          current = { href: null, title: '', image: null };
          const show = current;
          el.onEndTag(() => {
            if (show.href && show.title && !seen.has(show.href)) {
              seen.add(show.href);
              shows.push({ href: show.href, title: show.title.replace(/\s+/g, ' ').trim(), image: show.image });
            }
            if (current === show) current = null;
          });
        },
      })
      .on('ul.eo-events li article h3.eo-event-title a', {
        element(el) { if (current && !current.href) current.href = el.getAttribute('href'); },
      })
      .on('ul.eo-events li article h3.eo-event-title a span', {
        text(t) { if (current) current.title += t.text; },
      })
      .on('ul.eo-events li article img.eo-event-thumbnail', {
        element(el) {
          if (!current || current.image) return;
          const src = el.getAttribute('src') || el.getAttribute('data-src') || '';
          if (src && !src.startsWith('data:') && !/placeholder/i.test(src)) current.image = src;
        },
      });
  });

  return shows;
}

/* og:description on the show page holds everything: hall, start time, and either a single
   date ("תאריך: DD.MM.YY") or several ("לרכישת כרטיסים DD.MM.YY" repeated once per date) -
   verified against both shapes on live pages. */
function parseTarbutMeta(desc) {
  if (!desc) return null;
  const hallMatch = desc.match(/אולם:\s*(\S+)/);
  const hall = hallMatch ? hallMatch[1] : null;
  let timeMatch = desc.match(/תחילת המופע:\s*(\d{1,2}:\d{2})/);
  if (!timeMatch) timeMatch = desc.match(/\|\s*(\d{1,2}:\d{2})\s*אולם:/);
  const time = timeMatch ? timeMatch[1] : null;
  let dates = [...desc.matchAll(/לרכישת כרטיסים\s*(\d{2}\.\d{2}\.\d{2})/g)].map((m) => m[1]);
  if (!dates.length) {
    const single = desc.match(/תאריך:\s*(\d{2}\.\d{2}\.\d{2})/);
    if (single) dates = [single[1]];
  }
  if (!time || !dates.length) return null;
  return { hall, time, dates };
}

function extractTarbutSynopsis(desc) {
  if (!desc) return null;
  const idx = desc.indexOf('מקום פנוי');
  if (idx === -1) return null;
  const text = desc.slice(idx + 'מקום פנוי'.length).replace(/&nbsp;/g, ' ').replace(/\[&hellip;\]\s*$/, '').replace(/\s+/g, ' ').trim();
  if (!text) return null;
  return text.length > 320 ? text.slice(0, 320).trim() + '…' : text;
}

/* Ticket buttons sometimes route through a click-tracking wrapper with the real URL in a
   `url` query param - unwrap it so the client links straight to the ticket vendor. */
function extractTarbutTicketLinks(buttons) {
  const links = {};
  buttons.forEach(({ href, text }) => {
    const m = text.match(/לרכישת כרטיסים\s*(\d{2}\.\d{2}\.\d{2})/);
    if (!m) return;
    let realHref = href;
    const wrapped = href.match(/[?&]url=([^&]+)/);
    if (wrapped) { try { realHref = decodeURIComponent(wrapped[1]); } catch (e) { /* keep raw href */ } }
    links[m[1]] = realHref;
  });
  return links;
}

function parseTarbutDate(dateStr, timeStr) {
  const dm = dateStr.match(/(\d{2})\.(\d{2})\.(\d{2})/);
  const tm = timeStr.match(/(\d{1,2}):(\d{2})/);
  if (!dm || !tm) return null;
  return israelWallTimeToUTC(2000 + Number(dm[3]), Number(dm[2]), Number(dm[1]), Number(tm[1]), Number(tm[2]));
}

async function fetchTarbutShowDetail(show) {
  const res = await fetch(show.href, { headers: BROWSER_HEADERS_HTML });
  if (!res.ok) throw new Error('hatarbut detail HTTP ' + res.status);
  const html = await res.text();

  let desc = '';
  const buttons = [];
  let currentBtn = null;

  await runRewriter(html, (rewriter) => {
    rewriter
      .on('meta[property="og:description"]', {
        element(el) { desc = el.getAttribute('content') || ''; },
      })
      .on('a.elementor-button', {
        element(el) {
          const btn = { href: el.getAttribute('href') || '', text: '' };
          currentBtn = btn;
          el.onEndTag(() => { buttons.push(btn); if (currentBtn === btn) currentBtn = null; });
        },
      })
      .on('a.elementor-button .elementor-button-text', {
        text(t) { if (currentBtn) currentBtn.text += t.text; },
      });
  });

  const meta = parseTarbutMeta(desc);
  if (!meta) return [];
  const ticketLinks = extractTarbutTicketLinks(buttons);
  const synopsis = extractTarbutSynopsis(desc);

  const events = [];
  meta.dates.forEach((dateStr) => {
    const date = parseTarbutDate(dateStr, meta.time);
    if (!date) return;
    events.push({
      id: makeId('tarbut', show.title, date), source: 'tarbut', venue: 'היכל התרבות', type: 'music',
      title: show.title, date, link: ticketLinks[dateStr] || show.href,
      extra: meta.hall ? `אולם ${meta.hall}` : 'היכל התרבות', image: show.image || null,
      synopsis,
    });
  });
  return events;
}

async function fetchTarbut() {
  const shows = (await fetchTarbutShowList()).slice(0, TARBUT_SHOW_FETCH_CAP);
  const events = [];
  let idx = 0;
  async function worker() {
    while (idx < shows.length) {
      const show = shows[idx++];
      try { events.push(...await fetchTarbutShowDetail(show)); }
      catch (e) { console.error('tarbut show failed:', show.title, e); }
    }
  }
  await Promise.all(Array.from({ length: Math.min(TARBUT_CONCURRENCY, shows.length || 1) }, worker));
  return events;
}

// ============================================================================
// Orchestration
// ============================================================================

const EVENTS_KV_KEY = 'events-v1';
const CACHE_TTL_SECONDS = 10800; // 3 hours - matches the cron schedule in wrangler.toml
const VISTA_DAYS_AHEAD = 6; // matches the old client's "extended" Vista window

const CORS_HEADERS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, OPTIONS',
  'access-control-allow-headers': 'content-type',
};

function vistaDateRange(daysAhead) {
  const israelToday = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Jerusalem', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  const [y, m, d] = israelToday.split('-').map(Number);
  const base = new Date(Date.UTC(y, m - 1, d));
  return Array.from({ length: daysAhead }, (_, i) => {
    const dt = new Date(base);
    dt.setUTCDate(dt.getUTCDate() + i);
    return dt.toISOString().slice(0, 10);
  });
}

/* Subrequest budget (Workers free plan caps a single invocation at 50): lessin(1) +
   habima(1) + lev list(1) + lev detail(<=18) + ravhen(6) + planet(6) + barby(1) +
   hatarbut list(1) + hatarbut detail(<=10) + events KV put(1) = 46 worst case. No OMDb
   calls happen here at all (see file header), so there's no enrichment budget to share. */
async function refreshEvents(env) {
  const vistaDates = vistaDateRange(VISTA_DAYS_AHEAD);

  const tasks = {
    lessin: fetchLessin(),
    habima: fetchHabima(),
    lev: fetchLev(),
    ravhen: fetchVistaCinema('ravhen', vistaDates),
    planet: fetchVistaCinema('planet', vistaDates),
    barby: fetchBarby(env),
    tarbut: fetchTarbut(),
  };

  const keys = Object.keys(tasks);
  const settled = await Promise.allSettled(Object.values(tasks));

  const events = [];
  const sourceStatus = {};
  settled.forEach((result, i) => {
    const key = keys[i];
    if (result.status === 'fulfilled') {
      events.push(...result.value);
      sourceStatus[key] = { ok: true, count: result.value.length };
    } else {
      console.error(key, result.reason);
      sourceStatus[key] = { ok: false, error: String((result.reason && result.reason.message) || result.reason) };
    }
  });

  events.sort((a, b) => a.date - b.date);

  const payload = {
    meta: {
      generatedAt: new Date().toISOString(),
      sourceStatus,
      totalEvents: events.length,
    },
    events: events.map((e) => ({ ...e, date: e.date.toISOString() })),
  };

  const json = JSON.stringify(payload);
  try { await env.SHOWMUST_KV.put(EVENTS_KV_KEY, json, { expirationTtl: CACHE_TTL_SECONDS }); }
  catch (e) { console.error('events cache put failed:', e); }

  return json;
}

export default {
  async fetch(request, env, ctx) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: CORS_HEADERS });
    }

    let json = null;
    try { json = await env.SHOWMUST_KV.get(EVENTS_KV_KEY); } catch (e) { /* fall through to inline refresh */ }

    if (!json) {
      // Cold start (no cron run has completed yet, or the KV entry expired). Normal traffic
      // never hits this path - the cron trigger keeps KV warm well inside the 3h TTL.
      json = await refreshEvents(env);
    }

    return new Response(json, {
      headers: { ...CORS_HEADERS, 'content-type': 'application/json; charset=utf-8', 'cache-control': 'public, max-age=300' },
    });
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(refreshEvents(env));
  },
};
