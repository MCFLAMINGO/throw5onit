const VERSION = 'v24';
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
  e.respondWith(
    caches.match(e.request).then(cached => cached || fetch(e.request))
  );
});
