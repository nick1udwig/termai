import * as path from './path.ts';
import { expandSymbols } from './speech.ts';
import { similarityIndex, shellQuote } from './repair.ts';
import type { Catalog, Candidate } from './types.ts';
import type { EngineHost } from './host.ts';

/** Resolve one input file component at a time, including outside cached CWD paths.
 * Shared by managed downloads and the reader's cat-based path suggestions. */
export async function repairInputFile(input: string, catalog: Catalog, home: string, host: EngineHost, signal: AbortSignal, spokenInput = input): Promise<Candidate[] | undefined> {
  const expanded = expandSymbols(input).trim();
  const match = expanded.match(/^(download|cat)\s+(.+)$/i); if (!match || !catalog.commands.includes(match[1].toLowerCase())) return;
  const command = match[1].toLowerCase(); let operand = match[2], options = '';
  if (command === 'download') { const flags = operand.match(/^((?:(?:--file|--)\s+)+)(.+)$/); if (flags) { options = flags[1]; operand = flags[2]; } }
  // Ordinary cat keeps its multi-file grammar; only nested/absolute reader paths
  // need a bounded walk beyond its existing nearby-file matching.
  if (command === 'cat' && (!operand.includes('/') || (/\s/.test(operand.replace(/\s*\/\s*/g, '/')) && !/^("[^"]*"|'[^']*')$/.test(operand) && !/\bslash\b/i.test(spokenInput)))) return;
  if (/[|&;<>`$\\\n\r]/.test(operand) || (!options.includes('--') && operand.startsWith('-'))) return;
  const quoted = /^("[^"]*"|'[^']*')$/.test(operand);
  if (/["']/.test(operand) && !quoted) return;
  if (quoted) operand = operand.slice(1, -1); else operand = operand.replace(/\s*\/\s*/g, '/');
  const fromHome = !quoted && (operand === '~' || operand.startsWith('~/'));
  const absolute = operand.startsWith('/'), prefix = fromHome ? '~/' : absolute ? '/' : '';
  if (fromHome && !home) return [];
  const start = fromHome ? home : absolute ? '/' : catalog.cwd;
  const parts = (fromHome ? operand.slice(1) : operand).split('/').filter(Boolean);
  if (!parts.length || parts.length > 16 || operand.length > 2000) return [];
  const make = (rendered: string, score: number): Candidate => ({ command: command + ' ' + options + (quoted ? "'" + rendered.replaceAll("'", "'\\''") + "'" : shellQuote(rendered)), score: 130 + score / parts.length, changes: ['File path verified against the filesystem'] });
  const exact = await host.stat(path.join(start, ...parts), signal);
  if (exact) return exact.file ? [make(prefix + parts.join('/'), 100 * parts.length)] : [];
  if (quoted) return []; // Explicitly quoted spelling is authoritative.
  let branches = [{ actual: start, rendered: prefix, score: 0 }], reads = 0;
  const until = Date.now() + 1500;
  for (let i = 0; i < parts.length; i++) {
    const last = i === parts.length - 1, part = parts[i]; signal.throwIfAborted();
    const groups = await Promise.all(branches.map(async branch => {
      if (++reads > 48 || Date.now() > until) return [];
      const target = path.join(branch.actual, part), lookup = await host.lookup(target, signal);
      const append = (name: string, score: number) => ({ actual: path.join(branch.actual, name), rendered: branch.rendered + name + (last ? '' : '/'), score: branch.score + score });
      if (lookup.info) return (last ? lookup.info.file : lookup.info.directory) ? [append(part, 100)] : [];
      const entries = lookup.listing?.entries || [];
      const candidates = similarityIndex(entries.filter(e => last ? !e.directory || e.symlink : e.directory || e.symlink).map(e => e.name))(part, last)
        .filter(item => item.score >= 55).sort((a, b) => b.score - a.score).slice(0, 4);
      const found = await Promise.all(candidates.map(async candidate => {
        const info = await host.stat(path.join(branch.actual, candidate.value), signal);
        return info && (last ? info.file : info.directory) ? append(candidate.value, candidate.score) : undefined;
      }));
      return found.filter((item): item is NonNullable<typeof item> => !!item);
    }));
    branches = groups.flat().sort((a, b) => b.score - a.score).slice(0, 4); if (!branches.length) break;
  }
  return branches.slice(0, 3).map(branch => make(branch.rendered, branch.score));
}
