/* ============================================================================
   SHOWMUST-CONTENT — Cloudflare Worker

   Sibling of showmust-core (../cf-worker/worker.js) - NOT client-facing. showmust-core is the
   only URL the app ever calls; it reads this worker's `content-v1` KV entry directly (shared
   SHOWMUST_KV binding, no HTTP hop) and merges it into every response at request time.

   What lives here and why: Hatarbut's performance DATES only exist on each show's own detail
   page (unlike every other source, whose dates come from a single list/JSON fetch), and
   Lessin/Habima's synopsis+trailer likewise only exist on their own detail pages. Combined,
   the three sources have ~90+ unique shows - far more than fits in one 50-subrequest
   invocation's budget alongside everything showmust-core already does. So coverage rotates:
   each run detail-fetches a bounded slice per source (cursor persisted in content-v1),
   merges the results onto whatever this worker already had stored from previous runs (never
   discarding earlier progress), and prunes any show no longer present in its source's current
   listing. A full sweep of all three sources completes across a handful of cron cycles and
   then keeps itself continuously refreshed - see refreshContent below.

   content-v1 is intentionally stored WITHOUT a KV expirationTtl, unlike showmust-core's
   events-v1 (a from-scratch snapshot that's meant to go stale if its cron stops running).
   content-v1 is cumulative state built up across many rotation cycles - expiring it would
   silently discard everything and force a slow multi-cycle rebuild from empty for no benefit.
   ============================================================================ */

// ============================================================================
// Shared utilities (duplicated from cf-worker/worker.js - this project has no bundler, so a
// small explicit duplication here beats introducing build tooling just to share ~40 lines)
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

const HTML_NAMED_ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
  hellip: '…', mdash: '—', ndash: '–',
  lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”',
};

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

/* Workers always run in UTC - see cf-worker/worker.js's copy of this function for the full
   explanation of why the UTC round-trip through Asia/Jerusalem is needed. */
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

async function runRewriter(html, register) {
  const rewriter = new HTMLRewriter();
  register(rewriter);
  const res = new Response(html, { headers: { 'content-type': 'text/html; charset=utf-8' } });
  await rewriter.transform(res).arrayBuffer();
}

const CORS_HEADERS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, OPTIONS',
  'access-control-allow-headers': 'content-type',
};

// ============================================================================
// Lessin Theatre - title/href discovery (lightweight) + detail fetch
// ============================================================================

const LESSIN_URL = 'https://www.lessin.co.il/%D7%94%D7%A6%D7%92%D7%95%D7%AA/';

/* Only needs title->href pairs here (showmust-core already has the real dates from its own
   listing scrape) - same table structure as core's parseLessin, but skips date/time/hall
   entirely since nothing here needs them. */
async function fetchLessinTitleHrefs() {
  const res = await fetch(LESSIN_URL, { headers: BROWSER_HEADERS_HTML });
  if (!res.ok) throw new Error('lessin list HTTP ' + res.status);
  const html = await res.text();

  const rows = [];
  let current = null;

  await runRewriter(html, (rewriter) => {
    rewriter.on('tr.showlistitem td:nth-child(6) a', {
      element(el) {
        const href = el.getAttribute('href');
        if (!href) { current = null; return; }
        current = { href, title: '' };
        const row = current;
        rows.push(row);
        el.onEndTag(() => { if (current === row) current = null; });
      },
      text(t) { if (current) current.title += t.text; },
    });
  });

  const map = new Map();
  rows.forEach((r) => {
    const title = decodeHtmlEntities(r.title).replace(/\s+/g, ' ').trim();
    if (title && !map.has(title)) map.set(title, r.href);
  });
  return map;
}

/* Lessin's own show page carries a real synopsis (og:description) and, for most shows, an
   embedded YouTube trailer via <a class="showvideo" href="...">) - verified live across 3
   different current shows. extractYoutubeId on the client (index.html) already parses
   youtube.com/embed, youtube.com/watch and youtu.be forms alike, so the raw href is passed
   through as-is with no reformatting needed. Some shows (workshop/fringe nights) plausibly
   have no trailer at all - the selector then simply never fires and trailerUrl stays null.

   Image is NOT taken from og:image - verified live that it's just the site's generic
   homepage banner, identical across every show's page, not a per-show poster. The real
   per-show photo lives in a Swiper image carousel (`.show_slider .swiper-slide img`) further
   down the page - first slide is always the show's own hero photo (verified across multiple
   shows), so only the first match is kept (`current.image` guard, same pattern as other
   scrapers in this codebase). */
async function fetchLessinShowDetail(href) {
  const res = await fetch(href, { headers: BROWSER_HEADERS_HTML });
  if (!res.ok) throw new Error('lessin detail HTTP ' + res.status);
  const html = await res.text();

  let synopsis = null;
  let trailerUrl = null;
  const current = { image: null };

  await runRewriter(html, (rewriter) => {
    rewriter
      .on('meta[property="og:description"]', {
        element(el) {
          const content = decodeHtmlEntities(el.getAttribute('content') || '').replace(/\s+/g, ' ').trim();
          if (content) synopsis = content.length > 320 ? content.slice(0, 320).trim() + '…' : content;
        },
      })
      .on('a.showvideo', {
        element(el) {
          const href2 = el.getAttribute('href') || '';
          if (/youtu\.?be/.test(href2)) trailerUrl = href2;
        },
      })
      .on('.show_slider .swiper-slide img', {
        element(el) {
          if (current.image) return;
          const src = el.getAttribute('src');
          if (src && !src.startsWith('data:')) current.image = src;
        },
      });
  });

  if (!synopsis && !trailerUrl && !current.image) return null;
  return { synopsis, trailerUrl, image: current.image };
}

// ============================================================================
// Habima Theatre - title/url discovery (lightweight) + detail fetch
// ============================================================================

const HABIMA_URL = 'https://www.habima.co.il/wp-content/themes/tyco-wp/cache/allData.json';

/* Only shows with at least one scheduled presentation are worth tracking here - matches
   showmust-core's own filtering, so rotation budget isn't spent on shows core will never
   actually render an event card for. */
async function fetchHabimaTitleHrefs() {
  const res = await fetch(HABIMA_URL, { headers: BROWSER_HEADERS_JSON });
  if (!res.ok) throw new Error('habima list HTTP ' + res.status);
  const data = await res.json();
  const shows = (data.shows && data.shows.he) || {};
  const presentations = (data.presentations && data.presentations.he) || {};

  const map = new Map();
  Object.keys(presentations).forEach((showKey) => {
    const show = shows[showKey];
    if (show && show.title && show.url && (presentations[showKey] || []).length && !map.has(show.title)) {
      map.set(show.title, show.url);
    }
  });
  return map;
}

/* Each show's own page carries a real synopsis and, for most shows, an embedded YouTube
   trailer - verified live across 2 different current shows. Synopsis lives in two parts
   under .show-desc .content: a short h2.content-title tagline (often just a one-word genre
   like "דרמה רומנטית" - not meaningful alone) plus the actual description in
   p.content-subtitle; both are concatenated. Trailer is a plain <a class="play video-popup
   ...", href="..."> (both youtube.com/watch and youtu.be forms seen live). allData.json's own
   `excerpt` field is always empty in practice (verified: 0 of 47 shows have one) - not a
   usable shortcut, hence the detail-page fetch. */
async function fetchHabimaShowDetail(href) {
  const res = await fetch(href, { headers: BROWSER_HEADERS_HTML });
  if (!res.ok) throw new Error('habima detail HTTP ' + res.status);
  const html = await res.text();

  let tagline = '';
  let description = '';
  let trailerUrl = null;

  await runRewriter(html, (rewriter) => {
    rewriter
      .on('.show-desc .content h2.content-title', { text(t) { tagline += t.text; } })
      .on('.show-desc .content p.content-subtitle', { text(t) { description += t.text; } })
      .on('a.video-popup', {
        element(el) {
          if (trailerUrl) return;
          const href2 = el.getAttribute('href') || '';
          if (/youtu\.?be/.test(href2)) trailerUrl = href2;
        },
      });
  });

  const combined = [tagline, description].map((s) => decodeHtmlEntities(s).replace(/\s+/g, ' ').trim()).filter(Boolean).join(' — ');
  const synopsis = combined ? (combined.length > 320 ? combined.slice(0, 320).trim() + '…' : combined) : null;
  if (!synopsis && !trailerUrl) return null;
  return { synopsis, trailerUrl };
}

// ============================================================================
// Hatarbut Hall - full list + detail (its dates only exist behind the detail fetch)
// ============================================================================

const TARBUT_CALENDAR_URL = 'https://www.hatarbut.co.il/%D7%9C%D7%95%D7%97-%D7%94%D7%95%D7%A4%D7%A2%D7%95%D7%AA/calendar/';

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
              shows.push({ href: show.href, title: decodeHtmlEntities(show.title).replace(/\s+/g, ' ').trim(), image: show.image });
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
  const hallMatch = desc.match(/אולם:\s*([^\n]+?)\s*(?:תחילת המופע:|לרכישת כרטיסים|$)/);
  const hall = hallMatch ? hallMatch[1].trim() : null;
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
  const text = desc.slice(idx + 'מקום פנוי'.length).replace(/\[…\]\s*$/, '').replace(/\s+/g, ' ').trim();
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

/* Returns { hall, image, dates: [{date, link, synopsis}] } - a raw shape, not full Event
   objects (no id/source/venue/type/title) since showmust-core reconstructs those at merge
   time (see buildClientPayload in cf-worker/worker.js) - this worker doesn't need to know or
   duplicate that shape. */
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
        element(el) { desc = decodeHtmlEntities(el.getAttribute('content') || ''); },
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
  if (!meta) return null;
  const ticketLinks = extractTarbutTicketLinks(buttons);
  const synopsis = extractTarbutSynopsis(desc);

  const dates = [];
  meta.dates.forEach((dateStr) => {
    const date = parseTarbutDate(dateStr, meta.time);
    if (!date) return;
    dates.push({ date: date.toISOString(), link: ticketLinks[dateStr] || show.href, synopsis });
  });
  if (!dates.length) return null;
  return { hall: meta.hall, image: show.image || null, dates };
}

// ============================================================================
// Rotating coverage engine
// ============================================================================

function rotateSlice(list, cursor, count) {
  if (!list.length) return { slice: [], nextCursor: 0 };
  const n = Math.min(count, list.length);
  const slice = [];
  for (let i = 0; i < n; i++) slice.push(list[(cursor + i) % list.length]);
  return { slice, nextCursor: (cursor + n) % list.length };
}

/* Shared by all three sources below: detail-fetches a bounded rotating slice of `list`
   (advancing `cursor` each run, wrapping at the end), merges freshly-fetched results onto
   whatever this source already had stored (`prevMap`) so partial per-run coverage never loses
   ground, and PRUNES anything no longer present in the current list - naturally, since
   `merged` is built by walking `list` (the current truth), not `prevMap` (the old state), so
   a show that dropped off the site's own listing just doesn't get carried forward. */
async function rotateAndMerge({ list, prevMap, cursor, perRun, concurrency, fetchDetail }) {
  const { slice, nextCursor } = rotateSlice(list, cursor, perRun);

  const fetched = {};
  let idx = 0;
  async function worker() {
    while (idx < slice.length) {
      const item = slice[idx++];
      try {
        const detail = await fetchDetail(item);
        if (detail) fetched[item.title] = detail;
      } catch (e) { console.error('content: detail fetch failed:', item.title, e); }
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, slice.length || 1) }, worker));

  const merged = {};
  list.forEach((item) => {
    const value = fetched[item.title] || prevMap[item.title];
    if (value) merged[item.title] = value;
  });

  return {
    map: merged,
    nextCursor,
    status: { ok: true, fetchedThisRun: Object.keys(fetched).length, totalTracked: Object.keys(merged).length },
  };
}

// ============================================================================
// Orchestration
// ============================================================================

const CONTENT_KV_KEY = 'content-v1';
const CONCURRENCY = 3;
// Per-run detail-fetch budget per source, sized roughly proportional to each source's real
// catalog (Lessin ~22, Habima ~47, Hatarbut ~25 currently) so a full rotation sweep of all
// three completes in a comparable number of cron cycles rather than one source lagging far
// behind the others. Total worst case per run: 1(lessin list)+12(lessin detail)+1(habima
// list)+18(habima detail)+1(tarbut list)+12(tarbut detail)+1(KV get)+1(KV put) = 47, safely
// under the 50-subrequest cap with a small margin.
const LESSIN_DETAIL_PER_RUN = 12;
const HABIMA_DETAIL_PER_RUN = 18;
const TARBUT_DETAIL_PER_RUN = 12;

async function refreshContent(env) {
  let prev = { lessin: {}, habima: {}, tarbut: {}, meta: { cursors: {} } };
  try {
    const raw = await env.SHOWMUST_KV.get(CONTENT_KV_KEY);
    if (raw) prev = JSON.parse(raw);
  } catch (e) { console.error('content: failed to read previous state, starting fresh:', e); }

  const cursors = (prev.meta && prev.meta.cursors) || {};
  const sourceStatus = {};

  let lessin = { map: prev.lessin || {}, nextCursor: cursors.lessin || 0 };
  try {
    const list = Array.from((await fetchLessinTitleHrefs()).entries()).map(([title, href]) => ({ title, href }));
    lessin = await rotateAndMerge({
      list, prevMap: prev.lessin || {}, cursor: cursors.lessin || 0,
      perRun: LESSIN_DETAIL_PER_RUN, concurrency: CONCURRENCY,
      fetchDetail: (item) => fetchLessinShowDetail(item.href),
    });
    sourceStatus['lessin-enrichment'] = lessin.status;
  } catch (e) {
    console.error('content: lessin list failed, keeping previous state:', e);
    sourceStatus['lessin-enrichment'] = { ok: false, error: String(e.message || e), totalTracked: Object.keys(prev.lessin || {}).length };
  }

  let habima = { map: prev.habima || {}, nextCursor: cursors.habima || 0 };
  try {
    const list = Array.from((await fetchHabimaTitleHrefs()).entries()).map(([title, href]) => ({ title, href }));
    habima = await rotateAndMerge({
      list, prevMap: prev.habima || {}, cursor: cursors.habima || 0,
      perRun: HABIMA_DETAIL_PER_RUN, concurrency: CONCURRENCY,
      fetchDetail: (item) => fetchHabimaShowDetail(item.href),
    });
    sourceStatus['habima-enrichment'] = habima.status;
  } catch (e) {
    console.error('content: habima list failed, keeping previous state:', e);
    sourceStatus['habima-enrichment'] = { ok: false, error: String(e.message || e), totalTracked: Object.keys(prev.habima || {}).length };
  }

  let tarbut = { map: prev.tarbut || {}, nextCursor: cursors.tarbut || 0 };
  try {
    const rawList = await fetchTarbutShowList();
    const list = rawList.map((s) => ({ title: s.title, href: s.href, image: s.image }));
    tarbut = await rotateAndMerge({
      list, prevMap: prev.tarbut || {}, cursor: cursors.tarbut || 0,
      perRun: TARBUT_DETAIL_PER_RUN, concurrency: CONCURRENCY,
      fetchDetail: (item) => fetchTarbutShowDetail(item),
    });
    sourceStatus.tarbut = tarbut.status;
  } catch (e) {
    console.error('content: tarbut list failed, keeping previous state:', e);
    sourceStatus.tarbut = { ok: false, error: String(e.message || e), totalTracked: Object.keys(prev.tarbut || {}).length };
  }

  const payload = {
    meta: {
      generatedAt: new Date().toISOString(),
      cursors: { lessin: lessin.nextCursor, habima: habima.nextCursor, tarbut: tarbut.nextCursor },
      sourceStatus,
    },
    lessin: lessin.map,
    habima: habima.map,
    tarbut: tarbut.map,
  };

  const json = JSON.stringify(payload);
  // No expirationTtl - see file header on why content-v1 is cumulative state, not a
  // from-scratch cache entry.
  try { await env.SHOWMUST_KV.put(CONTENT_KV_KEY, json); }
  catch (e) { console.error('content-v1 put failed:', e); }

  return json;
}

/* Same manual-trigger pattern as showmust-core's /scrape - forces an immediate rotation step
   instead of waiting for the next cron tick. Gated by SCRAPE_SECRET
   (`wrangler secret put SCRAPE_SECRET` in this worker's own deployment - can reuse the same
   secret value as showmust-core's for convenience, or use a different one). */
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
      const json = await refreshContent(env);
      const { meta } = JSON.parse(json);
      return new Response(JSON.stringify({ triggered: true, meta }, null, 2), {
        headers: { ...CORS_HEADERS, 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
      });
    }

    // Not part of the normal client-facing flow (showmust-core reads content-v1 straight from
    // KV via the shared binding, no HTTP hop) - this plain GET exists purely so current state
    // can be inspected directly while debugging, without needing the scrape secret.
    let json = await env.SHOWMUST_KV.get(CONTENT_KV_KEY);
    if (!json) json = await refreshContent(env);
    return new Response(json, {
      headers: { ...CORS_HEADERS, 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
    });
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(refreshContent(env));
  },
};
