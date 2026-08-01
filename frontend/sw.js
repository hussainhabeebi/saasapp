const CACHE = 'lv-v4';
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
  const url = new URL(e.request.url);
  // Never cache NocoDB/API calls — always go network
  if (url.hostname.includes('aiingo.com') || url.hostname.includes('nocodb')) return;

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

  // Cache-first for everything else (scripts, styles, fonts, icons) — caches on first fetch so
  // later offline visits to a page have its dependencies already saved, no per-page asset list
  // to maintain by hand.
  e.respondWith(
    caches.match(e.request).then(cached => cached || fetch(e.request).then(res => {
      const copy = res.clone();
      caches.open(CACHE).then(c => c.put(e.request, copy)).catch(()=>{});
      return res;
    }).catch(() => cached))
  );
});
