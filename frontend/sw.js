const CACHE = 'lv-v11';
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

async function chatsResponse(request){
  const res=await fetch(request);
  if(!res.ok) return res;
  const html=await res.text();
  const tag='<script src="chats-hotfix.js?v=11"></script>';
  const patched=html.includes('chats-hotfix.js')?html:html.replace('</body>', tag+'\n</body>');
  const h=new Headers(res.headers);
  h.delete('content-length');
  h.delete('content-encoding');
  const out=new Response(patched,{status:res.status,statusText:res.statusText,headers:h});
  caches.open(CACHE).then(c=>c.put(request,out.clone())).catch(()=>{});
  return out;
}

self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return;

  if (e.request.mode === 'navigate') {
    const url=new URL(e.request.url);
    if(url.pathname.endsWith('/chats.html')){
      e.respondWith(chatsResponse(e.request).catch(() => caches.match(e.request).then(cached => cached || caches.match(OFFLINE_URL))));
      return;
    }
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

  e.respondWith(
    caches.match(e.request).then(cached => cached || fetch(e.request).then(res => {
      const copy = res.clone();
      caches.open(CACHE).then(c => c.put(e.request, copy)).catch(()=>{});
      return res;
    }).catch(() => cached))
  );
});
