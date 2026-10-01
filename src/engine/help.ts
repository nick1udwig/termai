import type { Flag } from './types.ts';
export interface Help { flags: Flag[]; subcommands: string[]; required?: number; safeSubcommands?: string[]; probeSubcommands?: string[]; aliases?: Record<string, string> }
export function commandsFromHelp(text: string, scope?: string): string[] {
  const found = new Set<string>();
  let section = false;
  let positional = false;
  for (const line of text.replace(/\x1b\[[0-9;]*m/g, '').split('\n')) {
    // Some CLIs (including Git command groups) enumerate children in usage alternatives.
    const usage = line.replace(/^\s*(?:usage|or):\s*/i, '').trim();
    if (scope && /^\s*(?:usage|or):/i.test(line) && usage.startsWith(scope + ' ')) {
      const child = usage.slice(scope.length + 1).match(/^([a-z][a-z0-9_-]*)(?:\s|$)/)?.[1];
      if (child) found.add(child);
    }
    if (/^\s*(?:[\w /-]+\s+)?(?:subcommands|commands)(?:\s*\([^)]*\))?\s*:?\s*$/i.test(line)) { section = true; positional = false; continue; }
    if (/^\s*positional arguments\s*:/i.test(line)) { positional = true; section = false; continue; }
    if (positional) {
      const choices = line.match(/^\s+\{([a-z][a-z0-9_, -]+)\}/i)?.[1];
      if (choices) for (const name of choices.split(',').map(name => name.trim())) if (/^[a-z][a-z0-9_-]*$/i.test(name)) found.add(name);
      if (/^\S/.test(line)) positional = false;
    }
    if (section && /^\S/.test(line)) section = false;
    if (section) {
      const name = line.match(/^\s{1,8}([a-z][a-z0-9_-]*)(?::\s+\S|\s{2,}\S|\s*$)/i)?.[1];
      if (name) found.add(name);
    }
  }
  return [...found];
}
/** A usage synopsis can advertise a command position without listing its names. */
export function hasCommandSlot(text: string): boolean {
  const lines = text.replace(/\x1b\[[0-9;]*m/g, '').split('\n');
  return lines.some((line, index) => /^\s*usage:/i.test(line) &&
    /[\[<]\s*(?:sub-?)?command(?:s)?\b/i.test([line, ...lines.slice(index + 1, index + 3)].join(' ')));
}
/** Extract command synopses and their aliases from a formatted manual's command reference.
 * Keep the shape strict: prose and examples must not become executable help routes. */
export function commandsFromManual(text: string): string[] {
  const lines = text.replace(/.\x08/g, '').replace(/\x1b\[[0-9;]*m/g, '').split('\n');
  const found = new Set<string>();
  let inCommands = false;
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    if (/^(?:COMMANDS|SUBCOMMANDS|COMMAND REFERENCE|AVAILABLE COMMANDS)\s*$/i.test(line)) { inCommands = true; continue; }
    if (!inCommands || /^(?:KEY BINDINGS|OPTIONS|SEE ALSO|EXAMPLES|FILES|AUTHORS?|BUGS|COPYRIGHT)\s*$/i.test(line)) {
      if (/^(?:KEY BINDINGS|OPTIONS|SEE ALSO|EXAMPLES|FILES|AUTHORS?|BUGS|COPYRIGHT)\s*$/i.test(line)) inCommands = false;
      continue;
    }
    const command = line.match(/^ {4,8}([a-z][a-z0-9-]+)\s+\[(?:[^\n]*)$/);
    if (!command || /^(?:command|subcommand|commands|subcommands)$/.test(command[1])) continue;
    found.add(command[1]);
    for (const continuation of lines.slice(index + 1, index + 4)) {
      if (!/^ {9,24}\S/.test(continuation)) break;
      const aliases = continuation.match(/\(alias(?:es)?:\s*([a-z][a-z0-9-]*(?:\s*,\s*[a-z][a-z0-9-]*)*)\)/i)?.[1];
      if (aliases) for (const alias of aliases.split(',').map(name => name.trim())) found.add(alias);
    }
  }
  return [...found];
}
/** Only infer mandatory operands from a single, simple usage synopsis. */
export function requiredFromHelp(text: string, command: string): number | undefined {
  const line = text.split('\n').find(line => /^usage:/i.test(line.trim()));
  if (!line) return undefined;
  let usage = line.replace(/^\s*usage:\s*/i, '');
  if (!usage.startsWith(command + ' ')) return undefined;
  usage = usage.slice(command.length);
  let depth = 0, required = '';
  for (const char of usage) {
    if (char === '[') { depth++; continue; }
    if (char === ']') { depth--; continue; }
    if (!depth) required += char;
  }
  const operands = required.replace(/\.\.\./g, '').trim().split(/\s+/).filter(Boolean);
  if (depth || !operands.length || operands.some(word => !/^(?:[A-Z][A-Z_0-9-]*|database|key|file|directory|pattern)$/.test(word))) return undefined;
  return operands.length;
}
export function flagsFromHelp(help: string): Flag[] {
  const flags = new Map<string, Flag>();
  for (const line of help.replace(/\x1b\[[0-9;]*m/g, '').split('\n')) {
    if (!/^\s*-/.test(line)) continue;
    const declaration = line.trimStart().split(/\s{2,}/)[0].replace(/--\[no-\]([a-zA-Z][\w-]*)/g, '--$1, --no-$1');
    const entries = [...declaration.matchAll(/(?:^|[\s,|])(--?[a-zA-Z][\w-]*)(?:(?:[ =]|\[=)([A-Z][A-Z_0-9-]*|strings?|ints?|floats?|duration|<[^>]+>|\{[^}]+\})(?=\s|,|\]|$))?/g)];
    const takesValue = entries.some(match => !!match[2] && !match[0].includes('[='));
    for (const match of entries) flags.set(match[1], { name: match[1], takesValue, ...(match[0].includes('[=') ? { optionalValue: true } : {}) });
  }
  return [...flags.values()];
}
