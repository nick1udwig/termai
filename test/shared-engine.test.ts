import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Discovery, type DiscoveryIO } from '../src/engine/index.ts';

const catalog = { cwd: '/project', commands: ['orchard'], paths: [], history: [] };

test('overlapping repairs keep discovery bound to their own host and cancellation signal', async () => {
  const discovery = new Discovery();
  let release!: () => void;
  const waiting = new Promise<void>(resolve => release = resolve);
  let started!: () => void;
  const entered = new Promise<void>(resolve => started = resolve);
  const calls: string[] = [];
  const io = (name: string, pause: boolean): DiscoveryIO => ({
    describe: async () => undefined,
    help: async (_command, route, _catalog, _env, signal) => {
      signal.throwIfAborted();
      calls.push(name + ':' + route.join('/'));
      if (!route.length && pause) { started(); await waiting; signal.throwIfAborted(); }
      return { flags: [], subcommands: route.length ? [] : ['workspace'] };
    },
  });
  try {
    const first = discovery.forHost(io('first', true));
    const second = discovery.forHost(io('second', false));
    const pending = first.discover('orchard workspace', catalog, {});
    await entered;
    await second.discover('orchard workspace', catalog, {});
    release(); await pending;
    assert.deepEqual(calls, ['first:', 'second:', 'second:workspace', 'first:workspace']);
    const aborted = new AbortController(); aborted.abort();
    await assert.rejects(first.discover('orchard workspace', catalog, {}, aborted.signal), { name: 'AbortError' });
    assert.equal(calls.length, 4);
  } finally { release(); discovery.dispose(); }
});

test('separate engine sessions do not share learned command metadata', async () => {
  const first = new Discovery({ describe: async () => undefined, help: async () => ({ flags: [{ name: '--private', takesValue: false }], subcommands: [] }) });
  const second = new Discovery({ describe: async () => undefined, help: async () => ({ flags: [], subcommands: [] }) });
  try {
    await first.discover('orchard', catalog, {});
    assert.equal(first.cached(catalog, {}).flags.orchard[0].name, '--private');
    assert.deepEqual(second.cached(catalog, {}).flags, {});
  } finally { first.dispose(); second.dispose(); }
});
