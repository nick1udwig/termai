import type { Readable, Writable } from 'node:stream';
import type { ServerMessage } from '../src/protocol.ts';

export interface TerminalSize { cols: number; rows: number }
export interface TerminalStream { output: Readable; input?: Writable; close(): Promise<void> }
type Viewer = { send: (message: ServerMessage) => void; size?: TerminalSize; order: number };
type Frame = Extract<ServerMessage, { type: 'herdr-frame' }>;
const sameSize = (a?: TerminalSize, b?: TerminalSize) => a?.cols === b?.cols && a?.rows === b?.rows;

/** One scoped Herdr controller per terminal. Desktop viewers observe; the most
 * recently resized mobile viewer owns geometry until it leaves. Herdr restores
 * its desktop shell geometry when the last mobile controller releases. */
export class HerdrTerminalStream {
  private viewers = new Set<Viewer>();
  private sequence = 0;
  private generation = 0;
  private work = Promise.resolve();
  private stream?: TerminalStream;
  private size?: TerminalSize;
  private frame?: Frame;
  private retry?: ReturnType<typeof setTimeout>;
  private open: (size?: TerminalSize) => Promise<TerminalStream>;
  private empty: () => void;
  constructor(open: (size?: TerminalSize) => Promise<TerminalStream>, empty: () => void) { this.open = open; this.empty = empty; }
  subscribe(send: Viewer['send']) {
    const viewer: Viewer = { send, order: 0 };
    this.viewers.add(viewer);
    if (this.frame) send(this.frame);
    if (!this.stream && !this.retry) this.schedule();
    return {
      resize: (size?: TerminalSize) => {
        if (!this.viewers.has(viewer) || sameSize(viewer.size, size)) return;
        viewer.size = size; viewer.order = ++this.sequence; this.schedule();
      },
      dispose: () => { if (this.viewers.delete(viewer)) this.schedule(); },
    };
  }
  private desiredSize() {
    return [...this.viewers].filter(v => v.size).sort((a, b) => b.order - a.order)[0]?.size;
  }
  private send(message: ServerMessage) { for (const viewer of this.viewers) viewer.send(message); }
  private reset() { this.frame = undefined; this.send({ type: 'herdr-frame', width: 0, height: 0, full: true, bytes: '' }); }
  private schedule() {
    clearTimeout(this.retry); this.retry = undefined;
    const generation = ++this.generation;
    this.work = this.work.then(() => this.sync(generation)).catch(() => this.failed(generation));
  }
  private async sync(generation: number) {
    if (generation !== this.generation) return;
    const size = this.desiredSize();
    if (this.stream && (!this.viewers.size || !!size !== !!this.size)) {
      const old = this.stream; this.stream = undefined; this.size = undefined; this.reset();
      // Release completes before opening a replacement, avoiding controller
      // conflicts on reconnects or rapid agent switches.
      await old.close();
    }
    if (generation !== this.generation) return;
    if (!this.viewers.size) { this.empty(); return; }
    if (this.stream) {
      if (size && !sameSize(size, this.size)) {
        this.stream.input!.write(JSON.stringify({ type: 'terminal.resize', ...size }) + '\n'); this.size = size;
      }
      return;
    }
    const stream = await this.open(size);
    if (generation !== this.generation) { await stream.close(); return; }
    this.stream = stream; this.size = size;
    let pending = '';
    stream.output.setEncoding('utf8');
    stream.output.on('data', (data: string) => {
      if (this.stream !== stream) return;
      pending += data;
      if (Buffer.byteLength(pending) > 8 * 1024 * 1024) { this.ended(stream); return; }
      let end;
      while ((end = pending.indexOf('\n')) !== -1) {
        const line = pending.slice(0, end); pending = pending.slice(end + 1);
        if (!line.trim()) continue;
        try {
          const raw = JSON.parse(line);
          if (raw.type === 'terminal.closed') { this.ended(stream); return; }
          if (raw.type !== 'terminal.frame' || raw.encoding !== 'ansi') continue;
          if (!Number.isInteger(raw.width) || !Number.isInteger(raw.height) || raw.width < 1 || raw.height < 1 || raw.width > 1000 || raw.height > 1000 || typeof raw.bytes !== 'string') { this.ended(stream); return; }
          const frame: Frame = { type: 'herdr-frame', width: raw.width, height: raw.height, full: raw.full === true, bytes: raw.bytes };
          if (frame.full) this.frame = frame; else this.frame = undefined;
          this.send(frame);
        } catch { this.ended(stream); return; }
      }
    });
    stream.output.on('error', () => this.ended(stream));
    stream.output.on('close', () => this.ended(stream));
    stream.input?.on('error', () => this.ended(stream));
  }
  private ended(stream: TerminalStream) {
    if (this.stream !== stream) return;
    this.stream = undefined; this.reset();
    const generation = ++this.generation;
    this.work = this.work.then(() => stream.close()).then(() => this.failed(generation), () => this.failed(generation));
  }
  private failed(generation: number) {
    if (generation !== this.generation) return;
    if (!this.viewers.size) { this.empty(); return; }
    if (this.desiredSize()) this.send({ type: 'reading-error', message: 'Cannot resize the Herdr terminal. Check that Herdr is available and no other terminal controller is attached.' });
    this.retry = setTimeout(() => { this.retry = undefined; this.schedule(); }, 2000); this.retry.unref();
  }
}
