import { probe, probePool, SharedTask } from './probes.ts';
import { createHash } from 'node:crypto';
import { access, stat } from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import type { Catalog, Flag } from '../src/protocol.ts';
import { describe, flagsFromHelp } from './catalog.ts';
import { tokens, matches } from './repair.ts';
import { commonFlags, subcommands, optionArity, type CommandMetadata } from './command-policy.ts';
interface Help { flags: Flag[]; subcommands: string[]; required?: number; safeSubcommands?: string[]; aliases?: Record<string, string> }
const builtins = new Set(['cd', 'echo', 'printf', 'export', 'alias', 'history', 'source', 'jobs', 'fg', 'bg', 'type', 'read', 'pwd', 'set', 'unset', 'umask', 'ulimit', 'pushd', 'popd']);
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
    if (/^\s*(?:[\w /-]+\s+)?(?:subcommands|commands)(?:\s*\([^)]*\))?\s*:\s*$/i.test(line)) { section = true; positional = false; continue; }
    if (/^\s*positional arguments\s*:/i.test(line)) { positional = true; section = false; continue; }
    if (positional) {
      const choices = line.match(/^\s+\{([a-z][a-z0-9_, -]+)\}/i)?.[1];
      if (choices) for (const name of choices.split(',').map(name => name.trim())) if (/^[a-z][a-z0-9_-]*$/i.test(name)) found.add(name);
      if (/^\S/.test(line)) positional = false;
    }
    if (section && /^\S/.test(line)) section = false;
    if (section) {
      const name = line.match(/^\s{1,8}([a-z][a-z0-9_-]*)(?:\s{2,}\S|\s*$)/i)?.[1];
      if (name) found.add(name);
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
/** Session-local, bounded help discovery. Only executable + verified subcommand + --help;
 * never evaluate the transcript or forward its arguments to a background process. */
export class Discovery {
  readonly stats = { helpProbes: 0 };
  private cache = new Map<string, { until: number; value: SharedTask<Help> }>();
  private snapshots = new Map<string, { until: number; metadata: CommandMetadata }>();
  private warming = false;
  private closed = false;
  private lifetime = new AbortController();
  private warmed = new Map<string, number>();
  private context(catalog: Catalog, env: NodeJS.ProcessEnv): string {
    const stable = Object.entries(env).filter(([key]) => !/^(?:_|PWD|OLDPWD|SHLVL|LINES|COLUMNS|TERMAI_.*)$/.test(key)).sort(([a], [b]) => a.localeCompare(b));
    return createHash('sha256').update(JSON.stringify([catalog.cwd, stable])).digest('hex');
  }
  cached(catalog: Catalog, env: NodeJS.ProcessEnv): CommandMetadata {
    const key = this.context(catalog, env), entry = this.snapshots.get(key);
    if (!entry || entry.until < Date.now()) return { flags: {}, subcommands: {}, requiredPositionals: {} };
    return { flags: { ...entry.metadata.flags }, subcommands: { ...entry.metadata.subcommands }, requiredPositionals: { ...entry.metadata.requiredPositionals } };
  }
  private remember(metadata: CommandMetadata, catalog: Catalog, env: NodeJS.ProcessEnv) {
    const key = this.context(catalog, env);
    let entry = this.snapshots.get(key);
    if (!entry || entry.until < Date.now()) {
      entry = { until: Date.now() + 600000, metadata: { flags: {}, subcommands: {}, requiredPositionals: {} } };
      if (this.snapshots.size >= 8) this.snapshots.delete(this.snapshots.keys().next().value!);
      this.snapshots.set(key, entry);
    }
    Object.assign(entry.metadata.flags, metadata.flags);
    Object.assign(entry.metadata.subcommands, metadata.subcommands);
    Object.assign(entry.metadata.requiredPositionals!, metadata.requiredPositionals);
  }
  /** Prewarm a small working set from common commands and recent history. */
  async prewarm(catalog: Catalog, env: NodeJS.ProcessEnv) {
    if (this.warming || this.closed) return;
    this.warming = true;
    try {
      const context = this.context(catalog, env);
      const common = ['git', 'git init', 'git add', 'git commit', 'git status', 'ls'];
      const recent = catalog.history.slice(-200).reverse().map(line => {
        const words = tokens(line);
        if (!words.length || /[|&;<>()`$\\]/.test(line) || words[0].value.startsWith('_')) return '';
        // Only prospective command names are kept, never historical argument values.
        return words.slice(0, 4).map(word => word.value).filter((word, index, all) => /^[a-z][\w-]*$/i.test(word) && !all.slice(0, index).some(previous => !/^[a-z][\w-]*$/i.test(previous))).join(' ');
      });
      const recentTargets = [...new Set(recent)].filter(line => line && catalog.commands.includes(tokens(line)[0].value)).slice(0, 10);
      const targets = [...new Set([...common.slice(0, 1), ...recentTargets, ...common.slice(1)])].filter(line => line && catalog.commands.includes(tokens(line)[0].value));
      for (const target of targets) {
        if (this.closed) break;
        const key = context + target;
        if ((this.warmed.get(key) || 0) > Date.now()) continue;
        // Reserve capacity for foreground discovery instead of queuing a large crawl.
        if (probePool.busy) break;
        await this.discover(target, catalog, env);
        this.warmed.set(key, Date.now() + 600000);
        if (this.warmed.size > 200) this.warmed.delete(this.warmed.keys().next().value!);
        await new Promise(resolve => setTimeout(resolve, 20));
      }
    } finally { this.warming = false; }
  }
  dispose() { this.closed = true; this.lifetime.abort(); }
  private async help(command: string, route: string[], catalog: Catalog, env: NodeJS.ProcessEnv, signal: AbortSignal): Promise<Help> {
    signal.throwIfAborted();
    if (!catalog.commands.includes(command) || !/^[\w.+-]+$/.test(command)) return { flags: [], subcommands: [] };
    let executable: string | undefined;
    let stamp = '';
    if (builtins.has(command)) executable = '/bin/bash';
    else for (const dir of (env.PATH || '').split(path.delimiter)) {
      const file = path.resolve(catalog.cwd, dir || '.', command);
      try { await access(file, constants.X_OK); const info = await stat(file); if (info.isFile()) { executable = file; stamp = `${info.mtimeMs}:${info.size}`; break; } } catch { /* Next PATH entry. */ }
    }
    if (!executable) return { flags: [], subcommands: [] }; // aliases/functions still participate in name matching
    signal.throwIfAborted();
    const key = JSON.stringify([executable, command, route, stamp, this.context(catalog, env)]);
    const cached = this.cache.get(key);
    if (cached && cached.until > Date.now() && !cached.value.aborted) return cached.value.wait(signal);
    const value = new SharedTask<Help>(async probeSignal => {
      this.stats.helpProbes++;
      let text = '';
      const args = builtins.has(command) ? ['--noprofile', '--norc', '-c', 'builtin help "$1"', 'termai-help', command] : [...route, command === 'git' && route.length ? '-h' : '--help'];
      try {
        const result = await probe(executable!, args, { cwd: catalog.cwd, timeout: 1500, killSignal: 'SIGKILL', maxBuffer: 128 * 1024,
          env: { ...env, BASH_ENV: '/dev/null', ENV: '/dev/null', NO_COLOR: '1', PAGER: 'cat', GIT_PAGER: 'cat', TERM: 'dumb', LC_ALL: 'C' } }, probeSignal);
        text = result.stdout + '\n' + result.stderr;
      } catch (error: any) {
        probeSignal.throwIfAborted();
        if (!error.killed) text = (error.stdout || '') + '\n' + (error.stderr || '');
      }
      const scope = [command, ...route].join(' ');
      const found: Help = { flags: flagsFromHelp(text), subcommands: commandsFromHelp(text, scope), required: requiredFromHelp(text, scope) };
      if (command === 'git' && !route.length) {
        // Git exposes its actual built-in, extension and alias names without executing them.
        const options = { cwd: catalog.cwd, timeout: 1500, maxBuffer: 128 * 1024, env: { ...env, GIT_PAGER: 'cat', LC_ALL: 'C' } };
        try {
          const all = await probe(executable!, ['--list-cmds=main,others,alias'], options, probeSignal);
          const main = await probe(executable!, ['--list-cmds=main'], options, probeSignal);
          found.subcommands = all.stdout.split('\n').filter(name => /^[\w-]+$/.test(name));
          found.safeSubcommands = main.stdout.split('\n').filter(Boolean);
          try {
            const config = await probe(executable!, ['config', '--get-regexp', '^alias\.'], options, probeSignal);
            found.aliases = {};
            for (const line of config.stdout.split('\n')) {
              const alias = line.match(/^alias\.([\w-]+)\s+([a-z][\w-]*)$/);
              if (alias && found.safeSubcommands.includes(alias[2])) found.aliases[alias[1]] = alias[2];
            }
          } catch { /* No configured aliases. Shell aliases are never evaluated. */ }
        } catch { /* Known schemas remain available on older Git versions. */ }
      }
      probeSignal.throwIfAborted();
      return found;
    });
    if (this.cache.size >= 200) this.cache.delete(this.cache.keys().next().value!);
    this.cache.set(key, { until: Date.now() + 10 * 60 * 1000, value });
    return value.wait(signal);
  }
  async discover(commandLine: string, catalog: Catalog, env: NodeJS.ProcessEnv, requestSignal?: AbortSignal): Promise<{ metadata: CommandMetadata; scriptFlags?: Flag[] }> {
    const signal = AbortSignal.any([this.lifetime.signal, requestSignal || AbortSignal.timeout(4000)]);
    signal.throwIfAborted();
    const deadline = Date.now() + 2500;
    const metadata: CommandMetadata = { flags: {}, subcommands: {}, requiredPositionals: {} };
    if (/[|&;<>()`$\\\n\r]/.test(commandLine)) return { metadata };
    const args = tokens(commandLine).map(t => t.value);
    const command = args[0];
    if (!command) return { metadata };
    const scriptFlags = await describe(commandLine, catalog.cwd, signal);
    if (scriptFlags !== undefined) return { metadata, scriptFlags };
    const words = tokens(commandLine);
    const root = await this.help(command, [], catalog, env, signal);
    const record = (route: string[], help: Help, inherited: Flag[] = []) => {
      const scope = [command, ...route].join(' ');
      metadata.flags[scope] = merge(merge(inherited, commonFlags[scope] || []), help.flags);
      metadata.subcommands[scope] = [...new Set([...(subcommands[scope] || []), ...help.subcommands])];
      if (help.required !== undefined) metadata.requiredPositionals![scope] = help.required;
    };
    record([], root);
    // A simple alias such as c=commit can reuse the real command's schema safely.
    for (const [alias, target] of Object.entries(root.aliases || {})) {
      if (commonFlags[`git ${target}`]) metadata.flags[`git ${alias}`] = merge(metadata.flags.git, commonFlags[`git ${target}`]);
    }
    signal.throwIfAborted();
    this.remember(metadata, catalog, env);
    // Search the command tree using the transcript, not an already-correct parse.
    // Only names learned from a parent are passed to child help; argument values
    // and guessed subcommands are never passed to the executable.
    let branches = [{ route: [] as string[], index: 1, score: 0 }];
    let probes = 1;
    for (let depth = 0; depth < 3 && branches.length && probes < 7 && Date.now() < deadline; depth++) {
      const next: typeof branches = [];
      for (const branch of branches) {
        const scope = [command, ...branch.route].join(' ');
        let index = branch.index;
        while (index < words.length && words[index].value.startsWith('-')) {
          const takes = optionArity(words[index].value, metadata.flags[scope]);
          if (takes === undefined || words[index].value === '--') break;
          index += takes ? 2 : 1;
        }
        const found = matches(words, index, metadata.subcommands[scope] || [], 3);
        for (const match of found.filter(match => match.score >= (found[0]?.score || 0) - 18).slice(0, 2)) {
          const route = [...branch.route, match.value];
          // A Git alias may be arbitrary code and is listed but never help-probed.
          if (command === 'git' && !(root.safeSubcommands || subcommands.git).includes(root.aliases?.[route[0]] || route[0])) continue;
          next.push({ route, index: index + match.consumed, score: branch.score + match.score });
        }
      }
      branches = next.sort((a, b) => b.score - a.score).slice(0, Math.min(2, 7 - probes));
      probes += branches.length;
      const children = await Promise.all(branches.map(branch => {
        const route = command === 'git' && root.aliases?.[branch.route[0]] ? [root.aliases[branch.route[0]], ...branch.route.slice(1)] : branch.route;
        return this.help(command, route, catalog, env, signal);
      }));
      children.forEach((help, index) => {
        const route = branches[index].route;
        record(route, help, metadata.flags[[command, ...route.slice(0, -1)].join(' ')]);
      });
      signal.throwIfAborted();
      this.remember(metadata, catalog, env);
    }
    return { metadata };
  }
}
function merge(base: Flag[] = [], discovered: Flag[]): Flag[] {
  return [...new Map([...base, ...discovered].map(flag => [flag.name, flag])).values()];
}
