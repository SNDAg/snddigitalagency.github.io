/* Service worker for SHOWMUST - PWA installability + basic offline app-shell caching.
   Deliberately minimal in scope: this only ever caches the page shell (index.html itself),
   never the live events data (SHOWMUST_API_URL), fonts, the analytics beacon, or anything
   cross-origin - those must always hit the network fresh. The point is just letting the app
   OPEN (and show its own "couldn't load data" state, which already exists) even with zero
   connectivity, not full offline functionality.

   Network-first, not cache-first: every load tries the network before falling back to the
   cached shell, and the cache is refreshed on every successful load. This avoids the classic
   PWA footgun of serving a stale shell forever after a deploy - visitors always get the latest
   HTML/JS when they have a connection, and only fall back to the last-cached version when they
   genuinely don't. */

const CACHE_NAME = 'showmust-shell-v1';
const SHELL_URL = './';

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.add(SHELL_URL))
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(
      keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))
    ))
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  // Only ever intercept same-origin document/navigation requests (i.e. the page itself) -
  // everything else (the events API, fonts, the Cloudflare Analytics beacon, font-awesome CDN)
  // must always go straight to the network untouched.
  if (request.mode !== 'navigate' && request.destination !== 'document') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  event.respondWith(
    fetch(request)
      .then((response) => {
        const copy = response.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(SHELL_URL, copy));
        return response;
      })
      .catch(() => caches.match(SHELL_URL))
  );
});
