import { readdir } from 'node:fs/promises';
import path from 'node:path';
import type { Candidate, Catalog, Flag } from '../src/protocol.ts';
import { repair, discoveryTarget, discoveryTargets, commandNames, commonFlags, subcommands, optionArity, similarity, tokens, type CommandMetadata } from './repair.ts';
import { repairDirectory } from './path-repair.ts';
import { candidateValid, simpleWords } from './validation.ts';
import { expandSymbols } from './speech.ts';
import { Discovery } from './discovery.ts';

const historyIndexes = new WeakMap<string[], Map<number, { line: string; words: NonNullable<ReturnType<typeof simpleWords>> }[]>>();
export function prepareHistory(catalog: Catalog) {
  if (historyIndexes.has(catalog.history)) return historyIndexes.get(catalog.history)!;
  const index = new Map<number, { line: string; words: NonNullable<ReturnType<typeof simpleWords>> }[]>();
  for (const line of new Set(catalog.history)) {
    const words = simpleWords(line);
    if (!words?.length || ['echo', 'printf'].includes(words[0].value)) continue;
    const length = line.replace(/\W/g, '').length;
    if (!index.has(length)) index.set(length, []);
    index.get(length)!.push({ line, words });
  }
  historyIndexes.set(catalog.history, index); return index;
}

function preservesExplicitInput(input: string, line: string): boolean {
  const spoken = tokens(input), candidate = simpleWords(line)?.map(word => word.value) || [];
  for (let i = 0; i < spoken.length; i++) {
    const word = spoken[i];
    if (word.quoted && !candidate.includes(word.value)) return false;
    if (!word.quoted && /^-./.test(word.value)) {
      const at = candidate.indexOf(word.value);
      if (at < 0) return false;
      const value = spoken[i + 1];
      if (value && !value.value.startsWith('-') && candidate[at + 1] !== value.value) return false;
    }
  }
  // A nearby historical command must not silently introduce an extra option.
  return candidate.filter(word => /^-./.test(word)).every(flag => spoken.some(word => word.value === flag || (!word.quoted && word.value.toLowerCase() === flag.replace(/^-+/, '').toLowerCase())));
}

export function historyCandidates(input: string, catalog: Catalog): Candidate[] {
  const spoken = expandSymbols(input).replace(/([a-zA-Z])\.$/, '$1');
  const allowed = new Set(commandNames(input, catalog));
  const candidates: Candidate[] = [];
  const index = prepareHistory(catalog), length = spoken.replace(/\W/g, '').length;
  const nearby = [-2, -1, 0, 1, 2].flatMap(delta => index.get(length + delta) || []);
  for (const { line, words } of nearby) {
    if (!allowed.has(words[0].value) || !preservesExplicitInput(input, line)) continue;
    // Match a whole historical command, not a prefix that could add unseen arguments.
    const score = similarity(spoken, line);
    if (score < 64 || Math.abs(spoken.replace(/\W/g, '').length - line.replace(/\W/g, '').length) > 2) continue;
    candidates.push({ command: line, score: score + 8 + (catalog.historyCwds?.[line] === catalog.cwd ? 6 : 0), changes: ['Matches shell history'] });
  }
  return candidates.sort((a, b) => b.score - a.score).slice(0, 6);
}
async function referencedPaths(input: string, catalog: Catalog, env: NodeJS.ProcessEnv): Promise<Catalog> {
  const expanded = expandSymbols(input);
  const prefixes = [...new Set(tokens(expanded).map(word => word.value.match(/^((?:~\/|\/|\.\.?\/)[^\s]*\/)/)?.[1]).filter((value): value is string => !!value))].slice(0, 4);
  const entries = await Promise.all(prefixes.map(async prefix => {
    const dir = path.resolve(catalog.cwd, prefix.startsWith('~/') ? path.join(env.HOME || catalog.cwd, prefix.slice(2)) : prefix);
    return (await readdir(dir, { withFileTypes: true }).catch(() => [])).slice(0, 1000).map(entry => prefix + entry.name + (entry.isDirectory() ? '/' : ''));
  }));
  return { ...catalog, paths: [...new Set([...catalog.paths, ...entries.flat()])] };
}
export type SuggestStage = 'history' | 'cache' | 'schema' | 'discovery' | 'directory';
function covered(candidate: Candidate, metadata: CommandMetadata): boolean {
  const words = simpleWords(candidate.command);
  if (!words?.length) return false;
  if (['python', 'python3', 'node', 'ruby', 'bash', 'sh'].includes(words[0].value) && words[1] && !words[1].value.startsWith('-')) return false;
  let scope = words[0].value;
  const schemas = { ...commonFlags, ...metadata.flags }, commands = { ...subcommands, ...metadata.subcommands };
  for (let i = 1; i < words.length; i++) {
    const word = words[i].value;
    if (word.startsWith('-')) { if (optionArity(word, schemas[scope] || [])) i++; continue; }
    if (commands[scope]?.includes(word)) scope += ' ' + word;
  }
  return Object.hasOwn(metadata.flags, scope) || Object.hasOwn(commonFlags, scope) ||
    (scope !== words[0].value && (subcommands[words[0].value] || []).includes(scope.slice(words[0].value.length + 1)));
}
export async function suggest(input: string, catalog: Catalog, env: NodeJS.ProcessEnv, discovery: Discovery, onStage?: (stage: SuggestStage) => void): Promise<Candidate[]> {
  const literal: Candidate = { command: input.trim(), score: 0, changes: [], literal: true };
  const metadata = discovery.cached(catalog, env);
  const historic = historyCandidates(input, catalog);
  const check = async (candidates: Candidate[], scriptFlags?: Flag[]) => {
    const unique = new Map<string, Candidate>();
    for (const candidate of candidates.filter(candidate => !candidate.literal).sort((a, b) => b.score - a.score))
      if (!unique.has(candidate.command)) unique.set(candidate.command, candidate);
    const ranked = [...unique.values()].slice(0, 8);
    const viable = ranked.filter(candidate => candidate.score >= (ranked[0]?.score || 0) - 18);
    const valid = await Promise.all(viable.map(candidate => candidateValid(input, candidate, catalog, env, metadata, scriptFlags)));
    return viable.filter((_, index) => valid[index]).slice(0, 3);
  };
  const fromHistory = await check(historic.filter(candidate => candidate.score >= 102));
  if (fromHistory.length) { onStage?.('history'); return [...fromHistory, literal]; }
  // Directory matching is a bounded filesystem lookup, and must precede generic
  // cached schemas (which can mistake a spoken path for another command).
  const directories = await repairDirectory(input, catalog, env.HOME || '');
  if (directories !== undefined) {
    onStage?.('directory'); return [...await check(directories), literal];
  }
  const cheap = repair(input, catalog, undefined, metadata).filter(candidate => !candidate.literal);
  const fast = await check(cheap.filter(candidate => candidate.score >= 100 && covered(candidate, metadata)));
  if (fast.length) { onStage?.(Object.keys(metadata.flags).length ? 'cache' : 'schema'); return [...fast, literal]; }

  // Filesystem expansion and process-based help discovery are fallback work.
  catalog = await referencedPaths(input, catalog, env);
  const preliminary = [...repair(input, catalog, undefined, metadata).filter(candidate => !candidate.literal), ...historic].sort((a, b) => b.score - a.score);
  const roots = discoveryTargets(expandSymbols(input), catalog);
  const targets = [...new Set([...(preliminary[0] ? [preliminary[0].command] : []), ...roots])].slice(0, 3);
  if (!targets.length) targets.push(discoveryTarget(input, catalog));
  let scriptFlags: Flag[] | undefined;
  const discoveries = await Promise.all(targets.map(target => discovery.discover(target, catalog, env)));
  for (const found of discoveries) {
    Object.assign(metadata.flags, found.metadata.flags);
    Object.assign(metadata.subcommands, found.metadata.subcommands);
    Object.assign(metadata.requiredPositionals!, found.metadata.requiredPositionals);
    scriptFlags ||= found.scriptFlags;
  }
  onStage?.('discovery');
  return [...await check([...repair(input, catalog, scriptFlags, metadata), ...historic], scriptFlags), literal];
}
