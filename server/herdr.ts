import { connect } from 'node:net';
import { spawn } from 'node:child_process';
import { shellQuote } from '../src/engine/repair.ts';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Readable, Duplex, Writable } from 'node:stream';
import type { SSHHost } from './ssh.ts';
import { HerdrTerminalStream, type TerminalSize, type TerminalStream } from './herdr-terminal-stream.ts';
import { Dictation } from './dictation.ts';
import type { ServerMessage, ShellState } from '../src/protocol.ts';
import { WebSocket } from 'ws';
import { herdrSession, herdrName, type HerdrAgent, type HerdrMessage, type HerdrSnapshot, type HerdrStatus } from '../src/herdr-protocol.ts';

const MAX_LINE = 8 * 1024 * 1024;
export function herdrSocket(session = '', env = process.env): string {
  session = herdrSession(session);
  if (!session && env.HERDR_SOCKET_PATH) return env.HERDR_SOCKET_PATH;
  const config = path.join(env.XDG_CONFIG_HOME || path.join(env.HOME || os.homedir(), '.config'), 'herdr');
  return path.join(config, ...(session ? ['sessions', session] : []), 'herdr.sock');
}
function lines(socket: Readable, consume: (value: any) => void, fail: (error: Error) => void) {
  let pending = ''; socket.setEncoding?.('utf8');
  socket.on('data', (data: string) => {
    pending += data;
    if (Buffer.byteLength(pending) > MAX_LINE) { fail(new Error('Herdr response exceeded its limit.')); return; }
    let index;
    while ((index = pending.indexOf('\n')) !== -1) {
      const line = pending.slice(0, index); pending = pending.slice(index + 1);
      if (!line.trim()) continue;
      try { consume(JSON.parse(line)); } catch (error) { fail(error instanceof Error ? error : new Error('Invalid Herdr response.')); return; }
    }
  });
}
export interface HerdrTarget { session: string; remote?: SSHHost; socketPath?: string; binary?: string; env?: NodeJS.ProcessEnv }
export type HerdrServer = string | HerdrTarget;
async function openHerdr(target: HerdrServer): Promise<Duplex> {
  const context = typeof target === 'string' ? { session: target } : target;
  if (context.remote) return context.remote.openUnix(context.socketPath || herdrSocket(context.session, { HOME: context.remote.home }));
  const socket = connect(context.socketPath || herdrSocket(context.session));
  await new Promise<void>((resolve, reject) => { socket.once('connect', resolve); socket.once('error', () => reject(new Error('Cannot connect to Herdr. Start its server on this machine first.'))); });
  return socket;
}
export async function herdrRequest(session: HerdrServer, method: string, params: object = {}): Promise<any> {
  const socket = await openHerdr(session);
  return new Promise((resolve, reject) => {
    const id = randomUUID(); let settled = false;
    const finish = (error?: Error, result?: any) => {
      if (settled) return; settled = true; clearTimeout(timer); socket.destroy(); error ? reject(error) : resolve(result);
    };
    const timer = setTimeout(() => finish(new Error('Herdr did not respond.')), 5000);
    socket.write(JSON.stringify({ id, method, params }) + '\n');
    socket.on('error', () => finish(new Error('Cannot connect to Herdr. Start its server on this backend first.')));
    socket.on('close', () => finish(new Error('Herdr disconnected before responding.')));
    lines(socket, reply => {
      if (reply.id !== id) return;
      if (reply.error) finish(new Error(reply.error.message || 'Herdr rejected the action.'));
      else finish(undefined, reply.result);
    }, error => finish(error));
  });
}
export function normalizeHerdrSnapshot(raw: any): HerdrSnapshot {
  const snapshot = raw?.snapshot;
  if (!snapshot || !Array.isArray(snapshot.agents) || !Array.isArray(snapshot.tabs) || !Array.isArray(snapshot.workspaces)) throw new Error('This Herdr server does not provide a session snapshot.');
  const workspaces = new Map<string, string>(snapshot.workspaces.map((w: any) => [w.workspace_id, w.label || `Workspace ${w.number || ''}`]));
  const tabs = new Map<string, any>(snapshot.tabs.map((t: any) => [t.tab_id, t]));
  const panes = new Map<string, any>((snapshot.panes || []).map((p: any) => [p.pane_id, p]));
  const agents: HerdrAgent[] = snapshot.agents.filter((a: any) => typeof a.terminal_id === 'string' && typeof a.pane_id === 'string').slice(0, 256).map((a: any) => ({
    terminalId: a.terminal_id, paneId: a.pane_id, workspaceId: a.workspace_id, tabId: a.tab_id, workspace: workspaces.get(a.workspace_id) || 'Workspace',
    name: panes.get(a.pane_id)?.label || a.title || panes.get(a.pane_id)?.title || a.name || a.terminal_title_stripped || panes.get(a.pane_id)?.terminal_title_stripped || tabs.get(a.tab_id)?.label || a.display_agent || a.agent || 'Agent', kind: a.display_agent || a.agent || 'Terminal',
    status: (['idle', 'working', 'blocked', 'done'].includes(a.agent_status) ? a.agent_status : 'unknown') as HerdrStatus,
    sequence: Number.isSafeInteger(a.state_change_seq) ? a.state_change_seq : a.revision || 0,
    ...(Number.isSafeInteger(a.completion_seq) ? { completion: a.completion_seq } : {}), cwd: a.foreground_cwd || a.cwd || '',
  }));
  const terminals = [...panes.values()].filter(p => typeof p.terminal_id === 'string').slice(0, 256).map(p => agents.find(a => a.terminalId === p.terminal_id) || ({
    terminalId: p.terminal_id, paneId: p.pane_id, workspaceId: p.workspace_id, tabId: p.tab_id,
    workspace: workspaces.get(p.workspace_id) || 'Workspace', name: p.label || p.title || p.terminal_title_stripped || tabs.get(p.tab_id)?.label || 'Terminal',
    kind: 'Terminal', status: 'idle' as const, sequence: p.revision || 0, cwd: p.foreground_cwd || p.cwd || '',
  }));
  // Older servers/fixtures may omit pane records for detected agents.
  for (const agent of agents) if (!terminals.some(t => t.terminalId === agent.terminalId)) terminals.push(agent);
  const spaces = snapshot.workspaces.map((w: any) => {
    const members = terminals.filter(t => t.workspaceId === w.workspace_id);
    const focused = [...panes.values()].find(p => p.workspace_id === w.workspace_id && p.tab_id === w.active_tab_id && p.focused);
    return { id: w.workspace_id, name: workspaces.get(w.workspace_id)!, terminalIds: members.map(t => t.terminalId), selectedTerminalId: focused?.terminal_id || members.find(t => t.tabId === w.active_tab_id)?.terminalId || members[0]?.terminalId };
  });
  return { version: snapshot.version, protocol: snapshot.protocol, agents, terminals, spaces };
}
export async function herdrSnapshot(session: HerdrServer) { return normalizeHerdrSnapshot(await herdrRequest(session, 'session.snapshot')); }
export async function herdrOptions(session: HerdrServer) {
  const response = await herdrRequest(session, 'server.agent_manifests');
  return { kinds: [...new Set<string>((response.manifests || []).map((m: any) => m.agent).filter((kind: any) => typeof kind === 'string' && /^[a-z][a-z0-9_-]{0,63}$/.test(kind)))] };
}
export async function herdrAction(session: HerdrServer, input: Record<string, unknown>) {
  const snapshot = await herdrSnapshot(session);
  if (input.action === 'create') {
    const name = herdrName(input.name);
    if (typeof input.kind !== 'string' || !(await herdrOptions(session)).kinds.includes(input.kind)) throw new Error('Choose a supported agent type.');
    const space = snapshot.spaces?.find(space => space.id === input.workspaceId);
    if (!space) throw new Error('Choose an existing space.');
    if (input.cwd !== undefined && (typeof input.cwd !== 'string' || input.cwd.length > 4096 || !input.cwd.startsWith('/') || /[\x00-\x1f\x7f]/.test(input.cwd))) throw new Error('Enter an absolute working directory.');
    const created = await herdrRequest(session, 'tab.create', { workspace_id: space.id, label: name, focus: false, ...(input.cwd ? { cwd: input.cwd } : {}) });
    const pane = created.root_pane;
    if (typeof pane?.pane_id !== 'string' || typeof pane.terminal_id !== 'string') throw new Error('Herdr created a tab but did not return its terminal. Open it from spaces.');
    try {
      await herdrRequest(session, 'pane.rename', { pane_id: pane.pane_id, label: name });
      await herdrRequest(session, 'agent.start', { pane_id: pane.pane_id, name: 'agent-' + randomUUID().replaceAll('-', '').slice(0, 20), kind: input.kind, args: [] });
      return { terminalId: pane.terminal_id };
    } catch (error) {
      // Keep the new terminal reviewable. Never retry an uncertain agent launch.
      return { terminalId: pane.terminal_id, error: (error as Error).message };
    }
  }
  if (input.action === 'rename-space' || input.action === 'close-space') {
    const space = snapshot.spaces?.find(space => space.id === input.workspaceId);
    if (!space) throw new Error('This space has closed.');
    if (input.action === 'close-space') return herdrRequest(session, 'workspace.close', { workspace_id: space.id, close_group: false });
    return herdrRequest(session, 'workspace.rename', { workspace_id: space.id, label: herdrName(input.name) });
  }
  if (typeof input.terminalId !== 'string') throw new Error('Choose an agent.');
  const agent = (snapshot.terminals || snapshot.agents).find(agent => agent.terminalId === input.terminalId);
  if (!agent) throw new Error('This agent has ended.');
  if (input.action === 'rename') return herdrRequest(session, 'pane.rename', { pane_id: agent.paneId, label: herdrName(input.name) });
  if (input.action === 'close') return herdrRequest(session, 'pane.close', { pane_id: agent.paneId });
  throw new Error('Unknown Herdr action.');
}

/** Metadata remains connected while the user views other workspace tabs. */
export class HerdrConnection {
  private subscription?: Duplex;
  private closed = false;
  private refreshing = false;
  private refreshAgain = false;
  private refreshTimer?: ReturnType<typeof setTimeout>;
  private reconnectTimer?: ReturnType<typeof setTimeout>;
  private poll: ReturnType<typeof setInterval>;
  private generation = 0;
  private subscribedPanes = '';
  private sink: (message: HerdrMessage) => void;
  private target: HerdrServer;
  constructor(ws: WebSocket | ((message: HerdrMessage) => void), target: HerdrServer) {
    this.sink = typeof ws === 'function' ? ws : message => deliver(ws, message); this.target = target;
    if (typeof ws !== 'function') { ws.on('close', () => this.dispose()); ws.on('error', () => this.dispose()); }
    this.subscribe(); this.poll = setInterval(() => this.refresh(), 10000); this.poll.unref();
  }
  private send(message: HerdrMessage) { this.sink(message); }
  private subscribe() {
    if (this.closed) return;
    const generation = ++this.generation;
    void herdrSnapshot(this.target).then(async snapshot => {
      const socket = await openHerdr(this.target);
      if (this.closed || generation !== this.generation) { socket.destroy(); return; }
      this.subscription?.destroy(); this.subscription = socket; this.subscribedPanes = paneKey(snapshot);
      socket.on('error', () => {});
      socket.on('close', () => { if (!this.closed && this.subscription === socket) this.reconnectTimer = setTimeout(() => this.subscribe(), 2000); });
      lines(socket, reply => {
        if (reply.error) { this.send({ type: 'error', message: reply.error.message || 'Herdr rejected status subscriptions.' }); socket.destroy(); return; }
        if (!this.refreshTimer) this.refreshTimer = setTimeout(() => { this.refreshTimer = undefined; this.refresh(); }, 40);
      }, () => socket.destroy());
      socket.write(JSON.stringify({ id: 'events', method: 'events.subscribe', params: { subscriptions: [
        ...['pane.agent_detected', 'pane.updated', 'pane.created', 'pane.closed', 'pane.moved', 'tab.created', 'tab.closed', 'tab.renamed', 'workspace.created', 'workspace.closed', 'workspace.renamed'].map(type => ({ type })),
        ...snapshot.agents.map(agent => ({ type: 'pane.agent_status_changed', pane_id: agent.paneId })),
      ] } }) + '\n');
    }).catch(error => {
      if (this.closed || generation !== this.generation) return;
      this.send({ type: 'error', message: error.message }); this.reconnectTimer = setTimeout(() => this.subscribe(), 2000);
    });
  }
  private refresh() {
    if (this.closed) return;
    if (this.refreshing) { this.refreshAgain = true; return; }
    this.refreshing = true;
    void herdrSnapshot(this.target).then(snapshot => {
      if (this.closed) return; this.send({ type: 'snapshot', snapshot });
      if (paneKey(snapshot) !== this.subscribedPanes) this.subscribe();
    }).catch(error => this.send({ type: 'error', message: error.message })).finally(() => {
      this.refreshing = false; if (this.refreshAgain) { this.refreshAgain = false; this.refresh(); }
    });
  }
  dispose() {
    if (this.closed) return; this.closed = true; ++this.generation; this.subscription?.destroy();
    clearTimeout(this.refreshTimer); clearTimeout(this.reconnectTimer); clearInterval(this.poll);
  }
}
/** Shared history, input and gestures; visible mobile viewers resize the PTY. */
export class HerdrTerminalConnection {
  private ws: WebSocket;
  private target: HerdrServer;
  private agent: HerdrAgent;
  private closed = false;
  private timer?: ReturnType<typeof setTimeout>;
  private screen = '';
  private terminal: ReturnType<HerdrTerminalStream['subscribe']>;
  private heartbeat: ReturnType<typeof setInterval>;
  private alive = true;
  private first = true;
  private inputWork = Promise.resolve();
  private pendingInputs = 0;
  private dictation?: Dictation;
  private dictationId = '';
  private state: ShellState;
  constructor(ws: WebSocket, target: HerdrServer, agent: HerdrAgent) {
    this.ws = ws; this.target = target; this.agent = agent;
    this.state = { cwd: agent.cwd, ready: false, inputTarget: 'program', terminalScroll: true, exited: false, prompt: 1, promptRevision: 0, inputRevision: 0 };
    this.send({ type: 'state', state: this.state });
    ws.on('message', (bytes, binary) => {
      if (binary) { this.dictation?.audio(Buffer.from(bytes as Buffer)); return; }
      try { this.receive(JSON.parse(bytes.toString())); } catch { ws.close(1008, 'Invalid terminal message'); }
    });
    ws.on('close', () => this.dispose()); ws.on('error', () => this.dispose());
    this.terminal = terminalStream(target, agent.terminalId).subscribe(message => this.send(message));
    ws.on('pong', () => { this.alive = true; });
    this.heartbeat = setInterval(() => {
      if (!this.alive) { ws.terminate(); return; }
      this.alive = false; if (ws.readyState === WebSocket.OPEN) ws.ping();
    }, 30000); this.heartbeat.unref();
    void this.read();
  }
  private send(message: ServerMessage) { deliver(this.ws, message); }
  private async read() {
    try {
      const response = await herdrRequest(this.target, 'pane.read', { pane_id: this.agent.paneId, source: 'recent_unwrapped', lines: 1000, format: 'ansi', strip_ansi: false });
      if (this.closed) return;
      const result = response.read;
      if (typeof result?.text !== 'string') throw new Error('Herdr did not return terminal history. Update Herdr to a version supporting recent-unwrapped reads.');
      if (this.first || result.text !== this.screen) {
        this.screen = result.text; this.first = false;
        this.send({ type: 'screen', text: result.text });
      }
    } catch (error) {
      if (!this.closed) { this.send({ type: 'reading-error', message: (error as Error).message }); this.ws.close(1011, 'Herdr terminal unavailable'); }
    } finally { if (!this.closed) this.timer = setTimeout(() => void this.read(), 150); }
  }
  private input(text: string, paste = false, validate = () => {}): Promise<void> {
    if (typeof text !== 'string' || text.length > 16000 || this.pendingInputs >= 128) return Promise.reject(new Error('Terminal input exceeded its limit.'));
    this.pendingInputs++;
    const task = this.inputWork.then(async () => {
      if (this.closed) throw new Error('The agent view changed. No input was sent.');
      const snapshot = await herdrSnapshot(this.target);
      const current = (snapshot.terminals || snapshot.agents).find(agent => agent.terminalId === this.agent.terminalId);
      if (!current || current.paneId !== this.agent.paneId || this.closed) throw new Error('This agent ended or moved. Reopen its tab. No input was sent.');
      validate();
      await herdrRequest(this.target, paste ? 'pane.send_input' : 'pane.send_text', { pane_id: this.agent.paneId, text });
    });
    this.inputWork = task.catch(() => {}).finally(() => { this.pendingInputs--; });
    return task;
  }
  private receive(message: any) {
    if (message.type === 'ack') return;
    if (message.type === 'resize') {
      if (!Number.isInteger(message.cols) || !Number.isInteger(message.rows) || message.cols < 1 || message.rows < 1 || message.cols > 1000 || message.rows > 1000 || message.mobile !== undefined && typeof message.mobile !== 'boolean') throw new Error('Invalid terminal size');
      this.terminal.resize(message.mobile === true ? { cols: message.cols, rows: message.rows } : undefined);
      return;
    }
    if (message.type === 'terminal-scroll') {
      if (!Number.isInteger(message.lines) || !message.lines || Math.abs(message.lines) > 100 || !Number.isInteger(message.column) || !Number.isInteger(message.row) || message.column < 0 || message.row < 0 || message.column >= 1000 || message.row >= 1000) throw new Error('Invalid terminal scroll');
      void this.terminal.scroll(message).catch(error => this.send({ type: 'reading-error', message: error.message }));
      return;
    }
    if (message.type === 'input') {
      if (typeof message.data !== 'string' || message.data.length > 16000) throw new Error('Invalid input');
      this.state.inputRevision++;
      void this.input(message.data).catch(error => this.send({ type: 'reading-error', message: error.message }));
    } else if (message.type === 'command') {
      const valid = typeof message.command === 'string' && !!message.command.trim() && message.command.length <= 16000 && !/[\x00-\x1f\x7f]/.test(message.command) && typeof message.id === 'string' && message.id.length <= 100;
      if (!valid) throw new Error('Invalid command');
      this.state.inputRevision++;
      void this.input(message.command + '\r').then(() => this.send({ type: 'result', id: message.id, accepted: true }), error => this.send({ type: 'result', id: message.id, accepted: false, message: error.message }));
    } else if (message.type === 'dictation') {
      if (typeof message.id !== 'string' || message.id.length > 100) throw new Error('Invalid dictation');
      if (message.action === 'start') {
        this.dictation?.cancel(); const revision = this.state.inputRevision;
        if (message.target !== 'program' || message.prompt !== this.state.prompt || message.revision !== revision) { this.send({ type: 'dictation', id: message.id, state: 'error', message: 'Terminal input changed. Try again.' }); return; }
        this.dictationId = message.id;
        this.dictation = new Dictation(async text => {
          if (this.closed || revision !== this.state.inputRevision || this.dictationId !== message.id) throw new Error('Terminal input changed during dictation. No text was inserted.');
          if (!text) return;
          await this.input(text, true, () => { if (revision !== this.state.inputRevision || this.dictationId !== message.id) throw new Error('Terminal input changed during dictation. No text was inserted.'); });
          this.state.inputRevision++;
          this.send({ type: 'pasted', text, replace: false, prompt: this.state.prompt, revision: this.state.inputRevision, source: 'dictation' });
        }, (state, reason) => this.send({ type: 'dictation', id: message.id, state, ...(reason ? { message: reason } : {}) }));
      } else if (message.id === this.dictationId && message.action === 'finish') this.dictation?.finish();
      else if (message.id === this.dictationId && message.action === 'cancel') { this.dictationId = ''; this.dictation?.cancel(); this.dictation = undefined; }
    } else throw new Error('Unknown terminal action');
  }
  dispose() { if (this.closed) return; this.closed = true; clearTimeout(this.timer); clearInterval(this.heartbeat); this.terminal.dispose(); this.dictationId = ''; this.dictation?.cancel(); }
}
function deliver(ws: WebSocket, message: HerdrMessage | ServerMessage) {
  if (ws.readyState !== WebSocket.OPEN) return;
  if (ws.bufferedAmount > MAX_LINE) { ws.close(1013, 'Viewer is too slow; reconnect for a fresh screen.'); return; }
  ws.send(JSON.stringify(message));
}
function paneKey(snapshot: HerdrSnapshot) { return snapshot.agents.map(agent => agent.paneId).sort().join(','); }

const localTerminals = new Map<string, HerdrTerminalStream>();
const remoteTerminals = new WeakMap<SSHHost, Map<string, HerdrTerminalStream>>();
function terminalStream(target: HerdrServer, terminalId: string) {
  const context = typeof target === 'string' ? { session: target } : target;
  const env = { ...context.env, HERDR_SOCKET_PATH: context.socketPath || herdrSocket(context.session, context.remote ? { HOME: context.remote.home } : { ...process.env, ...context.env }), HERDR_SESSION: '' };
  let terminals = localTerminals;
  if (context.remote) {
    terminals = remoteTerminals.get(context.remote) || new Map(); remoteTerminals.set(context.remote, terminals);
  }
  const key = JSON.stringify([env.HERDR_SOCKET_PATH, terminalId]);
  let resource = terminals.get(key);
  if (!resource) {
    resource = new HerdrTerminalStream(async (size?: TerminalSize): Promise<TerminalStream> => {
      const args = ['terminal', 'session', size ? 'control' : 'observe', terminalId];
      if (size) args.push('--cols', String(size.cols), '--rows', String(size.rows));
      // Never take over another controller. Control is scoped to this terminal,
      // and releasing it lets Herdr restore its desktop client's geometry.
      let output: Readable, input: Writable | undefined, stop: () => void;
      if (context.remote) {
        const assignments = Object.entries(env).filter(([key, value]) => value !== undefined && /^[A-Za-z_][A-Za-z0-9_]*$/.test(key) && !key.startsWith('TERMAI_')).map(([key, value]) => key + '=' + shellQuote(value!));
        const stream = await context.remote.openStream('env ' + assignments.join(' ') + ' ' + [context.binary || 'herdr', ...args].map(shellQuote).join(' '));
        stream.stderr.resume(); output = stream; input = size ? stream : undefined; stop = () => stream.close();
      } else {
        const child = spawn(context.binary || 'herdr', args, { env: { ...process.env, ...env }, stdio: ['pipe', 'pipe', 'ignore'] });
        child.on('error', () => {}); child.stdin.on('error', () => {});
        output = child.stdout; input = size ? child.stdin : undefined; stop = () => { child.kill(); };
      }
      return { output, input, close: () => new Promise<void>(resolve => {
        if (output.destroyed) { stop(); resolve(); return; }
        const done = () => { clearTimeout(timer); output.off('close', done); resolve(); };
        const timer = setTimeout(() => { stop(); done(); }, 1000); timer.unref();
        output.once('close', done);
        if (input && !input.destroyed && input.writable) input.end(JSON.stringify({ type: 'terminal.release' }) + '\n');
        else stop();
      }) };
    }, () => { if (terminals.get(key) === resource) terminals.delete(key); });
    terminals.set(key, resource);
  }
  return resource;
}
