import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { repairDirectory } from './local-engine.ts';

test('matching regular files cannot crowd a directory out of the repair shortlist', async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'termai-directory-rank-'));
  try {
    for (let i = 0; i < 8; i++) await writeFile(path.join(cwd, 'folder' + i), '');
    await mkdir(path.join(cwd, 'folders'));
    const catalog = { cwd, commands: ['cd'], paths: [], history: [] };
    assert.equal((await repairDirectory('cd folder', catalog, cwd))?.[0].command, 'cd folders');
    await writeFile(path.join(cwd, 'folder'), '');
    assert.deepEqual(await repairDirectory('cd folder', catalog, cwd), [], 'An exact file still blocks fuzzy replacement');
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

test('whole-path lookup retains quoting, scores and missing-prefix dot-dot behavior', async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'termai-directory-exact-'));
  try {
    await mkdir(path.join(cwd, 'one', 'two', 'three', 'My Folder'), { recursive: true });
    const catalog = { cwd, commands: ['cd'], paths: [], history: [] };
    const result = await repairDirectory('cd one/two/three/My Folder', catalog, cwd);
    assert.equal(result?.[0].command, "cd 'one/two/three/My Folder'");
    assert.equal(result?.[0].score, 210);
    assert.deepEqual(await repairDirectory('cd nonexistent/../one', catalog, cwd), []);
  } finally { await rm(cwd, { recursive: true, force: true }); }
});
