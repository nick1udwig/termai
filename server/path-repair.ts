import path from 'node:path';
import type { DirectoryHost as EngineHost } from '../src/directory-data.ts';
import { directoryHost as host } from './directory-host.ts';
import type { Candidate, Catalog } from '../src/protocol.ts';
import { shellQuote, similarityIndex } from './repair.ts';
import { expandSymbols } from './speech.ts';

const indexes = new WeakMap<object, ReturnType<typeof similarityIndex>>();
function componentMatches(spoken: string, entries: Awaited<ReturnType<EngineHost['entries']>>) {
  let index = indexes.get(entries);
  if (!index) {
    index = similarityIndex(entries.filter(entry => entry.directory || entry.symlink).map(entry => entry.name));
    indexes.set(entries, index);
  }
  const byName = new Map(entries.map(entry => [entry.name, entry]));
  return index(spoken).map(({ value, score }) => {
    const a = spoken.toLowerCase(), b = value.toLowerCase();
    if (!score && a.length >= 3 && a.length === b.length && [...a].filter((char, i) => char !== b[i]).length === 1) score = 62;
    return { entry: byName.get(value)!, score };
  });
}
/** Walk only the requested path, retaining actual directory names at each step.
 * No shell evaluation, recursive filesystem scan, or transcript execution. */
export async function repairDirectory(input: string, catalog: Catalog, home: string, signal?: AbortSignal): Promise<Candidate[] | undefined> {
  signal?.throwIfAborted();
  const expanded = expandSymbols(input).trim();
  const match = expanded.match(/^(cd|pushd)\s+(.*)$/i);
  if (!match || !catalog.commands.includes(match[1].toLowerCase())) return undefined;
  let target = match[2].trim(), options = '';
  const optionMatch = target.match(/^((?:(?:-[LPe]+|--)\s+)+)(.+)$/);
  if (optionMatch) { options = optionMatch[1]; target = optionMatch[2]; }
  if (!target || target === '-' || /[|&;<>`$\\\n\r]/.test(target) || /^-/.test(target)) return undefined;
  const quoted = /^("[^"]*"|'[^']*')$/.test(target);
  if (/["']/.test(target) && !quoted) return undefined;
  if (quoted) target = target.slice(1, -1);
  if (!quoted) target = target.replace(/\s*\/\s*/g, '/');
  const fromHome = !quoted && (target === '~' || target.startsWith('~/'));
  const absolute = target.startsWith('/');
  if (fromHome && !home) return undefined;
  const start = fromHome ? home : absolute ? '/' : catalog.cwd;
  const prefix = fromHome ? '~/' : absolute ? '/' : '';
  const parts = (fromHome ? target.slice(1) : target).split('/').filter(Boolean);
  if (parts.length > 16 || target.length > 2000) return undefined;
  type Branch = { actual: string; rendered: string; score: number };
  let branches: Branch[] = [{ actual: start, rendered: prefix, score: 0 }];
  const lookups = new Map<string, ReturnType<EngineHost['lookup']>>();
  const readLookup = (file: string) => {
    if (!lookups.has(file)) lookups.set(file, host.lookup(file, signal));
    return lookups.get(file)!;
  };
  const stats = new Map<string, ReturnType<EngineHost['stat']>>();
  const readStat = (file: string) => {
    if (!stats.has(file)) stats.set(file, host.stat(file, signal));
    return stats.get(file)!;
  };
  const candidate = (branch: Branch): Candidate => {
    const rendered = branch.rendered === '/' ? '/' : branch.rendered.replace(/\/$/, '') || '.';
    const argument = quoted ? `'${rendered.replaceAll("'", "'\\''")}'` : shellQuote(rendered);
    return { command: `${match[1].toLowerCase()} ${options}${argument}`, score: 110 + branch.score / Math.max(1, parts.length), changes: ['Path verified against existing directories'] };
  };
  // Exact ordinary paths take one lookup regardless of depth. Start the first
  // component too, so a miss does not add another sequential network request.
  if (parts.length > 1 && !parts.some(part => part === '.' || part === '..')) {
    const [whole] = await Promise.all([readStat(path.join(start, ...parts)), readLookup(path.join(start, parts[0]))]);
    if (whole) return whole.directory ? [candidate({ actual: '', rendered: prefix + parts.join('/'), score: 100 * parts.length })] : [];
  }
  const deadline = Date.now() + 1000;
  let reads = 0;
  for (const part of parts) {
    const groups = await Promise.all(branches.map(async branch => {
      const next: Branch[] = [];
      signal?.throwIfAborted();
      if (Date.now() > deadline || reads++ >= 48) return next;
      if (part === '.' || part === '..') {
        next.push({ actual: path.resolve(branch.actual, part), rendered: branch.rendered + part + '/', score: branch.score + 100 }); return next;
      }
      const actual = path.join(branch.actual, part);
      const { info, listing } = await readLookup(actual);
      if (info) {
        if (info.directory) next.push({ actual, rendered: branch.rendered + part + '/', score: branch.score + 100 });
        return next;
      }
      const entries = listing?.entries || [];
      const exact = entries.find(entry => entry.name === part);
      const matches = (exact ? componentMatches(part, [exact]) : quoted ? [] : componentMatches(part, entries))
        .filter(item => item.score > 0).sort((a, b) => b.score - a.score || a.entry.name.localeCompare(b.entry.name)).slice(0, 8);
      const found = await Promise.all(matches.map(async ({ entry, score }) => {
        const actual = path.join(branch.actual, entry.name);
        if (!entry.directory && !(entry.symlink && await readStat(actual).then(info => info?.directory))) return undefined;
        return { actual, rendered: branch.rendered + entry.name + '/', score: branch.score + score };
      }));
      return found.filter((branch): branch is Branch => !!branch);
    }));
    const next = groups.flat();
    branches = next.sort((a, b) => b.score - a.score).slice(0, 4);
    if (!branches.length) break;
  }
  return branches.slice(0, 3).map(candidate);
}
