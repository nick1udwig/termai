import type { Candidate, Catalog, Flag } from '../src/protocol.ts';
import { expandSymbols } from './speech.ts';

export const commonFlags: Record<string, Flag[]> = {
  cd: ['-L', '-P', '-e'].map(name => ({ name, takesValue: false })),
  ls: ['-a', '-l', '-L', '-h', '-R', '--all', '--human-readable'].map(name => ({ name, takesValue: false })),
  git: [{ name: '--help', takesValue: false }, { name: '--version', takesValue: false }, { name: '-C', takesValue: true }],
  'git status': ['--short', '--branch', '--porcelain', '--ignored'].map(name => ({ name, takesValue: false })),
  'git log': ['--oneline', '--all', '--stat', '--graph'].map(name => ({ name, takesValue: false })),
  'git diff': ['--stat', '--cached', '--name-only'].map(name => ({ name, takesValue: false })),
  'git add': ['--all', '--patch', '--update'].map(name => ({ name, takesValue: false })),
  'git commit': [{ name: '-m', takesValue: true }, { name: '--message', takesValue: true }, { name: '--amend', takesValue: false }],
  python3: [{ name: '--version', takesValue: false }, { name: '-m', takesValue: true }, { name: '-c', takesValue: true }],
  python: [{ name: '--version', takesValue: false }, { name: '-m', takesValue: true }, { name: '-c', takesValue: true }],
  grep: [{ name: '-i', takesValue: false }, { name: '-r', takesValue: false }, { name: '-n', takesValue: false }, { name: '--ignore-case', takesValue: false }],
  rg: [{ name: '--hidden', takesValue: false }, { name: '--glob', takesValue: true }, { name: '--ignore-case', takesValue: false }],
};
export const subcommands: Record<string, string[]> = { git: ['init', 'status', 'log', 'diff', 'add', 'commit', 'checkout', 'switch', 'branch', 'fetch', 'pull', 'push', 'show', 'restore', 'stash', 'clone'] };
const visibleCommands = new WeakMap<string[], { functions: Catalog['functions']; helpers: Set<string>; names: string[] }>();
export function commandNames(input: string, catalog: Catalog): string[] {
  const first = tokens(input)[0]?.value;
  let entry = visibleCommands.get(catalog.commands);
  if (!entry || entry.functions !== catalog.functions) {
    const helpers = new Set(catalog.functions?.filter(name => name.startsWith('_')) || []);
    entry = { functions: catalog.functions, helpers, names: helpers.size ? catalog.commands.filter(name => !helpers.has(name)) : catalog.commands };
    visibleCommands.set(catalog.commands, entry);
  }
  return first && entry.helpers.has(first) ? catalog.commands.filter(name => !entry.helpers.has(name) || name === first) : entry.names;
}
export function shellQuote(value: string): string {
  if (value.startsWith('~/')) return '~/' + shellQuote(value.slice(2));
  return /^[a-zA-Z0-9_@%+=:,./~-]+$/.test(value) ? value : `'${value.replaceAll("'", "'\\''")}'`;
}
export function tokens(input: string): { value: string; quoted: boolean }[] {
  return (input.match(/"[^"\n]*"|'[^'\n]*'|\S+/g) || []).map(value => ({
    quoted: /^["']/.test(value), value: /^["']/.test(value) ? value.slice(1, -1) : value,
  }));
}
const dash = /[\u2010-\u2015\u2212]/g;
/** Recover a missing command/option boundary only at an actual command name.
 * An existing hyphenated executable takes precedence over a proposed split. */
function commandTokens(input: string, catalog: Catalog): ReturnType<typeof tokens> {
  const words = tokens(input);
  const first = words[0];
  if (!first || first.quoted || catalog.commands.some(name => name.toLowerCase() === first.value.toLowerCase())) return words;
  const structural = first.value.replace(dash, '-');
  const prefix = catalog.commands.filter(name => structural.toLowerCase().startsWith(name.toLowerCase() + '-') && structural.length > name.length + 1)
    .sort((a, b) => b.length - a.length || a.localeCompare(b))[0];
  if (prefix) words.splice(0, 1,
    { value: first.value.slice(0, prefix.length), quoted: false },
    { value: structural.slice(prefix.length), quoted: false });
  return words;
}
/** Try every character boundary, but only keep prefixes that are real commands.
 * Exact executable names always win over a missing-dash interpretation. */
function compactBoundaries(input: string, catalog: Catalog): { command: string; prefix: string; suffix: string; rest: string }[] {
  const first = tokens(input)[0];
  if (!first || first.quoted || !/^[a-zA-Z0-9]+$/.test(first.value) || catalog.commands.some(name => name.toLowerCase() === first.value.toLowerCase())) return [];
  const names = new Map(catalog.commands.map(name => [name.toLowerCase(), name]));
  const result = [];
  for (let index = first.value.length - 1; index >= 1; index--) {
    const prefix = first.value.slice(0, index), command = names.get(prefix.toLowerCase());
    if (command) result.push({ command, prefix, suffix: first.value.slice(index), rest: input.trimStart().slice(first.value.length) });
  }
  return result;
}
/** Resolve an executable for help even when its option schema is not known yet. */
export function discoveryTarget(input: string, catalog: Catalog): string {
  if (/[|&;<>()`$\\\n\r]/.test(input)) return '';
  const words = commandTokens(input, catalog);
  const command = matches(words, 0, commandNames(input, catalog), 3)[0];
  return command ? [shellQuote(command.value), ...words.slice(command.consumed).map(word => shellQuote(word.value))].join(' ') : compactBoundaries(input, catalog)[0]?.command || '';
}
/** Search executable names independently of whether the remaining sentence parses. */
export function discoveryTargets(input: string, catalog: Catalog): string[] {
  if (/[|&;<>()`$\\\n\r]/.test(input)) return [];
  const words = commandTokens(input, catalog), names = commandNames(input, catalog);
  const exact = names.filter(name => name.toLowerCase() === words[0]?.value.toLowerCase());
  const roots = [...matches(words, 0, names, 1), ...matches(words, 0, names, 3)]
    .filter(match => !exact.length || exact.includes(match.value) || (match.consumed > 1 && match.score >= 94));
  const unique = new Map<string, Match>();
  for (const match of roots) if (!unique.has(match.value) || unique.get(match.value)!.score < match.score) unique.set(match.value, match);
  return [...unique.values()].slice(0, 3).map(match => [shellQuote(match.value), ...words.slice(match.consumed).map(word => shellQuote(word.value))].join(' '));
}
/** Whether a known option consumes the following token. Supports short bundles
 * and attached values without changing the case of those values. */
export function optionArity(value: string, flags: Flag[]): boolean | undefined {
  const equals = value.indexOf('=');
  const name = equals < 0 ? value : value.slice(0, equals);
  const exact = flags.find(flag => flag.name === name);
  if (exact) return equals < 0 && exact.takesValue;
  if (!/^-[^-].+/.test(value) || equals >= 0) return undefined;
  for (let index = 1; index < value.length; index++) {
    const flag = flags.find(flag => flag.name === '-' + value[index]);
    if (!flag) return undefined;
    if (flag.takesValue) return index === value.length - 1;
  }
  return false;
}
const key = (value: string) => value.toLowerCase()
  .replace(/\bthree\b/g, '3').replace(/\btwo\b/g, '2')
  .replace(/\bdot\b/g, '.').replace(/\b(?:dash|hyphen|underscore)\b/g, '')
  .replace(/\bpie\b/g, 'py').replace(/[^a-z0-9]/g, '');
function sounds(value: string): string {
  return key(value).replace(/ph/g, 'f').replace(/ck/g, 'k').replace(/qu/g, 'k')
    .replace(/[cg]/g, 'k').replace(/[sz]/g, 's').replace(/[aeiouy]/g, '').replace(/(.)\1+/g, '$1');
}
function oneEdit(a: string, b: string): boolean {
  if (Math.abs(a.length - b.length) > 1) return false;
  let i = 0, j = 0, edits = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) { i++; j++; continue; }
    if (++edits > 1) return false;
    if (a.length >= b.length) i++;
    if (b.length >= a.length) j++;
  }
  return edits + (a.length - i) + (b.length - j) <= 1;
}
function prepared(value: string) {
  const normalized = key(value);
  return { value, lower: value.toLowerCase(), normalized, phonetic: sounds(normalized) };
}
type Prepared = ReturnType<typeof prepared>;
function score(spoken: Prepared, exact: Prepared): number {
  if (spoken.value === exact.value) return 100;
  if (spoken.lower === exact.lower) return 98;
  const a = spoken.normalized, b = exact.normalized;
  if (!a || !b) return 0;
  if (a === b) return 94;
  if (a.length >= 4 && b.length >= 4 && spoken.phonetic === exact.phonetic && Math.abs(a.length - b.length) <= 2) return 66;
  if (a.length >= 3 && b.length >= 3 && oneEdit(a, b)) return 64;
  return 0;
}
export function similarity(spoken: string, exact: string): number { return score(prepared(spoken), prepared(exact)); }
// Catalog arrays are immutable snapshots. Weak keys release indexes with their catalog.
const matchIndexes = new WeakMap<string[], ReturnType<typeof buildIndex>>();
function buildIndex(candidates: string[]) {
  const entries = candidates.map(prepared);
  const lower = new Map<string, number[]>(), normalized = new Map<string, number[]>(), phonetic = new Map<string, number[]>(), lengths = new Map<number, number[]>();
  const add = <K>(map: Map<K, number[]>, key: K, index: number) => {
    const bucket = map.get(key);
    if (bucket) bucket.push(index); else map.set(key, [index]);
  };
  entries.forEach((entry, i) => {
    add(lower, entry.lower, i); add(normalized, entry.normalized, i);
    add(phonetic, entry.phonetic, i); add(lengths, entry.normalized.length, i);
  });
  return { entries, lower, normalized, phonetic, lengths };
}
interface Match { value: string; consumed: number; score: number }
export function matches(words: ReturnType<typeof tokens>, start: number, candidates: string[], maxWords: number): Match[] {
  const found: Match[] = [];
  let index = matchIndexes.get(candidates);
  if (!index) { index = buildIndex(candidates); matchIndexes.set(candidates, index); }
  for (let length = 1; length <= maxWords && start + length <= words.length; length++) {
    const span = words.slice(start, start + length);
    if (span.some(w => w.quoted || /^-/.test(w.value))) break;
    if (/^(dash|hyphen|underscore|dot|hep)$/i.test(span.at(-1)!.value)) continue;
    const spoken = prepared(span.map(w => w.value).join(' '));
    const nearby = new Set([
      ...index.lower.get(spoken.lower) || [], ...index.normalized.get(spoken.normalized) || [],
      ...index.phonetic.get(spoken.phonetic) || [],
      ...[-1, 0, 1].flatMap(delta => index.lengths.get(spoken.normalized.length + delta) || []),
    ]);
    for (const at of [...nearby].sort((a, b) => a - b)) {
      const candidate = index.entries[at], value = score(spoken, candidate);
      if (value) found.push({ value: candidate.value, consumed: length, score: value + (length - 1) * 8 });
    }
  }
  return found.sort((a, b) => b.score - a.score || a.value.localeCompare(b.value)).slice(0, 4);
}

export interface CommandMetadata { flags: Record<string, Flag[]>; subcommands: Record<string, string[]>; requiredPositionals?: Record<string, number> }
export function repair(input: string, catalog: Catalog, scriptFlags?: Flag[], metadata: CommandMetadata = { flags: {}, subcommands: {} }): Candidate[] {
  catalog = { ...catalog, commands: commandNames(input, catalog) };
  // Sentence punctuation introduced by dictation is ambiguous with real paths.
  // Try the sentence-free variant too; validation/ranking decides between them.
  const sentence = input.match(/^(.*[a-zA-Z])\.$/);
  if (sentence && !catalog.paths.includes(tokens(input).at(-1)?.value || '') && !/["'|&;<>()`$\\]/.test(input)) {
    const clean = repair(sentence[1], catalog, scriptFlags, metadata).filter(candidate => !candidate.literal);
    const completedSubcommand = clean.some(candidate => {
      const args = tokens(candidate.command);
      return args.length === 2 && (metadata.subcommands[args[0].value] || subcommands[args[0].value])?.includes(args[1].value);
    });
    if (completedSubcommand) return [...clean.map(candidate => ({ ...candidate, changes: [...candidate.changes, 'Remove dictation sentence punctuation'] })), { command: input.trim(), score: 0, changes: [], literal: true }];
  }
  const expanded = expandSymbols(input);
  const candidates = repairNormalized(expanded, catalog, scriptFlags, metadata);
  if (expanded === input) return candidates;
  const result = candidates.filter(candidate => !candidate.literal).map(candidate => ({ ...candidate, changes: ['Spoken symbols', ...candidate.changes] }));
  // Explicitly spoken shell syntax must retain its meaning (including globbing
  // and quote type), rather than becoming single-quoted positional arguments.
  if (/[|&;<>()`$\\?"'!\[\]{}#^]/.test(expanded)) {
    const first = tokens(expanded)[0]?.value;
    const canonical = catalog.commands.find(name => name.toLowerCase() === first?.toLowerCase());
    return [{ command: canonical ? canonical + expanded.slice(first.length) : expanded, score: 90, changes: ['Spoken symbols'] }, { command: input.trim(), score: 0, changes: [], literal: true }];
  }
  return [...result.slice(0, 3), { command: input.trim(), score: 0, changes: [], literal: true }];
}
function repairNormalized(input: string, catalog: Catalog, scriptFlags?: Flag[], metadata: CommandMetadata = { flags: {}, subcommands: {} }): Candidate[] {
  const initial = repairOne(input, catalog, scriptFlags, metadata);
  if (!input.trim() || /[|&;<>()`$\\\n\r]/.test(input) || initial.some(candidate => !candidate.literal && candidate.score >= 90)) return initial;
  const schemas = { ...commonFlags, ...metadata.flags };
  const candidates = initial.filter(candidate => !candidate.literal);
  for (const boundary of compactBoundaries(input, catalog)) {
    const flags = schemas[boundary.command] || [];
    const options = new Set(flags.filter(flag => flag.name.replace(/^-+/, '').toLowerCase() === boundary.suffix.toLowerCase()).map(flag => flag.name));
    for (const suffix of [boundary.suffix, boundary.suffix.toLowerCase()]) {
      if (optionArity('-' + suffix, flags) !== undefined) options.add('-' + suffix);
    }
    for (const option of options) {
      for (const candidate of repairOne(`${boundary.prefix} ${option}${boundary.rest}`, catalog, scriptFlags, metadata)) {
        if (!candidate.literal) candidates.push({ ...candidate, score: candidate.score - 8, changes: ['Restore command/flag boundary', ...candidate.changes] });
      }
    }
  }
  const unique = new Map<string, Candidate>();
  for (const candidate of candidates.sort((a, b) => b.score - a.score)) if (!unique.has(candidate.command)) unique.set(candidate.command, candidate);
  const result = [...unique.values()].slice(0, 3);
  if (result.length < 3) result.push({ command: input.trim(), score: 0, changes: [], literal: true });
  return result;
}
/** Context-constrained candidates, ranked for review or explicit top-result submission. */
function repairOne(input: string, catalog: Catalog, scriptFlags?: Flag[], metadata: CommandMetadata = { flags: {}, subcommands: {} }): Candidate[] {
  const schemas = { ...commonFlags, ...metadata.flags };
  const knownSubcommands = { ...subcommands, ...metadata.subcommands };
  const literal: Candidate = { command: input.trim(), score: 0, changes: [], literal: true };
  if (!input.trim()) return [];
  // Preserve shell syntax, substitutions, escaped strings, and multi-line input verbatim.
  // An unmatched quote remains editable rather than being silently repaired.
  if (/[|&;<>()`$\\\n\r]/.test(input) || (input.match(/'/g)?.length || 0) % 2 || (input.match(/"/g)?.length || 0) % 2) return [literal];
  const words = commandTokens(input, catalog);
  if (!words.length || words.length > 64 || input.length > 2000) return [literal];
  const exactCommands = catalog.commands.filter(name => name.toLowerCase() === words[0].value.toLowerCase());
  const commands = matches(words, 0, catalog.commands, 3).filter(match => !exactCommands.length || match.consumed > 1 || exactCommands.includes(match.value));
  type State = { args: string[]; scope: string; index: number; score: number; changes: string[]; valueNext: boolean; flags: Flag[]; literalRest: boolean; quoted: number[]; foldFlags: boolean };
  let states: State[] = commands.map(c => ({ args: [c.value], scope: c.value, index: c.consumed, score: c.score,
    changes: c.value !== words.slice(0, c.consumed).map(w => w.value).join(' ') ? [`Command → ${c.value}`] : [],
    valueNext: false, flags: schemas[c.value] || [], literalRest: false, quoted: [],
    foldFlags: (tokens(input)[0].value !== words[0].value) || (/^[A-Z][A-Z0-9]+$/.test(words[0].value) && words[0].value !== c.value && words[0].value.toLowerCase() === c.value.toLowerCase()) }));
  if (!states.length) return [literal];
  for (let step = 0; step < words.length && states.some(s => s.index < words.length); step++) {
    const next: State[] = [];
    for (const state of states) {
      if (state.index >= words.length) { next.push(state); continue; }
      const word = words[state.index];
      const push = (value: string, consumed = 1, score = 0, change?: string, flag?: Flag, quoted = false, isSubcommand = false) => {
        const args = [...state.args, value];
        const scope = isSubcommand ? state.scope + ' ' + value : state.scope;
        const isPythonScript = /^(python|python3)$/.test(args[0]) && args.length === 2 && value.endsWith('.py');
        next.push({ args, scope, index: state.index + consumed, score: state.score + score,
          changes: change ? [...state.changes, change] : state.changes,
          valueNext: !!flag?.takesValue, flags: isPythonScript && scriptFlags ? scriptFlags : schemas[scope] || state.flags,
          quoted: quoted ? [...state.quoted, args.length - 1] : state.quoted,
          literalRest: state.literalRest || value === '--', foldFlags: state.foldFlags });
      };
      if (word.quoted || state.valueNext || state.literalRest) { push(word.value, 1, 0, undefined, undefined, word.quoted); continue; }
      if (knownSubcommands[state.scope]?.length) {
        for (const sub of matches(words, state.index, knownSubcommands[state.scope], 3))
          push(sub.value, sub.consumed, sub.score >= 94 ? 40 : 24, sub.value === word.value ? undefined : `Subcommand → ${sub.value}`, undefined, false, true);
        if (!/^[-\u2010-\u2015\u2212]/.test(word.value)) continue;
      }
      if (/^[-\u2010-\u2015\u2212]/.test(word.value)) {
        if (word.value === '--') { push('--'); continue; }
        let option = word.value.replace(dash, '-'), consumed = 1;
        if (option === '-' && words[state.index + 1] && !words[state.index + 1].quoted && /^[a-zA-Z][\w-]*$/.test(words[state.index + 1].value)) {
          option += words[state.index + 1].value; consumed = 2;
        }
        const exact = optionArity(option, state.flags);
        const alternatives = new Set<string>();
        if (exact !== undefined) alternatives.add(option);
        const equals = option.indexOf('=');
        const name = equals < 0 ? option : option.slice(0, equals);
        {
          for (const flag of state.flags) if (flag.name.toLowerCase() === name.toLowerCase())
            alternatives.add(flag.name + (equals < 0 ? '' : option.slice(equals)));
        }
        for (const value of alternatives) {
          const takesValue = optionArity(value, state.flags);
          if (takesValue === undefined) continue;
          const flagName = value.split('=')[0];
          const preferredCase = state.foldFlags && flagName === flagName.toLowerCase();
          const score = !state.foldFlags && value === option ? 24 : preferredCase ? 12 : value === option ? 10 : 8;
          push(value, consumed, score, value !== word.value || consumed > 1 ? `Flag → ${value}` : undefined, { name: value, takesValue });
        }
        // Unknown options stay available only as the literal input, not validated alternatives.
        continue;
      }
      const pathPosition = ['cat', 'cd', 'ls', 'less', 'more', 'head', 'tail', 'file', 'stat', 'wc', 'du'].includes(state.args[0]) ||
        (['python', 'python3', 'node', 'ruby', 'bash', 'sh'].includes(state.args[0]) && state.args.length === 1) ||
        (state.args[0] === 'git' && state.args[1] === 'add');
      const exactPath = catalog.paths.includes(word.value) && /[./_-]/.test(word.value);
      const fileMatches = !pathPosition ? [] : exactPath ? [{ value: word.value, consumed: 1, score: 100 }] : matches(words, state.index, catalog.paths, 6);
      for (const file of fileMatches) push(file.value, file.consumed, file.score / 10,
        file.value !== words.slice(state.index, state.index + file.consumed).map(w => w.value).join(' ') ? `File → ${file.value}` : undefined);
      // Restore omitted/spoken dashes only against known flags. Free-form values stay literal.
      let matchedFlag = false;
      for (let n = 1; n <= 5 && state.index + n <= words.length; n++) {
        const span = words.slice(state.index, state.index + n);
        if (span.some(w => w.quoted || /^-/.test(w.value))) break;
        const spoken = span.map(w => w.value).join(' ').replace(/^(?:dash[ -]*|hyphen[ -]*|hep[ -]*)+/i, '');
        for (const flag of state.flags) if (key(spoken) === key(flag.name) && key(spoken)) {
          matchedFlag = true;
          push(flag.name, n, 14 + n, `Flag → ${flag.name}`, flag);
        }
      }
      if (!matchedFlag || fileMatches.length) push(word.value);
    }
    states = next.sort((a, b) => b.score - a.score).slice(0, 8);
  }
  const unique = new Map<string, Candidate>();
  for (const state of states.filter(s => s.index === words.length && !s.valueNext)) {
    if (state.changes.some(c => c.startsWith('Flag →')) && state.args.some((arg, index) => /^(dash|hep|hyphen)$/i.test(arg) && !state.quoted.includes(index))) continue;
    const command = state.args.map((value, index) => state.quoted.includes(index) ? `'${value.replaceAll("'", "'\\''")}'` : shellQuote(value)).join(' ');
    const historyBoost = Math.min(12, catalog.history.filter(h => h === command).length * 3);
    if (!unique.has(command)) unique.set(command, { command, score: state.score + historyBoost, changes: state.changes });
  }
  const result = [...unique.values()].sort((a, b) => b.score - a.score).slice(0, 3);
  if (result.length < 3 && !result.some(candidate => candidate.command === literal.command)) result.push(literal);
  return result;
}
