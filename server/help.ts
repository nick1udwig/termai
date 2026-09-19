import { probe, SharedTask } from './probes.ts';
import { createHash } from 'node:crypto';
import { access, stat } from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import type { Catalog } from '../src/protocol.ts';
import { commandsFromHelp, flagsFromHelp, requiredFromHelp, type Help } from '../src/engine/help.ts';
import { subcommands } from '../src/engine/command-policy.ts';
const builtins = new Set(['cd', 'echo', 'printf', 'export', 'alias', 'history', 'source', 'jobs', 'fg', 'bg', 'type', 'read', 'pwd', 'set', 'unset', 'umask', 'ulimit', 'pushd', 'popd']);
/** Native help capability. Every route is independently verified on the host. */
export class HelpProvider {
  readonly stats = { helpProbes: 0 };
  private cache = new Map<string, { until: number; value: SharedTask<Help> }>();
  private lifetime = new AbortController();
  dispose() { this.lifetime.abort(); }
  private context(catalog: Catalog, env: NodeJS.ProcessEnv): string {
    const stable = Object.entries(env).filter(([key]) => !/^(?:_|PWD|OLDPWD|SHLVL|LINES|COLUMNS|TERMAI_.*)$/.test(key)).sort(([a], [b]) => a.localeCompare(b));
    return createHash('sha256').update(JSON.stringify([catalog.cwd, stable])).digest('hex');
  }
  async read(command: string, route: string[], catalog: Catalog, env: NodeJS.ProcessEnv, requestSignal: AbortSignal): Promise<Help> {
    const signal = AbortSignal.any([requestSignal, this.lifetime.signal]);
    signal.throwIfAborted();
    if (route.length > 3 || route.some(name => !/^[a-z][\w-]*$/i.test(name))) throw new Error('Invalid help route.');
    let parent = await this.help(command, [], catalog, env, signal);
    for (let i = 0; i < route.length; i++) {
      const scope = [command, ...route.slice(0, i)].join(' ');
      const allowed = command === 'git' && i === 0 ? parent.safeSubcommands || subcommands.git : [...parent.subcommands, ...subcommands[scope] || []];
      if (!allowed.includes(route[i])) throw new Error('Unverified help route.');
      parent = await this.help(command, route.slice(0, i + 1), catalog, env, signal);
    }
    return parent;
  }
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
}
