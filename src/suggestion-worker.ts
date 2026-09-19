import { Discovery } from './engine/discovery.ts';
import { suggest } from './engine/suggestions.ts';
import { ContextCache, RemoteHost, type FactTransport } from './remote-host.ts';

const context = new ContextCache();
const syntaxCache = new Map<string, boolean>();
let currentHost: RemoteHost;
const discovery = new Discovery({
  help: (command, route, _catalog, _env, signal) => { signal.throwIfAborted(); return currentHost.help(command, route); },
  describe: (command, _catalog, _env, signal) => { signal.throwIfAborted(); return currentHost.describe(command); },
});
const active = new Map<number, AbortController>();
self.onmessage = async (event: MessageEvent<{ id: number; text?: string; endpoint?: string; cancel?: boolean }>) => {
  const { id, text, endpoint, cancel } = event.data;
  if (cancel) { active.get(id)?.abort(); return; }
  if (typeof text !== 'string' || text.length > 2000 || !endpoint) {
    self.postMessage({ id, error: 'Keep a command under 2,000 characters.' }); return;
  }
  // Only one foreground repair can be useful in this terminal.
  for (const controller of active.values()) controller.abort();
  const controller = new AbortController(); active.set(id, controller);
  const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(5000)]);
  const transport: FactTransport = async <T>(body: unknown, signal: AbortSignal): Promise<T> => {
    const response = await fetch(endpoint, { method: 'POST', credentials: 'same-origin', cache: 'no-store',
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal });
    const value = await response.json();
    if (!response.ok) throw new Error(value.error || 'Host facts unavailable.');
    return value;
  };
  try {
    const snapshot = await context.get(transport, signal);
    const host = currentHost = new RemoteHost(transport, snapshot, signal, syntaxCache);
    const candidates = await suggest(text, snapshot.catalog, { HOME: snapshot.home, HOST_CONTEXT: snapshot.discoveryKey }, discovery, host, undefined, signal);
    signal.throwIfAborted();
    self.postMessage({ id, candidates });
  } catch (error) {
    if (!controller.signal.aborted) self.postMessage({ id, error: error instanceof Error ? error.message : 'Repair failed.' });
  } finally { active.delete(id); }
};
