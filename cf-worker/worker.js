/* ============================================================================
   SHOWMUST-CORE — Cloudflare Worker (production, client-facing)

   Pre-scrapes theatre/cinema/music/stand-up listings from 8 sources, merges them into
   one JSON payload, and caches it in KV (refreshed by a cron trigger every
   3h). The client fetches this once and does all filtering locally.

   This is the ONLY worker the client ever talks to (same URL as always). A sibling worker,
   showmust-content (cf-worker-content/), independently scrapes Hatarbut in full plus
   Lessin/Habima detail-page enrichment (synopsis/trailer) on a rotating schedule, writing
   its own `content-v1` KV entry. This worker merges that in at REQUEST time (not baked into
   its own `events-v1` cron cycle) so the client always sees content-worker's latest data
   immediately, independent of either worker's own cron cadence - see buildClientPayload.
   Two workers, two exclusively-owned KV keys, no worker ever writes the other's key: nothing
   to race or clobber.

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

const HTML_NAMED_ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
  hellip: '…', mdash: '—', ndash: '–',
  lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”',
};

/* HTMLRewriter does NOT decode HTML entities for you - not in text() node content, and not
   in getAttribute() values either (verified: og:description's &quot; and a title's &#8211;
   both came through to the client completely raw, e.g. "שיער &#8211; HAIR" instead of
   "שיער – HAIR"). Every scraper below runs its extracted title/attribute text through this
   before it goes into the payload, otherwise visitors see literal "&#8211;"/"&quot;" garbage
   in the UI - this was the "broken encoding" reported for the Heichal HaTarbut "Hair" show,
   and it silently affected every other source's titles/synopses too, not just that one. */
function decodeHtmlEntities(str) {
  if (!str) return str;
  return str.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (match, ent) => {
    if (ent[0] === '#') {
      const code = ent[1] === 'x' || ent[1] === 'X' ? parseInt(ent.slice(2), 16) : parseInt(ent.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : match;
    }
    return Object.prototype.hasOwnProperty.call(HTML_NAMED_ENTITIES, ent) ? HTML_NAMED_ENTITIES[ent] : match;
  });
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
    const title = decodeHtmlEntities(row.titleText).replace(/\s+/g, ' ').trim();
    if (!title || !row.titleHref) continue;
    const date = israelWallTimeToUTC(yyyy, mm, dd, Number(tm[1]), Number(tm[2]));
    events.push({
      id: makeId('lessin', title, date), source: 'lessin', venue: 'בית ליסין', type: 'theatre',
      title, date, link: row.orderHref || row.titleHref, extra: decodeHtmlEntities(row.hall).replace(/\s+/g, ' ').trim(), image: null,
    });
  }
  return events;
}

/* Synopsis/trailer enrichment for Lessin moved to the sibling showmust-content worker
   (cf-worker-content/) - its own page (row.titleHref above, distinct from the ticket-purchase
   link used as event.link) carries a real og:description and, for most shows, an embedded
   YouTube trailer, but there are far too many unique shows to detail-fetch all of them within
   this worker's own budget alongside everything else it already does. This worker only needs
   the dates, which come entirely from the listing page above - no detail fetch required for
   that. See buildClientPayload for where showmust-content's synopsis/trailerUrl get merged
   back onto these events at request time. */
async function fetchLessin() {
  const res = await fetch(LESSIN_URL, { headers: BROWSER_HEADERS_HTML });
  if (!res.ok) throw new Error('lessin HTTP ' + res.status);
  return parseLessin(await res.text());
}

// ============================================================================
// Habima Theatre
// ============================================================================

const HABIMA_URL = 'https://www.habima.co.il/wp-content/themes/tyco-wp/cache/allData.json';

/* Synopsis/trailer enrichment for Habima moved to the sibling showmust-content worker
   (cf-worker-content/) - same reasoning as fetchLessin above (~47 unique shows, far more than
   this worker can afford to detail-fetch alongside everything else it does). This worker only
   needs the dates, which come entirely from allData.json's own presentations/shows objects -
   no detail fetch required for that. See buildClientPayload for where showmust-content's
   synopsis/trailerUrl get merged back onto these events at request time. */
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
  // Vista sometimes uses its own internal record ID as the slug instead of a real title-slug
  // - verified live: Planet Ayalon's Russian-dub alternate sessions (see dubLanguageSuffix
  // below) have film.link === .../films/8085s2r2/8085s2r2 - not a real word, just digits with
  // a couple of stray letters. A genuine title always has at least one real word (3+ letter
  // run); reject anything that doesn't, rather than feeding OMDb a garbage query like
  // "8085s2r2" that can only ever return zero or spurious results.
  const longestLetterRun = (slug.match(/[a-z]+/gi) || []).reduce((max, s) => Math.max(max, s.length), 0);
  if (longestLetterRun < 3) return null;
  return slug.replace(/-/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

/* Vista tags EVERY dubbed print with its language via attributeIds ("dubbed-lang-he",
   "dubbed-lang-ru", ...) - Hebrew is the default/expected dub for kids' movies in Israeli
   cinemas, not an exception (verified live post-deploy: 171 of 818 cinema events carry
   dubbed-lang-he, vs. 11 carrying dubbed-lang-ru - labeling "he" would tag nearly every
   animated film with a redundant "(דיבוב he)" instead of only the genuinely alternate
   sessions). Only a non-Hebrew dub is the real, separately-bookable alternate screening worth
   calling out (verified live: Planet Ayalon's Russian-dubbed "Spider-Man: Brand New Day"
   session carries "dubbed-lang-ru", its own filmId, and a name field that's Cyrillic apart
   from a truncated "Spider-Man:" fragment - see sanitizeFilmTitle's Cyrillic handling below,
   which is what produces the bare "Spider-Man" title from it). Left unlabeled, a session like
   that renders as an unexplained duplicate card right next to the main Hebrew listing.
   Appends a Hebrew "(דיבוב <language>)" suffix so it reads as intentional; unknown non-Hebrew
   codes fall back to the raw code rather than being silently dropped. */
const DUB_LANGUAGE_LABELS = { ru: 'רוסית', en: 'אנגלית', fr: 'צרפתית', es: 'ספרדית', ar: 'ערבית' };

function dubLanguageSuffix(attributeIds) {
  if (!Array.isArray(attributeIds)) return '';
  const attr = attributeIds.find((a) => /^dubbed-lang-/.test(a) && a !== 'dubbed-lang-he');
  if (!attr) return '';
  const code = attr.replace('dubbed-lang-', '');
  return ` (דיבוב ${DUB_LANGUAGE_LABELS[code] || code})`;
}

/* Some cinema listings return the title in Cyrillic instead of Hebrew/English for certain
   films - verified live on two different sources: Vista/Planet Ayalon ("Spider-Man: Brand
   New Day" came back as "ЧЕЛОВЕК-ПАУК: НОВЫЙ ДЕНЬ - :Spider-Man") and Lev ("The Odyssey"
   came back as bare "ОДИССЕЯ", no Latin text anywhere in the field at all) - both chains
   evidently also serve Russian-speaking audiences and don't consistently honor the
   Hebrew/English locale for every title. Preference order: (1) any embedded Latin-script
   segment in the raw title itself (the vendor sometimes appends the English title after a
   dash, as in the Spider-Man case - this also makes the client's own OMDb search variants,
   see imdbQueryVariants in index.html, match correctly instead of failing on garbage text),
   (2) englishFallback - each call site already computes an English hint independently for
   OMDb purposes (Vista: slugToImdbHint(film.link); Lev: the site's own .englishName) and
   passes it in here too, which is exactly what rescues the pure-Cyrillic "ОДИССЕЯ" case that
   has no Latin segment to extract, (3) the original text, kept as a last resort rather than
   dropping the showtime entirely - a missing real screening is worse than an imperfect title. */
const CYRILLIC_RE = /[\u0400-\u04FF]/;

function sanitizeFilmTitle(raw, englishFallback) {
  if (!raw) return englishFallback || raw;
  let title = decodeHtmlEntities(raw).replace(/\s+/g, ' ').trim();
  if (CYRILLIC_RE.test(title)) {
    const latinSegments = title.match(/[A-Za-z][A-Za-z0-9:''.,&!?\- ]{2,}/g) || [];
    const best = latinSegments.map((s) => s.trim()).sort((a, b) => b.length - a.length)[0];
    if (best) title = best;
    else if (englishFallback) title = englishFallback;
  }
  return title.replace(/^[\s:\-–—]+|[\s:\-–—]+$/g, '').replace(/\s+/g, ' ').trim() || raw;
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
    const title = sanitizeFilmTitle(film.name, slugToImdbHint(film.link)) + dubLanguageSuffix(film.attributeIds);
    events.push({
      id: makeId(sourceKey, title, date), source: sourceKey, venue: cfg.venue, type: 'cinema',
      title, date, link: ev.bookingLink || film.link, extra: cfg.extra,
      image: film.posterLink || null, imdbHint: slugToImdbHint(film.link),
      trailerUrl: film.videoLink || null,
      // Vista's own release year (e.g. "2026") - lets the client disambiguate OMDb lookups
      // for common English words that collide with unrelated films from other decades sharing
      // the exact same title (see fetchImdbScore in index.html). Not available from the other
      // (non-Vista) sources, so this is null there - omdbLookup already treats a falsy year as
      // "no year filter", so that's a no-op for them, not a regression.
      releaseYear: film.releaseYear || null,
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
// Lessin/Habima/Tarbut detail-fetching moved to the sibling showmust-content worker (see file
// header), freeing real room back in this worker's own budget - raised from the temporary 10
// back up past the original 18, covering Lev's entire live Tel Aviv catalog (verified: ~23
// movie links on the branch page at once) rather than an arbitrary subset.
const LEV_MOVIE_CAP = 20;
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
    .map((m) => {
      const imdbHint = decodeHtmlEntities(m.english).replace(/\s+/g, ' ').trim() || null;
      return {
        href: m.href,
        title: sanitizeFilmTitle(m.title || m.altTitle || '', imdbHint),
        image: m.image,
        imdbHint,
      };
    })
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
          const content = decodeHtmlEntities(el.getAttribute('content') || '').replace(/\s+/g, ' ').trim();
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
      title = decodeHtmlEntities(cand.replace(/^\[|\]$/g, '')).trim();
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

/* Hatarbut (theatre hall, music/theatre shows) moved entirely to the sibling
   showmust-content worker (cf-worker-content/) - unlike every other source here, Hatarbut's
   actual performance DATES only exist on each show's own detail page (the calendar/list page
   gives just title+image), so getting any real date coverage at all means detail-fetching
   most/all of its ~25 current shows - too much for this worker's own budget alongside
   everything else. showmust-content contributes Hatarbut's events via content-v1, merged in
   at request time - see buildClientPayload. */

// ============================================================================
// Ozen Bar (Music & Stand-up)
// ============================================================================

const OZEN_CATEGORIES = {
  music: { url: 'https://ozentelaviv.com/tc-event-category/ozen-shows/', type: 'music' },
  standup: { url: 'https://ozentelaviv.com/tc-event-category/stand-up/', type: 'standup' },
};

/* Verified against both live category-archive pages: every upcoming show is a
   <article class="... tc_events ..."> whose <h2 class="entry-title"><a> gives the title+link,
   whose <img class="... wp-post-image"> gives the poster, and whose single .entry-content <p>
   always *starts* with "DD/MM/YYYY HH:MM[ - [DD/MM/YYYY ]HH:MM]" followed by an optional
   "לכרטיסים >> <url>" external ticket link (go-out.co seen live; task also names Chillz/IWant
   as other vendors this venue uses - same plain-text pattern) and then the show's description.
   Everything needed already lives on this one archive page per category - no per-event detail
   fetch required, which matters for the Worker's 50-subrequest budget (see refreshEvents). */
async function fetchOzenCategory(categoryKey) {
  const cfg = OZEN_CATEGORIES[categoryKey];
  const res = await fetch(cfg.url, { headers: BROWSER_HEADERS_HTML });
  if (!res.ok) throw new Error(`ozen-${categoryKey} HTTP ${res.status}`);
  const html = await res.text();

  const rows = [];
  let current = null;

  await runRewriter(html, (rewriter) => {
    rewriter
      .on('article.tc_events', {
        element(el) {
          current = { href: null, title: '', image: null, body: '' };
          const row = current;
          rows.push(row);
          el.onEndTag(() => { if (current === row) current = null; });
        },
      })
      .on('article.tc_events h2.entry-title a', {
        element(el) { if (current && !current.href) current.href = el.getAttribute('href'); },
        text(t) { if (current) current.title += t.text; },
      })
      .on('article.tc_events img.wp-post-image', {
        element(el) {
          if (!current || current.image) return;
          const src = el.getAttribute('src') || '';
          if (src && !src.startsWith('data:')) current.image = src;
        },
      })
      .on('article.tc_events .entry-content p', {
        text(t) { if (current) current.body += t.text; },
      });
  });

  const events = [];
  rows.forEach((row) => {
    const title = decodeHtmlEntities(row.title).replace(/\s+/g, ' ').trim();
    if (!title || !row.href) return;
    const body = decodeHtmlEntities(row.body).replace(/\s+/g, ' ').trim();
    const dm = body.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})\s+(\d{1,2}):(\d{2})/);
    if (!dm) return;
    const [, dd, mm, yyyy, hh, min] = dm;
    const date = israelWallTimeToUTC(Number(yyyy), Number(mm), Number(dd), Number(hh), Number(min));

    // Not every show includes an inline ticket link (verified live: some events have none
    // at all), and the lead-in phrase varies ("לכרטיסים >>", "לרכישת כרטיסים >>", "לינק
    // ... –>>" - all verified live across both categories) - rather than enumerate every
    // phrasing, just take the first URL in the body (always the ticket link when present,
    // verified against all 15 live events at implementation time: go-out.co, tickets.comy.co.il).
    // Falls back to the event's own page when no URL is present, same pattern as lessin/tarbut.
    const urlMatch = body.match(/https?:\/\/[^\s"'<>]+/);
    const link = urlMatch ? urlMatch[0] : row.href;

    let synopsis = body
      .replace(/^\d{1,2}\/\d{1,2}\/\d{4}\s+\d{1,2}:\d{2}(\s*[-–]\s*(?:\d{1,2}\/\d{1,2}\/\d{4}\s+)?\d{1,2}:\d{2})?\s*/, '')
      .replace(/(לכרטיסים|לרכישת כרטיסים|לינק)[^\S\n]*[:\->–]*[^\S\n]*https?:\/\/\S+/, '')
      .replace(/\s+/g, ' ')
      .trim();
    if (synopsis.length > 320) synopsis = synopsis.slice(0, 320).trim() + '…';

    events.push({
      id: makeId(`ozen-${categoryKey}`, title, date), source: `ozen-${categoryKey}`, venue: 'אוזן בר', type: cfg.type,
      title, date, link, extra: 'אוזן בר, נמל תל אביב', image: row.image || null,
      synopsis: synopsis || null,
    });
  });
  return events;
}

// ============================================================================
// Orchestration
// ============================================================================

const EVENTS_KV_KEY = 'events-v1';
const CONTENT_KV_KEY = 'content-v1'; // written by the sibling showmust-content worker - read-only from here
const CACHE_TTL_SECONDS = 10800; // 3 hours - matches the cron schedule in wrangler.toml
/* Live-probed every date this many days out against Rav-Hen's and Planet Ayalon's real APIs:
   Rav-Hen returns 0 events past day+8, Planet Ayalon past day+9-10 (a handful trailing off by
   then). Cinemas simply don't publish showtimes further ahead than that - raising this further
   would just be spending subrequest budget on empty responses. 9 covers the real ceiling with
   a small buffer. Raised from 6 now that Tarbut/Lessin/Habima detail-fetching moved out to the
   sibling showmust-content worker, freeing real budget room here. */
const VISTA_DAYS_AHEAD = 9;

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

/* Subrequest budget (Workers free plan caps a single invocation at 50): lessin list(1) +
   habima list(1) + lev list(1) + lev detail(<=20) + ravhen(9) + planet(9) + barby(1) +
   ozen-music(1) + ozen-standup(1) + previous-payload KV get(1) + events KV put(1) = 46 worst
   case. Hatarbut and Lessin/Habima detail-page enrichment (synopsis/trailer) live entirely in
   the sibling showmust-content worker (cf-worker-content/) now - see that file and
   buildClientPayload below for how its content-v1 KV entry gets merged back in at request
   time. Splitting them out is what freed the room to raise LEV_MOVIE_CAP (10->20, covering
   Lev's whole live catalog) and VISTA_DAYS_AHEAD (6->9, the real horizon those cinemas
   publish to - see VISTA_DAYS_AHEAD's own comment) back up from last session's tighter caps.
   No OMDb calls happen here at all (see file header), so there's no enrichment budget to
   share with that. Ozen deliberately parses each category archive in full (no per-event
   detail fetch, see fetchOzenCategory) - verified live it has no trailer available at the
   source anyway (see index.html card template), so there's nothing to gain from a
   detail-fetch-per-show design there. Music and stand-up are two independent top-level tasks
   (like ravhen/planet) rather than one combined fetch, so either can fail and fall back on
   its own without dragging the other down. */
async function refreshEvents(env) {
  const vistaDates = vistaDateRange(VISTA_DAYS_AHEAD);

  // Self-healing fallback: read the last known-good payload *before* scraping - both its
  // events (grouped by source) and its per-source status - so that any source which fails
  // this round (timeout, network error, a DOM change that breaks its selectors) can fall
  // back to its own most recent successful data instead of silently vanishing from the feed
  // until the next successful cron run. Failure here (cold start, corrupt KV) just means no
  // fallback is available - scraping still proceeds.
  let previousEventsBySource = {};
  let previousSourceStatus = {};
  try {
    const prevJson = await env.SHOWMUST_KV.get(EVENTS_KV_KEY);
    if (prevJson) {
      const prevPayload = JSON.parse(prevJson);
      previousSourceStatus = (prevPayload.meta && prevPayload.meta.sourceStatus) || {};
      (prevPayload.events || []).forEach((e) => {
        (previousEventsBySource[e.source] || (previousEventsBySource[e.source] = [])).push(e);
      });
    }
  } catch (e) { console.error('failed to read previous payload for fallback:', e); }

  const tasks = {
    lessin: fetchLessin(),
    habima: fetchHabima(),
    lev: fetchLev(),
    ravhen: fetchVistaCinema('ravhen', vistaDates),
    planet: fetchVistaCinema('planet', vistaDates),
    barby: fetchBarby(env),
    'ozen-music': fetchOzenCategory('music'),
    'ozen-standup': fetchOzenCategory('standup'),
  };

  const keys = Object.keys(tasks);
  const settled = await Promise.allSettled(Object.values(tasks));

  // Computed once and reused both as meta.generatedAt below and as the lastSuccessfulScrape
  // stamp for every source that succeeds this round.
  const generatedAt = new Date().toISOString();

  const events = [];
  const sourceStatus = {};
  settled.forEach((result, i) => {
    const key = keys[i];
    if (result.status === 'fulfilled') {
      events.push(...result.value);
      sourceStatus[key] = { ok: true, count: result.value.length, fetchedCount: result.value.length, lastSuccessfulScrape: generatedAt };
    } else {
      // Fallback events already went through date serialization once (ISO strings from the
      // stored payload) - re-hydrate to Date so they sort/re-serialize identically to fresh
      // events below. Already-past showtimes in the fallback set are harmless: the client's
      // own date filters exclude them the same way they would any other past event.
      const fallbackEvents = (previousEventsBySource[key] || []).map((e) => ({ ...e, date: new Date(e.date) }));
      events.push(...fallbackEvents);
      const error = String((result.reason && result.reason.message) || result.reason);
      console.error(key, 'failed, serving fallback cache:', error);
      // lastSuccessfulScrape carries forward from the previous round's status rather than
      // being recomputed here, so it keeps pointing at the true last success through any
      // number of consecutive failures instead of resetting on every failed retry.
      const prevStatus = previousSourceStatus[key];
      const lastSuccessfulScrape = (prevStatus && prevStatus.lastSuccessfulScrape) || null;
      sourceStatus[key] = { ok: false, count: fallbackEvents.length, fetchedCount: 0, error, lastSuccessfulScrape };
    }
  });

  events.sort((a, b) => a.date - b.date);

  // Placed first in meta (object key order is preserved in JSON.stringify output) so it's the
  // very first thing visible when checking the /scrape response or the raw payload - a single
  // glance answers "did everything come back OK", instead of having to read sourceStatus's 9
  // per-source entries one at a time to confirm none of them has ok:false.
  const allSourcesOk = Object.values(sourceStatus).every((s) => s.ok);

  const payload = {
    meta: {
      allSourcesOk,
      generatedAt,
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

/* Merges the sibling showmust-content worker's content-v1 (Hatarbut's events in full, plus
   Lessin/Habima synopsis/trailer enrichment) onto this worker's own events-v1 payload -
   always at REQUEST time, never baked into events-v1 itself. That's what lets content-v1's
   much faster rotation cadence (every ~40 min, see cf-worker-content/) reach the client
   immediately regardless of when this worker's own 3h cron last ran, and vice versa: this
   worker's cron doesn't need to know or care that showmust-content exists at all. Missing or
   corrupt content-v1 degrades gracefully - client still gets everything from events-v1, just
   without Hatarbut/extra synopsis - same self-healing philosophy as previousEventsBySource in
   refreshEvents above, never a hard failure just because the sibling worker hasn't completed
   its first run yet or is having a bad day. coreJson is the raw events-v1 JSON string already
   in hand (either freshly scraped or read from KV by the caller) - avoids a redundant read. */
async function buildClientPayload(env, coreJson) {
  let content = null;
  try {
    const contentJson = await env.SHOWMUST_KV.get(CONTENT_KV_KEY);
    if (contentJson) content = JSON.parse(contentJson);
  } catch (e) { console.error('content-v1 read failed, serving core-only payload:', e); }

  if (!content) return coreJson; // nothing to merge - core's own payload is already complete on its own

  const core = JSON.parse(coreJson);
  const enrichmentBySource = { lessin: content.lessin || {}, habima: content.habima || {} };

  const events = core.events.map((e) => {
    const extra = enrichmentBySource[e.source] && enrichmentBySource[e.source][e.title];
    if (!extra) return e;
    return { ...e, synopsis: e.synopsis || extra.synopsis || null, trailerUrl: e.trailerUrl || extra.trailerUrl || null };
  });

  // Hatarbut contributes whole events (unlike Lessin/Habima, its dates only exist behind a
  // detail-page fetch - see the note where its scraper used to live, above fetchOzenCategory),
  // stored in content-v1 keyed by title -> { hall, image, dates: [{date, link, synopsis}] }.
  Object.entries(content.tarbut || {}).forEach(([title, show]) => {
    (show.dates || []).forEach((d) => {
      events.push({
        id: makeId('tarbut', title, new Date(d.date)), source: 'tarbut', venue: 'היכל התרבות', type: 'music',
        title, date: d.date, link: d.link, extra: show.hall ? `אולם ${show.hall}` : 'היכל התרבות',
        image: show.image || null, synopsis: d.synopsis || null,
      });
    });
  });

  events.sort((a, b) => new Date(a.date) - new Date(b.date));

  const sourceStatus = { ...core.meta.sourceStatus, ...((content.meta && content.meta.sourceStatus) || {}) };

  return JSON.stringify({
    meta: {
      allSourcesOk: Object.values(sourceStatus).every((s) => s.ok),
      generatedAt: core.meta.generatedAt,
      contentGeneratedAt: (content.meta && content.meta.generatedAt) || null,
      sourceStatus,
      totalEvents: events.length,
    },
    events,
  });
}

/* Manual scraper trigger - lets an admin force an immediate re-scrape (e.g. right after fixing
   a broken source, instead of waiting up to 3h for the next cron run) without waiting on
   ctx.waitUntil like the cron path does: this awaits refreshEvents directly and returns its
   *own* fresh meta, so the caller gets a real synchronous answer, not a "trust me, it's running"
   response. Gated by SCRAPE_SECRET (`wrangler secret put SCRAPE_SECRET`) - a plain string
   comparison, not constant-time, which is an intentional tradeoff for a lightweight admin
   trigger: worst case on a leaked/guessed key is someone burns your scrape budget early, not
   data exposure or corruption. Requests are rejected outright if the secret isn't configured
   at all, so an unset secret can never be misread as "no key required". */
function isAuthorizedScrapeRequest(url, env) {
  if (!env.SCRAPE_SECRET) return false;
  return url.searchParams.get('key') === env.SCRAPE_SECRET;
}

export default {
  async fetch(request, env, ctx) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: CORS_HEADERS });
    }

    const url = new URL(request.url);
    const wantsManualScrape = url.pathname === '/scrape' || url.searchParams.get('scrape') === 'true';

    if (wantsManualScrape) {
      if (!isAuthorizedScrapeRequest(url, env)) {
        return new Response(JSON.stringify({ error: 'unauthorized' }), {
          status: 401,
          headers: { ...CORS_HEADERS, 'content-type': 'application/json; charset=utf-8' },
        });
      }
      const json = await refreshEvents(env);
      const { meta } = JSON.parse(json);
      return new Response(JSON.stringify({ triggered: true, meta }, null, 2), {
        headers: { ...CORS_HEADERS, 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
      });
    }

    let json = null;
    try { json = await env.SHOWMUST_KV.get(EVENTS_KV_KEY); } catch (e) { /* fall through to inline refresh */ }

    if (!json) {
      // Cold start (no cron run has completed yet, or the KV entry expired). Normal traffic
      // never hits this path - the cron trigger keeps KV warm well inside the 3h TTL.
      json = await refreshEvents(env);
    }

    const merged = await buildClientPayload(env, json);

    return new Response(merged, {
      headers: { ...CORS_HEADERS, 'content-type': 'application/json; charset=utf-8', 'cache-control': 'public, max-age=300' },
    });
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(refreshEvents(env));
  },
};
