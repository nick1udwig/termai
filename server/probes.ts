import { execFile, type ExecFileOptions } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const aborted = () => new DOMException('Operation aborted', 'AbortError');

/** One subscriber can leave without cancelling work still needed by another. */
export class SharedTask<T> {
  private controller = new AbortController();
  private consumers = 0;
  private settled = false;
  private promise: Promise<T>;
  constructor(work: (signal: AbortSignal) => Promise<T>) {
    this.promise = Promise.resolve().then(() => {
      this.controller.signal.throwIfAborted();
      return work(this.controller.signal);
    }).finally(() => { this.settled = true; });
    void this.promise.catch(() => {});
  }
  get aborted() { return this.controller.signal.aborted; }
  async wait(signal: AbortSignal): Promise<T> {
    if (signal.aborted && !this.consumers && !this.settled) this.controller.abort(signal.reason);
    signal.throwIfAborted();
    this.consumers++;
    try {
      return await new Promise<T>((resolve, reject) => {
        const cancel = () => reject(signal.reason);
        signal.addEventListener('abort', cancel, { once: true });
        this.promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', cancel));
      });
    } finally {
      if (--this.consumers === 0 && !this.settled) this.controller.abort(aborted());
    }
  }
}

/** All help, Python inspection and syntax processes share the same bounded budget. */
export class ProbePool {
  private active = 0;
  private waiting = new Set<() => void>();
  private limit: number;
  constructor(limit = 2) { this.limit = limit; }
  get busy() { return this.active > 0 || this.waiting.size > 0; }
  async run<T>(signal: AbortSignal, work: () => Promise<T>): Promise<T> {
    signal.throwIfAborted();
    if (this.active < this.limit) this.active++;
    else {
      if (this.waiting.size >= 64) throw new Error('Probe queue is full');
      await new Promise<void>((resolve, reject) => {
        const start = () => { signal.removeEventListener('abort', cancel); resolve(); };
        const cancel = () => { this.waiting.delete(start); reject(signal.reason); };
        signal.addEventListener('abort', cancel, { once: true });
        this.waiting.add(start);
      });
    }
    try { signal.throwIfAborted(); return await work(); }
    finally {
      const next = this.waiting.values().next().value;
      if (next) { this.waiting.delete(next); next(); } else this.active--;
    }
  }
}
export const probePool = new ProbePool();
export function probe(file: string, args: string[], options: ExecFileOptions, signal: AbortSignal) {
  return probePool.run(signal, () => exec(file, args, { ...options, encoding: 'utf8', signal, killSignal: 'SIGKILL' }));
}
