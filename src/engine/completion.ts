import type { Catalog, Flag } from './types.ts';
import type { EngineHost } from './host.ts';
import { repair, tokens } from './repair.ts';
import { simpleWords } from './validation.ts';
import { childScope, flagsFor, isPathPosition, optionArity, subcommandsFor, type CommandMetadata } from './command-policy.ts';

function operandPosition(args: string[], metadata: CommandMetadata): boolean {
  if (isPathPosition(args)) return false;
  if (['echo', 'printf'].includes(args[0])) return false;
  let scope = args[0], literal = false;
  let operands = 0, suppliedText = false;
  for (let index = 1; index < args.length; index++) {
    const word = args[index];
    if (!literal && word === '--') { literal = true; continue; }
    if (!literal && word.startsWith('-')) {
      const takes = optionArity(word, flagsFor(scope, metadata));
      if (takes === undefined || (takes && ++index >= args.length)) return false;
      if (takes && ['-e', '--regexp', '-f', '--file'].includes(word)) suppliedText = true;
    } else {
      const child = !literal && childScope(scope, word, metadata);
      if (child) scope = child; else operands++;
    }
  }
  // Shell completion often offers filenames even at a search pattern or inline
  // program. That is useful for Tab, but is insufficient evidence to edit text.
  if (['grep', 'rg', 'sed', 'awk'].includes(args[0]) && !operands && !suppliedText) return false;
  return literal || !subcommandsFor(scope, metadata).length;
}

/** Learn operand names progressively: repaired earlier operands inform later
 * completion contexts. All facts expire with this suggestion request. */
export async function completeArguments(input: string, catalog: Catalog, metadata: CommandMetadata,
  host: EngineHost, signal: AbortSignal, scriptFlags?: Flag[]) {
  if (!host.complete || !simpleWords(input)) return [];
  const words = tokens(input);
  if (words.length > 64 || input.length > 2000) return [];
  const learned: CommandMetadata = { ...metadata, argumentValues: {} };
  const budget = AbortSignal.any([signal, AbortSignal.timeout(1500)]);
  let requests = 0;
  for (let index = 1; index < words.length && requests < 6 && !budget.aborted; index++) {
    const word = words[index];
    if (word.quoted || /^-|^(dash|hyphen|hep)$/i.test(word.value)) continue;
    const prefix = words.slice(0, index).map(word => word.quoted ? `'${word.value.replaceAll("'", "'\\''")}'` : word.value).join(' ');
    const prefixes = repair(prefix, catalog, scriptFlags, learned).filter(candidate => !candidate.literal).slice(0, 2);
    for (const candidate of prefixes) {
      const args = simpleWords(candidate.command)?.map(word => word.value);
      if (!args?.length || !operandPosition(args, metadata)) continue;
      // Never reinterpret an argument already recognized as a spoken option.
      const parsed = repair(`${candidate.command} ${word.value}`, catalog, scriptFlags, metadata).filter(candidate => !candidate.literal);
      if (parsed.some(candidate => tokens(candidate.command).at(-1)?.value.startsWith('-'))) continue;
      const key = JSON.stringify(args);
      if (Object.hasOwn(learned.argumentValues!, key) || requests >= 6 || budget.aborted) continue;
      signal.throwIfAborted(); requests++;
      // A short prefix keeps large completion sets bounded while tolerating an
      // error later in the name. Consecutive initials also supply that prefix.
      let prefix = word.value.toLowerCase();
      if (/^[a-z]$/i.test(prefix) && /^[a-z]$/i.test(words[index + 1]?.value || '')) prefix += words[index + 1].value.toLowerCase();
      prefix = /^[a-z0-9_]/i.test(prefix) ? prefix.slice(0, 2) : '';
      try {
        let values = await host.complete([...args, prefix], budget);
        if (!values.length && prefix && requests < 6 && !budget.aborted) {
          requests++; values = await host.complete([...args, ''], budget);
        }
        learned.argumentValues![key] = values;
      }
      catch { signal.throwIfAborted(); learned.argumentValues![key] = []; }
    }
  }
  signal.throwIfAborted();
  return repair(input, catalog, scriptFlags, learned).filter(candidate => candidate.changes.some(change => change.startsWith('Completion →')));
}
