import { createHash, randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, renameSync, rmSync } from 'node:fs';
import path from 'node:path';

/** Keep the generated pairing token across restarts; never start without one. */
export function pairingToken(directory: string, configured?: string): string {
  const validate = (token: string) => {
    if (token.length < 24 || token.trim() !== token || /[\r\n]/.test(token)) {
      throw new Error('The pairing token must contain at least 24 characters with no surrounding whitespace. Check TERMAI_TOKEN or pairing-token in TERMAI_DATA_DIR.');
    }
    return token;
  };
  if (configured) return validate(configured);
  const file = path.join(directory, 'pairing-token');
  try { return validate(readFileSync(file, 'utf8').trimEnd()); }
  catch (error: any) { if (error.code !== 'ENOENT') throw error; }
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const token = randomBytes(32).toString('hex');
  try { writeFileSync(file, token + '\n', { flag: 'wx', mode: 0o600 }); }
  catch (error: any) {
    if (error.code !== 'EEXIST') throw error;
    return validate(readFileSync(file, 'utf8').trimEnd());
  }
  return token;
}

const digest = (value: string) => createHash('sha256').update(value).digest('hex');
/** Only credential hashes are persisted. Rotating the pairing code revokes them. */
export class Pairings {
  private directory: string;
  private file: string;
  private tokenHash: string;
  private credentials = new Set<string>();
  constructor(directory: string, token: string) {
    this.directory = directory; this.file = path.join(directory, 'paired-clients.json'); this.tokenHash = digest(token);
    let stored;
    try { stored = JSON.parse(readFileSync(this.file, 'utf8')); }
    catch (error: any) { if (error.code === 'ENOENT') return; throw error; }
    if (!stored || stored.version !== 1 || typeof stored.tokenHash !== 'string' || !/^[a-f0-9]{64}$/.test(stored.tokenHash) || !Array.isArray(stored.credentials) ||
      stored.credentials.length > 256 || !stored.credentials.every((value: unknown) => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value))) {
      throw new Error('Invalid paired-clients.json. Restore it or remove it to revoke saved pairings.');
    }
    if (stored.tokenHash === this.tokenHash) this.credentials = new Set(stored.credentials);
    else this.save(new Set());
  }
  get size() { return this.credentials.size; }
  has(credential: string): boolean { return /^[a-f0-9]{64}$/.test(credential) && this.credentials.has(digest(credential)); }
  hasDigest(hash: string): boolean { return this.credentials.has(hash); }
  issue(): string {
    if (this.size >= 256) throw new Error('The saved pairing limit has been reached. Revoke old pairings before adding more.');
    const credential = randomBytes(32).toString('hex');
    const next = new Set(this.credentials); next.add(digest(credential)); this.save(next); this.credentials = next;
    return credential;
  }
  private save(credentials: Set<string>) {
    mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    const temporary = this.file + '.' + randomBytes(8).toString('hex');
    try {
      writeFileSync(temporary, JSON.stringify({ version: 1, tokenHash: this.tokenHash, credentials: [...credentials] }), { flag: 'wx', mode: 0o600 });
      renameSync(temporary, this.file);
    } finally { rmSync(temporary, { force: true }); }
  }
}
