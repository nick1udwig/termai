import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { repairDirectory, suggest } from './local-engine.ts';
import { Discovery } from './local-discovery.ts';

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

test('spoken tilde and slash produce verified alternatives for the dictated project path', async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'termai-spoken-path-'));
  const discovery = new Discovery();
  try {
    await mkdir(path.join(home, 'Work', 'git', 'termai'), { recursive: true });
    await mkdir(path.join(home, 'Work', 'git', 'termay'));
    await writeFile(path.join(home, 'Work', 'git', 'termee'), 'A file must not be suggested for cd');
    await symlink(path.join(home, 'Work', 'git'), path.join(home, 'git'));
    const catalog = { cwd: path.join(home, 'Work', 'git', 'termai'), commands: ['cd', 'pushd'], paths: [], history: [] };
    const input = 'cd tilde slash git slash termei';
    const result = await suggest(input, catalog, { ...process.env, HOME: home }, discovery);
    assert.deepEqual(result.filter(candidate => !candidate.literal).map(candidate => candidate.command), ['cd ~/git/termai', 'cd ~/git/termay']);
    assert.equal(result.at(-1)?.command, input);
    assert.equal(result.at(-1)?.literal, true);
    const nearby = await suggest('cd tilda slach git slach termei', catalog, { ...process.env, HOME: home }, discovery);
    assert.deepEqual(nearby.filter(candidate => !candidate.literal).map(candidate => candidate.command), ['cd ~/git/termai', 'cd ~/git/termay']);
    assert.equal(nearby.at(-1)?.command, 'cd tilda slach git slach termei');
    for (const spoken of ['kid', 'kit']) {
      const altered = `cd tilde slash ${spoken} slash term ai`;
      const alternatives = await suggest(altered, catalog, { ...process.env, HOME: home }, discovery);
      assert.equal(alternatives[0].command, 'cd ~/git/termai', JSON.stringify(alternatives));
      assert.equal(alternatives.at(-1)?.command, altered);
    }
    const omittedParent = await suggest('cd tilde slash term ai', catalog, { ...process.env, HOME: home }, discovery);
    assert.equal(omittedParent[0].command, 'cd ~/git/termai');
    assert.equal(omittedParent.at(-1)?.command, 'cd tilde slash term ai');
    await writeFile(path.join(home, 'termai'), 'An exact file blocks a search below home');
    assert.deepEqual((await suggest('cd tilde slash termai', catalog, { ...process.env, HOME: home }, discovery)).map(candidate => candidate.command), ['cd tilde slash termai']);
    assert.deepEqual((await suggest('cd tilde slash git slash nonexistent', catalog, { ...process.env, HOME: home }, discovery)).map(candidate => candidate.command), ['cd tilde slash git slash nonexistent']);
    assert.deepEqual(await repairDirectory('cd "tilde slash git slash termei"', catalog, home), []);
  } finally { discovery.dispose(); await rm(home, { recursive: true, force: true }); }
});
