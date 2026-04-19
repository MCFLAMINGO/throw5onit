const VERSION = 'v137';
const CACHE   = 'throw-' + VERSION;

const ASSETS = [
  '/',
  '/index.html',
  '/style.css',
  '/app.js',
  '/room.js',
  '/manifest.json',
  '/qrcode.min.js',
  '/jsqr.min.js',
  '/viem.bundle.js',
  '/mqtt.min.js',
  '/icon-192.png',
  '/icon-512.png',
];

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE).then(c => c.addAll(ASSETS)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  // Pass external requests (CDN images, APIs) straight through — never cache them
  if (!e.request.url.startsWith(self.location.origin)) {
    e.respondWith(fetch(e.request));
    return;
  }
  e.respondWith(
    caches.match(e.request).then(cached => cached || fetch(e.request))
  );
});

// ─── Force-update message from client ───────────────────────────────────────
self.addEventListener('message', e => {
  if (e.data && e.data.type === 'SKIP_WAITING') self.skipWaiting();
});

// ─── Web Push handler ────────────────────────────────────────────────────────
self.addEventListener('push', e => {
  if (!e.data) return;
  let data;
  try { data = e.data.json(); } catch { return; }

  const title   = data.title   || '💸 THROW';
  const options = {
    body:    data.body   || 'Money thrown to you!',
    icon:    data.icon   || '/icon-192.png',
    badge:   data.badge  || '/icon-192.png',
    data:    data.data   || { url: 'https://throw5onit.com' },
    vibrate: [200, 100, 200],
    requireInteraction: false,
  };

  e.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', e => {
  e.notification.close();
  const url = (e.notification.data && e.notification.data.url) || 'https://throw5onit.com';
  e.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
      // Focus existing window if open
      for (const client of list) {
        if (client.url.startsWith('https://throw5onit.com') && 'focus' in client) {
          return client.focus();
        }
      }
      // Otherwise open new window
      if (clients.openWindow) return clients.openWindow(url);
    })
  );
});
