import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { repairDirectory } from '../server/path-repair.ts';

test('directory paths are resolved component by component from home, cwd, and root', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'termai-paths-'));
  try {
    await mkdir(path.join(root, 'work', 'git', 'pebble-agent'), { recursive: true });
    await mkdir(path.join(root, 'work', 'git', 'My Folder'));
    await mkdir(path.join(root, 'work', 'git', 'FooBar'));
    await symlink(path.join(root, 'work', 'git'), path.join(root, 'git'));
    await writeFile(path.join(root, 'git', 'file-only'), 'Not a directory');
    const catalog = { cwd: root, commands: ['cd', '_cd', 'pushd', 'echo'], paths: [], history: [] };
    for (const input of ['Cd ~/git/pebble agent', 'CD ~/get/Pebble agent', 'cd ~ fas get fas pebble agent']) {
      const result = await repairDirectory(input, catalog, root);
      assert.equal(result?.[0].command, 'cd ~/git/pebble-agent');
      assert.ok(result?.every(candidate => !candidate.command.startsWith('_cd')));
    }
    assert.equal((await repairDirectory('cd git/pebble agent', catalog, root))?.[0].command, 'cd git/pebble-agent');
    assert.equal((await repairDirectory(`cd ${root}/git/pebble agent`, catalog, root))?.[0].command, `cd ${root}/git/pebble-agent`);
    assert.equal((await repairDirectory('cd ~/git/my folder', catalog, root))?.[0].command, "cd ~/'git/My Folder'");
    assert.equal((await repairDirectory('cd git/foo bar', catalog, root))?.[0].command, 'cd git/FooBar');
    assert.deepEqual(await repairDirectory('cd ~/git/nonexistent', catalog, root), []);
    assert.deepEqual(await repairDirectory('cd ~/git/file-only', catalog, root), []);
    assert.equal(await repairDirectory('echo ~/get/pebble agent', catalog, root), undefined);
    assert.equal(await repairDirectory('cd -', catalog, root), undefined);
    assert.equal(await repairDirectory('cd $(touch should-not-exist)', catalog, root), undefined);
    // New directories participate immediately; exact names are never fuzzy-replaced.
    await mkdir(path.join(root, 'get'));
    assert.deepEqual(await repairDirectory('cd ~/get/pebble agent', catalog, root), []);
    assert.deepEqual(await repairDirectory('cd "~/git/pebble agent"', catalog, root), []);
  } finally { await rm(root, { recursive: true, force: true }); }
});
