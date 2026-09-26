import { randomBytes } from 'node:crypto';
import { unlink } from 'node:fs/promises';
import path from 'node:path';
import type { FileHost } from './files.ts';
import type { TransferRequest } from '../src/transfer-protocol.ts';

export type TransferEvent = { action: 'upload' | 'download'; path: string } | { action: 'capture'; file: string; name: string };
export function parseTransfer(record: string[]): TransferEvent | undefined {
  if (['transfer-upload', 'transfer-download'].includes(record[0]) && record.length === 2) {
    const file = Buffer.from(record[1], 'base64').toString('utf8');
    if (file.startsWith('/') && file.length <= 4096 && !file.includes('\0')) return { action: record[0] === 'transfer-upload' ? 'upload' : 'download', path: file };
  }
  if (record[0] === 'transfer-capture' && record.length === 3 && /^download\.[a-zA-Z0-9]{8}$/.test(record[1])) {
    const name = Buffer.from(record[2], 'base64').toString('utf8');
    if (name && name !== '.' && name !== '..' && !/[/\\\x00-\x1f\x7f]/.test(name) && Buffer.byteLength(name) <= 255) return { action: 'capture', file: record[1], name };
  }
}
interface Pending { request: TransferRequest; capture: boolean; pending: boolean; timer: ReturnType<typeof setTimeout> }
/** Requests survive terminal reconnects; captured pipes stay on disk and expire. */
export class Transfers {
  private entries = new Map<string, Pending>();
  private host: FileHost;
  constructor(host: FileHost) { this.host = host; }
  add(event: TransferEvent, directory: string) {
    while (this.entries.size >= 16) this.remove(this.entries.keys().next().value!);
    const id = randomBytes(16).toString('hex');
    const file = event.action === 'capture' ? path.posix.join(directory, event.file) : event.path;
    const request: TransferRequest = { id, action: event.action === 'upload' ? 'upload' : 'download', path: file, name: event.action === 'capture' ? event.name : path.posix.basename(file) };
    const timer = setTimeout(() => this.remove(id), 15 * 60 * 1000); timer.unref();
    this.entries.set(id, { request, capture: event.action === 'capture', pending: true, timer }); return request;
  }
  get(id: string) { return this.entries.get(id)?.request; }
  acknowledge(id: string) { const item = this.entries.get(id); if (item) item.pending = false; }
  pending() { return [...this.entries.values()].filter(item => item.pending).map(item => item.request); }
  remove(id: string) {
    const item = this.entries.get(id); if (!item) return;
    clearTimeout(item.timer); this.entries.delete(id);
    if (item.capture) {
      if (this.host.remote) this.host.remote.files.unlink(item.request.path, () => {});
      else void unlink(item.request.path).catch(() => {});
    }
  }
  clear() { for (const id of this.entries.keys()) this.remove(id); }
}
