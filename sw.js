/* Tidepool service worker — lets the app open and play with no signal.
   Puzzles are generated on device from seeds, so offline play is complete;
   only submitting scores needs the network. */
const V = 'tidepool-v1';
const SHELL = [
  '/',
  '/index.html',
  '/manifest.json'
];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(V).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== V).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET') return;
  /* scores and social data must never come from a cache */
  if (url.pathname.startsWith('/api/')) return;

  e.respondWith(
    caches.match(e.request).then(hit => {
      const live = fetch(e.request).then(res => {
        if (res && res.status === 200 && (url.origin === location.origin || res.type === 'cors')){
          const copy = res.clone();
          caches.open(V).then(c => c.put(e.request, copy)).catch(()=>{});
        }
        return res;
      }).catch(() => hit);
      return hit || live;
    })
  );
});
