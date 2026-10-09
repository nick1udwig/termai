// A separate scope per backend lets each server own its VAPID key/subscription.
// The app shell is controlled by sw.js; this worker only handles notifications.
const APP = new URL('./', self.location.href);
self.addEventListener('push', event => {
  event.waitUntil((async () => {
    let message = {};
    try { message = event.data?.json() || {}; } catch {}
    const tabId = typeof message.tabId === 'string' && /^[a-f0-9-]{36}$/.test(message.tabId) ? message.tabId : '';
    const terminalId = typeof message.terminalId === 'string' ? message.terminalId.slice(0, 256) : '';
    // Every push produces a visible alert, as required by Safari and Web Push.
    await self.registration.showNotification(typeof message.title === 'string' ? message.title.slice(0, 100) : 'Herdr', {
      body: typeof message.body === 'string' ? message.body.slice(0, 200) : 'An agent needs your attention',
      icon: new URL('icon.svg', APP).href,
      tag: typeof message.tag === 'string' && message.tag ? message.tag.slice(0, 100) : 'herdr',
      vibrate: [200, 100, 200], renotify: true,
      data: { tabId, terminalId },
    });
  })());
});
self.addEventListener('notificationclick', event => {
  event.notification.close();
  event.waitUntil((async () => {
    const route = { type: 'herdr-notification', ...event.notification.data };
    const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const client = windows.find(client => {
      const url = new URL(client.url);
      return url.origin === APP.origin && (url.pathname === APP.pathname || url.pathname === new URL('index.html', APP).pathname);
    });
    if (client) { await client.focus(); client.postMessage(route); return; }
    const url = new URL(APP);
    if (route.tabId) url.searchParams.set('notificationTab', route.tabId);
    if (route.terminalId) url.searchParams.set('notificationTerminal', route.terminalId);
    await self.clients.openWindow(url.href);
  })());
});
