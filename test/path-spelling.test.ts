import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { pathSpelling, directoryHost } from '../server/directory-host.ts';
import { repairDirectory } from '../src/engine/path-repair.ts';
import { repairInputFile } from '../src/engine/file-repair.ts';
import type { EngineHost } from '../src/engine/host.ts';
import { RemoteHost, type FactTransport } from '../src/remote-host.ts';
import type { Snapshot, Fact } from '../src/facts.ts';

test('stored path spelling retains symlinks and distinguishes exact names on case-sensitive filesystems', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'termai-spelling-'));
  try {
    await mkdir(path.join(root, 'Work', 'My Folder'), { recursive: true });
    await writeFile(path.join(root, 'Work', 'My Folder', 'Guide.md'), 'guide');
    await symlink(path.join(root, 'Work'), path.join(root, 'git'));
    assert.equal(await pathSpelling(path.join(root, 'GIT', 'my folder', 'guide.md')), path.join(root, 'git', 'My Folder', 'Guide.md'));
    assert.equal(await pathSpelling(path.join(root, 'git', 'nonexistent')), undefined);
    // Case-sensitive volumes may contain both names, and exact case must win.
    await writeFile(path.join(root, 'Work', 'My Folder', 'guide.md'), 'lowercase');
    const names = await directoryHost.entries(path.join(root, 'Work', 'My Folder'), 100);
    if (names.some(entry => entry.name === 'guide.md') && names.some(entry => entry.name === 'Guide.md'))
      assert.equal(await pathSpelling(path.join(root, 'git', 'My Folder', 'guide.md')), path.join(root, 'git', 'My Folder', 'guide.md'));
    const aborted = AbortSignal.abort();
    await assert.rejects(pathSpelling(path.join(root, 'git'), aborted), { name: 'AbortError' });
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('case-insensitive existence facts retain filename case in local and remote path repairs', async () => {
  const catalog = { cwd: '/home/me', commands: ['cd', 'cat', 'download', 'upload'], paths: [], history: [] };
  const stored = new Map([
    ['/home/me/git', { file: false, directory: true, executable: false }],
    ['/home/me/git/my folder', { file: false, directory: true, executable: false, spelling: '/home/me/git/My Folder' }],
    ['/home/me/docs', { file: false, directory: true, executable: false }],
    ['/home/me/docs/guide.md', { file: true, directory: false, executable: false, spelling: '/home/me/docs/Guide.md' }],
  ]);
  const host: EngineHost = {
    stat: async file => stored.get(file.toLowerCase()),
    lookup: async file => ({ info: stored.get(file.toLowerCase()) }),
    entries: async () => [], syntax: async () => true,
  };
  const requests: Fact[][] = [], signal = AbortSignal.timeout(4000);
  const transport: FactTransport = async <T>(body: any): Promise<T> => {
    requests.push(body.operations);
    return JSON.parse(JSON.stringify(await Promise.all(body.operations.map((op: Fact) => op.kind === 'stat' ? host.stat(op.path) : op.kind === 'lookup' ? host.lookup(op.path) : undefined)))) as T;
  };
  const snapshot: Snapshot = { key: 'fixture', catalog, prompt: 1, pathsIncluded: false, catalogKey: 'fixture', home: catalog.cwd, discoveryKey: 'fixture' };
  for (const current of [host, new RemoteHost(transport, snapshot, signal)]) {
    assert.equal((await repairDirectory('cd ~/git/my folder', catalog, catalog.cwd, current, signal))?.[0].command, "cd ~/'git/My Folder'");
    assert.equal((await repairDirectory('upload ~/git/my folder', catalog, catalog.cwd, current, signal))?.[0].command, "upload ~/'git/My Folder'");
    assert.equal((await repairDirectory('cd git/my folder/.', catalog, catalog.cwd, current, signal))?.[0].command, "cd 'git/My Folder/.'");
    assert.equal((await repairInputFile('cat docs/guide.md', catalog, catalog.cwd, current, signal))?.[0].command, 'cat docs/Guide.md');
    assert.equal((await repairInputFile("download 'docs/guide.md'", catalog, catalog.cwd, current, signal))?.[0].command, "download 'docs/Guide.md'");
    assert.equal((await repairInputFile('cat docs/./guide.md', catalog, catalog.cwd, current, signal))?.[0].command, 'cat docs/./Guide.md');
  }
  assert.equal(requests[0].length, 2, 'Whole-path stat and the first lookup still share a single remote batch');
});
