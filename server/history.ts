import { open, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
export const HISTORY_ENTRIES = 5000;
export const HISTORY_BYTES = 2 * 1024 * 1024;

/** Readline prefers eternal history; explicit overrides never fall back. */
export async function readlineHistorySource(env: NodeJS.ProcessEnv = process.env,
  isFile = async (file: string) => !!(await stat(file).catch(() => undefined))?.isFile()): Promise<string> {
  if (env.TERMAI_HISTORY_FILE) return env.TERMAI_HISTORY_FILE;
  if (env.TERMAI_ETERNAL_HISTORY_FILE) return env.TERMAI_ETERNAL_HISTORY_FILE;
  const home = env.HOME || os.homedir(), eternal = path.join(home, '.bash_eternal_history');
  return await isFile(eternal) ? eternal : path.join(home, '.bash_history');
}

export function historyLines(raw: string, partial = false): string[] {
  const lines = raw.split('\n');
  if (partial) lines.shift();
  return lines.filter(line => line.trim() && !/^#\d+$/.test(line) && !/^\s/.test(line) && line.length <= 2000).slice(-HISTORY_ENTRIES);
}

const sourcesCache = new Map<string, { stamp: string; lines: Promise<string[]> }>();
async function cachedHistory(file: string) {
  const info = await stat(file).catch(() => undefined);
  if (!info?.isFile()) { sourcesCache.delete(file); return []; }
  const stamp = `${info.ino}:${info.mtimeMs}:${info.size}`;
  const cached = sourcesCache.get(file);
  if (cached?.stamp === stamp) return cached.lines;
  const lines = readHistory(file);
  if (sourcesCache.size >= 32) sourcesCache.delete(sourcesCache.keys().next().value!);
  sourcesCache.set(file, { stamp, lines });
  return lines;
}

/** Read bounded tails rather than skipping large eternal-history files. */
export async function readHistory(file: string, limit = HISTORY_BYTES): Promise<string[]> {
  let handle;
  try {
    handle = await open(file, 'r');
    const info = await handle.stat();
    if (!info.isFile()) return [];
    const start = Math.max(0, info.size - limit), buffer = Buffer.alloc(Math.min(info.size, limit));
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, start);
    return historyLines(buffer.subarray(0, bytesRead).toString('utf8'), start > 0);
  } catch { return []; }
  finally { await handle?.close(); }
}
export async function historySources(env: NodeJS.ProcessEnv = process.env): Promise<string[]> {
  const home = env.HOME || '';
  // An explicit override also isolates tests/custom installations from host history.
  const files = env.TERMAI_HISTORY_FILE ? [env.TERMAI_HISTORY_FILE, env.TERMAI_ETERNAL_HISTORY_FILE] : [
    path.join(home, '.bash_history'), path.join(home, '.bash_eternal_history'), env.TERMAI_ETERNAL_HISTORY_FILE,
    env.TERMAI_REAL_HISTFILE || env.HISTFILE,
  ];
  const sources = [...new Set(files.filter((file): file is string => !!file && file !== '/dev/null'))];
  const contents = await Promise.all(sources.map(cachedHistory));
  // Preserve the latest occurrence when files overlap, without counting copied history twice.
  return [...new Set(contents.flat().reverse())].reverse().slice(-HISTORY_ENTRIES);
}
