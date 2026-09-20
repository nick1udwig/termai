import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, mkdir, rm, access } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { Facts } from '../server/facts.ts';
import { HelpProvider } from '../server/help.ts';
import { ContextCache, RemoteHost, type FactTransport } from '../src/remote-host.ts';
import { Discovery } from '../src/engine/discovery.ts';
import { suggest } from '../src/engine/suggestions.ts';
import type { Catalog } from '../src/protocol.ts';

async function fixture() {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'termai-facts-'));
  const help = new HelpProvider();
  let catalog: Catalog = { cwd, commands: ['git', 'cat', 'ls', 'cd', 'tool'], paths: [], history: ['git init'] };
  const state = { prompt: 1, cwd, ready: true, exited: false };
  const env = { HOME: cwd, PATH: cwd + ':/usr/bin:/bin', PRIVATE_SECRET: 'do-not-send' };
  const source = { state, help, catalog: async () => catalog, environment: async () => env };
  const facts = new Facts(source);
  const requests: any[] = [];
  const transport: FactTransport = async <T>(body: any, signal: AbortSignal): Promise<T> => {
    requests.push(body);
    const result = body.kind === 'context' ? await facts.context(body.known) : await facts.read(body.key, body.operations, signal);
    return JSON.parse(JSON.stringify(result)) as T;
  };
  return { cwd, help, state, env, facts, requests, transport, setCatalog: (next: Catalog) => { catalog = next; },
    dispose: async () => { help.dispose(); await rm(cwd, { recursive: true, force: true }); } };
}

test('wire context hides environment values, reuses catalogs and rejects stale prompts', async () => {
  const f = await fixture();
  try {
    const cache = new ContextCache(), signal = AbortSignal.timeout(4000);
    const first = await cache.get(f.transport, signal), second = await cache.get(f.transport, signal);
    assert.equal(first.catalog, second.catalog);
    assert.ok(!JSON.stringify(first).includes('do-not-send'));
    assert.equal((await f.facts.context(first.catalogKey)).catalog, undefined);
    f.setCatalog({ ...first.catalog, paths: ['new-file'] });
    const third = await cache.get(f.transport, signal);
    assert.notEqual(third.catalogKey, first.catalogKey);
    assert.equal(third.key, first.key, 'Filesystem changes must not invalidate an ongoing repair');
    assert.equal(third.catalog.commands, first.catalog.commands, 'Keep matching indexes across path updates');
    f.state.prompt++;
    await assert.rejects(f.facts.read(first.key, [{ kind: 'syntax', command: 'git init' }], signal), /context changed/);
  } finally { await f.dispose(); }
});

test('remote repairs batch validation, cache immutable syntax and recheck live paths', async () => {
  const f = await fixture();
  try {
    const cache = new ContextCache(), syntax = new Map<string, boolean>();
    let host: RemoteHost;
    const discovery = new Discovery({ help: (...args) => host.help(args[0], args[1]), describe: command => host.describe(command) });
    const run = async (text: string) => {
      const signal = AbortSignal.timeout(4000), snapshot = await cache.get(f.transport, signal);
      host = new RemoteHost(f.transport, snapshot, signal, syntax);
      return suggest(text, snapshot.catalog, { HOME: snapshot.home, HOST_CONTEXT: snapshot.discoveryKey }, discovery, host, undefined, signal);
    };
    assert.equal((await run('Get in it.'))[0].command, 'git init');
    const before = f.requests.length;
    assert.equal((await run('Get in it.'))[0].command, 'git init');
    assert.equal(f.requests.length - before, 1, 'Warm history requires only a context freshness check');
    const signal = AbortSignal.timeout(4000), snapshot = await cache.get(f.transport, signal);
    host = new RemoteHost(f.transport, snapshot, signal);
    const start = f.requests.length;
    await Promise.all([host.syntax('ls -l'), host.syntax('ls -L'), host.syntax('ls -l')]);
    assert.equal(f.requests.length - start, 1);
    assert.equal(f.requests.at(-1).operations.length, 2);
    await writeFile(path.join(f.cwd, 'notes.txt'), 'notes');
    assert.equal((await run('cat notes.txt'))[0].command, 'cat notes.txt');
    await rm(path.join(f.cwd, 'notes.txt'));
    assert.ok((await run('cat notes.txt')).every(candidate => candidate.literal));
    await mkdir(path.join(f.cwd, 'folder'));
    assert.equal((await run('cd fold er'))[0].command, 'cd folder');
    assert.ok(f.requests.some(request => request.operations?.some((op: any) => op.kind === 'syntax' && op.command === 'cd folder') && request.operations.some((op: any) => op.kind === 'stat' && op.path.endsWith('/folder'))), 'Independent syntax and path checks share a batch');
    await assert.rejects(access(path.join(f.cwd, '.git')));
    discovery.dispose();
  } finally { await f.dispose(); }
});

test('host independently rejects unverified help routes and never executes transcript operands', async () => {
  const f = await fixture();
  try {
    await writeFile(path.join(f.cwd, 'tool'), `#!/bin/sh
case "$*" in
 '--help') printf 'Commands:\\n  safe    Safe command\\n';;
 'safe --help') printf '  --quiet  Silence\\n';;
 *) touch '${f.cwd}/executed';;
esac
`, { mode: 0o700 });
    const { key } = await f.facts.context();
    const signal = AbortSignal.timeout(4000);
    await assert.rejects(f.facts.read(key, [{ kind: 'help', command: 'tool', route: ['danger'] }], signal), /Unverified/);
    const [help] = await f.facts.read(key, [{ kind: 'help', command: 'tool', route: ['safe'] }], signal);
    assert.ok(JSON.stringify(help).includes('--quiet'));
    for (const operations of [[{ kind: 'exec', command: 'touch executed' }], [{ kind: 'entries', path: '/', limit: 10001 }], [{ kind: 'stat', path: 'relative' }], Array(65).fill({ kind: 'syntax', command: ':' })]) {
      await assert.rejects(f.facts.read(key, operations, signal));
    }
    await assert.rejects(access(path.join(f.cwd, 'executed')));
    await assert.rejects(f.facts.read(key, [{ kind: 'syntax', command: ':' }], AbortSignal.abort()), { name: 'AbortError' });
    f.env.PATH = '/different';
    await assert.rejects(f.facts.read(key, [{ kind: 'syntax', command: ':' }], signal), /context changed/);
  } finally { await f.dispose(); }
});

test('cached browser directories are revalidated and new exact names defeat old fuzzy paths', async () => {
  const { DirectoryCache, DirectoryChanged } = await import('../src/directory-cache.ts');
  const f = await fixture();
  try {
    await mkdir(path.join(f.cwd, 'folder', 'target'), { recursive: true });
    const cache = new ContextCache(), directories = new DirectoryCache(), syntax = new Map<string, boolean>();
    const discovery = { cached: () => ({ flags: {}, subcommands: {}, requiredPositionals: {} }), discover: async () => { throw new Error('Directory repair must not discover help'); } };
    const run = async () => {
      const signal = AbortSignal.timeout(4000), snapshot = await cache.get(f.transport, signal);
      for (let attempt = 0; ; attempt++) {
        const host = new RemoteHost(f.transport, snapshot, signal, syntax, directories);
        try {
          const result = await suggest('cd fold er/target', snapshot.catalog, {}, discovery, host, undefined, signal);
          await host.verify(); return result;
        } catch (error) { if (!(error instanceof DirectoryChanged) || attempt >= 2) throw error; }
      }
    };
    assert.equal((await run())[0].command, 'cd folder/target');
    const start = f.requests.length;
    assert.equal((await run())[0].command, 'cd folder/target');
    // The exact child can still require a lookup; versions must always be checked.
    assert.ok(f.requests.slice(start).some(request => request.operations?.some((op: any) => op.kind === 'directory')));
    await mkdir(path.join(f.cwd, 'fold er'));
    assert.ok((await run()).every(candidate => candidate.literal), 'A new exact prefix blocks the old fuzzy alternative');
    await rm(path.join(f.cwd, 'fold er'), { recursive: true });
    assert.equal((await run())[0].command, 'cd folder/target');
    await rm(path.join(f.cwd, 'folder', 'target'), { recursive: true });
    assert.ok((await run()).every(candidate => candidate.literal), 'Deleted destinations cannot survive cached matching');
  } finally { await f.dispose(); }
});

test('pushed lightweight context avoids foreground refresh and catalog deltas retain unchanged fields', async () => {
  const f = await fixture();
  try {
    const cache = new ContextCache(), signal = AbortSignal.timeout(4000);
    const first = await f.facts.context(undefined, false);
    assert.ok(cache.accept(first));
    const before = f.requests.length;
    const saved = await cache.get(f.transport, signal, false, f.state.prompt);
    assert.equal(f.requests.length, before);
    f.setCatalog({ ...saved.catalog, history: ['git init', 'cd folder'] });
    const changed = await f.facts.context(saved.catalogKey, false);
    assert.equal(changed.catalog, undefined);
    assert.deepEqual(Object.keys(changed.patch || {}), ['history']);
    const updated = cache.accept(changed)!;
    assert.equal(updated.catalog.commands, saved.catalog.commands);
    assert.deepEqual(updated.catalog.history, ['git init', 'cd folder']);
    assert.equal(new ContextCache().accept(changed), undefined, 'Deltas without a base require a full refresh');
    // A normal full-catalog response must not prevent applying later light-context deltas.
    await cache.get(f.transport, signal, true);
    f.setCatalog({ ...updated.catalog, history: ['git init', 'cd folder', 'cd another'] });
    assert.ok(cache.accept(await f.facts.context(changed.catalogKey, false)));
    f.state.prompt++;
    await cache.get(f.transport, signal, false, f.state.prompt);
    assert.ok(f.requests.length > before);
  } finally { await f.dispose(); }
});
