import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { ShellContext } from '../server/context.ts';
import { prepareHistory } from '../server/suggestions.ts';
import { Session } from '../server/session.ts';

test('a new prompt notices files created inside an already-cataloged subdirectory', async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'termai-nearby-refresh-'));
  try {
    await mkdir(path.join(cwd, 'nested'));
    const session = new Session(cwd, []) as any;
    const before = await session.paths(cwd);
    session.state.prompt++;
    assert.equal(await session.paths(cwd), before, 'unchanged paths retain their matching index');
    await writeFile(path.join(cwd, 'nested', 'new-script.py'), '');
    session.state.prompt++;
    assert.ok((await session.paths(cwd)).includes('nested/new-script.py'));
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

test('shell snapshots coalesce prompt reads and preserve unchanged parsed arrays', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'termai-context-'));
  try {
    await writeFile(path.join(dir, 'commands'), 'git\nls\ngit\n');
    await writeFile(path.join(dir, 'functions'), '_helper\n');
    await writeFile(path.join(dir, 'environment'), 'PATH=/bin\0HOME=/tmp\0');
    const context = new ShellContext(dir);
    assert.equal(context.get(1), context.get(1));
    const first = await context.get(1);
    await writeFile(path.join(dir, 'environment'), 'PATH=/bin\0HOME=/tmp\0');
    const second = await context.get(2);
    assert.equal(first.commands, second.commands);
    assert.equal(first.functions, second.functions);
    assert.equal(first.environment, second.environment);
    await writeFile(path.join(dir, 'commands'), 'newtool\n');
    await writeFile(path.join(dir, 'environment'), 'PATH=/new/bin\0');
    const third = await context.get(3);
    assert.deepEqual(third.commands, ['newtool']);
    assert.equal(third.environment.PATH, '/new/bin');
  } finally { await rm(dir, { recursive: true, force: true }); }
});
test('history refresh reuses parsed entries while adding and evicting commands', () => {
  const history = ['git init', 'git status'];
  const before = prepareHistory({ history });
  const after = prepareHistory({ history: ['git status', 'git add .'] }, history);
  assert.equal(after.entries.get('git status'), before.entries.get('git status'));
  assert.equal(after.entries.has('git init'), false);
  assert.equal(after.entries.get('git add .')?.words[2].value, '.');
});
