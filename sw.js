/* BUST — offline cache.
   Solo and pass-and-play work with no connection at all; only the online mode
   needs the network, and that request is deliberately never cached. */

const CACHE = 'bust-v7';
const ASSETS = [
  './',
  'index.html',
  'styles.css',
  'manifest.webmanifest',
  'src/main.js',
  'src/engine.js',
  'src/ai.js',
  'src/render.js',
  'src/icons.js',
  'src/modes.js',
  'src/rank.js',
  'src/audio.js',
  'src/net.js',
  'assets/icon.svg',
  'assets/icon-192.png',
  'assets/icon-512.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE)
      // Don't let one missing file sink the whole install.
      .then((c) => Promise.allSettled(ASSETS.map((a) => c.add(a))))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return; // fonts + PeerJS go straight to the network

  // Network-first for navigations so a deployed update lands immediately,
  // cache-first for everything else so the board never waits on a round trip.
  if (req.mode === 'navigate') {
    e.respondWith(
      fetch(req)
        .then((res) => {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put('index.html', copy));
          return res;
        })
        .catch(() => caches.match('index.html')),
    );
    return;
  }

  // Stale-while-revalidate: hand back the cached copy at once so the board
  // never waits on a round trip, but refresh it in the background so a
  // deployed update to the JS/CSS lands on the very next load.
  e.respondWith(
    caches.match(req).then((hit) => {
      const fetching = fetch(req)
        .then((res) => {
          if (res.ok) {
            const copy = res.clone();
            caches.open(CACHE).then((c) => c.put(req, copy));
          }
          return res;
        })
        .catch(() => hit);
      return hit || fetching;
    }),
  );
});
