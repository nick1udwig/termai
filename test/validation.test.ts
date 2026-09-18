import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, access } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { candidateValid, syntaxValid } from '../server/validation.ts';
import { suggest, historyCandidates } from '../server/suggestions.ts';
import { Discovery, requiredFromHelp } from '../server/discovery.ts';
import { historySources, readHistory } from '../server/history.ts';
import type { Catalog } from '../src/protocol.ts';

test('history merges standard, eternal, and configured files; large files use a bounded tail', async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'termai-history-'));
  try {
    await writeFile(path.join(cwd, '.bash_history'), '#123456789\ngit status\n private command\n');
    await writeFile(path.join(cwd, '.bash_eternal_history'), '#123456790\ngit init\ngit status\n');
    const configured = path.join(cwd, 'custom-history');
    await writeFile(configured, 'git log --oneline\n');
    assert.deepEqual(await historySources({ HOME: cwd, HISTFILE: configured }), ['git init', 'git status', 'git log --oneline']);
    await writeFile(configured, 'x'.repeat(1024) + '\ngit init\n');
    assert.deepEqual(await readHistory(configured, 100), ['git init']);
    assert.deepEqual(await historySources({ HOME: cwd, TERMAI_HISTORY_FILE: configured }), ['x'.repeat(1024), 'git init']);
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

test('syntax checking never executes commands, substitutions, redirections, or inherited startup hooks', async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'termai-validation-'));
  try {
    assert.equal(await syntaxValid('touch executed; echo "$(touch substituted)" > redirected', cwd), true);
    for (const name of ['executed', 'substituted', 'redirected']) await assert.rejects(access(path.join(cwd, name)));
    assert.equal(await syntaxValid('echo "unfinished', cwd), false);
    assert.equal(await syntaxValid('echo hi &&', cwd), false);
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

test('candidate checks reject missing commands, invalid subcommands/flags, missing values and nonexistent input paths', async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'termai-validation-'));
  try {
    await writeFile(path.join(cwd, 'actual file.txt'), '');
    const catalog: Catalog = { cwd, commands: ['git', 'cat', 'getent', 'ls', 'echo', '_git_init'], functions: ['_git_init'], paths: ['actual file.txt'], history: [] };
    const metadata = { flags: { getent: [{ name: '--help', takesValue: false }] }, subcommands: {}, requiredPositionals: { getent: 1 } };
    const valid = (command: string) => candidateValid('Get in it.', { command, score: 100, changes: [] }, catalog, { HOME: cwd }, metadata);
    assert.equal(await valid('git init'), true);
    assert.equal(await valid('_git_init'), false);
    for (const line of ['nonexistentcommand', 'git nonsense', 'git status --oneline', 'git commit --message', 'ls --all=foo', 'cat missing.txt', 'getent']) assert.equal(await valid(line), false, line);
    assert.equal(await valid("cat 'actual file.txt'"), true);
    assert.equal(await valid('getent --help'), true);
    assert.equal(requiredFromHelp('Usage: getent [OPTION...] database [key ...]', 'getent'), 1);
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

test('speech and history produce git init, exclude completion helpers and distant filler, without creating a repository', async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'termai-git-init-'));
  try {
    const catalog: Catalog = { cwd, commands: ['git', 'getent', 'getino', '_git_init', '_git_status'], functions: ['_git_init', '_git_status'], paths: [], history: [] };
    for (const history of [[], ['git init', '_git_init']]) {
      const candidates = await suggest('Get in it.', { ...catalog, history }, process.env, new Discovery());
      assert.deepEqual(candidates.filter(candidate => !candidate.literal).map(candidate => candidate.command), ['git init']);
      assert.equal(candidates.at(-1)?.command, 'Get in it.');
      await assert.rejects(access(path.join(cwd, '.git')));
    }
    assert.equal(historyCandidates('git push', { ...catalog, history: ['git push origin main --force'] }).length, 0);
    const history: Catalog = { ...catalog, history: ['git init'], historyCwds: { 'git init': cwd } };
    assert.ok(historyCandidates('Get in it.', history)[0].score > historyCandidates('Get in it.', { ...history, historyCwds: {} })[0].score);
    const gitAliases = await suggest('git not-a-subcommand', catalog, process.env, new Discovery());
    assert.ok(gitAliases.every(candidate => candidate.literal));
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

test('referenced directories supply actual filenames and stale historical paths are rejected', async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'termai-referenced-'));
  try {
    await mkdir(path.join(cwd, 'docs'));
    await writeFile(path.join(cwd, 'docs', 'My Notes.txt'), '');
    const catalog: Catalog = { cwd, commands: ['cat'], paths: [], history: ['cat ~/docs/missing.txt'] };
    const candidates = await suggest('cat ~/docs/my notes dot txt', catalog, { ...process.env, HOME: cwd }, new Discovery());
    assert.equal(candidates[0].command, "cat ~/'docs/My Notes.txt'");
    assert.ok((await suggest('cat ~/docs/missing.txt', catalog, { ...process.env, HOME: cwd }, new Discovery())).every(candidate => candidate.literal));
  } finally { await rm(cwd, { recursive: true, force: true }); }
});
