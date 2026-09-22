import { opendir, stat } from 'node:fs/promises';
import { watch, type Dirent, type FSWatcher } from 'node:fs';
import type { DirectorySnapshot } from '../src/directory-data.ts';

export async function directoryVersion(dir: string): Promise<string> {
  const info = await stat(dir, { bigint: true }).catch(() => undefined);
  return info ? `${info.dev}:${info.ino}:${info.mtimeNs}:${info.ctimeNs}:${info.size}:${info.nlink}:${info.mode}` : '';
}

interface Listing { native: Dirent[]; snapshot: DirectorySnapshot; stamp?: string; watcher?: FSWatcher }
const cache = new Map<string, Listing>();
let cachedEntries = 0, generation = 0;
function remove(key: string) {
  const value = cache.get(key);
  if (value) { cachedEntries -= value.native.length; value.watcher?.close(); cache.delete(key); }
}
/** Cache immutable listings, checking inode and timestamps on every use. */
async function listing(dir: string, limit: number, signal?: AbortSignal): Promise<Listing> {
  signal?.throwIfAborted();
  const empty = (): Listing => ({ native: [], snapshot: { version: '', entries: [], complete: false } });
  if (limit <= 0) return empty();
  const key = JSON.stringify([dir, limit]), version = await directoryVersion(dir);
  signal?.throwIfAborted();
  const previous = cache.get(key);
  if (previous) {
    if (version && previous.stamp === version) {
      cache.delete(key); cache.set(key, previous); return previous;
    }
    remove(key);
  }
  if (!version) return empty();
  const entries: Dirent[] = [];
  let complete = true;
  try {
    const handle = await opendir(dir, { bufferSize: Math.min(512, limit) });
    for await (const entry of handle) {
      signal?.throwIfAborted();
      entries.push(entry);
      if (entries.length >= limit) { complete = false; break; }
    }
  } catch { signal?.throwIfAborted(); return empty(); }
  entries.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
  const stable = version === await directoryVersion(dir);
  signal?.throwIfAborted();
  const value: Listing = { native: entries, stamp: version, snapshot: { version: stable ? version + ':' + ++generation : '', complete,
    entries: entries.map(entry => ({ name: entry.name, directory: entry.isDirectory(), symlink: entry.isSymbolicLink() })) } };
  if (stable) {
    // A simultaneous reader may have populated this key while enumeration awaited I/O.
    remove(key);
    try {
      value.watcher = watch(dir, { persistent: false }, () => { if (cache.get(key) === value) remove(key); });
      value.watcher.on('error', () => { if (cache.get(key) === value) remove(key); });
    } catch { /* Metadata checks remain available on filesystems without watches. */ }
    cache.set(key, value); cachedEntries += entries.length;
    while (cache.size > 64 || cachedEntries > 40000) {
      const oldest = cache.keys().next().value!;
      remove(oldest);
    }
  }
  return value;
}

/** Bound both enumeration and internal buffering, including huge directories. */
export async function directoryEntries(dir: string, limit: number, signal?: AbortSignal): Promise<Dirent[]> {
  return (await listing(dir, limit, signal)).native;
}
export async function directorySnapshot(dir: string, limit: number, signal?: AbortSignal): Promise<DirectorySnapshot> {
  return (await listing(dir, limit, signal)).snapshot;
}
export async function directoryFacts(dir: string, limit: number, signal?: AbortSignal) {
  return (await directorySnapshot(dir, limit, signal)).entries;
}
