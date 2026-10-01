import { createHash } from 'node:crypto';
import type { Catalog } from '../src/protocol.ts';
import type { ContextReply, Fact, FactValue } from '../src/facts.ts';
import type { SSHHost } from './ssh.ts';
import type { HelpProvider } from './help.ts';
import { describe } from './catalog.ts';
import { directorySnapshot } from './directories.ts';
import { localHost } from './host.ts';
import { validCompletionWords } from './completion.ts';

interface Source {
  state: { prompt: number; cwd: string; ready: boolean; exited: boolean };
  catalog(includePaths?: boolean): Promise<Catalog>;
  environment(): Promise<NodeJS.ProcessEnv>;
  help: Pick<HelpProvider, 'read'>;
  remote?: SSHHost;
}
/** Session-scoped capability boundary. Environment values never leave the host. */
export class Facts {
  private source: Source;
  private catalogs = new Map<string, Catalog>();
  constructor(source: Source) { this.source = source; }
  private async snapshot(includePaths = false) {
    const prompt = this.source.state.prompt;
    const [catalog, env] = await Promise.all([this.source.catalog(includePaths), this.source.environment()]);
    if (prompt !== this.source.state.prompt) throw new Error('Shell context changed. Try again.');
    const key = createHash('sha256').update(JSON.stringify([prompt, catalog.cwd, env])).digest('hex');
    return { key, catalog, env, prompt };
  }
  async context(known?: string, includePaths = true): Promise<ContextReply> {
    const { key, catalog: raw, env, prompt } = await this.snapshot(includePaths);
    const catalog = { ...raw, functions: raw.functions || [], historyCwds: raw.historyCwds || {} };
    const catalogKey = createHash('sha256').update(JSON.stringify(catalog)).digest('hex');
    const previous = known && this.catalogs.get(known);
    const data = catalogKey === known ? {} : previous
      ? { base: known, patch: Object.fromEntries(Object.entries(catalog).filter(([field, value]) => JSON.stringify(value) !== JSON.stringify(previous[field as keyof Catalog]))) }
      : { catalog };
    if (!this.catalogs.has(catalogKey)) {
      this.catalogs.set(catalogKey, catalog);
      if (this.catalogs.size > 8) this.catalogs.delete(this.catalogs.keys().next().value!);
    }
    return { key, catalogKey, prompt, pathsIncluded: includePaths, ...data, home: env.HOME || '', discoveryKey: createHash('sha256').update(JSON.stringify(Object.entries(env).filter(([key]) => !/^(?:_|PWD|OLDPWD|SHLVL|LINES|COLUMNS|TERMAI_.*)$/.test(key)).sort(([a], [b]) => a.localeCompare(b)))).digest('hex') };
  }
  async read(key: string, operations: unknown, signal: AbortSignal): Promise<FactValue[]> {
    if (!Array.isArray(operations) || operations.length < 1 || operations.length > 64) throw new Error('Use 1–64 fact operations.');
    // Validate the entire batch before starting any work.
    for (const op of operations) {
      if (!op || typeof op !== 'object') throw new Error('Invalid fact operation.');
      if (op.kind === 'directory' || op.kind === 'stat' || op.kind === 'lookup' || op.kind === 'entries') {
        if (typeof op.path !== 'string' || !op.path.startsWith('/') || op.path.length > 4096 || op.path.includes('\0')) throw new Error('Invalid path.');
        if (op.kind === 'directory' && op.version !== undefined && (typeof op.version !== 'string' || op.version.length > 256)) throw new Error('Invalid directory version.');
        if (op.kind === 'entries' && (!Number.isInteger(op.limit) || op.limit < 1 || op.limit > 10000)) throw new Error('Invalid directory limit.');
      } else if (op.kind === 'completion') {
        if (!validCompletionWords(op.words)) throw new Error('Invalid completion words.');
      } else if (op.kind === 'syntax' || op.kind === 'help' || op.kind === 'describe') {
        if (typeof op.command !== 'string' || op.command.length > 4000 || /[\x00-\x1f\x7f]/.test(op.command)) throw new Error('Invalid command.');
        if (op.kind === 'help' && (!Array.isArray(op.route) || op.route.length > 3 || op.route.some((name: unknown) => typeof name !== 'string' || !/^[a-z][\w-]*$/i.test(name)))) throw new Error('Invalid help route.');
      } else throw new Error('Unknown fact operation.');
    }
    if (operations.filter(op => op.kind === 'help' || op.kind === 'describe' || op.kind === 'completion').length > 8 || operations.filter(op => op.kind === 'entries' || op.kind === 'lookup').length > 8) throw new Error('Too many expensive operations.');
    signal.throwIfAborted();
    const snapshot = await this.snapshot();
    if (snapshot.key !== key) throw new Error('Shell context changed. Try again.');
    const { catalog, env, prompt } = snapshot, host = this.source.remote?.host(catalog.cwd, env) || localHost(catalog.cwd, env);
    for (const op of operations as Fact[]) if (op.kind === 'completion' && !catalog.commands.includes(op.words[0])) throw new Error('Unknown completion command.');
    const values = await Promise.all((operations as Fact[]).map(async op => {
      signal.throwIfAborted();
      if (op.kind === 'directory') {
        const snapshot = this.source.remote ? await this.source.remote.snapshot(op.path, 10000, signal) : await directorySnapshot(op.path, 10000, signal);
        return snapshot.version && snapshot.version === op.version
          ? { version: snapshot.version, complete: snapshot.complete } : snapshot;
      }
      if (op.kind === 'lookup') return host.lookup(op.path, signal);
      if (op.kind === 'stat') return await host.stat(op.path, signal) || null;
      if (op.kind === 'entries') return host.entries(op.path, op.limit, signal);
      if (op.kind === 'syntax') return host.syntax(op.command, signal);
      if (op.kind === 'completion') return host.complete!(op.words, signal);
      if (op.kind === 'help') return this.source.help.read(op.command, op.route, catalog, env, signal);
      return await (this.source.remote ? this.source.remote.describe(op.command, catalog.cwd, signal) : describe(op.command, catalog.cwd, signal)) || null;
    }));
    signal.throwIfAborted();
    if (this.source.state.prompt !== prompt || this.source.state.cwd !== catalog.cwd || this.source.state.exited) throw new Error('Shell context changed. Try again.');
    return values;
  }
}
