// Service worker for the staff PWA only (registered from staff.html). Caches the app shell so
// the job list UI still loads with a flaky signal on a job site; it never caches API responses —
// job data must always be fresh. Cross-origin requests (the Worker API) are left untouched.

const CACHE_NAME = 'field-service-staff-shell-v1';
const SHELL_FILES = ['staff.html', 'manifest.json', 'icons/icon.svg', 'icons/icon-maskable.svg'];

self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE_NAME).then(cache => cache.addAll(SHELL_FILES)));
  self.skipWaiting();
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(names => Promise.all(names.filter(n => n !== CACHE_NAME).map(n => caches.delete(n))))
  );
  self.clients.claim();
});

self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin || event.request.method !== 'GET') return; // never touch API calls
  event.respondWith(
    caches.match(event.request).then(cached => {
      const network = fetch(event.request).then(res => {
        if (res.ok) caches.open(CACHE_NAME).then(cache => cache.put(event.request, res.clone()));
        return res;
      }).catch(() => cached);
      return cached || network;
    })
  );
});
