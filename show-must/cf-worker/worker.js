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

   IMDb ratings are resolved SERVER-SIDE, here, shared by every visitor - there is no more
   per-user OMDb signup flow. A second, independent cron trigger (see IMDB_CRON/wrangler.toml)
   fires refreshImdbRatings, which reads this worker's own events-v1 for the current set of
   unique cinema titles, looks up each one against OMDb (using one of the comma-separated keys
   in the OMDB_API_KEYS secret, `wrangler secret put OMDB_API_KEYS`), and writes the results to
   its own exclusively-owned `imdb-v1` KV key - a rotating queue processes as many titles as fit
   in a per-run OMDb request budget (see IMDB_MAX_OMDB_REQUESTS_PER_RUN) so a whole-catalog
   refresh never blows the 50-subrequest budget of a single invocation. Each cron trigger is a
   fully independent Worker invocation with its
   own fresh subrequest budget, so this shares no budget at all with refreshEvents's 3h scrape
   cycle. buildClientPayload merges imdb-v1's ratings onto cinema events at request time, same
   merge-on-read pattern as content-v1. Cinema events still carry `imdbHint` (an English-title
   hint scraped alongside the showtime, e.g. from Rav-Hen's URL slug or Lev's English title) -
   now consumed here server-side instead of by client-side OMDb calls.
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
  // Strip a lone trailing period too - some chains (e.g. Rav-Hen) append one to every title,
  // which otherwise makes the same film register as two distinct titles ("Movie" vs "Movie.")
  // and show up twice in title-keyed views like buildImdbRankingsList (see index.html). A
  // trailing "..." ellipsis is left alone via the lookbehind, since that's meaningful punctuation.
  return title.replace(/^[\s:\-–—]+|[\s:\-–—]+$/g, '').replace(/(?<!\.)\.$/, '').replace(/\s+/g, ' ').trim() || raw;
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
// IMDb ratings (server-side, shared cache via imdb-v1 - see refreshImdbRatings)
// ============================================================================

/* Ported verbatim from the client's old per-user OMDb logic (removed from index.html this
   session) - the query-cleaning/variant heuristics were already tuned against real titles from
   these exact sources, no reason to redesign them now that the lookup moved server-side. */
const IMDB_NOISE_WORDS = /\b(מדובב|מדובבת|מתורגם|מתורגמת|תרגום|כתוביות|גרסה מקורית|תלת מימד|דיגיטלי|אנגלית|עברית)\b/g;

function cleanImdbQuery(str) {
  if (!str) return '';
  return str
    .replace(/\[.*?\]/g, ' ')
    .replace(/\(.*?\)/g, ' ')
    .replace(IMDB_NOISE_WORDS, ' ')
    .replace(/[׳']/g, '')
    .replace(/[:"״]/g, ' ')
    .replace(/\b(19|20)\d{2}\b\s*$/, '')
    .replace(/[.!?]+$/g, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

function extractLatinTitle(str) {
  if (!str) return null;
  const matches = str.match(/[A-Za-z][A-Za-z0-9:''.,&!?\- ]{2,}/g);
  if (!matches || !matches.length) return null;
  const best = matches.map((m) => m.trim()).sort((a, b) => b.length - a.length)[0];
  return best && best.length >= 3 ? best : null;
}

function imdbQueryVariants(title) {
  const variants = [];
  const latin = extractLatinTitle(title);
  if (latin) {
    const cleanedLatin = cleanImdbQuery(latin);
    if (cleanedLatin) variants.push(cleanedLatin);
  }
  const cleaned = cleanImdbQuery(title);
  if (cleaned && !variants.includes(cleaned)) variants.push(cleaned);
  const noSubtitle = cleaned.split(/\s[-–—]\s/)[0].trim();
  if (noSubtitle && !variants.includes(noSubtitle)) variants.push(noSubtitle);
  return variants;
}

/* counter is a shared { used } object, incremented once per actual OMDb HTTP call - lets
   refreshImdbRatings budget by real subrequest cost instead of a flat title count (see
   IMDB_MAX_OMDB_REQUESTS_PER_RUN). Most titles resolve in exactly 1 call (the hint alone
   matches), so budgeting per-title was wildly conservative in practice - counting the real
   cost lets a single run cover far more of the catalog. */
async function omdbLookup(apiKey, query, year, counter) {
  if (!query) return null;
  counter.used++;
  try {
    const yearParam = year ? `&y=${encodeURIComponent(year)}` : '';
    const res = await fetch(`https://www.omdbapi.com/?apikey=${encodeURIComponent(apiKey)}&t=${encodeURIComponent(query)}${yearParam}`);
    if (!res.ok) return null;
    const data = await res.json();
    if (data.Response === 'True') {
      return { rating: (data.imdbRating && data.imdbRating !== 'N/A') ? data.imdbRating : null, imdbId: data.imdbID || null };
    }
    return null;
  } catch (e) {
    console.error('OMDb lookup failed:', query, e);
    return null;
  }
}

async function omdbSearchFallback(apiKey, query, year, counter) {
  if (!query) return null;
  counter.used++;
  try {
    const yearParam = year ? `&y=${encodeURIComponent(year)}` : '';
    const res = await fetch(`https://www.omdbapi.com/?apikey=${encodeURIComponent(apiKey)}&s=${encodeURIComponent(query)}&type=movie${yearParam}`);
    if (!res.ok) return null;
    const data = await res.json();
    if (data.Response !== 'True' || !Array.isArray(data.Search) || !data.Search.length) return null;
    const imdbId = data.Search[0].imdbID;
    if (!imdbId) return null;
    counter.used++;
    const detailRes = await fetch(`https://www.omdbapi.com/?apikey=${encodeURIComponent(apiKey)}&i=${encodeURIComponent(imdbId)}`);
    if (!detailRes.ok) return null;
    const detail = await detailRes.json();
    if (detail.Response === 'True' && detail.imdbRating && detail.imdbRating !== 'N/A') {
      return { rating: detail.imdbRating, imdbId: detail.imdbID || null };
    }
    return null;
  } catch (e) {
    console.error('OMDb search fallback failed:', query, e);
    return null;
  }
}

/* Same bilingual-search strategy the client used to run per-visitor: try the English hint
   first (OMDb is indexed almost entirely in English, and the hint comes straight from the
   source's own URL slug/English title - see slugToImdbHint/fetchLevMovieList), then fall back
   through cleaned title variants, then a fuzzy search-by-title as a last resort. releaseYear
   (Vista sources only) disambiguates common English titles shared by unrelated films from
   different decades. Returns null only when no film at all could be matched - a matched film
   with no numeric rating yet (too new/unreleased) still returns {rating:null, imdbId}. */
async function lookupImdbRating(apiKey, title, hint, releaseYear, counter) {
  const cleanHint = cleanImdbQuery(hint);
  let result = cleanHint ? await omdbLookup(apiKey, cleanHint, releaseYear, counter) : null;
  if (!result) {
    for (const variant of imdbQueryVariants(title)) {
      if (variant.toLowerCase() === (cleanHint || '').toLowerCase()) continue;
      result = await omdbLookup(apiKey, variant, releaseYear, counter);
      if (result) break;
    }
  }
  if (!result) result = await omdbSearchFallback(apiKey, cleanHint || cleanImdbQuery(title), releaseYear, counter);
  return result;
}

function parseOmdbKeys(env) {
  return (env.OMDB_API_KEYS || '').split(',').map((s) => s.trim()).filter(Boolean);
}

const IMDB_KV_KEY = 'imdb-v1';
// Budgeted by actual OMDb subrequests made this run, not a flat title count - a title that
// resolves on the first hint-based lookup (the large majority, verified live) costs 1 call,
// while the rare full-fallback path (hint + up to 2 variants + search + detail) costs up to 6.
// 40 leaves headroom for events-v1 read(1) + imdb-v1 write(1) = 42 worst case, safely under the
// 50-subrequest cap, while processing far more of the catalog per run than a fixed title cap
// would (most runs use close to 1 call/title, so this covers ~35-40 titles, not just 7).
const IMDB_MAX_OMDB_REQUESTS_PER_RUN = 40;
// Ratings/IDs rarely change day to day - re-checking this often just catches a newly-released
// numeric rating for a recently-opened film, or a previously-unmatched title that OMDb has since
// indexed. New/unseen titles always take priority over stale re-checks (see the queue below).
const IMDB_REFRESH_STALE_MS = 7 * 24 * 60 * 60 * 1000;

/* Rotating-cursor refresh, same cumulative-merge philosophy as showmust-content's rotateAndMerge
   (cf-worker-content/worker.js): each run only touches as many titles as fit inside its own
   OMDb request budget (IMDB_MAX_OMDB_REQUESTS_PER_RUN), merges results onto whatever imdb-v1
   already held, and prunes titles that are no longer showing anywhere. Combined with the 10-min
   cron (see IMDB_CRON/wrangler.toml), a cold-start catalog (~60-90 unique cinema titles, per
   live measurement) reaches full coverage within roughly 30-40 minutes, then stays continuously
   fresh - new titles are always queued first (see `neverChecked` below), so a movie newly added
   to the catalog gets its rating within one cron cycle, not a multi-hour backlog. Reads events-v1
   (not content-v1) for the candidate title list because all three cinema sources
   (lev/ravhen/planet) are scraped directly by this worker - cinema never moves through
   showmust-content. */
async function refreshImdbRatings(env) {
  const apiKeys = parseOmdbKeys(env);
  if (!apiKeys.length) {
    console.error('OMDB_API_KEYS not configured - skipping IMDb rating refresh');
    return;
  }

  let coreEvents = [];
  try {
    const coreJson = await env.SHOWMUST_KV.get(EVENTS_KV_KEY);
    // A missing/unreadable events-v1 here is always transient (it's kept warm by its own 3h
    // cron plus every cold-start client request) - never a legitimate signal that cinema is
    // genuinely empty. Bailing out before touching imdb-v1 at all is deliberate: falling
    // through with an empty coreEvents would make the prune step below (which deletes any
    // rating whose title isn't in the current cinema list) wipe the *entire* cache on what's
    // just a momentary read miss, discarding real coverage for no reason.
    if (!coreJson) {
      console.error('imdb refresh: events-v1 not found in KV - skipping this run rather than risk wiping imdb-v1');
      return;
    }
    coreEvents = JSON.parse(coreJson).events || [];
  } catch (e) {
    console.error('imdb refresh: failed to read events-v1:', e);
    return;
  }

  const cinemaTitles = new Map(); // title -> { imdbHint, releaseYear }
  coreEvents.filter((e) => e.type === 'cinema').forEach((e) => {
    if (!cinemaTitles.has(e.title)) cinemaTitles.set(e.title, { imdbHint: e.imdbHint || null, releaseYear: e.releaseYear || null });
  });

  if (!cinemaTitles.size) {
    // Same reasoning as the events-v1 check above: events-v1 existing but momentarily carrying
    // zero cinema events (e.g. mid-refresh, or all three cinema sources failing simultaneously)
    // is far more likely a transient blip than reality - never treat it as "prune everything".
    console.error('imdb refresh: no cinema events found in events-v1 - skipping this run rather than risk wiping imdb-v1');
    return;
  }

  let store = { ratings: {}, keyIndex: 0, generatedAt: null };
  try {
    const prevJson = await env.SHOWMUST_KV.get(IMDB_KV_KEY);
    if (prevJson) store = { ...store, ...JSON.parse(prevJson) };
  } catch (e) { console.error('imdb refresh: failed to read previous imdb-v1:', e); }
  if (!store.ratings) store.ratings = {};

  // Prune ratings for films that are no longer showing anywhere - avoids imdb-v1 accumulating
  // stale entries forever, same reasoning as showmust-content's own pruning step.
  Object.keys(store.ratings).forEach((title) => { if (!cinemaTitles.has(title)) delete store.ratings[title]; });

  const now = Date.now();
  const titlesList = Array.from(cinemaTitles.keys());
  const neverChecked = titlesList.filter((t) => !store.ratings[t]);
  const stale = titlesList.filter((t) => store.ratings[t] && (now - (store.ratings[t].checkedAt || 0)) > IMDB_REFRESH_STALE_MS);
  const queue = [...neverChecked, ...stale];

  if (!queue.length) {
    // Nothing to do this run, but still persist the pruning above (harmless if unchanged) and
    // an updated generatedAt so the client-visible imdbGeneratedAt reflects a live worker.
    store.generatedAt = new Date().toISOString();
    try { await env.SHOWMUST_KV.put(IMDB_KV_KEY, JSON.stringify(store)); }
    catch (e) { console.error('imdb-v1 put failed:', e); }
    return;
  }

  const apiKey = apiKeys[store.keyIndex % apiKeys.length];
  const counter = { used: 0 };

  for (const title of queue) {
    if (counter.used >= IMDB_MAX_OMDB_REQUESTS_PER_RUN) break;
    const { imdbHint, releaseYear } = cinemaTitles.get(title);
    try {
      const result = await lookupImdbRating(apiKey, title, imdbHint, releaseYear, counter);
      store.ratings[title] = { rating: result ? result.rating : null, imdbId: result ? result.imdbId : null, checkedAt: now };
    } catch (e) {
      console.error('imdb lookup failed for', title, e);
    }
  }

  store.keyIndex = (store.keyIndex + 1) % apiKeys.length;
  store.generatedAt = new Date().toISOString();

  try { await env.SHOWMUST_KV.put(IMDB_KV_KEY, JSON.stringify(store)); }
  catch (e) { console.error('imdb-v1 put failed:', e); }
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
async function fetchBarbyMarkdown(env, extraHeaders = {}, attempt = 0) {
  const headers = { ...extraHeaders, ...(env.JINA_API_KEY ? { Authorization: `Bearer ${env.JINA_API_KEY}` } : {}) };
  const res = await fetch(JINA_BASE + BARBY_URL, { headers });
  if (res.status === 429 && attempt < 3) {
    const retryAfter = Number(res.headers.get('retry-after')) || (5 + attempt * 5);
    await new Promise((r) => setTimeout(r, retryAfter * 1000));
    return fetchBarbyMarkdown(env, extraHeaders, attempt + 1);
  }
  if (!res.ok) throw new Error('barby (jina) HTTP ' + res.status);
  return res.text();
}

/* A plain cached request from Jina occasionally comes back with zero shows parsed - verified
   live (repeatedly) that this isn't a parser/site-format problem: Jina had cached a snapshot
   taken before Barby's client-side SPA finished rendering its show list (a genuine React SPA,
   ~snapshot-before-hydration race on Jina's end), and since Jina then *keeps serving that same
   bad cached snapshot* for a while, a bare retry without forcing a fresh render would just get
   the identical empty result again - not actually a second chance. Only escalate to a forced-
   fresh, wait-for-real-content retry when the fast/cached path comes back empty, since that
   retry is slow (~15-20s measured live, vs ~0.5s for a good cache hit) - paying that cost on
   every single run regardless would be wasteful. `X-No-Cache`/`X-Wait-For-Selector` are
   documented Jina Reader headers (bypass Jina's own cache; wait for a CSS selector to exist in
   the DOM before returning) - `.card-home` is the real class Barby's React app renders each
   show card into (verified live via a real browser, not guessed from the markdown output).
   If this retry also comes back empty (or throws), refreshEvents' own fallback-to-previous-data
   safety net (the fulfilled-but-empty-result handling there) takes over from here - this is an
   additional layer to make hitting that safety net less frequent, not a replacement for it. */
async function fetchBarby(env) {
  const first = parseBarbyMarkdown(await fetchBarbyMarkdown(env));
  if (first.length > 0) return first;
  return parseBarbyMarkdown(await fetchBarbyMarkdown(env, { 'X-No-Cache': 'true', 'X-Wait-For-Selector': '.card-home' }));
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
   Ozen deliberately parses each category archive in full (no per-event detail fetch, see
   fetchOzenCategory) - verified live it has no trailer available at the source anyway (see
   index.html card template), so there's nothing to gain from a detail-fetch-per-show design
   there. Music and stand-up are two independent top-level tasks (like ravhen/planet) rather
   than one combined fetch, so either can fail and fall back on its own without dragging the
   other down. IMDb rating lookups (refreshImdbRatings) run on a completely separate cron
   trigger/invocation - see IMDB_CRON below - so they never share this budget at all; that
   run's own worst case is events-v1 KV get(1) + up to IMDB_MAX_OMDB_REQUESTS_PER_RUN(40) OMDb
   calls + imdb-v1 KV put(1) = 42, safely under 50 on its own. */
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
    const prevCount = (previousEventsBySource[key] || []).length;
    if (result.status === 'fulfilled' && result.value.length === 0 && prevCount > 0) {
      // Fulfilled-but-empty is its own failure mode, distinct from a thrown rejection (handled
      // below): the scrape didn't error, it just found nothing. That's indistinguishable from
      // "this source genuinely has zero events right now" UNLESS it previously had events -
      // a source that just had prevCount>0 going to 0 in one round is far more likely a
      // transient render glitch (observed on Barby: Jina's headless render occasionally
      // snapshots the page before its client-side SPA finishes hydrating the show list,
      // returning only the cookie-banner/footer shell with none of the actual listings) than
      // reality. Treated exactly like a rejection: fall back to last-known-good and mark
      // degraded, so the source doesn't silently vanish from the feed for a full cron cycle.
      const fallbackEvents = previousEventsBySource[key].map((e) => ({ ...e, date: new Date(e.date) }));
      events.push(...fallbackEvents);
      console.error(key, 'returned 0 events (previously had', prevCount + ') - serving fallback cache');
      const prevStatus = previousSourceStatus[key];
      const lastSuccessfulScrape = (prevStatus && prevStatus.lastSuccessfulScrape) || null;
      sourceStatus[key] = { ok: false, count: fallbackEvents.length, fetchedCount: 0, error: `scrape succeeded but returned 0 events (previously had ${prevCount})`, lastSuccessfulScrape };
    } else if (result.status === 'fulfilled') {
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
  let imdb = null;
  try {
    const [contentJson, imdbJson] = await Promise.all([
      env.SHOWMUST_KV.get(CONTENT_KV_KEY),
      env.SHOWMUST_KV.get(IMDB_KV_KEY),
    ]);
    if (contentJson) content = JSON.parse(contentJson);
    if (imdbJson) imdb = JSON.parse(imdbJson);
  } catch (e) { console.error('content-v1/imdb-v1 read failed, serving core-only payload:', e); }

  if (!content && !imdb) return coreJson; // nothing to merge - core's own payload is already complete on its own

  const core = JSON.parse(coreJson);
  const enrichmentBySource = content ? { lessin: content.lessin || {}, habima: content.habima || {} } : {};
  const ratings = (imdb && imdb.ratings) || {};

  const events = core.events.map((e) => {
    let out = e;
    const extra = enrichmentBySource[e.source] && enrichmentBySource[e.source][e.title];
    if (extra) out = { ...out, synopsis: out.synopsis || extra.synopsis || null, trailerUrl: out.trailerUrl || extra.trailerUrl || null, image: out.image || extra.image || null };
    // Server-side shared IMDb rating (see refreshImdbRatings) - replaces the old per-user
    // client-side OMDb flow entirely. Only cinema carries a rating; imdbId is still attached
    // even when rating is null (film matched on OMDb but has no numeric rating yet, e.g. too
    // new/unreleased) so the client can still link to the real IMDb page.
    if (out.type === 'cinema') {
      const r = ratings[out.title];
      if (r) out = { ...out, imdbRating: r.rating || null, imdbId: r.imdbId || null };
    }
    return out;
  });

  // Hatarbut contributes whole events (unlike Lessin/Habima, its dates only exist behind a
  // detail-page fetch - see the note where its scraper used to live, above fetchOzenCategory),
  // stored in content-v1 keyed by title -> { hall, image, dates: [{date, link, synopsis}] }.
  // seenIds guards against a transient double-add: events-v1 is TTL-cached for up to 3h, so a
  // request can land on a stale copy generated by pre-split code that still had Tarbut baked
  // directly into core.events - without this guard, that stale copy's own Tarbut entries plus
  // content-v1's would both appear until the TTL naturally expired. Once every cached events-v1
  // has cycled past its 3h TTL post-deploy this guard never actually triggers, but costs nothing
  // to leave in permanently as a safety net against any future stale-KV overlap.
  const seenIds = new Set(events.map((e) => e.id));
  if (content) {
    Object.entries(content.tarbut || {}).forEach(([title, show]) => {
      (show.dates || []).forEach((d) => {
        const id = makeId('tarbut', title, new Date(d.date));
        if (seenIds.has(id)) return;
        seenIds.add(id);
        events.push({
          id, source: 'tarbut', venue: 'היכל התרבות', type: 'music',
          title, date: d.date, link: d.link, extra: show.hall ? `אולם ${show.hall}` : 'היכל התרבות',
          image: show.image || null, synopsis: d.synopsis || null,
        });
      });
    });
  }

  events.sort((a, b) => new Date(a.date) - new Date(b.date));

  const sourceStatus = { ...core.meta.sourceStatus, ...((content && content.meta && content.meta.sourceStatus) || {}) };

  return JSON.stringify({
    meta: {
      allSourcesOk: Object.values(sourceStatus).every((s) => s.ok),
      generatedAt: core.meta.generatedAt,
      contentGeneratedAt: (content && content.meta && content.meta.generatedAt) || null,
      imdbGeneratedAt: (imdb && imdb.generatedAt) || null,
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

// Matches the second entry in wrangler.toml's `crons` array exactly - scheduled() dispatches on
// this to tell the IMDb-rating rotation apart from the regular 3h scrape cron. Two independent
// triggers, two independent invocations (and subrequest budgets) - see the file header and the
// budget comment above refreshEvents.
const IMDB_CRON = '*/10 * * * *';

export default {
  async fetch(request, env, ctx) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: CORS_HEADERS });
    }

    const url = new URL(request.url);
    const wantsManualScrape = url.pathname === '/scrape' || url.searchParams.get('scrape') === 'true';
    const wantsManualImdb = url.pathname === '/scrape-imdb';

    if (wantsManualImdb) {
      if (!isAuthorizedScrapeRequest(url, env)) {
        return new Response(JSON.stringify({ error: 'unauthorized' }), {
          status: 401,
          headers: { ...CORS_HEADERS, 'content-type': 'application/json; charset=utf-8' },
        });
      }
      await refreshImdbRatings(env);
      const imdbJson = await env.SHOWMUST_KV.get(IMDB_KV_KEY);
      const imdb = imdbJson ? JSON.parse(imdbJson) : null;
      return new Response(JSON.stringify({
        triggered: true,
        generatedAt: imdb && imdb.generatedAt,
        ratingsCount: imdb ? Object.keys(imdb.ratings || {}).length : 0,
      }, null, 2), {
        headers: { ...CORS_HEADERS, 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
      });
    }

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
    if (event.cron === IMDB_CRON) {
      ctx.waitUntil(refreshImdbRatings(env));
    } else {
      ctx.waitUntil(refreshEvents(env));
    }
  },
};
