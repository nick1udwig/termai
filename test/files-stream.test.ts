import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { uploadFile, fileError } from '../server/files.ts';

test('streaming uploads preserve existing files and symlinks, accept empty files, and remove interrupted writes', async () => {
  const cwd = await mkdtemp('/tmp/termai-streams-');
  let completed!: () => void;
  const host = { state: { cwd } };
  const server = http.createServer(async (req, res) => {
    try { await uploadFile(host, '.', new URL(req.url!, 'http://localhost').searchParams.get('name')!, req); res.writeHead(200).end(); }
    catch (error) { if (!res.destroyed) res.writeHead(fileError(error).status || 400).end(); }
    finally { completed?.(); }
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const base = 'http://127.0.0.1:' + (server.address() as import('node:net').AddressInfo).port;
  try {
    await writeFile(cwd + '/original', 'keep'); await symlink('original', cwd + '/link');
    for (const name of ['original', 'link']) assert.equal((await fetch(base + '/?name=' + name, { method: 'POST', body: 'replace' })).status, 409);
    assert.equal(await readFile(cwd + '/original', 'utf8'), 'keep');
    assert.equal((await fetch(base + '/?name=empty', { method: 'POST', body: '' })).status, 200); assert.equal((await stat(cwd + '/empty')).size, 0);
    const done = new Promise<void>(resolve => completed = resolve);
    const request = http.request(base + '/?name=partial', { method: 'POST' }); request.on('error', () => {}); request.write(Buffer.alloc(256 * 1024));
    for (let i = 0; i < 200 && !(await stat(cwd + '/partial').catch(() => undefined))?.size; i++) await new Promise(resolve => setTimeout(resolve, 5));
    assert.ok((await stat(cwd + '/partial')).size > 0);
    request.destroy(); await done;
    assert.equal(await stat(cwd + '/partial').then(() => true, () => false), false);
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await rm(cwd, { recursive: true, force: true }); }
});
