import type { ServerMessage } from './protocol.ts';
import { DirectoryCache, DirectoryChanged } from './directory-cache.ts';
import { directoryInput, Discovery, suggest } from './engine/index.ts';
import { ContextCache, RemoteHost, type FactTransport } from './remote-host.ts';

let context = new ContextCache();
let directories = new DirectoryCache();
const syntaxCache = new Map<string, boolean>();
const discovery = new Discovery();
const active = new Map<number, AbortController>();
self.onmessage = async (event: MessageEvent<{ id: number; text?: string; endpoint?: string; authorization?: string; cancel?: boolean; prompt?: number; reset?: boolean } | Extract<ServerMessage, { type: 'context' }>>) => {
  if ('type' in event.data) {
    context.accept(event.data.context);
    for (const item of event.data.directories) directories.remember(item.path, item.snapshot);
    return;
  }
  if (event.data.reset) {
    for (const controller of active.values()) controller.abort();
    context = new ContextCache(); directories = new DirectoryCache(); return;
  }
  const { id, text, endpoint, authorization, cancel, prompt } = event.data;
  if (cancel) { active.get(id)?.abort(); return; }
  if (typeof text !== 'string' || text.length > 2000 || !endpoint) {
    self.postMessage({ id, error: 'Keep a command under 2,000 characters.' }); return;
  }
  // Only one foreground repair can be useful in this terminal.
  for (const controller of active.values()) controller.abort();
  const controller = new AbortController(); active.set(id, controller);
  const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(12000)]);
  const transport: FactTransport = async <T>(body: unknown, signal: AbortSignal): Promise<T> => {
    const response = await fetch(endpoint, { method: 'POST', credentials: 'same-origin', cache: 'no-store',
      headers: { 'Content-Type': 'application/json', ...(authorization ? { Authorization: 'Bearer ' + authorization } : {}) }, body: JSON.stringify(body), signal });
    const value = await response.json();
    if (!response.ok) throw new Error(value.error || 'Host facts unavailable.');
    return value;
  };
  try {
    const search = async (snapshot: Awaited<ReturnType<ContextCache['get']>>) => {
      for (let attempt = 0; ; attempt++) {
        const host = new RemoteHost(transport, snapshot, signal, syntaxCache, directories);
        try {
          const metadata = discovery.forHost({
            help: (command, route, _catalog, _env, signal) => { signal.throwIfAborted(); return host.help(command, route); },
            describe: (command, _catalog, _env, signal) => { signal.throwIfAborted(); return host.describe(command); },
          });
          const candidates = await suggest(text, snapshot.catalog, { HOME: snapshot.home, HOST_CONTEXT: snapshot.discoveryKey }, metadata, host, undefined, signal);
          await host.verify();
          return candidates;
        } catch (error) { if (!(error instanceof DirectoryChanged) || attempt >= 2) throw error; }
      }
    };
    // The pushed context has command names and history but skips the expensive
    // SSH path scan. Try it first; only collect every path when it cannot help.
    const light = await context.get(transport, signal, false, prompt);
    let candidates = await search(light);
    if (candidates.every(candidate => candidate.literal) && !directoryInput(text)) {
      try {
        const rich = await context.get(transport, AbortSignal.any([signal, AbortSignal.timeout(3000)]), true, prompt);
        candidates = await search(rich);
      } catch (error) { if (signal.aborted) throw error; }
    }
    self.postMessage({ id, candidates });
  } catch (error) {
    if (!controller.signal.aborted) self.postMessage({ id, error: error instanceof Error ? error.message : 'Repair failed.' });
  } finally { active.delete(id); }
};
