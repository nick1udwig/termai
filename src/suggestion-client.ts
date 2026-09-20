import type { ServerMessage } from './protocol.ts';
import type { Candidate } from './protocol.ts';

/** Keep matching and parsing off the terminal's rendering/input thread. */
export class SuggestionClient {
  private worker?: Worker;
  private next = 0;
  private prompt = -1;
  onState(prompt: number) { this.prompt = prompt; }
  updateContext(message: Extract<ServerMessage, { type: 'context' }>) {
    this.openWorker(); this.worker!.postMessage(message);
  }
  disconnect() {
    this.worker?.postMessage({ reset: true });
  }
  private pending = new Map<number, { resolve(value: { candidates: Candidate[] }): void; reject(error: unknown): void }>();
  private openWorker() {
    if (!this.worker) {
      this.worker = new Worker(new URL('./suggestion-worker.ts', import.meta.url), { type: 'module' });
      this.worker.onmessage = ({ data }) => {
        const request = this.pending.get(data.id);
        if (data.error) request?.reject(new Error(data.error)); else request?.resolve({ candidates: data.candidates });
      };
      this.worker.onerror = event => {
        for (const request of this.pending.values()) request.reject(new Error(event.message || 'Repair worker unavailable.'));
        this.worker?.terminate(); this.worker = undefined;
      };
    }
  }
  suggest(text: string, signal: AbortSignal): Promise<{ candidates: Candidate[] }> {
    signal.throwIfAborted(); this.openWorker();
    const worker = this.worker!, id = ++this.next;
    return new Promise<{ candidates: Candidate[] }>((resolve, reject) => {
      const cancel = () => { worker.postMessage({ id, cancel: true }); this.pending.get(id)?.reject(signal.reason); };
      const finish = () => { signal.removeEventListener('abort', cancel); this.pending.delete(id); };
      this.pending.set(id, {
        resolve: result => { finish(); resolve(result); },
        reject: error => { finish(); reject(error); },
      });
      signal.addEventListener('abort', cancel, { once: true });
      worker.postMessage({ id, text, prompt: this.prompt, endpoint: new URL('api/facts', document.baseURI).href });
    });
  }
}
