import { open, stat } from 'node:fs/promises';
import path from 'node:path';
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
export async function readHistory(file: string, limit = 2 * 1024 * 1024): Promise<string[]> {
  let handle;
  try {
    handle = await open(file, 'r');
    const info = await handle.stat();
    if (!info.isFile()) return [];
    const start = Math.max(0, info.size - limit), buffer = Buffer.alloc(Math.min(info.size, limit));
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, start);
    const lines = buffer.subarray(0, bytesRead).toString('utf8').split('\n');
    if (start) lines.shift();
    return lines.filter(line => line.trim() && !/^#\d+$/.test(line) && !/^\s/.test(line) && line.length <= 2000).slice(-5000);
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
  return [...new Set(contents.flat().reverse())].reverse().slice(-5000);
}
