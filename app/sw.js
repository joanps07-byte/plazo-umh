// Plazo — service worker: app disponible sin conexión y notificaciones push.
const CACHE = 'plazo-v3';
const SHELL = ['./', 'index.html', 'app.css', 'app.js', 'demo.js', 'manifest.webmanifest', 'icons/icon-192.png', 'icons/icon-512.png', 'icons/apple-touch-icon.png'];

self.addEventListener('install', (e) => { e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting())); });
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});

// Archivos de la app: se sirve la copia guardada y se actualiza por detrás. La API y el campus nunca se guardan.
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin || url.pathname.startsWith('/api/') || url.pathname.startsWith('/cal/')) return;
  e.respondWith(caches.open(CACHE).then(async (cache) => {
    const key = e.request.mode === 'navigate' ? 'index.html' : e.request;
    const hit = await cache.match(key, { ignoreSearch: true });
    const fresh = fetch(e.request).then((res) => { if (res.ok) cache.put(key, res.clone()); return res; }).catch(() => hit);
    return hit || fresh;
  }));
});

self.addEventListener('push', (e) => {
  let n = {};
  try { n = e.data.json(); } catch { n = { title: 'Plazo', body: e.data ? e.data.text() : 'Hay novedades en el campus' }; }
  e.waitUntil(self.registration.showNotification(n.title || 'Plazo', { body: n.body || '', tag: n.tag, icon: 'icons/icon-192.png', badge: 'icons/badge.png', data: { url: n.url || '/' } }));
});

self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const url = e.notification.data?.url || '/';
  e.waitUntil((async () => {
    const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    if (all.length) { const c = all[0]; await c.focus(); c.postMessage({ type: 'open', url }); return; }
    await self.clients.openWindow(url);
  })());
});
