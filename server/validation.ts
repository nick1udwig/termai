import { probe, SharedTask } from './probes.ts';
import { access, stat } from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import type { Candidate, Catalog, Flag } from '../src/protocol.ts';
import { commandNames, commonFlags, optionArity, subcommands, type CommandMetadata } from './repair.ts';
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
const syntaxCache = new Map<string, SharedTask<boolean>>();
export function syntaxValid(command: string, cwd: string, signal = AbortSignal.timeout(4000)): Promise<boolean> {
  signal.throwIfAborted();
  const key = JSON.stringify([cwd, command]);
  const cached = syntaxCache.get(key);
  if (cached && !cached.aborted) return cached.wait(signal);
  if (syntaxCache.size >= 1000) syntaxCache.delete(syntaxCache.keys().next().value!);
  const result = new SharedTask(probeSignal => checkSyntax(command, cwd, probeSignal));
  syntaxCache.set(key, result);
  return result.wait(signal);
}
async function checkSyntax(command: string, cwd: string, signal: AbortSignal): Promise<boolean> {
  try {
    // No startup files, inherited shell functions, or execution. Even substitutions
    // and redirections in this string are only parsed by Bash's noexec mode.
    await probe('/bin/bash', ['--noprofile', '--norc', '-n', '-c', command], {
      cwd, timeout: 1000, maxBuffer: 16384,
      env: { PATH: '/usr/bin:/bin', LC_ALL: 'C', BASH_ENV: '/dev/null', ENV: '/dev/null' },
    }, signal);
    return true;
  } catch { signal.throwIfAborted(); return false; }
}
function resolve(word: Word, cwd: string, env: NodeJS.ProcessEnv): string {
  const value = word.home && (word.value === '~' || word.value.startsWith('~/')) ? path.join(env.HOME || cwd, word.value.slice(1)) : word.value;
  return path.resolve(cwd, value);
}
export async function candidateValid(input: string, candidate: Candidate, catalog: Catalog, env: NodeJS.ProcessEnv,
  metadata: CommandMetadata, scriptFlags?: Flag[], signal = AbortSignal.timeout(4000)): Promise<boolean> {
  if (!await syntaxValid(candidate.command, catalog.cwd, signal)) return false;
  const words = simpleWords(candidate.command);
  // Complex shell expressions get syntax checking only; never evaluate expansions.
  if (!words) return true;
  if (!words.length) return false;
  const command = words[0].value;
  if (!commandNames(input, catalog).includes(command)) {
    if (!command.includes('/')) return false;
    const file = resolve(words[0], catalog.cwd, env);
    try { await access(file, constants.X_OK); if (!(await stat(file)).isFile()) return false; } catch { return false; }
  }
  let cwd = catalog.cwd, scope = command, flags = metadata.flags[command] || commonFlags[command] || [];
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
    const subs = metadata.subcommands[scope] || subcommands[scope] || [];
    if (!literal && subs.length) {
      if (!subs.includes(arg)) return false;
      scope += ' ' + arg; flags = metadata.flags[scope] || commonFlags[scope] || [];
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
  const directoryOnly = ['cd', 'pushd'].includes(command);
  if (directoryOnly && operands.length > 1) return false;
  const inputFiles = ['cat', 'less', 'more', 'head', 'tail', 'file', 'stat', 'wc', 'du', 'ls'].includes(command);
  const script = ['python', 'python3', 'node', 'ruby', 'bash', 'sh'].includes(command) && !words.some(word => ['-c', '-m', '-e', '--eval'].includes(word.value));
  const gitFiles = command === 'git' && scope === 'git add';
  const check = directoryOnly || inputFiles || gitFiles ? operands : script ? operands.slice(0, 1) : [];
  for (const operand of check) {
    signal.throwIfAborted();
    if (operand.value === '-') continue;
    try {
      const info = await stat(resolve(operand, cwd, env));
      if (directoryOnly && !info.isDirectory()) return false;
      if (script && !info.isFile()) return false;
    } catch { return false; }
  }
  return true;
}
