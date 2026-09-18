import * as pty from 'node-pty';
import { watch, type FSWatcher } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { WebSocket } from 'ws';
import type { Catalog, ClientMessage, ServerMessage, ShellState } from '../src/protocol.ts';
import { Discovery } from './discovery.ts';
import { Markers } from './markers.ts';
import { initialHistory, pathsIn } from './catalog.ts';
import { prepareHistory } from './suggestions.ts';
import { ShellContext } from './context.ts';
import { Queue } from '../src/queue.ts';
const MAX_REPLAY = 2 * 1024 * 1024;
const MAX_REPLAY_CHUNKS = 16384;
const WINDOW = 128 * 1024;
const RC = `
if [[ -z "$TERMAI_NO_RC" && -f "$HOME/.bashrc" ]]; then source "$HOME/.bashrc"; fi
if [[ -f "$TERMAI_HISTORY_SOURCE" ]]; then history -r "$TERMAI_HISTORY_SOURCE"; fi
export TERMAI_REAL_HISTFILE="$HISTFILE"
HISTFILE=/dev/null
HISTCONTROL=ignorespace:ignoredups
HISTSIZE=1000
set -o history
set -o emacs
bind 'set enable-bracketed-paste on'
bind 'set enable-active-region off'
__termai_prompt() {
  local termai_status=$?
  local termai_functions="$(builtin compgen -A function)" termai_aliases="$(builtin compgen -A alias)"
  local termai_refresh=0 termai_dir
  if [[ "$PATH" != "$__termai_catalog_path" || "$PWD" != "$__termai_catalog_cwd" || "$termai_functions" != "$__termai_catalog_functions" || "$termai_aliases" != "$__termai_catalog_aliases" || $((SECONDS - __termai_catalog_at)) -ge 2 ]]; then
    termai_refresh=1
  else
    local IFS=:
    for termai_dir in $PATH; do
      if [[ "\${termai_dir:-.}" -nt "$TERMAI_COMMANDS_FILE" ]]; then termai_refresh=1; break; fi
    done
  fi
  if ((termai_refresh)); then
    builtin compgen -c > "$TERMAI_COMMANDS_FILE"
    printf '%s\\n' "$termai_functions" > "$TERMAI_FUNCTIONS_FILE"
    __termai_catalog_path="$PATH" __termai_catalog_cwd="$PWD" __termai_catalog_functions="$termai_functions" __termai_catalog_aliases="$termai_aliases" __termai_catalog_at=$SECONDS
  fi
  command env -0 > "$TERMAI_ENV_FILE"
  printf '\\033]777;termai;%s;prompt;%s;%s\\007' "$TERMAI_NONCE" "$termai_status" "$(printf '%s\\0%s' "$PWD" "$(HISTTIMEFORMAT= builtin history 1)" | command base64)"
}
PROMPT_COMMAND=(__termai_prompt)
PS0=$'\\033]777;termai;'"$TERMAI_NONCE"$';busy\\007'
PS1='\\[\\e[38;5;114m\\]\\w\\[\\e[0m\\] $ '
`;
interface Output { seq: number; data: string; bytes: number }
export class Session {
  state: ShellState;
  history: string[] = [];
  discovery = new Discovery();
  socket?: WebSocket;
  private process!: pty.IPty;
  private dir = '';
  private shellContext!: ShellContext;
  private pathsCache?: { cwd: string; at: number; version: number; value: string[] };
  private pathsVersion = 0;
  private outputs = new Queue<Output>();
  private outputBytes = 0;
  private seq = 0;
  private truncated = false;
  private paused = false;
  private pending = new Queue<Output>();
  private outstanding = new Map<number, number>();
  private outstandingBytes = 0;
  private sentSeq = 0;
  private results = new Map<string, Extract<ServerMessage, { type: 'result' }>>();
  private expiry?: ReturnType<typeof setTimeout>;
  private watcher?: FSWatcher;
  private watchedCwd = '';
  private catalogFlight?: { prompt: number; promise: Promise<Catalog> };
  private catalogCache?: { at: number; value: Catalog };
  private baseCommands: string[];
  private lastHistory = '';
  private historyReadAt = 0;
  private historyCwds: Record<string, string> = {};
  private terminalKey = randomBytes(12).toString('hex');
  constructor(cwd: string, baseCommands: string[]) {
    this.state = { cwd, inputRevision: 0, promptRevision: 0, ready: false, prompt: 0, exited: false }; this.baseCommands = baseCommands;
  }
  async start() {
    this.dir = await mkdtemp(path.join(os.tmpdir(), 'termai-'));
    this.shellContext = new ShellContext(this.dir);
    this.history = await initialHistory();
    const rc = path.join(this.dir, 'bashrc');
    await writeFile(rc, RC, { mode: 0o600 });
    const markers = new Markers(this.terminalKey, ({ cwd, code, history }) => {
      const commandCwd = this.state.cwd;
      const hadPrompt = this.state.prompt > 0;
      this.state = { cwd: cwd || this.state.cwd, inputRevision: this.state.inputRevision + 1, promptRevision: this.state.inputRevision + 1, ready: true, prompt: this.state.prompt + 1, exited: false, exitCode: code };
      const line = history.replace(/^\s*\d+\s+/, '').trimEnd();
      if (hadPrompt && history !== this.lastHistory && line && !/^\s/.test(line)) {
        this.updateHistory([...this.history, line].slice(-5000));
        this.historyCwds[line] = commandCwd;
        if (Object.keys(this.historyCwds).length > 1000) delete this.historyCwds[Object.keys(this.historyCwds)[0]];
      }
      this.lastHistory = history; this.catalogCache = undefined;
      if (this.watchedCwd !== this.state.cwd) {
        this.watcher?.close(); this.watchedCwd = this.state.cwd;
        try { this.watcher = watch(this.state.cwd, () => { this.pathsVersion++; this.catalogCache = undefined; }); this.watcher.on('error', () => this.watcher?.close()); } catch { /* Poll on demand if watching is unavailable. */ }
      }
      void this.catalog().then(async catalog => {
        prepareHistory(catalog);
        if (this.state.ready && !this.state.exited) await this.discovery.prewarm(catalog, await this.environment());
      }).catch(() => {});
      this.send({ type: 'state', state: this.state });
    }, () => { this.state.ready = false; this.send({ type: 'state', state: this.state }); });
    this.process = pty.spawn('/bin/bash', ['--noprofile', '--rcfile', rc, '-i'], {
      name: 'xterm-256color', cols: 80, rows: 24, cwd: this.state.cwd,
      env: { ...process.env as Record<string, string>, COLORTERM: 'truecolor',
        TERMAI_ENV_FILE: path.join(this.dir, 'environment'),
        TERMAI_NONCE: this.terminalKey, TERMAI_COMMANDS_FILE: path.join(this.dir, 'commands'),
        TERMAI_FUNCTIONS_FILE: path.join(this.dir, 'functions'),
        TERMAI_HISTORY_SOURCE: process.env.TERMAI_HISTORY_FILE || path.join(os.homedir(), '.bash_history') },
    });
    this.process.onData(data => {
      const visible = markers.feed(data);
      if (!visible) return;
      const output = { seq: ++this.seq, data: visible, bytes: Buffer.byteLength(visible) };
      this.outputs.push(output); this.outputBytes += output.bytes;
      while ((this.outputBytes > MAX_REPLAY || this.outputs.length > MAX_REPLAY_CHUNKS) && this.outputs.length > 1) {
        this.outputBytes -= this.outputs.shift()!.bytes; this.truncated = true;
      }
      if (this.socket) { this.pending.push(output); this.flush(); }
    });
    this.process.onExit(({ exitCode }) => {
      this.state = { ...this.state, exited: true, ready: false, exitCode };
      this.send({ type: 'state', state: this.state });
    });
  }
  private send(message: ServerMessage) {
    if (this.socket?.readyState === 1) this.socket.send(JSON.stringify(message));
  }
  private flush() {
    if (!this.socket || this.socket.readyState !== 1) return;
    while (this.pending.length && this.outstandingBytes < WINDOW) {
      const next = this.pending.shift()!;
      this.send({ type: 'output', seq: next.seq, data: next.data });
      this.sentSeq = next.seq; this.outstanding.set(next.seq, next.bytes); this.outstandingBytes += next.bytes;
    }
    const shouldPause = this.outstandingBytes >= WINDOW || this.pending.length > 0;
    if (shouldPause !== this.paused && !this.state.exited) {
      this.paused = shouldPause;
      if (shouldPause) this.process.pause(); else this.process.resume();
    }
  }
  attach(socket: WebSocket, after: number, expire: () => void) {
    clearTimeout(this.expiry);
    if (this.socket) this.socket.close(4001, 'This shell was opened in another tab.');
    this.socket = socket; this.outstanding.clear(); this.outstandingBytes = 0; this.sentSeq = 0;
    const first = this.outputs.peek()?.seq || 1;
    const gap = after > this.seq || (after > 0 && after < first - 1);
    this.send({ type: 'hello', reset: after === 0 || gap, truncated: (after === 0 && this.truncated) || gap, firstSeq: first });
    this.pending = new Queue([...this.outputs].filter(o => o.seq > (gap ? 0 : after)));
    this.send({ type: 'state', state: this.state }); this.flush();
    socket.on('message', data => {
      if (socket !== this.socket) return;
      try { this.receive(JSON.parse(data.toString())); } catch { socket.close(1008, 'Invalid message'); }
    });
    socket.on('close', () => {
      if (socket !== this.socket) return;
      this.socket = undefined; this.pending.clear(); this.outstanding.clear(); this.outstandingBytes = 0;
      if (this.paused && !this.state.exited) { this.paused = false; this.process.resume(); }
      this.expiry = setTimeout(expire, 60 * 60 * 1000); this.expiry.unref();
    });
  }
  private receive(message: ClientMessage) {
    if (message.type === 'ack' && Number.isSafeInteger(message.seq) && message.seq <= this.sentSeq) {
      for (const [seq, bytes] of this.outstanding) {
        if (seq > message.seq) break;
        this.outstanding.delete(seq); this.outstandingBytes -= bytes;
      }
      this.flush();
    } else if (message.type === 'resize') {
      if (!Number.isInteger(message.cols) || !Number.isInteger(message.rows)) return;
      if (!this.state.exited) this.process.resize(Math.max(2, Math.min(300, message.cols)), Math.max(2, Math.min(120, message.rows)));
    } else if (message.type === 'input' && typeof message.data === 'string' && message.data.length <= 65536) {
      if (!this.state.exited) {
        this.state.inputRevision++;
        if (/[\r\n\x03\x04]/.test(message.data)) { this.state.ready = false; this.send({ type: 'state', state: this.state }); }
        this.process.write(message.data);
      }
    } else if (message.type === 'replace' && typeof message.text === 'string' && typeof message.id === 'string') {
      const accepted = message.id.length <= 100 && this.state.ready && !this.state.exited &&
        message.prompt === this.state.prompt && message.revision === this.state.inputRevision &&
        message.text.length <= 4000 && !/[\x00-\x1f\x7f]/.test(message.text);
      if (accepted) {
        this.state.inputRevision++;
        // Edit Readline without submitting. Revision guards prevent late repairs overwriting input.
        this.process.write(`\x07\x05\x15\x1b[200~${message.text}\x1b[201~`);
      }
      this.send({ type: 'edit-result', id: message.id, accepted, revision: this.state.inputRevision });
    } else if (message.type === 'command' && typeof message.command === 'string' && typeof message.id === 'string') {
      if (message.id.length > 100) return;
      const previous = this.results.get(message.id);
      if (previous) { this.send(previous); return; }
      const accepted = this.state.ready && !this.state.exited && message.prompt === this.state.prompt &&
        message.command.length > 0 && message.command.length <= 4000 && !/[\x00-\x1f\x7f]/.test(message.command);
      const result: Extract<ServerMessage, { type: 'result' }> = { type: 'result', id: message.id, accepted,
        ...(!accepted ? { message: 'The shell is not at the same prompt. Review the command and try again.' } : {}) };
      this.results.set(message.id, result);
      if (this.results.size > 1000) this.results.delete(this.results.keys().next().value!);
      if (accepted) {
        this.state.inputRevision++;
        this.state.ready = false; this.send({ type: 'state', state: this.state });
        // Clear the current Readline buffer, then bracketed-paste the approved line.
        this.process.write(`\x07\x05\x15\x1b[200~${message.command}\x1b[201~\r`);
      }
      this.send(result);
    }
  }
  private updateHistory(next: string[]) {
    if (next.length === this.history.length && next.every((line, i) => line === this.history[i])) return;
    prepareHistory({ history: next }, this.history);
    this.history = next;
  }
  async environment(): Promise<NodeJS.ProcessEnv> {
    return (await this.shellContext.get(this.state.prompt)).environment;
  }
  private async paths(cwd: string) {
    const version = this.pathsVersion, cached = this.pathsCache;
    if (cached?.cwd === cwd && cached.version === version && Date.now() - cached.at < 2000) return cached.value;
    const value = await pathsIn(cwd);
    if (this.state.cwd === cwd && this.pathsVersion === version) this.pathsCache = { cwd, version, at: Date.now(), value };
    return value;
  }
  async catalog(): Promise<Catalog> {
    if (this.catalogCache && Date.now() - this.catalogCache.at < 2000) return { ...this.catalogCache.value, history: this.history };
    const { cwd, prompt } = this.state;
    if (this.catalogFlight?.prompt === prompt) return this.catalogFlight.promise;
    const promise = (async () => {
      if (Date.now() - this.historyReadAt > 10000) {
        this.historyReadAt = Date.now();
        const external = await initialHistory(await this.environment());
        this.updateHistory([...new Set([...external, ...this.history].reverse())].reverse().slice(-5000));
      }
      const [paths, shell] = await Promise.all([this.paths(cwd), this.shellContext.get(prompt)]);
      const value: Catalog = { cwd, paths, commands: shell.commands.length ? shell.commands : this.baseCommands, functions: shell.functions, history: this.history, historyCwds: { ...this.historyCwds } };
      if (this.state.prompt === prompt) this.catalogCache = { at: Date.now(), value };
      return value;
    })();
    this.catalogFlight = { prompt, promise };
    try { return await promise; } finally { if (this.catalogFlight?.promise === promise) this.catalogFlight = undefined; }
  }
  async dispose() {
    this.discovery.dispose();
    this.watcher?.close();
    clearTimeout(this.expiry); this.socket?.close(1000, 'Session ended'); this.socket = undefined;
    if (this.process && !this.state.exited) this.process.kill();
    if (this.dir) await rm(this.dir, { recursive: true, force: true });
  }
}
