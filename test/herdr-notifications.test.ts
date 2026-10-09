import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createECDH, createHash, randomBytes, randomUUID } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { EventEmitter } from 'node:events';
import { runInNewContext } from 'node:vm';
import type { WebSocket } from 'ws';
import webpush from 'web-push';
import { HerdrNotifications, pushSubscription } from '../server/herdr-notifications.ts';
import { herdrFixture } from './herdr-fixture.ts';
import { HerdrNotifications as BrowserNotifications } from '../src/herdr-notifications.ts';
import { responsePreview, agentResponsePreview, notificationBody } from '../server/herdr-notification-preview.ts';
import { herdrSnapshot } from '../server/herdr.ts';

test('response previews retain prose, remove terminal paint/composer/footer, and handle unavailable output', async () => {
  assert.equal(responsePreview('Old response\n\n\x1b[32m• New response\x1b[0m\n  continues here.\n\nWorked for 12s\n\n╭─────╮\n│ › ask again │\n╰─────╯\nmodel · status'), 'New response continues here.');
  assert.equal(responsePreview(''), '');
  const preview = responsePreview('🙂'.repeat(400)); assert.equal(Array.from(preview).length, 280); assert.ok(preview.endsWith('…'));
  assert.equal(notificationBody('/work/project', ''), '/work/project');
  const fixture = await herdrFixture(), target = { session: '', socketPath: fixture.socketPath };
  try {
    const agent = (await herdrSnapshot(target)).agents[0];
    fixture.snapshot.panes[0].terminal_id = 'replacement';
    assert.equal(await agentResponsePreview(target, agent), '');
    assert.ok(!fixture.actions.some(action => action.method === 'pane.read'), 'A recycled pane cannot provide another agent’s preview');
  } finally { await fixture.close(); }
});

test('the push worker displays the directory and full response preview while retaining click routing', async () => {
  const handlers = new Map<string, (event: any) => void>(), shown: any[] = [];
  runInNewContext(await readFile(new URL('../public/push-sw.js', import.meta.url), 'utf8'), { URL, self: {
    location: { href: 'https://termai.example/t/push-sw.js' },
    addEventListener: (type: string, handler: (event: any) => void) => handlers.set(type, handler),
    registration: { async showNotification(title: string, options: unknown) { shown.push({ title, options }); } },
  } });
  const tabId = randomUUID(), body = notificationBody('/workspace/' + 'project-'.repeat(20), responsePreview('Finished 🙂 ' + 'response '.repeat(40)));
  let delivered!: Promise<void>;
  handlers.get('push')!({ data: { json: () => ({ title: 'Review', body, tabId, terminalId: 'term_1' }) }, waitUntil: (work: Promise<void>) => delivered = work });
  await delivered;
  assert.ok(body.length > 200); assert.equal(shown[0].options.body, body);
  assert.equal(shown[0].options.data.tabId, tabId); assert.equal(shown[0].options.data.terminalId, 'term_1');
});

const owner = 'a'.repeat(64), other = 'b'.repeat(64), ownerHash = createHash('sha256').update(owner).digest('hex');
function subscription() { const key = createECDH('prime256v1'); key.generateKeys(); return { endpoint: 'https://fcm.googleapis.com/fcm/send/test-device', keys: { p256dh: key.getPublicKey().toString('base64url'), auth: randomBytes(16).toString('base64url') } }; }
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
async function until(check: () => boolean | Promise<boolean>) { for (let end = Date.now() + 5000; Date.now() < end;) { if (await check()) return; await delay(20); } throw new Error('Notification check timed out'); }
async function initialized(directory: string) { await until(async () => { try { const stored = JSON.parse(await readFile(directory + '/herdr-push.json', 'utf8')); return Object.values(stored.checkpoints).some((states: any) => states.term_1?.raw); } catch { return false; } }); }

test('closing a connection during browser subscription restoration cannot register an orphan watch', async () => {
  const actions: string[] = []; let finish!: () => void;
  const manager = new BrowserNotifications(async <T>(_id: string, name: string) => { actions.push(name); return {} as T; }, () => {});
  manager.restore = () => new Promise<void>(resolve => finish = resolve); manager.device = () => 'test-device';
  const watch = manager.watch('primary', randomUUID(), '');
  const tab = randomUUID();
  // A separate live watch can still finish normally.
  finish(); await watch; actions.length = 0;
  const pending = manager.watch('primary', tab, ''); await manager.unwatch('primary', tab); finish(); await pending;
  assert.deepEqual(actions, ['api/notifications/unwatch']);
});

test('push subscriptions accept browser services and reject arbitrary/private URLs and invalid keys', () => {
  const input = subscription(); assert.deepEqual(pushSubscription(input), input);
  for (const endpoint of ['http://fcm.googleapis.com/test', 'https://127.0.0.1/test', 'https://localhost/test', 'https://fcm.googleapis.com.attacker.test/test', 'https://user:pass@fcm.googleapis.com/test', 'https://fcm.googleapis.com:8443/test']) assert.throws(() => pushSubscription({ ...input, endpoint }));
  for (const endpoint of ['https://updates.push.services.mozilla.com/wpush/v2/test', 'https://web.push.apple.com/test', 'https://example.notify.windows.com/test']) assert.equal(pushSubscription({ ...input, endpoint }).endpoint, endpoint);
  assert.throws(() => pushSubscription({ ...input, keys: { p256dh: 'bad', auth: 'bad' } }));
  assert.throws(() => pushSubscription({ ...input, keys: { ...input.keys, p256dh: Buffer.concat([Buffer.from([4]), Buffer.alloc(64)]).toString('base64url') } }));
});

test('default delivery builds an encrypted authenticated Web Push request without exposing agent text', async () => {
  const fixture = await herdrFixture(); const original = webpush.sendNotification; let request: ReturnType<typeof webpush.generateRequestDetails> | undefined;
  webpush.sendNotification = async (subscription, payload, options) => { request = webpush.generateRequestDetails(subscription, payload ?? undefined, options); return { statusCode: 201, body: '', headers: {} }; };
  const manager = new HerdrNotifications(fixture.directory + '/push', hash => hash === ownerHash);
  try {
    const device = manager.subscribe(owner, subscription()); manager.addView(owner, device, randomUUID(), '', { session: '', socketPath: fixture.socketPath });
    await initialized(fixture.directory + '/push'); fixture.update(1, 'idle'); await until(() => !!request);
    assert.equal(request!.endpoint, 'https://fcm.googleapis.com/fcm/send/test-device');
    assert.equal(request!.headers['Content-Encoding'], 'aes128gcm'); assert.ok(String(request!.headers.Authorization).startsWith('vapid '));
    assert.equal(request!.headers.TTL, 3600); assert.equal(request!.headers.Urgency, 'high');
    assert.ok(Buffer.isBuffer(request!.body)); assert.ok(!request!.body!.includes(Buffer.from('Live Herdr terminal')));
  } finally { manager.dispose(); webpush.sendNotification = original; await fixture.close(); }
});

test('server watches send background alerts without a browser, suppress focused devices, and resume local watches after restart', async () => {
  const fixture = await herdrFixture(), directory = fixture.directory + '/push', sent: any[] = [];
  const send = async (_subscription: unknown, payload: string) => { sent.push(JSON.parse(payload)); };
  let manager = new HerdrNotifications(directory, hash => hash === ownerHash, send);
  try {
    const device = manager.subscribe(owner, subscription()), tabId = randomUUID();
    assert.throws(() => manager.addView(other, device, tabId, '', { session: '' }));
    manager.addView(owner, device, tabId, '', { session: '', socketPath: fixture.socketPath });
    await initialized(directory); assert.equal(sent.length, 0, 'Opening a connection is quiet');
    fixture.setScreen(1, '\x1b[32m• Updated the parser. All tests passed.\x1b[0m\n\nWorked for 12s\n\n╭────────────╮\n│ › ask again │\n╰────────────╯\nmodel · footer');
    fixture.update(1, 'idle'); await until(() => sent.length === 1);
    assert.equal(sent[0].body, 'Updated the parser. All tests passed.\n/workspace'); assert.equal(sent[0].title, 'tests'); assert.equal(sent[0].tabId, tabId); assert.equal(sent[0].terminalId, 'term_1');
    assert.equal(fixture.actions.filter(a => a.method === 'pane.read').at(-1).params.format, 'ansi', 'Notification previews use a passive read');
    const socket = new EventEmitter() as unknown as WebSocket;
    manager.setPresence(socket, owner, device, true);
    fixture.update(1, 'working'); await delay(180); fixture.update(1, 'blocked'); await delay(180);
    manager.acknowledge(owner, device, '', { session: '', socketPath: fixture.socketPath }, { terminalId: 'term_1', kind: 'request', sequence: fixture.snapshot.agents[1].state_change_seq });
    assert.equal(sent.length, 1, 'The focused app owns the sound instead');
    manager.setPresence(socket, owner, device, false);
    fixture.update(1, 'working'); await delay(180); fixture.update(1, 'blocked'); await until(() => sent.length === 2);
    assert.equal(sent[1].body, 'Updated the parser. All tests passed.\n/workspace');
    manager.setPresence(socket, owner, device, true);
    fixture.update(1, 'working'); await delay(180); fixture.update(1, 'idle'); await delay(180); assert.equal(sent.length, 2);
    socket.emit('close'); await until(() => sent.length === 3);
    manager.dispose();
    const stored = await readFile(directory + '/herdr-push.json', 'utf8');
    assert.ok(!stored.includes(owner)); assert.ok(!stored.includes('Live Herdr terminal')); assert.ok(!stored.includes('Updated the parser')); assert.equal((await stat(directory + '/push-keys.json')).mode & 0o777, 0o600);
    manager = new HerdrNotifications(directory, hash => hash === ownerHash, send);
    await delay(250); assert.equal(sent.length, 3, 'Restart does not replay old alerts');
    fixture.update(1, 'working'); await delay(180); fixture.update(1, 'idle'); await until(() => sent.length === 4);
    manager.removeView(owner, device, tabId);
    fixture.update(1, 'working'); await delay(180); fixture.update(1, 'idle'); await delay(180); assert.equal(sent.length, 4, 'Closing the connection stops notifications');
  } finally { manager.dispose(); await fixture.close(); }
});

test('expired push devices and revoked pairings stop receiving notifications', async () => {
  const fixture = await herdrFixture(), directory = fixture.directory + '/push'; let sends = 0, valid = true;
  const manager = new HerdrNotifications(directory, hash => valid && hash === ownerHash, async () => { sends++; throw { statusCode: 410 }; });
  try {
    const device = manager.subscribe(owner, subscription()), tabId = randomUUID(); manager.addView(owner, device, tabId, '', { session: '', socketPath: fixture.socketPath });
    await initialized(directory); fixture.update(1, 'idle'); await until(() => sends === 1);
    assert.throws(() => manager.addView(owner, device, tabId, '', { session: '' }));
    const next = manager.subscribe(owner, subscription()); manager.addView(owner, next, tabId, '', { session: '', socketPath: fixture.socketPath }); await delay(200);
    valid = false; fixture.update(1, 'working'); await delay(180); fixture.update(1, 'idle'); await delay(180); assert.equal(sends, 1);
  } finally { manager.dispose(); await fixture.close(); }
});
