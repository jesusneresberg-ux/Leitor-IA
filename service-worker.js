// LUME — leitura PDF inteiramente local depois da primeira instalação online.
const CACHE = 'lume-reader-offline-v6';
const CORE = ['./', './index.html', './manifest.webmanifest', './cloud.js',
              './assets/pdfjs/pdf.min.mjs', './assets/pdfjs/pdf.worker.min.mjs'];
self.addEventListener('install', event => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    await cache.addAll(CORE);
    await self.skipWaiting();
  })());
});
self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter(k =>
      (k.startsWith('lume-reader-') || k.startsWith('leitor-ia-')) && k !== CACHE
    ).map(k => caches.delete(k)));
    await self.clients.claim();
  })());
});
self.addEventListener('fetch', event => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  event.respondWith((async () => {
    const cached = await caches.match(req);
    if (req.mode === 'navigate') {
      try {
        const live = await fetch(req);
        if (live.ok) (await caches.open(CACHE)).put(req, live.clone());
        return live;
      } catch (_) {
        return cached || await caches.match('./index.html') || Response.error();
      }
    }
    if (cached) return cached;
    try {
      const live = await fetch(req);
      if (live.ok) (await caches.open(CACHE)).put(req, live.clone());
      return live;
    } catch (_) { return Response.error(); }
  })());
});
self.addEventListener('message', event => {
  if (event.data?.type === 'CACHE_OFFLINE_ENGINE') {
    event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(CORE)));
  }
});
