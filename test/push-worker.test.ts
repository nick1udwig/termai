import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

test('push worker always shows a visible vibrating notification and routes clicks inside the mounted app', async () => {
  const handlers: Record<string, (event: any) => void> = {}, notifications: any[] = [], opened: string[] = [], messages: any[] = [];
  let focused = 0, closed = 0;
  const windows: any[] = [{ url: 'https://example.com/another/', focus: () => assert.fail('Sibling app focused') }];
  runInNewContext(readFileSync(new URL('../public/push-sw.js', import.meta.url), 'utf8'), {
    URL, self: {
      location: { href: 'https://example.com/t/push-sw.js' },
      registration: { showNotification: async (title: string, options: any) => notifications.push({ title, ...options }) },
      clients: { matchAll: async () => windows, openWindow: async (url: string) => opened.push(url) },
      addEventListener: (name: string, handler: (event: any) => void) => handlers[name] = handler,
    },
  });
  const dispatch = async (name: string, data: any) => { let work; handlers[name]({ ...data, waitUntil: (promise: any) => work = promise }); await work; };
  const tabId = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
  await dispatch('push', { data: { json: () => ({ title: 'Review', body: 'Agent finished', tag: 'test', tabId, terminalId: 'term_4', url: 'https://attacker.test/' }) } });
  assert.equal(notifications[0].title, 'Review'); assert.equal(notifications[0].body, 'Agent finished'); assert.equal(notifications[0].vibrate.join(), '200,100,200'); assert.equal(notifications[0].silent, undefined);
  const notification = { data: notifications[0].data, close: () => closed++ };
  await dispatch('notificationclick', { notification });
  assert.equal(opened[0], 'https://example.com/t/?notificationTab=' + tabId + '&notificationTerminal=term_4');
  windows.push({ url: 'https://example.com/t/', focus: async () => focused++, postMessage: (message: any) => messages.push(message) });
  await dispatch('notificationclick', { notification });
  assert.equal(focused, 1); assert.equal(closed, 2); assert.equal(messages[0].terminalId, 'term_4'); assert.equal(messages[0].type, 'herdr-notification');
  await dispatch('push', { data: { json: () => { throw new Error('Malformed payload'); } } }); assert.equal(notifications[1].title, 'Herdr');
  await dispatch('push', {}); assert.equal(notifications.length, 3, 'Even an empty push is visible');
  await dispatch('push', { data: { json: () => ({ tag: '' }) } }); assert.equal(notifications[3].tag, 'herdr', 'Renotify always has a nonempty tag');
});
