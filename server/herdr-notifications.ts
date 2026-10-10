import { createHash, ECDH, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import path from 'node:path';
import webpush from 'web-push';
import type { WebSocket } from 'ws';
import { HerdrConnection, type HerdrTarget } from './herdr.ts';
import { HerdrState, type HerdrNotification } from '../src/herdr-state.ts';
import type { HerdrSnapshot } from '../src/herdr-protocol.ts';
import { agentResponsePreview, notificationBody } from './herdr-notification-preview.ts';

const hash = (value: string) => createHash('sha256').update(value).digest('hex');
interface View { id: string; session: string; source: string; socketPath?: string; remote: boolean }
interface Device { id: string; owner: string; subscription: webpush.PushSubscription; views: View[] }
type Checkpoint = ReturnType<HerdrState['checkpoint']>;
interface Watch { tracker: HerdrState; connection: HerdrConnection }

/** Push endpoints must belong to a browser push service, never an arbitrary
 * URL supplied by a paired client (including private-network destinations). */
export function pushSubscription(value: unknown): webpush.PushSubscription {
  const input = value as any;
  if (!input || typeof input.endpoint !== 'string' || input.endpoint.length > 4096) throw new Error('Invalid push subscription.');
  const url = new URL(input.endpoint);
  const host = url.hostname;
  const provider = host === 'fcm.googleapis.com' || host === 'updates.push.services.mozilla.com' || host.endsWith('.push.services.mozilla.com') || host === 'web.push.apple.com' || host.endsWith('.push.apple.com') || host.endsWith('.notify.windows.com');
  if (!provider || url.protocol !== 'https:' || url.port && url.port !== '443' || url.username || url.password || url.hash) throw new Error('Unsupported browser push service.');
  const keys = input.keys;
  if (!keys || typeof keys.p256dh !== 'string' || typeof keys.auth !== 'string' || !/^[A-Za-z0-9_-]+={0,2}$/.test(keys.p256dh) || !/^[A-Za-z0-9_-]+={0,2}$/.test(keys.auth) || Buffer.from(keys.p256dh, 'base64url').length !== 65 || Buffer.from(keys.p256dh, 'base64url')[0] !== 4 || Buffer.from(keys.auth, 'base64url').length !== 16) throw new Error('Invalid push encryption keys.');
  try { ECDH.convertKey(Buffer.from(keys.p256dh, 'base64url'), 'prime256v1'); } catch { throw new Error('Invalid push encryption key.'); }
  return { endpoint: url.href, keys: { p256dh: keys.p256dh, auth: keys.auth } };
}

/** Runs independently of browser connections, including when a PWA is asleep.
 * Stored credentials are pairing digests; SSH keys and terminal output are never
 * saved here. Local watches resume after restart; SSH watches need reconnection. */
export class HerdrNotifications {
  readonly publicKey: string;
  private directory: string;
  private devices = new Map<string, Device>();
  private watches = new Map<string, Watch>();
  private checkpoints: Record<string, Checkpoint> = {};
  private presence = new Map<WebSocket, { owner: string; device: string; focused: boolean; until: number }>();
  private send: (subscription: webpush.PushSubscription, payload: string) => Promise<unknown>;
  private validOwner: (hash: string) => boolean;
  private saveTimer?: ReturnType<typeof setTimeout>;
  private stopped = false;
  private pending = 0;
  private acknowledgements = new Map<string, number>();
  constructor(directory: string, validOwner: (hash: string) => boolean, send?: HerdrNotifications['send'], contact = 'https://example.com/termai') {
    this.directory = directory; this.validOwner = validOwner;
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    let keys: ReturnType<typeof webpush.generateVAPIDKeys>;
    try { keys = JSON.parse(readFileSync(path.join(directory, 'push-keys.json'), 'utf8')); }
    catch (error: any) {
      if (error.code !== 'ENOENT') throw error;
      keys = webpush.generateVAPIDKeys(); this.write('push-keys.json', keys);
    }
    const details = { subject: process.env.TERMAI_PUSH_CONTACT || contact, ...keys };
    // Validate before accepting subscriptions, without sending anything.
    webpush.getVapidHeaders('https://fcm.googleapis.com', details.subject, keys.publicKey, keys.privateKey, 'aes128gcm');
    this.publicKey = keys.publicKey;
    this.send = send || ((subscription, payload) => webpush.sendNotification(subscription, payload, { vapidDetails: details, TTL: 3600, urgency: 'high', timeout: 10000 }));
    let stored;
    try { stored = JSON.parse(readFileSync(path.join(directory, 'herdr-push.json'), 'utf8')); }
    catch (error: any) { if (error.code !== 'ENOENT') throw error; }
    if (stored) {
      if (stored.version !== 1 || !Array.isArray(stored.devices) || stored.devices.length > 256) throw new Error('Invalid herdr-push.json.');
      this.checkpoints = stored.checkpoints || {};
      for (const device of stored.devices as Device[]) {
        if (!validOwner(device.owner)) continue;
        device.subscription = pushSubscription(device.subscription);
        if (!Array.isArray(device.views) || device.views.length > 16 || !device.views.every(view => typeof view.id === 'string' && typeof view.session === 'string' && typeof view.source === 'string')) throw new Error('Invalid saved Herdr notification watches.');
        this.devices.set(device.id, device);
        for (const view of device.views) if (!view.remote) this.watch(device.owner, view, { session: view.session, socketPath: view.socketPath });
      }
    }
    this.prune();
  }
  private write(name: string, value: unknown) {
    const file = path.join(this.directory, name), temporary = file + '.tmp';
    writeFileSync(temporary, JSON.stringify(value), { mode: 0o600 }); renameSync(temporary, file);
  }
  private save() {
    if (this.saveTimer || this.stopped) return;
    this.saveTimer = setTimeout(() => { this.saveTimer = undefined; this.flush(); }, 100); this.saveTimer.unref();
  }
  private flush() {
    this.write('herdr-push.json', { version: 1, devices: [...this.devices.values()], checkpoints: this.checkpoints });
  }
  subscribe(owner: string, input: unknown) {
    const ownerHash = hash(owner), subscription = pushSubscription(input);
    let device = [...this.devices.values()].find(device => device.owner === ownerHash && device.subscription.endpoint === subscription.endpoint);
    if (!device) {
      if (this.devices.size >= 256) throw new Error('The notification device limit has been reached.');
      device = { id: randomUUID(), owner: ownerHash, subscription, views: [] }; this.devices.set(device.id, device);
    } else device.subscription = subscription;
    this.save(); return device.id;
  }
  private device(owner: string, id: unknown) {
    const device = typeof id === 'string' ? this.devices.get(id) : undefined;
    if (!device || device.owner !== hash(owner)) throw new Error('Enable notifications on this device first.');
    return device;
  }
  addView(owner: string, id: unknown, viewId: unknown, source: string, target: HerdrTarget) {
    const device = this.device(owner, id);
    if (typeof viewId !== 'string' || !/^[a-f0-9-]{36}$/.test(viewId)) throw new Error('Invalid notification tab.');
    const view = { id: viewId, source, session: target.session, socketPath: target.socketPath, remote: !!target.remote };
    if (!device.views.some(view => view.id === viewId) && device.views.length >= 16) throw new Error('At most 16 Herdr tabs can send notifications per device.');
    this.watch(device.owner, view, target);
    device.views = [...device.views.filter(view => view.id !== viewId), view]; this.prune(); this.save();
  }
  removeView(owner: string, id: unknown, viewId: unknown) {
    const device = this.device(owner, id); device.views = device.views.filter(view => view.id !== viewId); this.prune(); this.save();
  }
  removeSource(owner: string, source: string) {
    for (const device of this.devices.values()) if (device.owner === hash(owner)) device.views = device.views.filter(view => view.source !== source);
    this.prune(); this.save();
  }
  unsubscribe(owner: string, id: unknown) { this.devices.delete(this.device(owner, id).id); this.prune(); this.save(); }
  setPresence(ws: WebSocket, owner: string, id: unknown, focused: boolean) {
    const device = this.device(owner, id);
    if (!this.presence.has(ws)) ws.once('close', () => this.presence.delete(ws));
    this.presence.set(ws, { owner: device.owner, device: device.id, focused, until: Date.now() + 45000 });
  }
  acknowledge(owner: string, id: unknown, source: string, target: HerdrTarget, event: HerdrNotification) {
    const device = this.device(owner, id);
    if (typeof event.terminalId !== 'string' || event.terminalId.length > 256 || !['done', 'request'].includes(event.kind) || !Number.isSafeInteger(event.sequence)) return;
    const key = this.key(device.owner, { id: '', source, session: target.session, socketPath: target.socketPath, remote: !!target.remote });
    this.acknowledgements.set(this.receipt(device.id, key, event), Date.now() + 60000);
    for (const [key, until] of this.acknowledgements) if (until < Date.now() || this.acknowledgements.size > 1024) this.acknowledgements.delete(key);
  }
  private receipt(device: string, key: string, event: HerdrNotification) { return JSON.stringify([device, key, event.terminalId, event.kind, event.sequence]); }
  private focused(device: Device) {
    return [...this.presence.values()].some(p => p.owner === device.owner && p.device === device.id && p.focused && p.until > Date.now());
  }
  private key(owner: string, view: View) { return JSON.stringify([owner, view.source, view.session, view.socketPath || '']); }
  private watch(owner: string, view: View, target: HerdrTarget) {
    const key = this.key(owner, view); if (this.watches.has(key)) return;
    if (this.watches.size >= 64) throw new Error('The notification connection limit has been reached.');
    const tracker = new HerdrState(this.checkpoints[key]);
    const connection = new HerdrConnection(message => {
      if (message.type !== 'snapshot' || this.stopped) return;
      for (const event of tracker.update(message.snapshot)) this.notify(key, event, message.snapshot, target);
      const checkpoint = tracker.checkpoint();
      if (JSON.stringify(this.checkpoints[key]) !== JSON.stringify(checkpoint)) { this.checkpoints[key] = checkpoint; this.save(); }
    }, target);
    this.watches.set(key, { tracker, connection });
  }
  private notify(key: string, event: HerdrNotification, snapshot: HerdrSnapshot, target: HerdrTarget) {
    const agent = snapshot.agents.find(agent => agent.terminalId === event.terminalId); if (!agent) return;
    let preview: Promise<string> | undefined;
    for (const device of this.devices.values()) {
      const view = device.views.find(view => this.key(device.owner, view) === key);
      if (!view || !this.validOwner(device.owner) || this.pending >= 128) continue;
      const payload = async () => JSON.stringify({ title: agent.name, body: notificationBody(agent.cwd, await (preview ||= agentResponsePreview(target, agent))), tag: 'herdr-' + hash(key + event.terminalId + event.kind).slice(0, 32), tabId: view.id, terminalId: event.terminalId });
      this.pending++;
      void this.deliver(device, key, this.receipt(device.id, key, event), payload).finally(() => this.pending--);
    }
  }
  private async deliver(device: Device, key: string, receipt: string, payload: () => Promise<string>) {
    const live = () => !this.stopped && this.devices.has(device.id) && this.validOwner(device.owner) && device.views.some(view => this.key(device.owner, view) === key);
    const acknowledged = () => (this.acknowledgements.get(receipt) || 0) > Date.now();
    const delay = (ms: number) => new Promise<void>(resolve => { const timer = setTimeout(resolve, ms); timer.unref(); });
    // Give foreground delivery time to acknowledge the sound. If a browser is
    // frozen or its network vanishes, let its focus lease expire and send push
    // instead of losing the event under stale presence information.
    await delay(300);
    while (live() && this.focused(device) && !acknowledged()) await delay(1000);
    if (!live() || acknowledged()) return;
    const message = await payload();
    while (live() && this.focused(device) && !acknowledged()) await delay(1000);
    if (!live() || acknowledged()) return;
    // Retry transient service failures; a revoked/expired subscription is removed.
    for (let attempt = 0; attempt < 3 && live() && !acknowledged() && !this.focused(device); attempt++) {
      try { await this.send(device.subscription, message); return; }
      catch (error: any) {
        if (error.statusCode === 404 || error.statusCode === 410) { this.devices.delete(device.id); this.prune(); this.save(); return; }
        if (error.statusCode && error.statusCode < 500 && error.statusCode !== 429) return;
        if (attempt < 2) await delay((attempt + 1) * 15000);
      }
    }
  }
  private prune() {
    const live = new Set([...this.devices.values()].flatMap(device => device.views.map(view => this.key(device.owner, view))));
    for (const [key, watch] of this.watches) if (!live.has(key)) { watch.connection.dispose(); this.watches.delete(key); delete this.checkpoints[key]; }
    for (const key of Object.keys(this.checkpoints)) if (!live.has(key)) delete this.checkpoints[key];
  }
  dispose() {
    if (this.stopped) return; this.stopped = true; clearTimeout(this.saveTimer);
    for (const watch of this.watches.values()) watch.connection.dispose(); this.presence.clear(); this.flush();
  }
}
