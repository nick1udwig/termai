import * as path from './path.ts';
import type { EngineHost, Environment, MetadataDiscovery } from './host.ts';
import type { Candidate, Catalog, Flag } from './types.ts';
import { repair, discoveryTarget, discoveryTargets, commandNames, similarity, tokens } from './repair.ts';
import { repairInputFile } from './file-repair.ts';
import { downloadPipeline } from './transfer-command.ts';
import { repairDirectory } from './path-repair.ts';
import { candidateValid, simpleWords } from './validation.ts';
import { expandSymbols, symbolAlternatives } from './speech.ts';
import { commonFlags, subcommands, flagsFor, childScope, scriptCommands, optionArity, isPathPosition, type CommandMetadata } from './command-policy.ts';

type HistoryEntry = { line: string; words: NonNullable<ReturnType<typeof simpleWords>> };
const historyIndexes = new WeakMap<string[], { lengths: Map<number, HistoryEntry[]>; entries: Map<string, HistoryEntry> }>();
export function prepareHistory(catalog: Pick<Catalog, 'history'>, previous?: string[]) {
  if (historyIndexes.has(catalog.history)) return historyIndexes.get(catalog.history)!;
  const lengths = new Map<number, HistoryEntry[]>(), entries = new Map<string, HistoryEntry>();
  const old = previous && historyIndexes.get(previous)?.entries;
  for (const line of new Set(catalog.history)) {
    const entry = old?.get(line);
    const words = entry?.words || simpleWords(line);
    if (!words?.length || ['echo', 'printf'].includes(words[0].value)) continue;
    const length = line.replace(/\W/g, '').length;
    const parsed = entry || { line, words };
    entries.set(line, parsed);
    if (!lengths.has(length)) lengths.set(length, []);
    lengths.get(length)!.push(parsed);
  }
  const index = { lengths, entries };
  historyIndexes.set(catalog.history, index); return index;
}

function preservesExplicitInput(spoken: ReturnType<typeof tokens>, words: NonNullable<ReturnType<typeof simpleWords>>): boolean {
  const candidate = words.map(word => word.value);
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
  const inputWords = tokens(input);
  const allowed = new Set(commandNames(input, catalog));
  const candidates: Candidate[] = [];
  const index = prepareHistory(catalog), length = spoken.replace(/\W/g, '').length;
  const nearby = [-2, -1, 0, 1, 2].flatMap(delta => index.lengths.get(length + delta) || []);
  for (const { line, words } of nearby) {
    if (!allowed.has(words[0].value) || !preservesExplicitInput(inputWords, words)) continue;
    // Match a whole historical command, not a prefix that could add unseen arguments.
    const score = similarity(spoken, line);
    if (score < 64) continue;
    candidates.push({ command: line, score: score + 8 + (catalog.historyCwds?.[line] === catalog.cwd ? 6 : 0), changes: ['Matches shell history'] });
  }
  return candidates.sort((a, b) => b.score - a.score).slice(0, 6);
}
async function referencedPaths(input: string, catalog: Catalog, env: Environment, host: EngineHost, signal: AbortSignal): Promise<Catalog> {
  const expanded = expandSymbols(input);
  const prefixes = [...new Set(tokens(expanded).map(word => word.value.match(/^((?:~\/|\/|\.\.?\/)[^\s]*\/)/)?.[1]).filter((value): value is string => !!value))].slice(0, 4);
  if (!prefixes.length) return catalog;
  const entries = await Promise.all(prefixes.map(async prefix => {
    const dir = path.resolve(catalog.cwd, prefix.startsWith('~/') ? path.join(env.HOME || catalog.cwd, prefix.slice(2)) : prefix);
    return (await host.entries(dir, 1000, signal)).map(entry => prefix + entry.name + (entry.directory ? '/' : ''));
  }));
  const paths = new Set(catalog.paths);
  const previousSize = paths.size;
  for (const entry of entries.flat()) paths.add(entry);
  return paths.size === previousSize ? catalog : { ...catalog, paths: [...paths] };
}
async function nearbyFilePaths(input: string, catalog: Catalog, host: EngineHost, signal: AbortSignal): Promise<Catalog> {
  if (catalog.paths.length) return catalog;
  const expanded = expandSymbols(input);
  if (/[~\/*?<>|&;$]/.test(expanded)) return catalog;
  const words = tokens(expanded);
  const command = catalog.commands.find(name => name.toLowerCase() === words[0]?.value.toLowerCase());
  if (!command || words.length < 2 || !isPathPosition([command, ...words.slice(1, 2).map(word => word.value)]) ||
      !words.slice(1).some(word => !word.quoted && !word.value.startsWith('-'))) return catalog;
  try {
    const entries = await host.entries(catalog.cwd, 1000, signal);
    signal.throwIfAborted();
    const paths = new Set(catalog.paths);
    for (const entry of entries) paths.add(entry.name + (entry.directory ? '/' : ''));
    return paths.size === catalog.paths.length ? catalog : { ...catalog, paths: [...paths] };
  } catch (error) { signal.throwIfAborted(); return catalog; }
}
export type SuggestStage = 'history' | 'cache' | 'schema' | 'discovery' | 'directory';
async function compoundAlternatives(input: string, catalog: Catalog, env: Environment, discovery: MetadataDiscovery, host: EngineHost, signal: AbortSignal): Promise<Candidate[]> {
  if (!/\b(?:semicolon|semi\s+colon|mic)\b|\s;\s/i.test(input)) return [];
  const expanded = expandSymbols(input);
  if (!/\s;\s/.test(expanded) || /["'`$\\|&<>()\[\]{}\n\r]/.test(expanded)) return [];
  const parts = expanded.split(/\s*;\s*/);
  if (parts.length !== 2 || parts.some(part => !part || !simpleWords(part)?.length)) return [];
  const metadata = discovery.cached(catalog, env);
  const choices = await Promise.all(parts.map(async part => {
    const literal: Candidate = { command: part, score: 100, changes: [], literal: true };
    const candidates = [...repair(part, catalog, undefined, metadata).filter(candidate => !candidate.literal), literal];
    const checked = await Promise.all(candidates.map(async candidate => await candidateValid(part, candidate, catalog, env, metadata, host, undefined, signal) ? candidate : undefined));
    return checked.filter((candidate): candidate is Candidate => !!candidate).sort((a, b) => {
      const rank = (candidate: Candidate) => candidate.score - (!part.endsWith('/') && candidate.command.endsWith('/') ? 15 : 0) + (candidate.command === part ? 10 : 0);
      return rank(b) - rank(a);
    }).slice(0, 2);
  }));
  if (choices.some(group => !group.length)) return [];
  const combined = new Map<string, Candidate>();
  for (const first of choices[0]) for (const second of choices[1]) {
    const command = `${first.command}; ${second.command}`;
    if (command === input.trim() || combined.has(command)) continue;
    const candidate: Candidate = { command, score: Math.min(first.score, second.score) + 12, changes: ['Spoken command separator'] };
    if (await candidateValid(input, candidate, catalog, env, metadata, host, undefined, signal)) combined.set(command, candidate);
  }
  return [...combined.values()].sort((a, b) => b.score - a.score).slice(0, 2);
}
function covered(candidate: Candidate, metadata: CommandMetadata): boolean {
  const words = simpleWords(candidate.command);
  if (!words?.length) return false;
  if (scriptCommands.has(words[0].value) && words[1] && !words[1].value.startsWith('-')) return false;
  let scope = words[0].value;
  for (let i = 1; i < words.length; i++) {
    const word = words[i].value;
    if (word.startsWith('-')) { if (optionArity(word, flagsFor(scope, metadata))) i++; continue; }
    scope = childScope(scope, word, metadata) || scope;
  }
  return Object.hasOwn(metadata.flags, scope) || Object.hasOwn(commonFlags, scope) ||
    (scope !== words[0].value && (subcommands[words[0].value] || []).includes(scope.slice(words[0].value.length + 1)));
}
export async function suggest(input: string, catalog: Catalog, env: Environment, discovery: MetadataDiscovery, host: EngineHost, onStage?: (stage: SuggestStage) => void, signal = AbortSignal.timeout(5000)): Promise<Candidate[]> {
  const pipeline = catalog.commands.includes('download') ? downloadPipeline(input) : undefined;
  if (pipeline) {
    const upstream = await suggest(pipeline.command, catalog, env, discovery, host, onStage, signal);
    const candidates = upstream.filter(candidate => !candidate.literal).map(candidate => ({ ...candidate, command: candidate.command + ' | ' + pipeline.tail }));
    return [...candidates.slice(0, 3), { command: input.trim(), score: 0, changes: [], literal: true }];
  }
  const compound = await compoundAlternatives(input, catalog, env, discovery, host, signal);
  if (compound.length) return [...compound, { command: input.trim(), score: 0, changes: [], literal: true }];
  const alternatives = symbolAlternatives(input);
  if (!alternatives.length) return suggestOne(input, catalog, env, discovery, host, onStage, signal);
  const groups = await Promise.all([input, ...alternatives].map(async (text, index) => {
    // Spoken shell syntax is proposed verbatim and checked without evaluating it.
    if (index && /[|&;<>()`$\\*?"'!\[\]{}#^]/.test(text)) {
      const first = tokens(text)[0]?.value;
      const canonical = catalog.commands.find(command => command.toLowerCase() === first?.toLowerCase());
      const candidate: Candidate = { command: canonical ? canonical + text.slice(first.length) : text, score: 90, changes: ['Spoken symbols'] };
      return await candidateValid(input, candidate, catalog, env, discovery.cached(catalog, env), host, undefined, signal) ? [candidate] : [];
    }
    return suggestOne(text, catalog, env, discovery, host, onStage, signal);
  }));
  const candidates = groups.flatMap((group, index) => group.filter(candidate => !candidate.literal && candidate.command !== input.trim()).map(candidate => index === 0 ? candidate : {
    ...candidate, score: candidate.score - 12, changes: ['Spoken symbol alternative', ...candidate.changes],
  })).sort((a, b) => b.score - a.score);
  const unique = new Map<string, Candidate>();
  for (const candidate of candidates) if (!unique.has(candidate.command)) unique.set(candidate.command, candidate);
  return [...[...unique.values()].slice(0, 3), { command: input.trim(), score: 0, changes: [], literal: true }];
}
async function suggestOne(input: string, catalog: Catalog, env: Environment, discovery: MetadataDiscovery, host: EngineHost, onStage?: (stage: SuggestStage) => void, signal = AbortSignal.timeout(5000)): Promise<Candidate[]> {
  signal.throwIfAborted();
  const literal: Candidate = { command: input.trim(), score: 0, changes: [], literal: true };
  const metadata = discovery.cached(catalog, env);
  const files = await repairInputFile(input, catalog, env.HOME || '', host, signal);
  if (files !== undefined) { onStage?.('directory'); return [...files, literal]; }
  const historic = historyCandidates(input, catalog);
  const check = async (candidates: Candidate[], scriptFlags?: Flag[]) => {
    signal.throwIfAborted();
    const unique = new Map<string, Candidate>();
    for (const candidate of candidates.filter(candidate => !candidate.literal).sort((a, b) => b.score - a.score))
      if (!unique.has(candidate.command)) unique.set(candidate.command, candidate);
    const ranked = [...unique.values()].slice(0, 8);
    const viable = ranked.filter(candidate => candidate.score >= (ranked[0]?.score || 0) - 18);
    const valid = await Promise.all(viable.map(candidate => candidateValid(input, candidate, catalog, env, metadata, host, scriptFlags, signal)));
    return viable.filter((_, index) => valid[index]).slice(0, 3);
  };
  const fromHistory = await check(historic.filter(candidate => candidate.score >= 102));
  if (fromHistory.length) { onStage?.('history'); return [...fromHistory, literal]; }
  // Directory matching is a bounded filesystem lookup, and must precede generic
  // cached schemas (which can mistake a spoken path for another command).
  signal.throwIfAborted();
  const directories = await repairDirectory(input, catalog, env.HOME || '', host, signal);
  if (directories !== undefined) {
    onStage?.('directory'); return [...await check(directories), literal];
  }
  signal.throwIfAborted();
  catalog = await nearbyFilePaths(input, catalog, host, signal);
  const cheap = repair(input, catalog, undefined, metadata).filter(candidate => !candidate.literal);
  const fast = await check(cheap.filter(candidate => candidate.score >= 100 && covered(candidate, metadata)));
  if (fast.length) { onStage?.(Object.keys(metadata.flags).length ? 'cache' : 'schema'); return [...fast, literal]; }

  // Filesystem expansion and process-based help discovery are fallback work.
  const expandedCatalog = await referencedPaths(input, catalog, env, host, signal);
  const preliminaryRepairs = expandedCatalog === catalog ? cheap : repair(input, expandedCatalog, undefined, metadata).filter(candidate => !candidate.literal);
  catalog = expandedCatalog;
  const preliminary = [...preliminaryRepairs, ...historic].sort((a, b) => b.score - a.score);
  const roots = discoveryTargets(expandSymbols(input), catalog);
  const targets = [...new Set([...(preliminary[0] ? [preliminary[0].command] : []), ...roots])].slice(0, 3);
  if (!targets.length) targets.push(discoveryTarget(input, catalog));
  let scriptFlags: Flag[] | undefined;
  const previousMetadata = JSON.stringify(metadata);
  const discoveries = await Promise.all(targets.map(target => discovery.discover(target, catalog, env, signal)));
  for (const found of discoveries) {
    Object.assign(metadata.flags, found.metadata.flags);
    Object.assign(metadata.subcommands, found.metadata.subcommands);
    Object.assign(metadata.requiredPositionals!, found.metadata.requiredPositionals);
    scriptFlags ||= found.scriptFlags;
  }
  onStage?.('discovery');
  signal.throwIfAborted();
  const repairs = scriptFlags === undefined && previousMetadata === JSON.stringify(metadata) ? preliminaryRepairs : repair(input, catalog, scriptFlags, metadata);
  return [...await check([...repairs, ...historic], scriptFlags), literal];
}
