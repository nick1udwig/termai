import * as path from './path.ts';
import type { Candidate, Catalog, Flag } from './types.ts';
import type { EngineHost, Environment } from './host.ts';
import { commandNames } from './repair.ts';
import { flagsFor, subcommandsFor, childScope, scriptCommands, directoryCommands, inputFileCommands, inlineScriptOptions, optionArity, type CommandMetadata } from './command-policy.ts';
interface Word { value: string; home: boolean }
/** Parse simple arguments without expanding variables, substitutions or globs. */
export function simpleWords(line: string): Word[] | undefined {
  const result: Word[] = [];
  let value = '', quote = '', active = false, home = false;
  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if (quote === "'") { if (char === "'") quote = ''; else value += char; continue; }
    if (char === '\\') { if (++i >= line.length) return undefined; value += line[i]; active = true; continue; }
    if (quote === '"') { if (char === '"') quote = ''; else if (char === '$' || char === '`') return undefined; else value += char; continue; }
    if (char === '"' || char === "'") { quote = char; active = true; continue; }
    if (/[|&;<>()`$*?\[\]{}\n\r]/.test(char)) return undefined;
    if (/\s/.test(char)) { if (active) result.push({ value, home }); value = ''; active = false; home = false; continue; }
    if (!active && char === '#') return undefined;
    if (!active && char === '~') home = true;
    value += char; active = true;
  }
  if (quote) return undefined;
  if (active) result.push({ value, home });
  return result;
}
function resolve(word: Word, cwd: string, env: Environment): string {
  const value = word.home && (word.value === '~' || word.value.startsWith('~/')) ? path.join(env.HOME || cwd, word.value.slice(1)) : word.value;
  return path.resolve(cwd, value);
}
export async function candidateValid(input: string, candidate: Candidate, catalog: Catalog, env: Environment,
  metadata: CommandMetadata, host: EngineHost, scriptFlags?: Flag[], signal = AbortSignal.timeout(4000)): Promise<boolean> {
  const results = await Promise.all([host.syntax(candidate.command, signal), candidatePolicyValid(input, candidate, catalog, env, metadata, host, scriptFlags, signal)]);
  return results.every(Boolean);
}
async function candidatePolicyValid(input: string, candidate: Candidate, catalog: Catalog, env: Environment,
  metadata: CommandMetadata, host: EngineHost, scriptFlags?: Flag[], signal = AbortSignal.timeout(4000)): Promise<boolean> {
  const words = simpleWords(candidate.command);
  // Complex shell expressions get syntax checking only; never evaluate expansions.
  if (!words) return true;
  if (!words.length) return false;
  const command = words[0].value;
  if (!commandNames(input, catalog).includes(command)) {
    if (!command.includes('/')) return false;
    const file = resolve(words[0], catalog.cwd, env);
    const info = await host.stat(file, signal);
    if (!info?.file || !info.executable) return false;
  }
  let cwd = catalog.cwd, scope = command, flags = flagsFor(command, metadata);
  let literal = false;
  const valueFlags: string[] = [];
  const operands: Word[] = [];
  for (let i = 1; i < words.length; i++) {
    const word = words[i], arg = word.value;
    if (!literal && arg === '--') { literal = true; continue; }
    if (!literal && /^-./.test(arg)) {
      const takes = optionArity(arg, flags);
      if (takes === undefined) return false;
      if (arg.includes('=')) {
        const flag = flags.find(flag => flag.name === arg.split('=')[0]);
        if (flag && !flag.takesValue && !flag.optionalValue) return false;
      }
      if (takes) {
        if (++i >= words.length) return false;
        valueFlags.push(arg);
        if (command === 'git' && arg === '-C') cwd = resolve(words[i], cwd, env);
      }
      continue;
    }
    const subs = subcommandsFor(scope, metadata);
    if (!literal && subs.length) {
      const child = childScope(scope, arg, metadata);
      if (!child) return false;
      scope = child; flags = flagsFor(scope, metadata);
      continue;
    }
    operands.push(word);
    if (/^python[23]?$/.test(command) && operands.length === 1 && scriptFlags) flags = scriptFlags;
  }
  const help = words.some(word => ['--help', '-h', '--version'].includes(word.value));
  const required = metadata.requiredPositionals?.[scope];
  const patternFlag = ['grep', 'rg'].includes(command) && valueFlags.some(flag => ['-e', '--regexp', '-f', '--file'].includes(flag));
  if (!help && required !== undefined && operands.length < required && !patternFlag) return false;
  if (help) return true;
  const directoryOnly = directoryCommands.has(command);
  if (directoryOnly && operands.length > 1) return false;
  const inputFiles = inputFileCommands.has(command);
  const script = scriptCommands.has(command) && !words.some(word => inlineScriptOptions.has(word.value));
  const gitFiles = command === 'git' && scope === 'git add';
  const check = directoryOnly || inputFiles || gitFiles ? operands : script ? operands.slice(0, 1) : [];
  for (const operand of check) {
    signal.throwIfAborted();
    if (operand.value === '-') continue;
    try {
      const info = await host.stat(resolve(operand, cwd, env), signal, false);
      if (!info) return false;
      if (directoryOnly && !info.directory) return false;
      if (script && !info.file) return false;
    } catch { return false; }
  }
  return true;
}
