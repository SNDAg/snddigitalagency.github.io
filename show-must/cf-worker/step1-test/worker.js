/**
 * SHOWMUST — STEP 1: Anti-scraping / bot-block probe.
 *
 * Fires a native `fetch()` from the Cloudflare Worker's edge IP at each of the
 * 7 source sites and reports back status codes, content-type, response size,
 * and a heuristic "isLikelyBlocked" flag (Cloudflare challenge page, 403/503,
 * captcha markers, etc). No parsing/scraping logic here on purpose — this is
 * a go/no-go check for native fetch per source, nothing else.
 *
 * Deploy this as-is to aged-hall-eff1.shahaf579.workers.dev and open the URL
 * in a browser to read the JSON report.
 */

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

function todayISO() {
  // Vista's "at-date" endpoints want the *local* (Asia/Jerusalem) date, not UTC.
  return new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Jerusalem' });
}

const DATE_STR = todayISO();

const TARGETS = [
  {
    name: 'lessin',
    label: 'Lessin Theatre',
    url: 'https://www.lessin.co.il/%D7%94%D7%A6%D7%92%D7%95%D7%AA/',
    headers: BROWSER_HEADERS_HTML,
    expect: 'html',
  },
  {
    name: 'habima',
    label: 'Habima Theatre (direct JSON)',
    url: 'https://www.habima.co.il/wp-content/themes/tyco-wp/cache/allData.json',
    headers: BROWSER_HEADERS_JSON,
    expect: 'json',
  },
  {
    name: 'lev',
    label: 'Lev Cinema',
    url: 'https://www.lev.co.il/location/telaviv/',
    headers: BROWSER_HEADERS_HTML,
    expect: 'html',
  },
  {
    name: 'ravhen',
    label: 'Rav-Hen Cinema (Vista API)',
    url: `https://www.rav-hen.co.il/rh/data-api-service/v1/quickbook/10104/film-events/in-cinema/1071/at-date/${DATE_STR}?attr=&lang=he_IL`,
    headers: BROWSER_HEADERS_JSON,
    expect: 'json',
  },
  {
    name: 'barby',
    label: 'Barby Club',
    url: 'https://www.barby.co.il/',
    headers: BROWSER_HEADERS_HTML,
    expect: 'html',
  },
  {
    name: 'planet',
    label: 'Planet Cinema (Vista API)',
    url: `https://www.planetcinema.co.il/il/data-api-service/v1/quickbook/10100/film-events/in-cinema/1025/at-date/${DATE_STR}?attr=&lang=he_IL`,
    headers: BROWSER_HEADERS_JSON,
    expect: 'json',
  },
  {
    name: 'hatarbut',
    label: 'Hatarbut Hall',
    url: 'https://www.hatarbut.co.il/%D7%9C%D7%95%D7%97-%D7%94%D7%95%D7%A4%D7%A2%D7%95%D7%AA/calendar/',
    headers: BROWSER_HEADERS_HTML,
    expect: 'html',
  },
];

const CHALLENGE_MARKERS = [
  'just a moment',
  'attention required',
  'cf-chl',
  'cf_chl',
  'checking your browser',
  'captcha',
  'access denied',
  'are you human',
  'enable javascript and cookies',
  '/cdn-cgi/challenge-platform',
];

function looksLikeChallenge(bodyLower, headers) {
  if (headers.get('cf-mitigated')) return true;
  if (headers.get('cf-chl-bypass')) return true;
  return CHALLENGE_MARKERS.some((marker) => bodyLower.includes(marker));
}

async function probe(target) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8000);
  const startedAt = Date.now();

  try {
    const res = await fetch(target.url, {
      headers: target.headers,
      redirect: 'follow',
      signal: controller.signal,
      cf: { cacheTtl: 0, cacheEverything: false },
    });

    const elapsedMs = Date.now() - startedAt;
    const contentType = res.headers.get('content-type') || '';
    const bodyText = await res.text();
    const bodyLower = bodyText.toLowerCase();

    const blocked = !res.ok || looksLikeChallenge(bodyLower, res.headers);
    const looksLikeExpectedJson = target.expect === 'json' && bodyText.trim().startsWith('{');

    return {
      source: target.name,
      label: target.label,
      url: target.url,
      status: res.status,
      ok: res.ok,
      elapsedMs,
      contentType,
      bodyBytes: bodyText.length,
      cfRay: res.headers.get('cf-ray') || null,
      server: res.headers.get('server') || null,
      isLikelyBlocked: blocked,
      matchesExpectedFormat: target.expect === 'json' ? looksLikeExpectedJson : contentType.includes('text/html'),
      verdict: blocked ? 'BLOCKED — needs Jina fallback' : 'OK — native fetch works',
      bodyPreview: bodyText.slice(0, 300).replace(/\s+/g, ' ').trim(),
    };
  } catch (err) {
    return {
      source: target.name,
      label: target.label,
      url: target.url,
      status: null,
      ok: false,
      elapsedMs: Date.now() - startedAt,
      error: err.name === 'AbortError' ? 'TIMEOUT (>8s)' : String(err.message || err),
      isLikelyBlocked: true,
      verdict: 'BLOCKED (network/timeout) — needs Jina fallback',
    };
  } finally {
    clearTimeout(timeout);
  }
}

export default {
  async fetch(request) {
    const results = await Promise.all(TARGETS.map(probe));

    const summary = {
      testedAt: new Date().toISOString(),
      dateUsedForVistaApis: DATE_STR,
      totalSources: results.length,
      blockedSources: results.filter((r) => r.isLikelyBlocked).map((r) => r.source),
      okSources: results.filter((r) => !r.isLikelyBlocked).map((r) => r.source),
    };

    const payload = { summary, results };

    return new Response(JSON.stringify(payload, null, 2), {
      status: 200,
      headers: {
        'content-type': 'application/json; charset=utf-8',
        'access-control-allow-origin': '*',
        'cache-control': 'no-store',
      },
    });
  },
};
