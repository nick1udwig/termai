import { randomBytes } from 'node:crypto';
import { stripVTControlCharacters } from 'node:util';
import { MAX_READING_BYTES, readingMime } from './reading.ts';

interface Capture { id: string; name: string; data: Buffer; mime: string; pending: boolean; exitCode: number }
/** Session-owned snapshots survive browser reconnects, with bounded retention. */
export class ReadingCaptures {
  private entries = new Map<string, Capture>();
  private bytes = 0;
  add(name: string, data: Buffer, exitCode = 0) {
    if (data.length > MAX_READING_BYTES) throw new Error('Reading Mode output exceeds the 20 MB limit.');
    const mime = readingMime('', data);
    if (mime.startsWith('text/')) data = Buffer.from(stripVTControlCharacters(data.toString('utf8')));
    while (this.entries.size >= 16 || this.bytes + data.length > 64 * 1024 * 1024) this.remove(this.entries.keys().next().value!);
    const id = randomBytes(16).toString('hex');
    name = stripVTControlCharacters(name).replace(/[\x00-\x1f\x7f]/g, ' ').trim().slice(0, 180) || 'Command output';
    this.entries.set(id, { id, name, data, mime, pending: true, exitCode }); this.bytes += data.length;
    return { id, name, exitCode };
  }
  get(id: string) { const capture = this.entries.get(id); if (capture) capture.pending = false; return capture; }
  pending() { return [...this.entries.values()].filter(entry => entry.pending).map(({ id, name, exitCode }) => ({ id, name, exitCode })); }
  remove(id: string) { const entry = this.entries.get(id); if (entry) this.bytes -= entry.data.length; this.entries.delete(id); }
  clear() { this.entries.clear(); this.bytes = 0; }
}
