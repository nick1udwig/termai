import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, mkdir, chmod, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { directoryEntries } from '../server/directories.ts';
import { repairDirectory } from '../server/path-repair.ts';

test('directory enumeration respects entry budgets, sorting and cancellation', async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'termai-directory-budget-'));
  try {
    await Promise.all(Array.from({ length: 100 }, (_, i) => writeFile(path.join(cwd, `file-${i}`), '')));
    assert.deepEqual(await directoryEntries(cwd, 0), []);
    const names = (await directoryEntries(cwd, 7)).map(entry => entry.name);
    assert.equal(names.length, 7);
    assert.deepEqual(names, [...names].sort());
    assert.deepEqual((await directoryEntries(cwd, 7)).map(entry => entry.name), names);
    await assert.rejects(directoryEntries(cwd, 7, AbortSignal.abort()), { name: 'AbortError' });
  } finally { await rm(cwd, { recursive: true, force: true }); }
});
test('exact paths work without directory listing permission and exact files do not become directories', async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'termai-exact-directory-'));
  const protectedDir = path.join(cwd, 'protected');
  try {
    await mkdir(path.join(protectedDir, 'target'), { recursive: true });
    await writeFile(path.join(cwd, 'file'), ''); await mkdir(path.join(cwd, 'files'));
    await chmod(protectedDir, 0o111);
    const catalog = { cwd, commands: ['cd'], paths: [], history: [] };
    assert.equal((await repairDirectory('cd protected/target', catalog, cwd))?.[0].command, 'cd protected/target');
    assert.deepEqual(await repairDirectory('cd file', catalog, cwd), []);
  } finally { await chmod(protectedDir, 0o700); await rm(cwd, { recursive: true, force: true }); }
});
