/**
 * Cache-first service worker. The game is a fixed set of static files, so
 * serving from cache makes launches instant and lets it run with no
 * connection at all; updates are fetched in the background and applied on
 * the next launch.
 */
const VERSION = 'gem-quest-fa5ba820e4';
const ASSETS = [
  './',
  'index.html',
  'styles.css?v=fa5ba820e4',
  'bundle.js?v=fa5ba820e4',
  'manifest.webmanifest',
  'icon.svg',
  'icon-180.png',
  'icon-192.png',
  'icon-512.png',
  'icon-maskable-512.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(VERSION)
      .then((cache) => cache.addAll(ASSETS))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;
  if (new URL(request.url).origin !== self.location.origin) return;

  // Navigations go to the network first so a deploy is picked up on the very
  // next launch, falling back to cache when offline. Assets are content
  // hashed, so cache-first is always safe for them.
  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request)
        .then((response) => {
          const copy = response.clone();
          caches.open(VERSION).then((cache) => cache.put(request, copy));
          return response;
        })
        .catch(() => caches.match(request).then((hit) => hit || caches.match('index.html'))),
    );
    return;
  }

  event.respondWith(
    caches.match(request).then((hit) => {
      // Serve immediately from cache, then refresh it for next time.
      const network = fetch(request)
        .then((response) => {
          if (response && response.status === 200) {
            const copy = response.clone();
            caches.open(VERSION).then((cache) => cache.put(request, copy));
          }
          return response;
        })
        .catch(() => hit);
      return hit || network;
    }),
  );
});
