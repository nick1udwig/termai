/** Four-way engine comparison using real host facts and a JSON transport with injected RTT.
 * Idle pushes are measured separately from foreground time; this is not a phone CPU profile. */
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';
import type { Catalog } from '../src/protocol.ts';

const variants = [
  { name: 'original master', ref: 'ba21e2c', client: false, optimized: false },
  { name: 'optimized master', ref: process.env.BENCH_MASTER || 'master', client: false, optimized: true },
  { name: 'original experiment', ref: '17e629b', client: true, optimized: false },
  { name: 'optimized experiment', ref: process.env.BENCH_CLIENT || 'experiment/client-driven-terminal', client: true, optimized: true },
];
const rtts = (process.env.BENCH_RTT || '0,50,150').split(',').map(Number);
const repeats = Number(process.env.BENCH_REPEATS || 3);
const temp = await mkdtemp(path.join(os.tmpdir(), 'termai-architecture-'));
const cwd = path.join(temp, 'fixture');
const delay = (ms: number) => ms ? new Promise(resolve => setTimeout(resolve, ms)) : Promise.resolve();
const median = (values: number[]) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
const rounded = (value: number) => +value.toFixed(2);
const cases = [
  ['history', 'Get in it.'], ['schema', 'Git commit -m "exact message"'], ['flags', 'LSL'],
  ['python', 'Python three hello world dot py myarg food'], ['nested help', 'Orchard work space recon cile target VALUE'],
  ['directory', 'Cd ~ fas get fas pebble agent'], ['exact directory', 'cd git/pebble-agent'],
  ['large directory', 'cd big/wor kspace'], ['referenced file', 'cat ~/docs/my notes dot txt'],
] as const;
const rows: unknown[] = [];
let comparisons = 0;
try {
  await mkdir(cwd);
  await mkdir(path.join(cwd, 'git', 'pebble-agent'), { recursive: true });
  await mkdir(path.join(cwd, 'docs'));
  await mkdir(path.join(cwd, 'big', 'workspace'), { recursive: true });
  for (let start = 0; start < 2000; start += 50) await Promise.all(Array.from({ length: 50 }, (_, i) => writeFile(path.join(cwd, 'big', `artifact${start + i}.txt`), '')));
  await writeFile(path.join(cwd, 'docs', 'My Notes.txt'), 'notes');
  await writeFile(path.join(cwd, 'hello_world.py'), "import argparse\np=argparse.ArgumentParser()\np.add_argument('--myarg')\n");
  await writeFile(path.join(cwd, 'orchard'), `#!/bin/sh
case "$*" in
 '--help') printf 'Commands:\\n  workspace    Workspaces\\n';;
 'workspace --help') printf 'Commands:\\n  reconcile    Reconcile workspace\\n';;
 'workspace reconcile --help') printf '  --target NAME  Destination\\n';;
 *) exit 1;;
esac
`, { mode: 0o700 });
  const catalog: Catalog = { cwd, commands: ['git', 'ls', 'cd', 'cat', 'echo', 'python3', 'orchard', ...Array.from({ length: 3000 }, (_, i) => `program${i}`)],
    paths: ['hello_world.py', 'docs/', 'git/', 'big/'], history: [...Array.from({ length: 4999 }, (_, i) => `program${i % 3000} argument${i}`), 'git init'] };
  const env = { HOME: cwd, PATH: cwd + ':/usr/bin:/bin' };
  const loaded = [];
  for (const variant of variants) {
    const root = path.join(temp, variant.name.replaceAll(' ', '-')); await mkdir(root);
    const revision = execFileSync('git', ['rev-parse', variant.ref], { encoding: 'utf8' }).trim();
    const archive = execFileSync('git', ['archive', revision, 'server', 'src', 'package.json'], { maxBuffer: 10 * 1024 * 1024 });
    execFileSync('tar', ['-x', '-C', root], { input: archive });
    const load = (file: string) => import(pathToFileURL(path.join(root, file)).href);
    const engine = await load(variant.client ? 'src/engine/suggestions.ts' : 'server/suggestions.ts');
    const discovery = await load(variant.client ? 'src/engine/discovery.ts' : 'server/discovery.ts');
    const modules = variant.client ? {
      ...await load('server/facts.ts'), ...await load('server/help.ts'), ...await load('src/remote-host.ts'),
      ...(variant.optimized ? { ...await load('src/directory-cache.ts'), ...await load('server/directories.ts'), ...await load('src/engine/path-repair.ts') } : {}),
    } : {};
    loaded.push({ ...variant, revision, engine, discovery, modules });
  }
  for (const rtt of rtts) for (const [name, text] of cases) {
    let expected: unknown;
    for (const variant of loaded) {
      const m = variant.modules;
      const help = variant.client ? new m.HelpProvider() : undefined;
      const source = { state: { cwd, prompt: 1, ready: true, exited: false }, catalog: async (includePaths = true) => includePaths ? catalog : { ...catalog, paths: [] }, environment: async () => env, help };
      const facts = variant.client ? new m.Facts(source) : undefined;
      const cache = variant.client ? new m.ContextCache() : undefined;
      const syntax = new Map<string, boolean>(), directories = variant.client && variant.optimized ? new m.DirectoryCache() : undefined;
      let host: any, requests = 0, bytes = 0, hostMs = 0, pushKey: string | undefined, pushDirectoryVersion: string | undefined;
      const discovery = variant.client ? new variant.discovery.Discovery({ help: (command: string, route: string[]) => host.help(command, route), describe: (command: string) => host.describe(command) }) : new variant.discovery.Discovery();
      const transport = async (body: any, signal: AbortSignal) => {
        requests++; bytes += Buffer.byteLength(JSON.stringify(body));
        await delay(rtt / 2);
        const start = performance.now();
        const result = body.kind === 'context' ? await facts.context(body.known, body.paths !== false) : await facts.read(body.key, body.operations, signal);
        hostMs += performance.now() - start;
        const wire = JSON.stringify(result); bytes += Buffer.byteLength(wire);
        await delay(rtt / 2); return JSON.parse(wire);
      };
      const times: number[] = [], counts: number[] = [], sizes: number[] = [], hostTimes: number[] = [], idleBytes: number[] = [], idleTimes: number[] = [];
      try {
        for (let i = 0; i <= repeats; i++) {
          // Model an already delivered periodic idle push for warm optimized-client trials.
          // Both its host time and wire bytes are recorded outside the foreground interval.
          if (i && variant.client && variant.optimized) {
            const start = performance.now();
            const context = await facts.context(pushKey, false); pushKey = context.catalogKey;
            const snapshot = await m.directorySnapshot(cwd, 10000);
            const prefetch = snapshot.version === pushDirectoryVersion ? [] : [{ path: cwd, snapshot }]; pushDirectoryVersion = snapshot.version;
            const wire = JSON.stringify({ context, directories: prefetch });
            idleBytes.push(Buffer.byteLength(wire));
            const pushed = JSON.parse(wire); cache.accept(pushed.context);
            for (const entry of pushed.directories) directories.remember(entry.path, entry.snapshot);
            idleTimes.push(performance.now() - start);
          }
          requests = bytes = hostMs = 0;
          const begin = performance.now(), signal = AbortSignal.timeout(5000);
          let actual;
          if (!variant.client) {
            requests = 1; await delay(rtt / 2);
            const start = performance.now();
            actual = await variant.engine.suggest(text, catalog, env, discovery, undefined, signal);
            hostMs = performance.now() - start;
            bytes = Buffer.byteLength(JSON.stringify({ text })) + Buffer.byteLength(JSON.stringify({ candidates: actual }));
            await delay(rtt / 2);
          } else {
            const includePaths = !variant.optimized || !m.directoryInput(text);
            const snapshot = await cache.get(transport, signal, includePaths, variant.optimized ? 1 : undefined);
            for (let attempt = 0; ; attempt++) {
              host = new m.RemoteHost(transport, snapshot, signal, syntax, directories);
              try {
                actual = await variant.engine.suggest(text, snapshot.catalog, { HOME: snapshot.home, HOST_CONTEXT: snapshot.discoveryKey }, discovery, host, undefined, signal);
                if (variant.optimized) await host.verify();
                break;
              } catch (error) { if (!variant.optimized || !(error instanceof m.DirectoryChanged) || attempt >= 2) throw error; }
            }
          }
          times.push(performance.now() - begin); counts.push(requests); sizes.push(bytes); hostTimes.push(hostMs);
          if (expected === undefined) expected = actual;
          assert.deepEqual(actual, expected, `${variant.name}: ${name}, RTT=${rtt}, iteration=${i}`); comparisons++;
        }
        const row = { variant: variant.name, case: name, rtt, coldMs: rounded(times[0]), warmMs: rounded(median(times.slice(1))), coldRequests: counts[0], warmRequests: median(counts.slice(1)), coldBytes: sizes[0], warmBytes: median(sizes.slice(1)), warmHostMs: rounded(median(hostTimes.slice(1))), idlePushBytesTotal: idleBytes.reduce((a, b) => a + b, 0), idlePushHostMsTotal: rounded(idleTimes.reduce((a, b) => a + b, 0)) };
        rows.push(row); console.log(JSON.stringify(row));
      } finally { discovery.dispose(); help?.dispose(); }
    }
  }
  await mkdir(new URL('../.test-artifacts/', import.meta.url), { recursive: true });
  const output = process.env.BENCH_OUTPUT || new URL('../.test-artifacts/architecture-benchmark.json', import.meta.url);
  await writeFile(output, JSON.stringify({ revisions: loaded.map(({ name, revision }) => ({ name, revision })), repeats, comparisons, runtime: process.version, platform: `${process.platform}/${process.arch}`, rows }, null, 2));
} finally { await rm(temp, { recursive: true, force: true }); }
