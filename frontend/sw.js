const CACHE = 'lv-v8';
const OFFLINE_URL = '/offline.html';
// Shared across every page on every domain this file is served from (app.leadvyne.com,
// leadvyne.com, onshope.com — same physical file, isolated per-origin by the browser).
// Pages are monolithic self-contained HTML (inline CSS/JS), so precaching just needs the
// offline fallback plus the handful of cross-origin libs common to most tool pages; anything
// else (per-page CDN scripts, icons, the page itself) gets cached the first time it's fetched.
const ASSETS = [
  OFFLINE_URL,
  'https://cdn.jsdelivr.net/npm/chart.js@4.4.0/dist/chart.umd.min.js',
  'https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@500;600;700&family=Inter:wght@400;500;600&family=JetBrains+Mono:wght@400;500&display=swap'
];

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE).then(c => c.addAll(ASSETS).catch(()=>{}))
  );
  self.skipWaiting();
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return; // form submits/API writes always go straight to network

  if (e.request.mode === 'navigate') {
    // Network-first so a page always reflects the latest deploy when online; caches the response
    // as it goes so the exact page just visited is available offline next time. Falls back to
    // whatever cached copy of that page exists, then to a generic offline page as a last resort.
    e.respondWith(
      fetch(e.request)
        .then(res => {
          const copy = res.clone();
          caches.open(CACHE).then(c => c.put(e.request, copy)).catch(()=>{});
          return res;
        })
        .catch(() => caches.match(e.request).then(cached => cached || caches.match(OFFLINE_URL)))
    );
    return;
  }

  // Only cache actual static resources (scripts, styles, fonts, images) — never data calls.
  // Every API call in this app (leads, messages, conversations — all through
  // leadvyne-api-proxy.leadvyne.workers.dev and similar) is a JS fetch()/XHR, which reports an
  // empty `destination`, so it falls straight through to the network here instead of ever being
  // cached. Caching those was what made messages show stale/delayed while online and diverge
  // between devices — each device would freeze on whatever response it happened to cache first.
  if (!['script', 'style', 'font', 'image'].includes(e.request.destination)) return;

  // Cache-first, caching on first fetch — no per-page asset list to maintain by hand.
  e.respondWith(
    caches.match(e.request).then(cached => cached || fetch(e.request).then(res => {
      const copy = res.clone();
      caches.open(CACHE).then(c => c.put(e.request, copy)).catch(()=>{});
      return res;
    }).catch(() => cached))
  );
});
