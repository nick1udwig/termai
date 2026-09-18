import { opendir } from 'node:fs/promises';
import type { Dirent } from 'node:fs';

/** Bound enumeration and allocation, including the directory reader's internal buffer. */
export async function directoryEntries(dir: string, limit: number, signal?: AbortSignal): Promise<Dirent[]> {
  signal?.throwIfAborted();
  if (limit <= 0) return [];
  const entries: Dirent[] = [];
  try {
    const handle = await opendir(dir, { bufferSize: Math.min(32, limit) });
    for await (const entry of handle) {
      signal?.throwIfAborted();
      entries.push(entry);
      if (entries.length >= limit) break;
    }
  } catch { signal?.throwIfAborted(); }
  return entries.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
}
