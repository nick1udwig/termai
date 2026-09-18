// Cache only this installation's app shell; never terminal/API traffic or sibling apps.
const BASE = new URL(self.registration.scope);
const PREFIX = `termai-shell:${BASE.pathname}:`;
const CACHE = PREFIX + '__TERMAI_BUILD__';
const asset = name => new URL(name, BASE).href;
const FILES = /*__TERMAI_ASSETS__*/ ['', 'icon.svg', 'manifest.webmanifest'];
const known = new Set(FILES.map(asset));
self.addEventListener('install', event => event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(FILES.map(asset)))));
self.addEventListener('activate', event => event.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(key => key.startsWith(PREFIX) && key !== CACHE).map(key => caches.delete(key)))).then(() => self.clients.claim())));
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);
  if (event.request.method !== 'GET' || url.origin !== BASE.origin || !url.pathname.startsWith(BASE.pathname)) return;
  const relative = url.pathname.slice(BASE.pathname.length);
  if (relative.startsWith('api/') || relative === 'ws') return;
  const navigate = event.request.mode === 'navigate';
  const canonical = new URL(url.pathname, BASE.origin).href;
  if (!(navigate || relative.startsWith('assets/') || known.has(canonical))) return;
  event.respondWith((async () => {
    const cache = await caches.open(CACHE);
    if (!navigate) {
      // Hashed assets are immutable; a waiting worker may already have the next build.
      const cached = await cache.match(canonical) || (relative.startsWith('assets/') && await caches.match(canonical));
      if (cached) return cached;
    }
    try {
      const response = await fetch(event.request);
      // Store only this build's finite manifest, and one canonical navigation entry.
      if (response.ok && (navigate || known.has(canonical))) event.waitUntil(cache.put(navigate ? asset('') : canonical, response.clone()));
      return response;
    } catch {
      return (await cache.match(navigate ? asset('') : canonical)) || new Response('Offline', { status: 503 });
    }
  })());
});
