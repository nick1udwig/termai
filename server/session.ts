import * as pty from 'node-pty';
import { TRANSFER_SHELL } from './transfer-shell.ts';
import { Transfers } from './transfers.ts';
import { Dictation } from './dictation.ts';
import { watch, type FSWatcher } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { WebSocket } from 'ws';
import type { Catalog, ClientMessage, ServerMessage, ShellState, EngineMode } from '../src/protocol.ts';
import { dictationTarget, type DictationTarget } from '../src/protocol.ts';
import { PasteMode } from './paste-mode.ts';
import { HelpProvider } from './help.ts';
import { Discovery } from './discovery.ts';
import { prepareHistory } from './suggestions.ts';
import { Markers } from './markers.ts';
import { initialHistory, pathsIn } from './catalog.ts';
import { Facts } from './facts.ts';
import { ShellContext } from './context.ts';
import { Queue } from '../src/queue.ts';
import type { SSHHost } from './ssh.ts';
import { directorySnapshot, directoryVersion } from './directories.ts';
import { SSH_WRAPPER_CHECK } from './ssh-capture.ts';
import { READING_SHELL } from './reading-shell.ts';
import { ReadingCaptures } from './reading-captures.ts';
import { COMPLETION_SNAPSHOT } from './completion.ts';
import { HISTORY_SHELL } from './history-shell.ts';
import { HISTORY_ENTRIES, readlineHistorySource } from './history.ts';
import { readForViewing } from './reading.ts';
const MAX_REPLAY = 2 * 1024 * 1024;
const MAX_REPLAY_CHUNKS = 16384;
const WINDOW = 128 * 1024;
const RC = `
if [[ -z "$TERMAI_NO_RC" && -f "$HOME/.bashrc" ]]; then source "$HOME/.bashrc"; fi
set +o history
HISTSIZE=${HISTORY_ENTRIES}
if [[ -f "$TERMAI_HISTORY_SOURCE" ]]; then history -r "$TERMAI_HISTORY_SOURCE"; fi
export TERMAI_REAL_HISTFILE="$HISTFILE"
HISTFILE=/dev/null
HISTCONTROL=ignorespace:ignoredups
set -o emacs
bind 'set enable-bracketed-paste on'
bind 'set enable-active-region off'
__termai_input_line() {
  printf '\\033]777;termai;%s;input-line;%s;%s\\007' "$TERMAI_NONCE" "$(printf '%s' "\${READLINE_LINE:0:READLINE_POINT}" | command base64)" "$(printf '%s' "$READLINE_LINE" | command base64)"
}
bind -x '"\\C-x\\C-r":__termai_input_line'
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
${COMPLETION_SNAPSHOT}
  # Remote programs may leave the cursor above old output. Clear the unused area
  # before drawing our next prompt, without erasing output above or scrollback.
  printf '\\033[J\\033]777;termai;%s;prompt;%s;%s\\007' "$TERMAI_NONCE" "$termai_status" "$(printf '%s\\0%s' "$PWD" "$(HISTTIMEFORMAT= builtin history 1)" | command base64)"
}
${SSH_WRAPPER_CHECK}
${TRANSFER_SHELL}
${READING_SHELL}
${HISTORY_SHELL}
# Readline owns history, completion and pasted text. Inspect its final buffer,
# prefix managed utilities for ignorespace and divert local SSH connections.
__termai_accept() {
  if [[ "$READLINE_LINE" != ' '* ]] && __termai_history_special "$READLINE_LINE"; then
    READLINE_LINE=" $READLINE_LINE"
    READLINE_POINT=$((READLINE_POINT + 1))
  fi
  if [[ "$TERMAI_CAPTURE_SSH" == 1 && "$READLINE_LINE" =~ ^[[:space:]]*(ssh|/usr/bin/ssh)[[:space:]] && ! "$READLINE_LINE" =~ [[:cntrl:]] && \${#READLINE_LINE} -le 4000 ]]; then
    # Preserve custom SSH behavior, but allow wrappers that immediately forward
    # the same arguments (such as reconnect/terminal-cleanup wrappers).
    if [[ "$READLINE_LINE" =~ ^[[:space:]]*ssh[[:space:]] ]]; then
      local termai_kind="$(builtin type -t ssh)"
      if [[ "$termai_kind" == function ]]; then
        __termai_ssh_passthrough || return
      elif [[ "$termai_kind" != file ]]; then
        return
      fi
      local termai_ssh="$(builtin type -P ssh)"
      [[ "$termai_ssh" == /usr/bin/ssh || "$termai_ssh" == /bin/ssh ]] || return
    fi
    [[ "$READLINE_LINE" == [[:space:]]* ]] || builtin history -s "$READLINE_LINE"
    printf '\\r\\n\\033]777;termai;%s;ssh;%s\\007' "$TERMAI_NONCE" "$(printf '%s' "$READLINE_LINE" | command base64)"
    READLINE_LINE= READLINE_POINT=0
  fi
}
bind -x '"\\C-x\\C-t":__termai_accept'
bind '"\\C-m":"\\C-x\\C-t\\C-j"'
PROMPT_COMMAND=(__termai_prompt)
PS0=$'\\033]777;termai;'"$TERMAI_NONCE"$';busy\\007'
PS1='\\[\\e[38;5;114m\\]\\w\\[\\e[0m\\] $ '
set -o history
`;
export interface ShellProcess {
  write(data: string): void; resize(cols: number, rows: number): void; pause(): void; resume(): void; kill(): void;
  onData(callback: (data: string) => void): unknown; onExit(callback: (event: { exitCode: number }) => void): unknown;
}
interface Output { seq: number; data: string; bytes: number }
export class Session {
  private inputLineRequest?: { id: string; prompt: number; revision: number };
  private inputLineTimer?: ReturnType<typeof setTimeout>;
  private rejectInputLine() {
    clearTimeout(this.inputLineTimer);
    const request = this.inputLineRequest; this.inputLineRequest = undefined;
    if (request) this.send({ type: 'input-line', ...request });
  }
  readonly transfers = new Transfers(this);
  private dictation?: Dictation;
  private dictationId?: string;
  private pasteMode = new PasteMode();
  private pasteDictation(text: string, prompt: number, revision: number, target: DictationTarget) {
    if (dictationTarget(this.state) !== target) return false;
    if (target === 'shell') return this.paste(text, prompt, revision, false, 'dictation');
    if (this.state.exited || this.captured || prompt !== this.state.prompt || revision !== this.state.inputRevision || !text || text.length > 16000 || /[\x00-\x1f\x7f-\x9f]/.test(text)) return false;
    this.state.inputRevision++;
    this.process.write(this.pasteMode.paste(text));
    this.send({ type: 'pasted', text, replace: false, source: 'dictation', prompt, revision: this.state.inputRevision });
    return true;
  }
  paste(text: string, prompt: number, revision: number, replace = false, source?: 'dictation') {
    if (!this.state.ready || this.state.exited || this.captured || prompt !== this.state.prompt || revision !== this.state.inputRevision || !text || text.length > 16000 || /[\x00-\x1f\x7f-\x9f]/.test(text)) return false;
    this.state.inputRevision++;
    this.process.write(`${replace ? '\x07\x05\x15' : ''}\x1b[200~${text}\x1b[201~`);
    this.send({ type: 'pasted', text, replace, source, prompt: this.state.prompt, revision: this.state.inputRevision });
    return true;
  }
  readonly streamId = randomBytes(16).toString('hex');
  state: ShellState;
  history: string[] = [];
  help: Pick<HelpProvider, 'read' | 'dispose'> = new HelpProvider();
  readonly remote?: SSHHost;
  facts = new Facts(this);
  readonly engineMode: EngineMode;
  readonly discovery?: Discovery;
  socket?: WebSocket;
  readonly readingCaptures = new ReadingCaptures();
  private readingWork = Promise.resolve();
  private readingJobs = 0;
  private disposed = false;
  captured?: { id: string; command: string };
  private capturedResult?: { id: string; command: string; value: unknown; acknowledged: boolean };
  acknowledgeCapture(id: string) { if (this.capturedResult?.id === id) this.capturedResult.acknowledged = true; this.send({ type: 'ssh-released', id }); }
  captureFlight?: Promise<unknown>;
  captureResult(id: string) { return this.capturedResult?.id === id ? this.capturedResult.value : undefined; }
  releaseCapture(id: string, native = false, value?: unknown) {
    if (this.captured?.id !== id) throw new Error('This SSH request is no longer active.');
    const command = this.captured.command; this.captured = undefined;
    if (value) this.capturedResult = { id, command, value, acknowledged: false };
    this.send({ type: 'ssh-released', id });
    if (native) this.process.write(`\x07\x05\x15\x1b[200~${command}\x1b[201~\x0a`);
  }
  private process!: ShellProcess;
  private dir = '';
  private shellContext!: ShellContext;
  private pathsCache?: { cwd: string; at: number; version: number; prompt: number; directories: Map<string, string>; value: string[] };
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
  private catalogFlight?: { prompt: number; includePaths: boolean; promise: Promise<Catalog> };
  private catalogCache?: { at: number; includePaths: boolean; value: Catalog };
  private baseCommands: string[];
  private lastHistory = '';
  private historyReadAt = 0;
  private historyCwds: Record<string, string> = {};
  private contextTimer?: ReturnType<typeof setTimeout>;
  private contextGeneration = 0;
  private pushedCatalog?: string;
  private pushedDirectories = new Map<string, string>();
  private terminalKey = randomBytes(12).toString('hex');
  readonly filesOnly: boolean;
  constructor(cwd: string, baseCommands: string[], engineMode: EngineMode = 'server', remote?: SSHHost, filesOnly = false) {
    this.filesOnly = filesOnly;
    this.remote = remote;
    if (remote) { engineMode = 'client'; this.help = remote.help; }
    this.engineMode = engineMode;
    if (engineMode === 'server') this.discovery = new Discovery();
    this.state = { cwd, inputRevision: 0, promptRevision: 0, ready: false, prompt: 0, exited: false }; this.baseCommands = baseCommands;
  }
  async start() {
    if (this.filesOnly) { this.state.ready = true; return; }
    let rc = '';
    if (!this.remote) {
      this.dir = await mkdtemp(path.join(os.tmpdir(), 'termai-'));
      this.shellContext = new ShellContext(this.dir);
      this.history = await initialHistory();
      rc = path.join(this.dir, 'bashrc');
      await writeFile(rc, RC, { mode: 0o600 });
    } else this.history = this.remote.history();
    const markers = new Markers(this.terminalKey, ({ cwd, code, history }) => {
      this.rejectInputLine();
      const commandCwd = this.state.cwd;
      const hadPrompt = this.state.prompt > 0;
      this.state = { cwd: cwd || this.state.cwd, inputRevision: this.state.inputRevision + 1, promptRevision: this.state.inputRevision + 1, ready: true, inputTarget: 'shell', prompt: this.state.prompt + 1, exited: false, exitCode: code };
      const line = history.replace(/^\s*\d+\s+/, '').trimEnd();
      if (hadPrompt && history !== this.lastHistory && line && !/^\s/.test(line)) {
        this.updateHistory([...this.history, line].slice(-5000));
        this.historyCwds[line] = commandCwd;
        if (Object.keys(this.historyCwds).length > 1000) delete this.historyCwds[Object.keys(this.historyCwds)[0]];
      }
      this.lastHistory = history; this.catalogCache = undefined;
      if (!this.remote && this.watchedCwd !== this.state.cwd) {
        this.watcher?.close(); this.watchedCwd = this.state.cwd;
        try { this.watcher = watch(this.state.cwd, () => { this.pathsVersion++; this.catalogCache = undefined; }); this.watcher.on('error', () => this.watcher?.close()); } catch { /* Poll on demand if watching is unavailable. */ }
      }
      if (this.discovery) void this.catalog(false).then(async catalog => {
        prepareHistory(catalog);
        if (this.state.ready && !this.state.exited) await this.discovery!.prewarm(catalog, await this.environment());
      }).catch(() => {});
      this.send({ type: 'state', state: this.state });
      void this.pushContext().catch(() => {});
    }, () => { this.state.ready = false; this.state.inputTarget = 'program'; this.send({ type: 'state', state: this.state }); }, command => {
      if (this.remote || this.captured) return;
      this.captured = { id: randomBytes(16).toString('hex'), command };
      this.send({ type: 'ssh-command', ...this.captured });
    }, event => {
      if (event.type === 'file') { this.send({ type: 'reading-file', path: event.path }); return; }
      const file = path.posix.join(this.remote?.readingDirectory || this.dir, event.file);
      const cleanup = () => this.remote ? this.remote.removeReadingCapture(event.file) : rm(file, { force: true });
      if (this.readingJobs >= 16) { void cleanup().catch(() => {}); this.send({ type: 'reading-error', message: 'Too many outputs are waiting for Reading Mode.' }); return; }
      this.readingJobs++;
      this.readingWork = this.readingWork.then(async () => {
        try {
          if (this.disposed) return;
          const result = await readForViewing(this, file);
          if (!this.disposed) this.send({ type: 'reading-capture', ...this.readingCaptures.add(event.name, result.data, event.exitCode) });
        } catch (error) {
          if (!this.disposed) this.send({ type: 'reading-error', message: error instanceof Error ? error.message : 'Could not read command output.' });
        } finally { this.readingJobs--; await cleanup().catch(() => {}); }
      });
    });
    markers.onTransfer = event => {
      this.send({ type: 'transfer', request: this.transfers.add(event, this.remote?.transferDirectory || this.dir) });
    };
    markers.onInputLine = (text, cursor) => {
      clearTimeout(this.inputLineTimer);
      const request = this.inputLineRequest; this.inputLineRequest = undefined;
      if (!request) return;
      const intact = this.state.ready && !this.state.exited && !this.captured && request.prompt === this.state.prompt && request.revision === this.state.inputRevision;
      this.send({ type: 'input-line', ...request, ...(intact ? { text, cursor } : {}) });
    };
    this.process = this.remote ? await this.remote.start(RC, this.terminalKey) : pty.spawn('/bin/bash', ['--noprofile', '--rcfile', rc, '-i'], {
      name: 'xterm-256color', cols: 80, rows: 24, cwd: this.state.cwd,
      env: { ...process.env as Record<string, string>, COLORTERM: 'truecolor',
        TERMAI_TRANSFER_DIR: this.dir,
        TERMAI_CAPTURE_SSH: '1',
        TERMAI_READING_DIR: this.dir,
        TERMAI_ENV_FILE: path.join(this.dir, 'environment'),
        TERMAI_NONCE: this.terminalKey, TERMAI_COMMANDS_FILE: path.join(this.dir, 'commands'),
        TERMAI_FUNCTIONS_FILE: path.join(this.dir, 'functions'),
        TERMAI_COMPLETIONS_FILE: path.join(this.dir, 'completions'),
        TERMAI_HISTORY_SOURCE: await readlineHistorySource() },
    });
    this.process.onData(data => {
      this.pasteMode.feed(data);
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
      this.state = { ...this.state, exited: true, ready: false, inputTarget: undefined, exitCode };
      this.send({ type: 'state', state: this.state });
    });
  }
  private async pushContext() {
    if (this.engineMode !== 'client') return;
    clearTimeout(this.contextTimer);
    const socket = this.socket, prompt = this.state.prompt, generation = ++this.contextGeneration;
    if (!socket || !this.state.ready || this.state.exited) return;
    try {
      const context = await this.facts.context(this.pushedCatalog, false);
      const directories = [];
      for (const dir of new Set([context.catalog?.cwd || this.state.cwd, context.home].filter(Boolean))) {
        const snapshot = this.remote ? await this.remote.snapshot(dir, 10000) : await directorySnapshot(dir, 10000);
        // Prefetch only small complete roots; larger directories stay on demand.
        if (snapshot.complete && snapshot.entries.length <= 1000 && this.pushedDirectories.get(dir) !== snapshot.version) directories.push({ path: dir, snapshot });
      }
      if (socket !== this.socket || generation !== this.contextGeneration || prompt !== this.state.prompt || !this.state.ready) return;
      this.send({ type: 'context', context, directories });
      this.pushedCatalog = context.catalogKey;
      for (const item of directories) this.pushedDirectories.set(item.path, item.snapshot.version);
      if (this.pushedDirectories.size > 8) this.pushedDirectories.delete(this.pushedDirectories.keys().next().value!);
    } finally {
      if (socket === this.socket && generation === this.contextGeneration && this.state.ready && !this.state.exited) {
        this.contextTimer = setTimeout(() => void this.pushContext().catch(() => {}), 2000);
        this.contextTimer.unref();
      }
    }
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
  attach(socket: WebSocket, after: number, expire: () => void, streamId?: string) {
    this.dictation?.cancel(); this.dictation = undefined;
    clearTimeout(this.expiry);
    if (this.socket) this.socket.close(4001, 'This shell was opened in another tab.');
    this.socket = socket; this.pushedCatalog = undefined; this.pushedDirectories.clear(); this.outstanding.clear(); this.outstandingBytes = 0; this.sentSeq = 0;
    const first = this.outputs.peek()?.seq || 1;
    const changed = !!streamId && streamId !== this.streamId;
    const gap = changed || after > this.seq || (after > 0 && after < first - 1);
    this.send({ type: 'hello', streamId: this.streamId, engine: this.engineMode, reset: after === 0 || gap, truncated: ((after === 0 || changed) && this.truncated) || (gap && !changed), firstSeq: first });
    this.pending = new Queue([...this.outputs].filter(o => o.seq > (gap ? 0 : after)));
    this.send({ type: 'state', state: this.state }); this.flush();
    if (this.captured) this.send({ type: 'ssh-command', ...this.captured });
    else if (this.capturedResult && !this.capturedResult.acknowledged) this.send({ type: 'ssh-command', id: this.capturedResult.id, command: this.capturedResult.command });
    for (const request of this.transfers.pending()) this.send({ type: 'transfer', request });
    for (const capture of this.readingCaptures.pending()) this.send({ type: 'reading-capture', ...capture });
    void this.pushContext().catch(() => {});
    socket.on('message', (data, binary) => {
      if (socket !== this.socket) return;
      if (binary) { this.dictation?.audio(Buffer.from(data as Buffer)); return; }
      try { this.receive(JSON.parse(data.toString())); } catch { socket.close(1008, 'Invalid message'); }
    });
    socket.on('close', () => {
      if (socket !== this.socket) return;
      this.dictation?.cancel(); this.dictation = undefined;
      clearTimeout(this.contextTimer); this.contextGeneration++;
      this.socket = undefined; this.pending.clear(); this.outstanding.clear(); this.outstandingBytes = 0;
      if (this.paused && !this.state.exited) { this.paused = false; this.process.resume(); }
      this.expiry = setTimeout(expire, 60 * 60 * 1000); this.expiry.unref();
    });
  }
  private receive(message: ClientMessage) {
    if (message.type === 'dictation') {
      if (typeof message.id !== 'string' || !/^[a-f0-9-]{36}$/.test(message.id)) return;
      if (message.action === 'cancel' && message.id === this.dictationId) { this.dictation?.cancel(); this.dictation = undefined; this.dictationId = undefined; }
      else if (message.action === 'finish' && message.id === this.dictationId) this.dictation?.finish();
      else if (message.action === 'start' && !this.dictation) {
        const prompt = this.state.prompt, revision = this.state.inputRevision;
        const target = dictationTarget(this.state);
        if (!target || this.captured || message.prompt !== prompt || message.revision !== revision || (message.target || 'shell') !== target) {
          this.send({ type: 'dictation', id: message.id, state: 'error', message: target && !this.captured ? 'Terminal input changed. Try dictating again.' : 'Wait for terminal input before dictating.' }); return;
        }
        this.dictationId = message.id;
        this.dictation = new Dictation(text => {
          if (text && !this.pasteDictation(text, prompt, revision, target)) throw new Error('The terminal changed during dictation. No text was inserted.');
        }, (state, message) => {
          const id = this.dictationId!;
          if (state !== 'ready') { this.dictation = undefined; this.dictationId = undefined; }
          this.send({ type: 'dictation', id, state, message });
        });
      }
      return;
    }
    if (message.type === 'input-line' && typeof message.id === 'string' && message.id.length <= 100) {
      if (!this.state.ready || this.state.exited || this.captured || this.inputLineRequest || message.prompt !== this.state.prompt || message.revision !== this.state.inputRevision) {
        this.send({ type: 'input-line', id: message.id, prompt: message.prompt, revision: message.revision }); return;
      }
      this.inputLineRequest = { id: message.id, prompt: message.prompt, revision: message.revision };
      this.inputLineTimer = setTimeout(() => this.rejectInputLine(), 2000); this.inputLineTimer.unref();
      this.process.write('\x18\x12');
    } else if (message.type === 'ack' && Number.isSafeInteger(message.seq) && message.seq <= this.sentSeq) {
      for (const [seq, bytes] of this.outstanding) {
        if (seq > message.seq) break;
        this.outstanding.delete(seq); this.outstandingBytes -= bytes;
      }
      this.flush();
    } else if (message.type === 'resize') {
      if (!Number.isInteger(message.cols) || !Number.isInteger(message.rows)) return;
      if (!this.state.exited) this.process.resize(Math.max(2, Math.min(300, message.cols)), Math.max(2, Math.min(120, message.rows)));
    } else if (message.type === 'input' && typeof message.data === 'string' && message.data.length <= 65536) {
      if (!this.state.exited && !this.captured) {
        this.state.inputRevision++;
        // Ctrl-D may delete a character in Readline. An actual EOF is reported
        // by onExit; it must not strand an editable prompt in the busy state.
        if (/[\r\n\x03]/.test(message.data)) {
          if (this.state.ready) this.state.inputTarget = undefined;
          this.state.ready = false; this.send({ type: 'state', state: this.state });
        }
        this.process.write(message.data);
      }
    } else if (message.type === 'replace' && typeof message.text === 'string' && typeof message.id === 'string') {
      const accepted = message.id.length <= 100 && this.state.ready && !this.state.exited && !this.captured &&
        message.prompt === this.state.prompt && message.revision === this.state.inputRevision &&
        message.text.length <= 4000 && !/[\x00-\x1f\x7f]/.test(message.text);
      if (accepted) {
        this.state.inputRevision++;
        // Edit Readline without submitting. Revision guards prevent late repairs overwriting input.
        this.process.write(`\x07\x05\x15\x1b[200~${message.text}\x1b[201~`);
        // An explicitly cleared line is known again after a reconnect.
        if (!message.text) { this.state.promptRevision = this.state.inputRevision; this.send({ type: 'state', state: this.state }); }
      }
      this.send({ type: 'edit-result', id: message.id, accepted, revision: this.state.inputRevision });
    } else if (message.type === 'command' && typeof message.command === 'string' && typeof message.id === 'string') {
      if (message.id.length > 100) return;
      const previous = this.results.get(message.id);
      if (previous) { this.send(previous); return; }
      const accepted = this.state.ready && !this.state.exited && !this.captured && message.prompt === this.state.prompt &&
        message.command.length > 0 && message.command.length <= 4000 && !/[\x00-\x1f\x7f]/.test(message.command);
      const result: Extract<ServerMessage, { type: 'result' }> = { type: 'result', id: message.id, accepted,
        ...(!accepted ? { message: 'The shell is not at the same prompt. Review the command and try again.' } : {}) };
      this.results.set(message.id, result);
      if (this.results.size > 1000) this.results.delete(this.results.keys().next().value!);
      if (accepted) {
        this.state.inputRevision++;
        this.state.ready = false; this.state.inputTarget = undefined; this.send({ type: 'state', state: this.state });
        // Clear the current Readline buffer, then bracketed-paste the approved line.
        this.process.write(`\x07\x05\x15\x1b[200~${message.command}\x1b[201~\r`);
      }
      this.send(result);
    }
  }
  private updateHistory(next: string[]) {
    if (next.length === this.history.length && next.every((line, i) => line === this.history[i])) return;
    if (this.discovery) prepareHistory({ history: next }, this.history);
    this.history = next;
  }
  async environment(): Promise<NodeJS.ProcessEnv> {
    return (await (this.remote ? this.remote.context(this.state.prompt) : this.shellContext.get(this.state.prompt))).environment;
  }
  private async paths(cwd: string) {
    if (this.remote) return this.remote.paths(cwd);
    const version = this.pathsVersion, cached = this.pathsCache;
    if (cached?.cwd === cwd && cached.version === version && Date.now() - cached.at < 2000) {
      const unchanged = cached.prompt === this.state.prompt || (await Promise.all([...cached.directories].map(async ([dir, stamp]) => await directoryVersion(dir) === stamp))).every(Boolean);
      if (unchanged && this.pathsVersion === version) { cached.prompt = this.state.prompt; return cached.value; }
    }
    const directories = new Map<string, string>();
    let value = await pathsIn(cwd, directories);
    if (cached?.cwd === cwd && cached.value.length === value.length && value.every((entry, i) => entry === cached.value[i])) value = cached.value;
    if (this.state.cwd === cwd && this.pathsVersion === version) this.pathsCache = { cwd, version, prompt: this.state.prompt, directories, at: Date.now(), value };
    return value;
  }
  async catalog(includePaths = true): Promise<Catalog> {
    if (this.catalogCache?.includePaths === includePaths && Date.now() - this.catalogCache.at < 2000) return { ...this.catalogCache.value, history: this.history };
    const { cwd, prompt } = this.state;
    if (this.catalogFlight?.prompt === prompt && this.catalogFlight.includePaths === includePaths) return this.catalogFlight.promise;
    const promise = (async () => {
      if (!this.remote && Date.now() - this.historyReadAt > 10000) {
        this.historyReadAt = Date.now();
        const external = await initialHistory(await this.environment());
        this.updateHistory([...new Set([...external, ...this.history].reverse())].reverse().slice(-5000));
      }
      const [paths, shell] = await Promise.all([includePaths ? this.paths(cwd) : [], this.remote ? this.remote.context(prompt) : this.shellContext.get(prompt)]);
      const value: Catalog = { cwd, paths, commands: shell.commands.length ? shell.commands : this.baseCommands, functions: shell.functions, history: this.history, historyCwds: { ...this.historyCwds } };
      if (this.state.prompt === prompt) this.catalogCache = { at: Date.now(), includePaths, value };
      return value;
    })();
    this.catalogFlight = { prompt, includePaths, promise };
    try { return await promise; } finally { if (this.catalogFlight?.promise === promise) this.catalogFlight = undefined; }
  }
  async dispose() {
    this.rejectInputLine();
    this.dictation?.cancel(); this.dictation = undefined;
    this.transfers.clear();
    this.disposed = true; this.readingCaptures.clear();
    this.discovery?.dispose(); this.help.dispose(); clearTimeout(this.contextTimer); this.contextGeneration++;
    this.watcher?.close();
    clearTimeout(this.expiry); this.socket?.close(1000, 'Session ended'); this.socket = undefined;
    if (this.process && !this.state.exited) this.process.kill();
    await this.remote?.dispose();
    if (this.dir) await rm(this.dir, { recursive: true, force: true });
  }
}
