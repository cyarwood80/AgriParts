// Keeps the app shell available offline so saved job packs open in a field
// with no signal. API responses are never cached here: packs live in local
// storage with their own licence expiry.
const CACHE = 'linchpin-shell-v8';
const SHELL = ['./', 'index.html', 'app.css', 'icon.svg', 'manifest.webmanifest', 'js/app.js', 'js/lib.js', 'js/counter.js', 'js/orders.js', 'js/insights.js', 'js/field.js', 'js/review.js', 'js/desk.js', 'js/job.js', 'js/explode.js', 'js/diagram.js', 'js/find.js', 'js/model3d.js'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});

// Network first (so updates show straight away), cache when offline.
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin || !url.pathname.startsWith('/app/')) return;
  e.respondWith(
    fetch(e.request)
      .then((res) => {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(e.request, copy));
        return res;
      })
      .catch(() => caches.match(e.request, { ignoreSearch: true }).then((r) => r ?? caches.match('index.html'))),
  );
});
