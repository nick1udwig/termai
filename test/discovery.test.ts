import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Discovery, commandsFromHelp } from '../server/discovery.ts';
import { pathsIn, flagsFromHelp } from '../server/catalog.ts';
import { repair } from '../server/repair.ts';

test('learn flags using the shell PATH, isolate subcommands, coalesce requests, and never forward transcript arguments', async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'termai-discovery-'));
  try {
    await mkdir(path.join(cwd, 'bin'));
    await writeFile(path.join(cwd, 'bin', 'fixture-tool'), `#!/bin/sh
printf '%s\\n' "$*" >> probes
if [ "$1" = 'ship' ]; then
  printf '  --destination NAME  Target\\n'
else
  printf 'Commands:\\n  ship    Send the artifact\\nOptions:\\n  --loud  Verbose\\n'
fi
`, { mode: 0o700 });
    const catalog = { cwd, commands: ['fixture-tool'], paths: [], history: [] };
    const env = { PATH: path.join(cwd, 'bin') };
    const discovery = new Discovery();
    const [first, second] = await Promise.all([
      discovery.discover('fixture-tool ship destination SECRET', catalog, env),
      discovery.discover('fixture-tool ship destination SECRET', catalog, env),
    ]);
    assert.deepEqual(first, second);
    assert.equal(repair('fixture-tool Ship destination SECRET', catalog, undefined, first.metadata)[0].command, 'fixture-tool ship --destination SECRET');
    assert.equal(await readFile(path.join(cwd, 'probes'), 'utf8'), '--help\nship --help\n');
    await discovery.discover('fixture-tool ship destination OTHER', catalog, env);
    assert.equal(await readFile(path.join(cwd, 'probes'), 'utf8'), '--help\nship --help\n');
    assert.ok(!repair('fixture-tool destination SECRET', catalog, undefined, first.metadata)[0].command.includes('--destination'));
    await discovery.discover('fixture-tool && touch should-not-exist', catalog, env);
    assert.equal(await readFile(path.join(cwd, 'probes'), 'utf8'), '--help\nship --help\n');
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

test('directory catalog includes hidden files and normally skipped directory names', async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'termai-paths-'));
  try {
    await mkdir(path.join(cwd, 'node_modules'));
    await writeFile(path.join(cwd, '.hidden'), '');
    await writeFile(path.join(cwd, 'z-last.txt'), '');
    assert.deepEqual((await pathsIn(cwd)).sort(), ['.hidden', 'node_modules/', 'z-last.txt']);
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

test('help parsing recognizes subcommands and optional flag values', () => {
  assert.deepEqual(commandsFromHelp('Commands:\n  deploy    Deploy it\n  status    Show status\nOptions:\n  --json    JSON'), ['deploy', 'status']);
  assert.deepEqual(flagsFromHelp('  --output=FILE  Save file\n  --color[=WHEN]  Color\n  -q, --quiet  Silence'), [
    { name: '--output', takesValue: true }, { name: '--color', takesValue: false, optionalValue: true },
    { name: '-q', takesValue: false }, { name: '--quiet', takesValue: false },
  ]);
});

test('command listing recognizes Cobra, Clap and argparse layouts without treating option choices as commands', () => {
  assert.deepEqual(commandsFromHelp('Basic Commands (Beginner):\n  create    Create one\nOther Commands:\n  inspect   Inspect one\nOptions:\n  --color   Color'), ['create', 'inspect']);
  assert.deepEqual(commandsFromHelp('Commands:\n  workspace  Workspaces\n  help       Help\n\nOptions:\n  --mode {fast,slow}  Speed'), ['workspace', 'help']);
  assert.deepEqual(commandsFromHelp('positional arguments:\n  {reconcile,rollout}\n    reconcile  Reconcile it\noptions:\n  --color {red,blue}'), ['reconcile', 'rollout']);
  assert.deepEqual(commandsFromHelp('usage: git worktree add [OPTIONS] PATH\n   or: git worktree list [--porcelain]\n   or: git worktree remove PATH', 'git worktree'), ['add', 'list', 'remove']);
  assert.deepEqual(flagsFromHelp('    --[no-]porcelain      Machine-readable output'), [{ name: '--porcelain', takesValue: false }, { name: '--no-porcelain', takesValue: false }]);
});

test('cold discovery searches previously unknown nested subcommands and flags using only verified help routes', async () => {
  const { suggest } = await import('../server/suggestions.ts');
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'termai-command-tree-'));
  try {
    await mkdir(path.join(cwd, 'bin'));
    await writeFile(path.join(cwd, 'bin', 'orchard'), `#!/bin/sh
printf '%s\\n' "$*" >> probes
case "$*" in
  '--help') printf 'Available Commands:\\n  workspace    Workspace operations\\n  archive      Archives\\nOptions:\\n  --profile NAME  Account\\n';;
  'workspace --help') printf 'Commands:\\n  reconcile    Reconcile workspace\\n  suspend      Suspend workspace\\n';;
  'workspace reconcile --help') printf 'Options:\\n  --target NAME  Destination\\n  --preview  Preview\\n';;
  *) printf 'EXECUTED\\n' >> executed;;
esac
`, { mode: 0o700 });
    const catalog = { cwd, commands: ['orchard'], paths: [], history: [] };
    const env = { PATH: path.join(cwd, 'bin') };
    const discovery = new Discovery();
    const transcript = 'Orchard work space recon cile target PRIVATE_VALUE';
    const first = await suggest(transcript, catalog, env, discovery);
    assert.equal(first[0].command, 'orchard workspace reconcile --target PRIVATE_VALUE');
    assert.deepEqual(first.filter(candidate => !candidate.literal).map(candidate => candidate.command), ['orchard workspace reconcile --target PRIVATE_VALUE']);
    assert.equal(await readFile(path.join(cwd, 'probes'), 'utf8'), '--help\nworkspace --help\nworkspace reconcile --help\n');
    await assert.rejects(readFile(path.join(cwd, 'executed')));
    const again = await suggest('Orchard work space recon cile target OTHER_VALUE', catalog, env, discovery);
    assert.equal(again[0].command, 'orchard workspace reconcile --target OTHER_VALUE');
    assert.equal(await readFile(path.join(cwd, 'probes'), 'utf8'), '--help\nworkspace --help\nworkspace reconcile --help\n');
    const globalFlag = await suggest('orchard --profile PERSONAL workspace reconcile --preview', catalog, env, discovery);
    assert.equal(globalFlag[0].command, 'orchard --profile PERSONAL workspace reconcile --preview');
    const unknown = await suggest('orchard workspace destroy-everything target VALUE', catalog, env, discovery);
    assert.ok(unknown.every(candidate => candidate.literal));
    assert.equal(await readFile(path.join(cwd, 'probes'), 'utf8'), '--help\nworkspace --help\nworkspace reconcile --help\n');
  } finally { await rm(cwd, { recursive: true, force: true }); }
});
