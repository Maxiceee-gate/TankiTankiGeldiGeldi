const CACHE = 'tanki-v4';
const TILES = 'tanki-tiles-v1';
const LIBS = 'tanki-libs-v1';
const MAX_TILES = 3000;
const SHELL = ['/', '/app.css', '/app.js', '/manifest.json', '/icon-192.png'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)));
  self.skipWaiting();
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => ![CACHE, TILES, LIBS].includes(k)).map(k => caches.delete(k)))));
  self.clients.claim();
});

let puts = 0;
async function cacheFirst(name, req, isTile) {
  const cache = await caches.open(name);
  const hit = await cache.match(req);
  if (hit) return hit;
  const res = await fetch(req);
  if (res.ok) {
    await cache.put(req, res.clone());
    if (isTile && ++puts % 100 === 0) {
      const keys = await cache.keys();
      await Promise.all(keys.slice(0, Math.max(0, keys.length - MAX_TILES)).map(k => cache.delete(k)));
    }
  }
  return res;
}

self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  // Map tiles and CDN libraries/fonts: serve from the phone once downloaded
  if (e.request.method === 'GET' && url.hostname === 'tile.openstreetmap.org') return e.respondWith(cacheFirst(TILES, e.request, true));
  if (e.request.method === 'GET' && /^(unpkg\.com|fonts\.googleapis\.com|fonts\.gstatic\.com)$/.test(url.hostname)) return e.respondWith(cacheFirst(LIBS, e.request));
  // App files: network-first so updates arrive on the next start; cache only as offline fallback
  if (e.request.method !== 'GET' || url.origin !== location.origin || url.pathname.startsWith('/api/') || url.pathname === '/ws') return;
  e.respondWith(
    fetch(e.request)
      .then(res => {
        if (res.ok) { const copy = res.clone(); caches.open(CACHE).then(c => c.put(e.request, copy)); }
        return res;
      })
      .catch(() => caches.match(e.request).then(hit => hit || caches.match('/')))
  );
});

self.addEventListener('notificationclick', e => {
  e.notification.close();
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
    const open = list.find(c => 'focus' in c);
    return open ? open.focus() : self.clients.openWindow('/');
  }));
});
