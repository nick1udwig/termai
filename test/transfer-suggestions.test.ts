import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { suggest } from '../server/suggestions.ts';
import { transferAction, downloadPipeline } from '../src/engine/transfer-command.ts';
import type { MetadataDiscovery } from '../src/engine/host.ts';

test('transfer alternatives resolve real paths, nested spelling, home paths and preserve output names', async () => {
  const cwd = await mkdtemp('/tmp/termai-transfer-suggest-');
  await mkdir(cwd + '/Documents/project', { recursive: true });
  await writeFile(cwd + '/hello_world.py', 'world'); await writeFile(cwd + '/hello-world.py', 'other');
  await writeFile(cwd + '/Documents/project/My Notes.txt', 'notes');
  const discoveries: string[] = [];
  const metadata = { flags: {}, subcommands: {}, requiredPositionals: {} };
  const discovery: MetadataDiscovery = { cached: () => metadata, discover: async command => { discoveries.push(command); return { metadata }; } };
  const catalog = { cwd, commands: ['download', 'upload', 'cat', 'echo'], paths: [], history: [] };
  const choices = async (input: string) => (await suggest(input, catalog, { HOME: cwd }, discovery)).filter(c => !c.literal).map(c => c.command);
  try {
    const both = await choices('Download hello world dot py'); assert.ok(both.includes('download hello_world.py'), JSON.stringify(both)); assert.ok(both.includes('download hello-world.py'));
    assert.deepEqual(await choices('download hello_world.py'), ['download hello_world.py']);
    assert.deepEqual(await choices('download missing.py'), []);
    assert.ok((await choices('cat documents slash project slash my notes dot txt')).includes("cat 'Documents/project/My Notes.txt'"), 'Reader paths use the same live filesystem walk');
    assert.deepEqual(await choices('download Documents'), []);
    assert.ok((await choices('download documents slash project slash my notes dot txt')).includes("download 'Documents/project/My Notes.txt'"));
    assert.deepEqual(await choices('download ~/Documents/project/MyNotes.txt'), ["download ~/'Documents/project/My Notes.txt'"]);
    assert.ok((await choices('download --file hello_world.py')).includes('download --file hello_world.py'));
    assert.ok((await choices('upload documents slash project')).includes('upload Documents/project'));
    assert.deepEqual(await choices('upload hello_world.py'), []);
    assert.ok((await choices('upload')).includes('upload'));
    assert.ok((await choices('cat hello world dot py pipe download new-output.txt')).some(c => c === 'cat hello_world.py | download new-output.txt'));
    assert.deepEqual(discoveries.filter(command => /^(upload|download)(?:\s|$)/.test(command)), [], 'Managed actions must not be run or probed for --help');
    assert.equal(transferAction('upload'), 'upload'); assert.equal(transferAction('echo upload'), undefined);
    assert.equal(downloadPipeline('echo "| download"'), undefined);
  } finally { await rm(cwd, { recursive: true, force: true }); }
});
