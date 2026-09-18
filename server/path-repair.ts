import { stat } from 'node:fs/promises';
import path from 'node:path';
import type { Candidate, Catalog } from '../src/protocol.ts';
import { shellQuote, similarity } from './repair.ts';
import { expandSymbols } from './speech.ts';
import { directoryEntries } from './directories.ts';

function componentScore(spoken: string, actual: string): number {
  const score = similarity(spoken, actual);
  if (score) return score;
  // Short path components deserve edit-distance correction too: get → git.
  const a = spoken.toLowerCase(), b = actual.toLowerCase();
  if (a.length >= 3 && a.length === b.length && [...a].filter((char, index) => char !== b[index]).length === 1) return 62;
  return 0;
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
  const reads = new Map<string, ReturnType<typeof readdirNames>>();
  const deadline = Date.now() + 1000;
  async function readdirNames(dir: string) { return directoryEntries(dir, 10000, signal); }
  for (const part of parts) {
    const next: Branch[] = [];
    for (const branch of branches) {
      signal?.throwIfAborted();
      if (Date.now() > deadline || reads.size >= 48) break;
      if (part === '.' || part === '..') {
        next.push({ actual: path.resolve(branch.actual, part), rendered: branch.rendered + part + '/', score: branch.score + 100 }); continue;
      }
      const actual = path.join(branch.actual, part);
      const info = await stat(actual).catch(() => undefined);
      if (info) {
        if (info.isDirectory()) next.push({ actual, rendered: branch.rendered + part + '/', score: branch.score + 100 });
        continue;
      }
      if (!reads.has(branch.actual)) reads.set(branch.actual, readdirNames(branch.actual));
      const entries = await reads.get(branch.actual)!;
      const exact = entries.find(entry => entry.name === part);
      const matches = (exact ? [exact] : quoted ? [] : entries)
        .map(entry => ({ entry, score: componentScore(part, entry.name) }))
        .filter(item => item.score > 0).sort((a, b) => b.score - a.score || a.entry.name.localeCompare(b.entry.name)).slice(0, 8);
      for (const { entry, score } of matches) {
        const actual = path.join(branch.actual, entry.name);
        if (!entry.isDirectory() && !(entry.isSymbolicLink() && await stat(actual).then(info => info.isDirectory(), () => false))) continue;
        next.push({ actual, rendered: branch.rendered + entry.name + '/', score: branch.score + score });
      }
    }
    branches = next.sort((a, b) => b.score - a.score).slice(0, 4);
    if (!branches.length) break;
  }
  return branches.slice(0, 3).map(branch => {
    const rendered = branch.rendered === '/' ? '/' : branch.rendered.replace(/\/$/, '') || '.';
    const argument = quoted ? `'${rendered.replaceAll("'", "'\\''")}'` : shellQuote(rendered);
    return { command: `${match[1].toLowerCase()} ${options}${argument}`, score: 110 + branch.score / Math.max(1, parts.length), changes: ['Path verified against existing directories'] };
  });
}
