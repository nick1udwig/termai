import type { Flag } from '../src/protocol.ts';

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

export interface CommandMetadata { flags: Record<string, Flag[]>; subcommands: Record<string, string[]>; requiredPositionals?: Record<string, number> }

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

export const scriptCommands = new Set(['python', 'python3', 'node', 'ruby', 'bash', 'sh']);
export const directoryCommands = new Set(['cd', 'pushd']);
export const inputFileCommands = new Set(['cat', 'less', 'more', 'head', 'tail', 'file', 'stat', 'wc', 'du', 'ls']);
export const inlineScriptOptions = new Set(['-c', '-m', '-e', '--eval']);
const noFlags: Flag[] = [], noCommands: string[] = [];
export function flagsFor(scope: string, metadata: CommandMetadata, fallback = noFlags): Flag[] {
  return metadata.flags[scope] || commonFlags[scope] || fallback;
}
export function subcommandsFor(scope: string, metadata: CommandMetadata): string[] {
  return metadata.subcommands[scope] || subcommands[scope] || noCommands;
}
export function childScope(scope: string, word: string, metadata: CommandMetadata): string | undefined {
  return subcommandsFor(scope, metadata).includes(word) ? scope + ' ' + word : undefined;
}
/** Generation deliberately repairs only the known filename positions. */
export function isPathPosition(args: string[]): boolean {
  return inputFileCommands.has(args[0]) || args[0] === 'cd' ||
    (scriptCommands.has(args[0]) && args.length === 1) || (args[0] === 'git' && args[1] === 'add');
}
