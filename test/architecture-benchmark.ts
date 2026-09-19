/** Controlled comparison: real host facts, JSON transport, configurable simulated RTT.
 * Client CPU runs in Node here; use browser/device profiling before shipping. */
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';
import { Facts } from '../server/facts.ts';
import { HelpProvider } from '../server/help.ts';
import { ContextCache, RemoteHost, type FactTransport } from '../src/remote-host.ts';
import { Discovery } from '../src/engine/discovery.ts';
import { suggest } from '../src/engine/suggestions.ts';
import type { Catalog } from '../src/protocol.ts';

const reference = process.env.BENCH_BASE || 'ba21e2c';
const rtts = (process.env.BENCH_RTT || '0,50,150').split(',').map(Number);
const repeats = Number(process.env.BENCH_REPEATS || 3);
const temp = await mkdtemp(path.join(os.tmpdir(), 'termai-architecture-'));
const baseline = path.join(temp, 'baseline'), cwd = path.join(temp, 'fixture');
await mkdir(baseline); await mkdir(cwd);
const archive = execFileSync('git', ['archive', reference, 'server', 'src', 'package.json'], { maxBuffer: 10 * 1024 * 1024 });
execFileSync('tar', ['-x', '-C', baseline], { input: archive });
const { suggest: oldSuggest } = await import(pathToFileURL(path.join(baseline, 'server/suggestions.ts')).href);
const { Discovery: OldDiscovery } = await import(pathToFileURL(path.join(baseline, 'server/discovery.ts')).href);
await mkdir(path.join(cwd, 'git', 'pebble-agent'), { recursive: true });
await mkdir(path.join(cwd, 'docs'));
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
  paths: ['hello_world.py', 'docs/', 'git/'], history: [...Array.from({ length: 4999 }, (_, i) => `program${i % 3000} argument${i}`), 'git init'] };
const env = { HOME: cwd, PATH: cwd + ':/usr/bin:/bin' };
const cases = [
  ['history', 'Get in it.'], ['schema', 'Git commit -m "exact message"'], ['flags', 'LSL'],
  ['python', 'Python three hello world dot py myarg food'], ['nested help', 'Orchard work space recon cile target VALUE'],
  ['directory', 'Cd ~ fas get fas pebble agent'], ['referenced file', 'cat ~/docs/my notes dot txt'],
] as const;
const rows: unknown[] = [];
const delay = (ms: number) => ms ? new Promise(resolve => setTimeout(resolve, ms)) : Promise.resolve();
const median = (values: number[]) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
try {
  for (const rtt of rtts) for (const [name, text] of cases) {
    const oldDiscovery = new OldDiscovery(), help = new HelpProvider();
    const source = { state: { cwd, prompt: 1, ready: true, exited: false }, catalog: async () => catalog, environment: async () => env, help };
    const facts = new Facts(source), cache = new ContextCache(), syntax = new Map<string, boolean>();
    let currentHost: RemoteHost, requests = 0, bytes = 0, hostMs = 0;
    const discovery = new Discovery({ help: (command, route) => currentHost.help(command, route), describe: command => currentHost.describe(command) });
    const transport: FactTransport = async <T>(body: any, signal: AbortSignal): Promise<T> => {
      requests++; bytes += Buffer.byteLength(JSON.stringify(body));
      await delay(rtt / 2);
      const start = performance.now();
      const result = body.kind === 'context' ? await facts.context(body.known) : await facts.read(body.key, body.operations, signal);
      hostMs += performance.now() - start;
      const wire = JSON.stringify(result); bytes += Buffer.byteLength(wire);
      await delay(rtt / 2); return JSON.parse(wire) as T;
    };
    const oldTimes: number[] = [], clientTimes: number[] = [], batchCounts: number[] = [], byteCounts: number[] = [], hostTimes: number[] = [], baselineHostTimes: number[] = [];
    try {
      for (let i = 0; i <= repeats; i++) {
        const start = performance.now();
        await delay(rtt / 2);
        const hostStart = performance.now();
        const expected = await oldSuggest(text, catalog, env, oldDiscovery);
        baselineHostTimes.push(performance.now() - hostStart);
        await delay(rtt / 2); oldTimes.push(performance.now() - start);
        requests = bytes = hostMs = 0;
        const begin = performance.now(), signal = AbortSignal.timeout(5000);
        const snapshot = await cache.get(transport, signal);
        currentHost = new RemoteHost(transport, snapshot, signal, syntax);
        const actual = await suggest(text, snapshot.catalog, { HOME: snapshot.home, HOST_CONTEXT: snapshot.discoveryKey }, discovery, currentHost, undefined, signal);
        assert.deepEqual(actual, expected, `${name}, RTT=${rtt}, iteration=${i}: candidate parity`);
        clientTimes.push(performance.now() - begin); batchCounts.push(requests); byteCounts.push(bytes); hostTimes.push(hostMs);
      }
      const row = { case: name, rtt, baselineColdMs: +oldTimes[0].toFixed(1), clientColdMs: +clientTimes[0].toFixed(1), coldRequests: batchCounts[0], coldBytes: byteCounts[0],
        baselineWarmMs: +median(oldTimes.slice(1)).toFixed(1), clientWarmMs: +median(clientTimes.slice(1)).toFixed(1), warmRequests: median(batchCounts.slice(1)), warmBytes: median(byteCounts.slice(1)),
        baselineWarmHostMs: +median(baselineHostTimes.slice(1)).toFixed(2), clientWarmHostMs: +median(hostTimes.slice(1)).toFixed(2) };
      rows.push(row); console.log(JSON.stringify(row));
    } finally { oldDiscovery.dispose(); discovery.dispose(); help.dispose(); }
  }
  await mkdir(new URL('../.test-artifacts/', import.meta.url), { recursive: true });
  await writeFile(new URL('../.test-artifacts/architecture-benchmark.json', import.meta.url), JSON.stringify({ reference, repeats, runtime: process.version, platform: `${process.platform}/${process.arch}`, rows }, null, 2));
} finally { await rm(temp, { recursive: true, force: true }); }
