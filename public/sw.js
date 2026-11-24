const CACHE = 'tanki-v1';
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
  // Cache-first for static assets
  e.respondWith(
    caches.match(e.request).then(cached => {
      if (cached) return cached;
      return fetch(e.request).then(res => {
        if (res.ok && res.type === 'basic') {
          caches.open(CACHE).then(c => c.put(e.request, res.clone()));
        }
        return res;
      }).catch(() => caches.match('/'));
    })
  );
});

// Background sync for queued GPS updates
self.addEventListener('sync', e => {
  if (e.tag === 'sync-gps') {
    e.waitUntil(syncGPS());
  }
});

async function syncGPS() {
  // GPS queue is handled by the app.js using IndexedDB
  const clients = await self.clients.matchAll();
  clients.forEach(c => c.postMessage({ type: 'sync-gps' }));
}
