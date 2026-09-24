import * as path from './path.ts';
import type { EngineHost } from './host.ts';
import type { Candidate, Catalog } from './types.ts';
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
/** Recognize the bounded directory grammar before collecting unrelated paths. */
export function directoryInput(input: string) {
  const expanded = expandSymbols(input).trim();
  const match = expanded.match(/^(cd|pushd)\s+(.*)$/i);
  if (!match) return undefined;
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
  const prefix = fromHome ? '~/' : absolute ? '/' : '';
  const parts = (fromHome ? target.slice(1) : target).split('/').filter(Boolean);
  if (parts.length > 16 || target.length > 2000) return undefined;
  return { command: match[1].toLowerCase(), options, quoted, fromHome, absolute, prefix, parts };
}
/** Walk only the requested path; never evaluate the shell or scan unrelated trees. */
export async function repairDirectory(input: string, catalog: Catalog, home: string, host: EngineHost, signal?: AbortSignal): Promise<Candidate[] | undefined> {
  signal?.throwIfAborted();
  const request = directoryInput(input);
  if (!request || !catalog.commands.includes(request.command) || (request.fromHome && !home)) return undefined;
  const { command, options, quoted, fromHome, absolute, prefix, parts } = request;
  const start = fromHome ? home : absolute ? '/' : catalog.cwd;
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
    return { command: `${command} ${options}${argument}`, score: 110 + branch.score / Math.max(1, parts.length), changes: ['Path verified against existing directories'] };
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
  // A spoken project name may omit the directory immediately below home.
  // Search one level of existing home directories only after the literal path
  // and its direct spelling alternatives have failed.
  if (!branches.length && fromHome && !quoted && parts.length === 1 &&
      parts[0].replace(/[^a-z0-9]/gi, '').length >= 4 && Date.now() < deadline) {
    const requested = path.join(home, parts[0]);
    if (await readStat(requested)) return []; // An exact file must not redirect elsewhere.
    const root = await readLookup(requested);
    const parents = (root.listing?.entries || await host.entries(home, 256, signal))
      .filter(entry => !entry.name.startsWith('.') && (entry.directory || entry.symlink))
      .sort((a, b) => Number(b.symlink) - Number(a.symlink) || a.name.length - b.name.length || a.name.localeCompare(b.name))
      .slice(0, 16);
    const found: Branch[] = [];
    for (let at = 0; at < parents.length && Date.now() < deadline; at += 4) {
      const groups = await Promise.all(parents.slice(at, at + 4).map(async parent => {
        const parentPath = path.join(home, parent.name);
        let entries: Awaited<ReturnType<EngineHost['entries']>>;
        try { entries = await host.entries(parentPath, 256, signal); }
        catch { signal?.throwIfAborted(); return [] as Branch[]; }
        const matches = componentMatches(parts[0], entries).filter(match => match.score >= 64)
          .sort((a, b) => b.score - a.score).slice(0, 3);
        const valid = await Promise.all(matches.map(async ({ entry, score }) => {
          const actual = path.join(parentPath, entry.name);
          if (!entry.directory && !(entry.symlink && await readStat(actual).then(info => info?.directory))) return undefined;
          return { actual, rendered: `~/${parent.name}/${entry.name}`, score: score - 36 };
        }));
        return valid.filter((branch): branch is Branch => !!branch);
      }));
      found.push(...groups.flat());
      if (found.some(branch => branch.score >= 58)) break; // An exact normalized name is enough.
    }
    return found.sort((a, b) => b.score - a.score || a.rendered.length - b.rendered.length)
      .slice(0, 3).map(candidate);
  }
  return branches.slice(0, 3).map(candidate);
}
