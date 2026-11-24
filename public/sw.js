const CACHE = 'tanki-v2';
const SHELL = ['/', '/app.css', '/app.js', '/manifest.json', '/icon-192.svg'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)));
  self.skipWaiting();
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys =>
    Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
  ));
  self.clients.claim();
});

self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);

  // Network-first for API calls
  if (url.pathname.startsWith('/api/')) {
    e.respondWith(fetch(e.request).catch(() => new Response('{"error":"Offline"}', { headers: { 'Content-Type': 'application/json' } })));
    return;
  }

  // Network-first for static assets — always fetch fresh, cache as fallback
  e.respondWith(
    fetch(e.request)
      .then(res => {
        if (res.ok && res.type === 'basic') {
          caches.open(CACHE).then(c => c.put(e.request, res.clone()));
        }
        return res;
      })
      .catch(() => caches.match(e.request).then(cached => cached || caches.match('/')))
  );
});

// Background sync for queued GPS updates
self.addEventListener('sync', e => {
  if (e.tag === 'sync-gps') {
    e.waitUntil(syncGPS());
  }
});

async function syncGPS() {
  const clients = await self.clients.matchAll();
  clients.forEach(c => c.postMessage({ type: 'sync-gps' }));
}
