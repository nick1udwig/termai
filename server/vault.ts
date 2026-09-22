import { randomBytes, randomUUID, createCipheriv, createDecipheriv, createHash, scrypt } from 'node:crypto';
import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import path from 'node:path';
import ssh2 from 'ssh2';
const { utils } = ssh2;
import type { KeyInfo, KnownHost, KeyReference } from '../src/connections.ts';
type StoredKey = KeyInfo & ({ reference?: undefined; salt: string; iv: string; tag: string; ciphertext: string } | { reference: KeyReference });
interface Data { keys: StoredKey[]; knownHosts: KnownHost[] }
const derive = (passphrase: string, salt: Buffer, length: number) => new Promise<Buffer>((resolve, reject) => scrypt(passphrase, salt, length, { N: 32768, maxmem: 64 * 1024 * 1024 }, (error, key) => error ? reject(error) : resolve(key)));
export const fingerprint = (key: Buffer) => 'SHA256:' + createHash('sha256').update(key).digest('base64').replace(/=+$/, '');
function password(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !value.length) throw new Error('Enter a key passphrase.');
}
/** Inspect only: browser imports can be validated without saving them here. */
export function inspectPrivateKey(raw: unknown, passphrase: unknown) {
  password(passphrase);
  if (typeof raw !== 'string' || !raw || raw.length > 20000) throw new Error('Invalid private key.');
  const result = utils.parseKey(raw, passphrase), parsed = Array.isArray(result) ? result.length === 1 ? result[0] : new Error() : result;
  if (parsed instanceof Error || !parsed.isPrivateKey()) throw new Error('Cannot unlock this private key. Check its passphrase and format.');
  return { publicKey: parsed.type + ' ' + parsed.getPublicSSH().toString('base64'), fingerprint: fingerprint(parsed.getPublicSSH()) };
}
export class Vault {
  private directory: string;
  private queue: Promise<unknown> = Promise.resolve();
  constructor(directory: string) { this.directory = directory; }
  private async load(): Promise<Data> {
    try { return JSON.parse(await readFile(path.join(this.directory, 'vault.json'), 'utf8')); }
    catch (error: any) { if (error.code === 'ENOENT') return { keys: [], knownHosts: [] }; throw error; }
  }
  private change<T>(fn: (data: Data) => T | Promise<T>): Promise<T> {
    const task = this.queue.then(async () => {
      const data = await this.load(), result = await fn(data);
      await mkdir(this.directory, { recursive: true, mode: 0o700 });
      const file = path.join(this.directory, 'vault.json'), temp = file + '.' + randomUUID();
      await writeFile(temp, JSON.stringify(data), { mode: 0o600, flag: 'wx' }); await rename(temp, file); return result;
    });
    this.queue = task.catch(() => {}); return task;
  }
  async list() {
    await this.queue;
    const data = await this.load();
    return { keys: data.keys.map(({ id, name, publicKey, fingerprint, createdAt, reference }): KeyInfo => ({ id, name, publicKey, fingerprint, createdAt, ...(reference ? { reference } : {}) })), knownHosts: data.knownHosts };
  }
  async create(name: unknown, passphrase: unknown, privateKey?: unknown, replaceId?: string) {
    password(passphrase);
    if (typeof name !== 'string' || !name.trim() || name.length > 100) throw new Error('Name the SSH key (up to 100 characters).');
    if (privateKey !== undefined && (typeof privateKey !== 'string' || privateKey.length > 20000)) throw new Error('Invalid private key.');
    const raw = privateKey || await new Promise<string>((resolve, reject) => utils.generateKeyPair('ed25519', {}, (error, pair) => error ? reject(error) : resolve(pair.private)));
    const metadata = inspectPrivateKey(raw, passphrase);
    const salt = randomBytes(16), iv = randomBytes(12), key = await derive(passphrase, salt, 32) as Buffer;
    const cipher = createCipheriv('aes-256-gcm', key, iv), plaintext = Buffer.from(raw as string);
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]); key.fill(0); plaintext.fill(0);
    const info: StoredKey = { id: randomUUID(), name: name.trim(), ...metadata, createdAt: new Date().toISOString(), salt: salt.toString('base64'), iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), ciphertext: ciphertext.toString('base64') };
    await this.change(data => {
      const index = replaceId ? data.keys.findIndex(key => key.id === replaceId) : -1;
      if (index >= 0) {
        if (data.keys[index].reference) throw new Error('A key reference cannot be overwritten with a stored key.');
        if (data.keys[index].fingerprint !== info.fingerprint) throw new Error('This backup belongs to a different SSH key.');
        info.id = data.keys[index].id; data.keys[index] = info;
      } else { if (data.keys.length >= 64) throw new Error('The keychain holds up to 64 keys.'); data.keys.push(info); }
    });
    return (await this.list()).keys.find(key => key.id === info.id)!;
  }
  async reference(name: string, info: Pick<KeyInfo, 'publicKey' | 'fingerprint'>, reference: KeyReference): Promise<KeyInfo> {
    if (!path.isAbsolute(reference.path) || !['file', 'agent'].includes(reference.type)) throw new Error('Invalid SSH key reference.');
    return this.change(data => {
      const existing = data.keys.find(key => key.fingerprint === info.fingerprint && key.reference?.type === reference.type && key.reference.path === reference.path);
      if (existing) return existing;
      if (data.keys.length >= 64) throw new Error('The keychain holds up to 64 keys.');
      const key: StoredKey = { id: randomUUID(), name: name.slice(0, 100), publicKey: info.publicKey, fingerprint: info.fingerprint,
        reference: { type: reference.type, path: reference.path }, createdAt: new Date().toISOString() };
      data.keys.push(key); return key;
    });
  }
  async unlock(id: string, passphrase: unknown): Promise<Buffer> {
    password(passphrase); await this.queue;
    const item = (await this.load()).keys.find(key => key.id === id);
    if (!item) throw new Error('SSH key not found on this backend.');
    if (item.reference) throw new Error('This key is an external reference. Export it from its original location.');
    const key = await derive(passphrase, Buffer.from(item.salt, 'base64'), 32) as Buffer;
    try {
      const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(item.iv, 'base64')); decipher.setAuthTag(Buffer.from(item.tag, 'base64'));
      return Buffer.concat([decipher.update(Buffer.from(item.ciphertext, 'base64')), decipher.final()]);
    } catch { throw new Error('Incorrect key passphrase.'); } finally { key.fill(0); }
  }
  async remove(id: string) { await this.change(data => { data.keys = data.keys.filter(key => key.id !== id); }); }
  async rename(id: string, name: string) {
    if (!name.trim() || name.length > 100) throw new Error('Enter a key name.');
    await this.change(data => { const key = data.keys.find(key => key.id === id); if (!key) throw new Error('Key not found.'); key.name = name.trim(); });
  }
  async trust(host: string, port: number, value: string) {
    await this.change(data => {
      const existing = data.knownHosts.find(item => item.host === host && item.port === port);
      if (existing && existing.fingerprint !== value) throw new Error('Host key changed. Remove its known-host entry only after verifying the new fingerprint.');
      if (!existing) { if (data.knownHosts.length >= 1000) throw new Error('Known-host limit reached.'); data.knownHosts.push({ host, port, fingerprint: value }); }
    });
  }
  async forget(host: string, port: number) { await this.change(data => { data.knownHosts = data.knownHosts.filter(item => item.host !== host || item.port !== port); }); }
}
