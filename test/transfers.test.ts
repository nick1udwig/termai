import { localBash } from '../server/shell.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import * as pty from 'node-pty';
import { TRANSFER_SHELL } from '../server/transfer-shell.ts';
import { Markers } from '../server/markers.ts';
import { parseTransfer, Transfers, type TransferEvent } from '../server/transfers.ts';
async function shell(cwd: string, command: string) {
  const events: TransferEvent[] = [], parser = new Markers('file-test', () => {}, () => {}); parser.onTransfer = e => events.push(e);
  const child = pty.spawn(localBash(), ['--noprofile', '--norc', '-c', TRANSFER_SHELL + '\n' + command], { cwd, env: { ...process.env, TERMAI_NONCE: 'file-test', TERMAI_TRANSFER_DIR: cwd }, cols: 80, rows: 24 });
  let output = ''; child.onData(data => output += parser.feed(data));
  const code = await new Promise<number>((resolve, reject) => { const timer = setTimeout(() => { child.kill(); reject(new Error('Transfer utility timed out')); }, 5000); child.onExit(({ exitCode }) => { clearTimeout(timer); resolve(exitCode); }); });
  return { events, output, code };
}
test('upload captures invocation cwd; download resolves quoted filenames without execution', async () => {
  const cwd = await mkdtemp('/tmp/termai-transfer-shell-');
  try {
    await writeFile(cwd + '/a file.bin', Buffer.from([0, 255]));
    const up = await shell(cwd, 'set -u; upload; cd /'); assert.equal(up.code, 0); assert.deepEqual(up.events, [{ action: 'upload', path: cwd }]);
    const down = await shell(cwd, "download 'a file.bin'"); assert.equal(down.code, 0); assert.deepEqual(down.events, [{ action: 'download', path: cwd + '/a file.bin' }]);
    const missing = await shell(cwd, 'download missing'); assert.equal(missing.code, 2); assert.deepEqual(missing.events, []);
  } finally { await rm(cwd, { recursive: true, force: true }); }
});
test('piped download keeps binary bytes on disk and supports an explicit filename', async () => {
  const cwd = await mkdtemp('/tmp/termai-transfer-pipe-');
  try {
    for (const named of [false, true]) {
      const result = await shell(cwd, `set -euo pipefail; printf '\\000\\377ABC' | download ${named ? "'result file.bin'" : ''}`);
      assert.equal(result.code, 0); assert.equal(result.output, ''); const event = result.events[0]; assert.equal(event.action, 'capture');
      if (event.action === 'capture') { assert.equal(event.name, named ? 'result file.bin' : 'command-output.txt'); assert.deepEqual(await readFile(cwd + '/' + event.file), Buffer.from([0, 255, 65, 66, 67])); }
    }
    const bad = await shell(cwd, "printf x | download ../unsafe"); assert.equal(bad.code, 2); assert.deepEqual(bad.events, []);
  } finally { await rm(cwd, { recursive: true, force: true }); }
});
test('private transfer markers survive chunking and reject path escapes in captures', () => {
  const events: TransferEvent[] = [], parser = new Markers('secret', () => {}, () => {}); parser.onTransfer = event => events.push(event);
  const marker = '\x1b]777;termai;secret;transfer-upload;' + Buffer.from('/some folder').toString('base64') + '\x07';
  let output = ''; for (const c of marker) output += parser.feed(c);
  assert.equal(output, ''); assert.deepEqual(events, [{ action: 'upload', path: '/some folder' }]);
  assert.equal(parseTransfer(['transfer-capture', '../escape', 'eA==']), undefined);
  assert.equal(parseTransfer(['transfer-capture', 'download.ABCDEFGH', Buffer.from('../bad').toString('base64')]), undefined);
  assert.equal(parser.feed(marker.replace('secret', 'wrong')), marker.replace('secret', 'wrong'));
});
test('requests replay until acknowledged, and captured disk files are removed on cleanup', async () => {
  const cwd = await mkdtemp('/tmp/termai-transfers-'); const transfers = new Transfers({ state: { cwd } });
  try {
    await writeFile(cwd + '/download.ABCDEFGH', 'data');
    const item = transfers.add({ action: 'capture', file: 'download.ABCDEFGH', name: 'out.txt' }, cwd);
    assert.deepEqual(transfers.pending(), [item]); transfers.acknowledge(item.id); assert.deepEqual(transfers.pending(), []); assert.ok(transfers.get(item.id));
    transfers.clear(); assert.equal(transfers.get(item.id), undefined);
    for (let i = 0; i < 100 && (await readdir(cwd)).length; i++) await new Promise(r => setTimeout(r, 5));
    assert.deepEqual(await readdir(cwd), []);
  } finally { transfers.clear(); await rm(cwd, { recursive: true, force: true }); }
});
