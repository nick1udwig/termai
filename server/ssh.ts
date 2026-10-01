import ssh2, { type ClientChannel, type SFTPWrapper, type Stats } from 'ssh2';
import { createHash } from 'node:crypto';
import { connect as tcpConnect } from 'node:net';
import path from 'node:path';
import type { Catalog, Flag } from '../src/protocol.ts';
import type { DirectorySnapshot, EngineHost } from '../src/engine/index.ts';
import { shellQuote, tokens } from '../src/engine/repair.ts';
import { commandsFromHelp, commandsFromManual, hasCommandSlot, flagsFromHelp, requiredFromHelp, type Help } from '../src/engine/help.ts';
import { subcommands } from '../src/engine/command-policy.ts';
import { sshAddress, type SSHConnection } from '../src/connections.ts';
import { agentIdentities, readIdentity, keyInfo, type SystemSSH, type SystemIdentity } from './system-ssh.ts';
import type { KeyInfo } from '../src/connections.ts';
import { fingerprint, Vault, inspectPrivateKey } from './vault.ts';
import { AST_SCRIPT } from './catalog.ts';
import type { ShellProcess } from './session.ts';
import { COMPLETION_SCRIPT, completionArgs, completionValues, validCompletionWords } from './completion.ts';

export async function routeProbe(input: SSHConnection): Promise<number> {
  const { host, port } = sshAddress(input);
  return new Promise((resolve, reject) => {
    const start = performance.now(), socket = tcpConnect({ host, port });
    socket.setTimeout(2500); socket.once('timeout', () => socket.destroy(new Error('SSH endpoint did not respond.')));
    socket.once('error', reject); socket.once('connect', () => { resolve(performance.now() - start); socket.destroy(); });
  });
}
function bounded<T>(work: Promise<T>, signal = AbortSignal.timeout(4000)): Promise<T> {
  return new Promise((resolve, reject) => {
    const cancel = () => reject(signal.reason);
    if (signal.aborted) cancel(); else signal.addEventListener('abort', cancel, { once: true });
    work.then(resolve, reject).finally(() => signal.removeEventListener('abort', cancel));
  });
}
/** One SSH transport per terminal; PTY and bounded fact channels share its connection. */
export class SSHHost {
  private client = new ssh2.Client();
  key?: KeyInfo;
  private sftp!: SFTPWrapper;
  get files() { return this.sftp; }
  private dir = '';
  get transferDirectory() { return this.dir; }
  home = '';
  cwd = '';
  private initialHistory: string[] = [];
  private contextCache?: { prompt: number; promise: ReturnType<SSHHost['readContext']> };
  private helpCache = new Map<string, { until: number; task: Promise<Help> }>();
  private syntaxCache = new Map<string, boolean>();
  private active = 0;
  private waiters: (() => void)[] = [];
  private closed = false;
  static async connect(input: SSHConnection, vault: Vault, system?: SystemSSH, filesOnly = false) {
    const address = sshAddress(input), target = new SSHHost();
    const known = (await vault.list()).knownHosts.find(item => item.host === address.host && item.port === address.port);
    let key: Buffer | undefined;
    const stored = input.keyId ? (await vault.list()).keys.find(key => key.id === input.keyId) : undefined;
    if (stored?.reference) {
      const reference = stored.reference; let identity: SystemIdentity | undefined;
      if (reference.type === 'file') {
        const parsed = await readIdentity(reference.path, input.passphrase);
        if (!parsed) throw Object.assign(new Error('Unlock the referenced SSH key.'), { needsSecret: true });
        const info = keyInfo(parsed); if (info.fingerprint !== stored.fingerprint) throw new Error('The referenced SSH key has changed. Remove its reference and connect again to select the new identity.');
        identity = { ...info, reference, method: { type: 'publickey', username: address.username, key: parsed } };
      } else {
        const match = (await agentIdentities(reference.path)).find(({ key }) => keyInfo(key).fingerprint === stored.fingerprint);
        if (!match) throw new Error('This SSH identity is not available in the backend agent.');
        identity = { ...keyInfo(match.key), reference, method: { type: 'agent', username: address.username, agent: match.agent } };
      }
      system = { ...address, identities: [identity], known: new Set(), locked: false };
    }
    if (system) { if (!system.identities.length) throw Object.assign(new Error('No unlocked SSH identity is available.'), { needsSecret: system.locked }); }
    else if (input.privateKey !== undefined) {
      if (input.keyId) throw new Error('Choose one SSH key source.');
      inspectPrivateKey(input.privateKey, input.passphrase); key = Buffer.from(input.privateKey);
    } else if (input.keyId) key = await vault.unlock(input.keyId, input.passphrase);
    else if (typeof input.password !== 'string' || !input.password) throw new Error('Choose an SSH key or enter the SSH account password.');
    let observed = '', verified = false, successful: SystemIdentity | undefined, attempt = 0;
    try {
      await new Promise<void>((resolve, reject) => {
        target.client.once('ready', resolve).on('error', reject).connect({ ...address, privateKey: key, passphrase: key ? input.passphrase : undefined, password: key ? undefined : input.password,
          ...(system ? { algorithms: system.hostKeyAlgorithms?.length ? { serverHostKey: system.hostKeyAlgorithms as NonNullable<ssh2.ConnectConfig['algorithms']>['serverHostKey'] } : undefined, authHandler: () => { successful = system!.identities[attempt++]; return successful?.method || false; } } : {}),
          readyTimeout: 12000, keepaliveInterval: 15000, keepaliveCountMax: 3,
          hostVerifier: (raw: Buffer) => { observed = fingerprint(raw as Buffer); verified = known ? observed === known.fingerprint : system?.known.size ? system.known.has(observed) : observed === input.trust; return verified; },
        });
      });
      if (successful) target.key = await vault.reference(address.username + '@' + address.host, successful, successful.reference);
      else target.key = stored;
      if (!known && verified) await vault.trust(address.host, address.port, observed);
      target.sftp = await bounded(new Promise<SFTPWrapper>((resolve, reject) => target.client.sftp((error, sftp) => error ? reject(error) : resolve(sftp))));
      if (filesOnly) {
        target.home = target.cwd = await bounded(new Promise<string>((resolve, reject) => target.sftp.realpath('.', (error, value) => error ? reject(error) : resolve(value))));
        return target;
      }
      const info = await target.exec(`printf '%s\\n%s' "$HOME" "$PWD"`);
      [target.home, target.cwd] = info.stdout.trimEnd().split('\n');
      if (!target.home?.startsWith('/') || !target.cwd?.startsWith('/')) throw new Error('SSH target must provide a POSIX shell and SFTP.');
      target.initialHistory = (await target.readFile(path.posix.join(target.home, '.bash_history')).catch(() => '')).split('\n').filter(line => line && !/^#\d+$/.test(line)).slice(-5000);
      return target;
    } catch (error) {
      target.client.end();
      if (observed && !verified) throw Object.assign(new Error(known || system?.known.size ? 'The SSH host key has changed.' : 'Verify the SSH host fingerprint before connecting.'), { status: 409, fingerprint: observed, changed: !!known || !!system?.known.size });
      if ((error as { level?: string }).level === 'client-authentication' && system?.locked) throw Object.assign(new Error('Unlock the SSH identity to connect.'), { needsSecret: true });
      throw error;
    } finally { key?.fill(0); }
  }
  async exec(command: string, signal = AbortSignal.timeout(4000), pty = false): Promise<{ stdout: string; stderr: string; code: number }> {
    signal.throwIfAborted();
    if (this.closed) throw new Error('SSH connection closed.');
    if (this.active >= 4) await new Promise<void>((resolve, reject) => {
      const cancel = () => { this.waiters = this.waiters.filter(wake => wake !== ready); reject(signal.reason); };
      const ready = () => { signal.removeEventListener('abort', cancel); resolve(); };
      this.waiters.push(ready); signal.addEventListener('abort', cancel, { once: true });
    });
    signal.throwIfAborted(); if (this.closed) throw new Error('SSH connection closed.'); this.active++;
    try { return await new Promise((resolve, reject) => {
      let channel: ClientChannel | undefined, stdout = '', stderr = '', size = 0, settled = false;
      const finish = (error?: Error, code = 0) => { if (settled) return; settled = true; signal.removeEventListener('abort', cancel); error ? reject(error) : resolve({ stdout, stderr, code }); };
      const cancel = () => { channel?.signal('KILL'); channel?.close(); finish(signal.reason); };
      signal.addEventListener('abort', cancel, { once: true });
      this.client.exec(command, { pty }, (error, stream) => {
        if (error) { finish(error); return; } channel = stream;
        if (settled || signal.aborted) { stream.close(); return; }
        const data = (buffer: Buffer, err: boolean) => { size += buffer.length; if (size > 1024 * 1024) { stream.close(); finish(new Error('SSH fact output exceeded its limit.')); } else if (err) stderr += buffer; else stdout += buffer; };
        stream.on('data', (buffer: Buffer) => data(buffer, false)); stream.stderr.on('data', buffer => data(buffer, true));
        stream.on('error', finish); stream.on('close', (code: number) => finish(undefined, code ?? 0));
      });
    }); } finally { this.active--; this.waiters.shift()?.(); }
  }
  private async readFile(file: string, limit = 1024 * 1024): Promise<string> {
    return new Promise((resolve, reject) => {
      let raw = '', size = 0;
      const stream = this.sftp.createReadStream(file);
      const timer = setTimeout(() => stream.destroy(new Error('SSH file read timed out.')), 4000);
      stream.on('data', (chunk: Buffer) => { size += chunk.length; if (size > limit) stream.destroy(new Error('SSH file exceeds limit.')); else raw += chunk; });
      stream.on('error', reject); stream.on('end', () => resolve(raw)); stream.on('close', () => clearTimeout(timer));
    });
  }
  async start(rc: string, nonce: string): Promise<ShellProcess> {
    const result = await this.exec('umask 077; mktemp -d /tmp/termai.XXXXXXXX');
    this.dir = result.stdout.trim();
    if (result.code || !/^\/tmp\/termai\.[a-zA-Z0-9]+$/.test(this.dir)) throw new Error('Cannot create a private SSH shell context.');
    await bounded(new Promise<void>((resolve, reject) => this.sftp.writeFile(this.dir + '/bashrc', rc, { mode: 0o600 }, error => error ? reject(error) : resolve())));
    const variables = { TERMAI_TRANSFER_DIR: this.dir, TERMAI_CAPTURE_SSH: '0', TERMAI_NONCE: nonce, TERMAI_ENV_FILE: this.dir + '/environment', TERMAI_COMMANDS_FILE: this.dir + '/commands', TERMAI_FUNCTIONS_FILE: this.dir + '/functions', TERMAI_COMPLETIONS_FILE: this.dir + '/completions', TERMAI_HISTORY_SOURCE: this.home + '/.bash_history', TERM: 'xterm-256color', COLORTERM: 'truecolor' };
    const command = 'cd ' + shellQuote(this.home) + ' && env ' + Object.entries(variables).map(([k, v]) => k + '=' + shellQuote(v)).join(' ') + ' bash --noprofile --rcfile ' + shellQuote(this.dir + '/bashrc') + ' -i';
    const stream = await bounded(new Promise<ClientChannel>((resolve, reject) => this.client.exec(command, { pty: { term: 'xterm-256color', cols: 80, rows: 24, width: 0, height: 0 } }, (error, stream) => error ? reject(error) : resolve(stream))));
    stream.setEncoding('utf8'); stream.on('error', () => stream.close());
    return { write: data => { stream.write(data); }, resize: (cols, rows) => stream.setWindow(rows, cols, 0, 0),
      pause: () => { stream.pause(); }, resume: () => { stream.resume(); }, kill: () => { stream.close(); },
      onData: callback => { stream.on('data', callback); }, onExit: callback => { stream.once('close', (code: number) => callback({ exitCode: code ?? 0 })); },
    };
  }
  history() { return this.initialHistory; }
  private async readContext() {
    const [commands, functions, raw] = await Promise.all(['commands', 'functions', 'environment'].map(name => this.readFile(this.dir + '/' + name)));
    return { commands: [...new Set(commands.split('\n').filter(Boolean))].sort(), functions: functions.split('\n').filter(Boolean), environment: Object.fromEntries(raw.split('\0').filter(line => line.includes('=')).map(line => { const i = line.indexOf('='); return [line.slice(0, i), line.slice(i + 1)]; })) as NodeJS.ProcessEnv };
  }
  context(prompt: number) {
    if (this.contextCache?.prompt !== prompt) {
      const promise = this.readContext(); this.contextCache = { prompt, promise };
      promise.catch(() => { if (this.contextCache?.promise === promise) this.contextCache = undefined; });
    }
    return this.contextCache.promise;
  }
  private async info(file: string, signal?: AbortSignal): Promise<Stats | undefined> {
    return bounded(new Promise<Stats | undefined>(resolve => this.sftp.stat(file, (error, attrs) => resolve(error ? undefined : attrs))), signal);
  }
  async snapshot(dir: string, limit = 10000, signal?: AbortSignal): Promise<DirectorySnapshot> {
    signal?.throwIfAborted();
    const entries: DirectorySnapshot['entries'] = [];
    const deadline = signal ? AbortSignal.any([signal, AbortSignal.timeout(4000)]) : AbortSignal.timeout(4000);
    const handle = await bounded(new Promise<Buffer | undefined>(resolve => this.sftp.opendir(dir, (error, handle) => { if (handle && deadline.aborted) this.sftp.close(handle, () => {}); resolve(error ? undefined : handle); })), deadline);
    if (!handle) return { entries, complete: false, version: '' };
    let complete = false;
    try {
      while (entries.length < limit) {
        signal?.throwIfAborted();
        const batch = await bounded(new Promise<import('ssh2').FileEntryWithStats[] | false>((resolve, reject) => this.sftp.readdir(handle, (error, list) => (error as Error & { code?: number })?.code === 1 ? resolve(false) : error ? reject(error) : resolve(list))), deadline);
        if (!batch || !batch.length) { complete = true; break; }
        for (const entry of batch) if (entry.filename !== '.' && entry.filename !== '..') {
          if (entries.length >= limit) break;
          entries.push({ name: entry.filename, directory: entry.attrs.isDirectory(), symlink: entry.attrs.isSymbolicLink() });
        }
      }
    } finally { await bounded(new Promise<void>(resolve => this.sftp.close(handle, () => resolve()))).catch(() => {}); }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    return { entries, complete, version: createHash('sha256').update(JSON.stringify(entries)).digest('hex') };
  }
  host(cwd: string, env: NodeJS.ProcessEnv = {}): EngineHost {
    const host: EngineHost = {
      stat: async (file, signal) => { signal?.throwIfAborted(); const info = await this.info(file, signal); signal?.throwIfAborted(); return info ? { file: info.isFile(), directory: info.isDirectory(), executable: info.isFile() && (await this.exec('test -x ' + shellQuote(file), signal)).code === 0 } : undefined; },
      entries: async (dir, limit, signal) => (await this.snapshot(dir, limit, signal)).entries,
      lookup: async (file, signal) => { const info = await host.stat(file, signal); return info ? { info } : { listing: await this.snapshot(path.posix.dirname(file), 10000, signal) }; },
      syntax: async (command, signal) => {
        const key = JSON.stringify([cwd, command]); if (this.syntaxCache.has(key)) return this.syntaxCache.get(key)!;
        const result = await this.exec(`cd ${shellQuote(cwd)} && env -i PATH=/usr/bin:/bin BASH_ENV=/dev/null ENV=/dev/null bash --noprofile --norc -n -c ${shellQuote(command)}`, signal);
        if (this.syntaxCache.size >= 1000) this.syntaxCache.delete(this.syntaxCache.keys().next().value!);
        this.syntaxCache.set(key, result.code === 0); return result.code === 0;
      },
      complete: async (words, signal) => {
        signal.throwIfAborted();
        if (!validCompletionWords(words)) return [];
        const deadline = AbortSignal.any([signal, AbortSignal.timeout(1200)]);
        const variables = { ...env, BASH_ENV: '/dev/null', ENV: '/dev/null', GIT_OPTIONAL_LOCKS: '0', TERMAI_COMPLETIONS_FILE: this.dir + '/completions' };
        const assignments = Object.entries(variables).filter(([key, value]) => /^[a-zA-Z_][\w]*$/.test(key) && typeof value === 'string').map(([key, value]) => key + '=' + shellQuote(value!)).join(' ');
        try {
          const result = await this.exec(`cd ${shellQuote(cwd)} && env ${assignments} bash --noprofile --norc -c ${shellQuote(COMPLETION_SCRIPT)} termai-completion ${completionArgs(words).map(shellQuote).join(' ')}`, deadline);
          return completionValues(result.stdout);
        } catch { signal.throwIfAborted(); return []; }
      },
    }; return host;
  }
  async paths(cwd: string) {
    const signal = AbortSignal.timeout(4000);
    const entries = (await this.snapshot(cwd, 10000, signal)).entries, paths = entries.map(entry => entry.name + (entry.directory ? '/' : ''));
    for (const entry of entries.filter(entry => entry.directory && !entry.name.startsWith('.') && !['node_modules', 'dist', 'venv'].includes(entry.name))) {
      if (paths.length >= 4000) break;
      for (const child of (await this.snapshot(path.posix.join(cwd, entry.name), 4000 - paths.length, signal)).entries) paths.push(entry.name + '/' + child.name + (child.directory ? '/' : ''));
    }
    return paths;
  }
  async describe(command: string, cwd: string, signal: AbortSignal): Promise<Flag[] | undefined> {
    const args = tokens(command).map(token => token.value);
    if (!/^(python|python3)$/.test(args[0]) || !args[1]?.endsWith('.py')) return undefined;
    const file = path.posix.resolve(cwd, args[1]), info = await this.info(file, signal);
    if (!info?.isFile() || info.size > 1024 * 1024) return undefined;
    const result = await this.exec('python3 -I -c ' + shellQuote(AST_SCRIPT) + ' ' + shellQuote(file), signal);
    try { return result.code === 0 ? JSON.parse(result.stdout) : undefined; } catch { return undefined; }
  }
  help = { read: async (command: string, route: string[], catalog: Catalog, env: NodeJS.ProcessEnv, signal: AbortSignal): Promise<Help> => {
    if (!catalog.commands.includes(command) || !/^[\w.+-]+$/.test(command) || route.length > 3) return { flags: [], subcommands: [] };
    let parent = await this.readHelp(command, [], catalog, env, signal);
    for (let i = 0; i < route.length; i++) {
      if (!(command === 'git' && i === 0 ? parent.safeSubcommands || subcommands.git : parent.probeSubcommands ?? parent.subcommands).includes(route[i])) throw new Error('Unverified help route.');
      parent = await this.readHelp(command, route.slice(0, i + 1), catalog, env, signal);
    }
    return parent;
  }, dispose() {} };
  private async readHelp(command: string, route: string[], catalog: Catalog, env: NodeJS.ProcessEnv, signal: AbortSignal): Promise<Help> {
    const key = JSON.stringify([command, route, catalog.cwd, env.HOME, env.PATH, catalog.functions]);
    const cached = this.helpCache.get(key); if (cached && cached.until > Date.now()) return cached.task;
    const task = (async () => {
      const args = [command, ...route, command === 'git' && route.length ? '-h' : '--help'].map(shellQuote).join(' ');
      const result = await this.exec(`cd ${shellQuote(catalog.cwd)} && env -i HOME=${shellQuote(env.HOME || this.home)} PATH=${shellQuote(env.PATH || '/usr/bin:/bin')} BASH_ENV=/dev/null ENV=/dev/null PAGER=cat GIT_PAGER=cat TERM=dumb LC_ALL=C ${args}`, signal);
      const text = result.stdout + '\n' + result.stderr, scope = [command, ...route].join(' ');
      const help: Help = { flags: flagsFromHelp(text), subcommands: commandsFromHelp(text, scope), required: requiredFromHelp(text, scope) };
      if (command !== 'git' && !route.length && !help.subcommands.length && hasCommandSlot(text)) {
        try {
          const manual = await this.exec(`cd ${shellQuote(catalog.cwd)} && env -i PATH=/usr/bin:/bin HOME=${shellQuote(env.HOME || this.home)} MANWIDTH=100 MANPAGER=cat MANOPT= LC_ALL=C /usr/bin/man -P cat -- ${shellQuote(command)}`, signal);
          if (manual.code === 0) {
            help.subcommands = commandsFromManual(manual.stdout);
            if (help.subcommands.length) help.probeSubcommands = [];
          }
        } catch { signal.throwIfAborted(); /* No manual is available on every remote host. */ }
      }
      if (command === 'git') help.safeSubcommands = subcommands.git;
      return help;
    })();
    if (this.helpCache.size >= 200) this.helpCache.delete(this.helpCache.keys().next().value!);
    this.helpCache.set(key, { until: Date.now() + 600000, task }); task.catch(() => { if (this.helpCache.get(key)?.task === task) this.helpCache.delete(key); }); return task;
  }
  async dispose() { if (this.closed) return; if (this.dir) await this.exec('rm -rf -- ' + shellQuote(this.dir)).catch(() => {}); this.closed = true; this.client.end(); for (const wake of this.waiters.splice(0)) wake(); }
}
