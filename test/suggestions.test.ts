import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, access } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Discovery } from '../server/discovery.ts';
import { suggest, historyCandidates, prepareHistory, type SuggestStage } from '../server/suggestions.ts';
import type { Catalog } from '../src/protocol.ts';

class NoDiscovery extends Discovery {
  override async discover(): ReturnType<Discovery['discover']> { throw new Error('Live discovery should not run'); }
}

test('history preserves explicit options and quoted values instead of matching punctuation away', () => {
  const catalog: Catalog = { cwd: '/tmp', commands: ['git'], paths: [], history: [
    "git c . m 'add init commit'", "git c -M 'add init commit'", "git c -m 'add init commix'",
    "git c -m 'add init commit'", "git c -m 'add init commit' -a",
  ] };
  assert.deepEqual(historyCandidates('Git c -m "add init commit"', catalog).map(candidate => candidate.command), ["git c -m 'add init commit'"]);
});

test('strong history and common schemas bypass dynamic discovery while retaining validation', async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'termai-fast-suggest-'));
  try {
    const discovery = new NoDiscovery();
    const catalog: Catalog = { cwd, commands: ['git', 'ls'], paths: [], history: ['git init', 'git add .'] };
    prepareHistory(catalog);
    let stage: SuggestStage | undefined;
    for (const [input, command] of [['Git init', 'git init'], ['Git add .', 'git add .']]) {
      const choices = await suggest(input, catalog, process.env, discovery, value => stage = value);
      assert.equal(stage, 'history');
      assert.equal(choices[0].command, command);
    }
    const choices = await suggest('Git commit -m "exact message"', { ...catalog, history: [] }, process.env, discovery, value => stage = value);
    assert.equal(stage, 'schema');
    assert.equal(choices[0].command, "git commit -m 'exact message'");
    await assert.rejects(access(path.join(cwd, '.git')));
    assert.equal(discovery.stats.helpProbes, 0);
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

test('background prewarm learns unknown nested commands from history; dictation reuses metadata without searching', async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'termai-prewarm-'));
  try {
    await mkdir(path.join(cwd, 'bin'));
    await writeFile(path.join(cwd, 'bin', 'orchard'), `#!/bin/sh
printf '%s\\n' "$*" >> probes
case "$*" in
  '--help') printf 'Commands:\\n  workspace    Workspace operations\\n';;
  'workspace --help') printf 'Commands:\\n  reconcile    Reconcile workspace\\n';;
  'workspace reconcile --help') printf 'Options:\\n  --target NAME  Destination\\n';;
  *) printf 'EXECUTED\\n' >> executed;;
esac
`, { mode: 0o700 });
    const catalog: Catalog = { cwd, commands: ['orchard'], paths: [], history: ['orchard workspace reconcile --target PRIVATE_VALUE'] };
    const env = { PATH: path.join(cwd, 'bin') };
    const discovery = new Discovery();
    await discovery.prewarm(catalog, env);
    assert.equal(await readFile(path.join(cwd, 'probes'), 'utf8'), '--help\nworkspace --help\nworkspace reconcile --help\n');
    await discovery.prewarm(catalog, env);
    assert.equal(discovery.stats.helpProbes, 3);
    discovery.discover = async () => { throw new Error('Warm parsing must not search'); };
    let stage: SuggestStage | undefined;
    const choices = await suggest('Orchard work space recon cile target OTHER_VALUE', catalog, env, discovery, value => stage = value);
    assert.equal(stage, 'cache');
    assert.equal(choices[0].command, 'orchard workspace reconcile --target OTHER_VALUE');
    await assert.rejects(access(path.join(cwd, 'executed')));
    assert.deepEqual(discovery.cached({ ...catalog, cwd: '/tmp' }, env).flags, {});
    assert.deepEqual(discovery.cached(catalog, { PATH: '/another/path' }).flags, {});
    discovery.dispose();
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

test('simple Git aliases reuse builtin flags and preserve -m; shell aliases are never invoked', async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'termai-git-alias-'));
  try {
    const config = path.join(cwd, 'config');
    await writeFile(config, '[alias]\n c = commit\n danger = !touch alias-executed\n');
    const env = { PATH: '/usr/bin:/bin', HOME: cwd, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: config };
    const catalog: Catalog = { cwd, commands: ['git'], paths: [], history: ["git c . m 'add init commit'"] };
    const discovery = new Discovery();
    let stage: SuggestStage | undefined;
    const choices = await suggest('Git c -m "add init commit"', catalog, env, discovery, value => stage = value);
    assert.equal(stage, 'discovery');
    assert.equal(choices[0].command, "git c -m 'add init commit'");
    assert.ok(choices.every(candidate => !candidate.command.includes('. m')));
    await discovery.discover('git danger', catalog, env);
    await assert.rejects(access(path.join(cwd, 'alias-executed')));
    discovery.discover = async () => { throw new Error('Alias metadata should already be cached'); };
    assert.equal((await suggest('Git c -m "another message"', catalog, env, discovery, value => stage = value))[0].command, "git c -m 'another message'");
    assert.equal(stage, 'cache');
    await assert.rejects(access(path.join(cwd, '.git')));
  } finally { await rm(cwd, { recursive: true, force: true }); }
});
