const CACHE = 'lv-v17';
const OFFLINE_URL = '/offline.html';
const ASSETS = [
  OFFLINE_URL,
  'https://cdn.jsdelivr.net/npm/chart.js@4.4.0/dist/chart.umd.min.js',
  'https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@500;600;700&family=Inter:wght@400;500;600&family=JetBrains+Mono:wght@400;500&display=swap'
];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS).catch(()=>{})));
  self.skipWaiting();
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))));
  self.clients.claim();
});

self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return;

  if (e.request.mode === 'navigate') {
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

  if (!['script', 'style', 'font', 'image'].includes(e.request.destination)) return;

  // The app's own scripts and stylesheets (accounting-ledger.js, ads-report.js, …) keep their
  // name across deploys, so cache-first served the copy from a phone's FIRST visit forever —
  // a new page with old code. Network-first keeps them current; the cache is the offline
  // fallback only. Versioned CDN files, fonts and images stay cache-first below.
  const sameOrigin = new URL(e.request.url).origin === self.location.origin;
  if (sameOrigin && (e.request.destination === 'script' || e.request.destination === 'style')) {
    e.respondWith(
      fetch(e.request)
        .then(res => {
          if (res.ok) { const copy = res.clone(); caches.open(CACHE).then(c => c.put(e.request, copy)).catch(()=>{}); }
          return res;
        })
        .catch(() => caches.match(e.request))
    );
    return;
  }

  e.respondWith(
    caches.match(e.request).then(cached => cached || fetch(e.request).then(res => {
      const copy = res.clone();
      caches.open(CACHE).then(c => c.put(e.request, copy)).catch(()=>{});
      return res;
    }).catch(() => cached))
  );
});
