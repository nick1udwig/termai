import type { Catalog, Flag } from './types.ts';
import type { Environment, MetadataDiscovery } from './host.ts';
import type { Help } from './help.ts';
import { tokens, matches } from './repair.ts';
import { commonFlags, subcommands, optionArity, type CommandMetadata } from './command-policy.ts';
export interface DiscoveryIO {
  help(command: string, route: string[], catalog: Catalog, env: Environment, signal: AbortSignal): Promise<Help>;
  describe(command: string, catalog: Catalog, env: Environment, signal: AbortSignal): Promise<Flag[] | undefined>;
  busy?(): boolean;
}
/** Session-owned metadata cache and bounded search of the host's command tree. */
export class Discovery {
  private io?: DiscoveryIO;
  constructor(io?: DiscoveryIO) { this.io = io; }
  /** Bind I/O to a repair while retaining this session's learned metadata. */
  forHost(io: DiscoveryIO): MetadataDiscovery {
    return { cached: (catalog, env) => this.cached(catalog, env),
      discover: (command, catalog, env, signal) => this.discover(command, catalog, env, signal, io) };
  }
  private snapshots = new Map<string, { until: number; metadata: CommandMetadata }>();
  private warming = false;
  private closed = false;
  private lifetime = new AbortController();
  private warmed = new Map<string, number>();
  private context(catalog: Catalog, env: Environment): string {
    const stable = Object.entries(env).filter(([key]) => !/^(?:_|PWD|OLDPWD|SHLVL|LINES|COLUMNS|TERMAI_.*)$/.test(key)).sort(([a], [b]) => a.localeCompare(b));
    return JSON.stringify([catalog.cwd, stable]);
  }
  cached(catalog: Catalog, env: Environment): CommandMetadata {
    const key = this.context(catalog, env), entry = this.snapshots.get(key);
    if (!entry || entry.until < Date.now()) return { flags: {}, subcommands: {}, requiredPositionals: {} };
    return { flags: { ...entry.metadata.flags }, subcommands: { ...entry.metadata.subcommands }, requiredPositionals: { ...entry.metadata.requiredPositionals } };
  }
  private remember(metadata: CommandMetadata, catalog: Catalog, env: Environment) {
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
  async prewarm(catalog: Catalog, env: Environment) {
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
        if (this.io?.busy?.()) break;
        await this.discover(target, catalog, env);
        this.warmed.set(key, Date.now() + 600000);
        if (this.warmed.size > 200) this.warmed.delete(this.warmed.keys().next().value!);
        await new Promise(resolve => setTimeout(resolve, 20));
      }
    } finally { this.warming = false; }
  }
  dispose() { this.closed = true; this.lifetime.abort(); }
  async discover(commandLine: string, catalog: Catalog, env: Environment, requestSignal?: AbortSignal, io = this.io): Promise<{ metadata: CommandMetadata; scriptFlags?: Flag[] }> {
    if (!io) throw new Error('Discovery requires a host adapter.');
    const signal = AbortSignal.any([this.lifetime.signal, requestSignal || AbortSignal.timeout(4000)]);
    signal.throwIfAborted();
    const deadline = Date.now() + 2500;
    const metadata: CommandMetadata = { flags: {}, subcommands: {}, requiredPositionals: {} };
    if (/[|&;<>()`$\\\n\r]/.test(commandLine)) return { metadata };
    const args = tokens(commandLine).map(t => t.value);
    const command = args[0];
    if (!command) return { metadata };
    const scriptFlags = /^(python|python3)$/.test(command) && args[1]?.endsWith('.py')
      ? await io.describe(commandLine, catalog, env, signal) : undefined;
    if (scriptFlags !== undefined) return { metadata, scriptFlags };
    const words = tokens(commandLine);
    const root = await io.help(command, [], catalog, env, signal);
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
        return io.help(command, route, catalog, env, signal);
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
