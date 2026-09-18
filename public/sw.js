// Cache only this installation's app shell; never terminal/API traffic or sibling apps.
const BASE = new URL(self.registration.scope);
const PREFIX = `termai-shell:${BASE.pathname}:`;
const CACHE = PREFIX + 'v2';
const asset = name => new URL(name, BASE).href;
self.addEventListener('install', event => event.waitUntil(caches.open(CACHE).then(cache => cache.addAll([asset(''), asset('icon.svg'), asset('manifest.webmanifest')]))));
self.addEventListener('activate', event => event.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(key => key.startsWith(PREFIX) && key !== CACHE).map(key => caches.delete(key)))).then(() => self.clients.claim())));
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);
  if (event.request.method !== 'GET' || url.origin !== BASE.origin || !url.pathname.startsWith(BASE.pathname)) return;
  const relative = url.pathname.slice(BASE.pathname.length);
  if (relative.startsWith('api/') || relative === 'ws') return;
  if (!(event.request.mode === 'navigate' || relative.startsWith('assets/') || ['icon.svg', 'manifest.webmanifest'].includes(relative))) return;
  event.respondWith(fetch(event.request).then(response => {
    if (response.ok) { const copy = response.clone(); void caches.open(CACHE).then(cache => cache.put(event.request, copy)); }
    return response;
  }).catch(async () => (await caches.match(event.request)) || (event.request.mode === 'navigate' ? await caches.match(asset('')) : undefined) || new Response('Offline', { status: 503 })));
});
