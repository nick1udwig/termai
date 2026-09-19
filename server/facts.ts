import { createHash } from 'node:crypto';
import type { Catalog } from '../src/protocol.ts';
import type { ContextReply, Fact, FactValue } from '../src/facts.ts';
import type { HelpProvider } from './help.ts';
import { describe } from './catalog.ts';
import { localHost } from './host.ts';

interface Source {
  state: { prompt: number; cwd: string; ready: boolean; exited: boolean };
  catalog(): Promise<Catalog>;
  environment(): Promise<NodeJS.ProcessEnv>;
  help: HelpProvider;
}
/** Session-scoped capability boundary. Environment values never leave the host. */
export class Facts {
  private source: Source;
  constructor(source: Source) { this.source = source; }
  private async snapshot() {
    const prompt = this.source.state.prompt;
    const [catalog, env] = await Promise.all([this.source.catalog(), this.source.environment()]);
    if (prompt !== this.source.state.prompt) throw new Error('Shell context changed. Try again.');
    const key = createHash('sha256').update(JSON.stringify([prompt, catalog.cwd, env])).digest('hex');
    return { key, catalog, env, prompt };
  }
  async context(known?: string): Promise<ContextReply> {
    const { key, catalog, env } = await this.snapshot();
    const catalogKey = createHash('sha256').update(JSON.stringify(catalog)).digest('hex');
    return { key, catalogKey, ...(catalogKey === known ? {} : { catalog }), home: env.HOME || '', discoveryKey: createHash('sha256').update(JSON.stringify(Object.entries(env).filter(([key]) => !/^(?:_|PWD|OLDPWD|SHLVL|LINES|COLUMNS|TERMAI_.*)$/.test(key)).sort(([a], [b]) => a.localeCompare(b)))).digest('hex') };
  }
  async read(key: string, operations: unknown, signal: AbortSignal): Promise<FactValue[]> {
    if (!Array.isArray(operations) || operations.length < 1 || operations.length > 64) throw new Error('Use 1–64 fact operations.');
    // Validate the entire batch before starting any work.
    for (const op of operations) {
      if (!op || typeof op !== 'object') throw new Error('Invalid fact operation.');
      if (op.kind === 'stat' || op.kind === 'entries') {
        if (typeof op.path !== 'string' || !op.path.startsWith('/') || op.path.length > 4096 || op.path.includes('\0')) throw new Error('Invalid path.');
        if (op.kind === 'entries' && (!Number.isInteger(op.limit) || op.limit < 1 || op.limit > 10000)) throw new Error('Invalid directory limit.');
      } else if (op.kind === 'syntax' || op.kind === 'help' || op.kind === 'describe') {
        if (typeof op.command !== 'string' || op.command.length > 4000 || /[\x00-\x1f\x7f]/.test(op.command)) throw new Error('Invalid command.');
        if (op.kind === 'help' && (!Array.isArray(op.route) || op.route.length > 3 || op.route.some((name: unknown) => typeof name !== 'string' || !/^[a-z][\w-]*$/i.test(name)))) throw new Error('Invalid help route.');
      } else throw new Error('Unknown fact operation.');
    }
    if (operations.filter(op => op.kind === 'help' || op.kind === 'describe').length > 8 || operations.filter(op => op.kind === 'entries').length > 8) throw new Error('Too many expensive operations.');
    signal.throwIfAborted();
    const snapshot = await this.snapshot();
    if (snapshot.key !== key) throw new Error('Shell context changed. Try again.');
    const { catalog, env, prompt } = snapshot, host = localHost(catalog.cwd);
    const values = await Promise.all((operations as Fact[]).map(async op => {
      signal.throwIfAborted();
      if (op.kind === 'stat') return await host.stat(op.path, signal) || null;
      if (op.kind === 'entries') return host.entries(op.path, op.limit, signal);
      if (op.kind === 'syntax') return host.syntax(op.command, signal);
      if (op.kind === 'help') return this.source.help.read(op.command, op.route, catalog, env, signal);
      return await describe(op.command, catalog.cwd, signal) || null;
    }));
    signal.throwIfAborted();
    if (this.source.state.prompt !== prompt || this.source.state.cwd !== catalog.cwd || this.source.state.exited) throw new Error('Shell context changed. Try again.');
    return values;
  }
}
