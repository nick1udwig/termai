import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, chmod, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { Writable } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { gzipSync, brotliCompressSync, brotliDecompressSync } from 'node:zlib';
import { acceptedEncodings, staticAssets } from '../server/assets.ts';

class Response extends Writable {
  headers: Record<string, unknown> = {};
  chunks: Buffer[] = [];
  statusCode = 200;
  headersSent = false;
  setHeader(name: string, value: unknown) { this.headers[name] = value; }
  writeHead(status: number) { this.statusCode = status; return this; }
  override _write(chunk: Buffer, _: string, done: () => void) { this.headersSent = true; this.chunks.push(Buffer.from(chunk)); done(); }
  get body() { return Buffer.concat(this.chunks); }
}
test('encoding negotiation respects exclusions, preferences and identity fallback', () => {
  assert.deepEqual(acceptedEncodings(), ['identity']);
  assert.deepEqual(acceptedEncodings('gzip, br'), ['br', 'gzip', 'identity']);
  assert.deepEqual(acceptedEncodings('br;q=0, gzip;q=1, identity;q=0.5'), ['gzip', 'identity']);
  assert.deepEqual(acceptedEncodings('*;q=0'), []);
});
test('static assets stream negotiated variants, serve body-free HEAD and rewrite mounted HTML', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'termai-assets-'));
  try {
    await mkdir(path.join(dir, 'assets'));
    const file = path.join(dir, 'assets', 'app.js'), content = Buffer.from('const hello = "world";'.repeat(100));
    await writeFile(file, content); await writeFile(file + '.gz', gzipSync(content)); await writeFile(file + '.br', brotliCompressSync(content));
    await writeFile(path.join(dir, 'index.html'), '<base href="/" data-termai-base><main>Hi</main>');
    const serve = staticAssets(dir, '/mounted/');
    const request = async (pathname: string, encoding?: string, method = 'GET') => {
      const response = new Response();
      await serve({ method, headers: { 'accept-encoding': encoding } } as IncomingMessage, response as unknown as ServerResponse, pathname);
      return response;
    };
    const compressed = await request('/assets/app.js', 'gzip, br');
    assert.equal(compressed.headers['Content-Encoding'], 'br');
    assert.equal(compressed.headers['Vary'], 'Accept-Encoding');
    assert.deepEqual(brotliDecompressSync(compressed.body), content);
    assert.deepEqual((await request('/assets/app.js')).body, content);
    assert.equal((await request('/assets/app.js', '*;q=0')).statusCode, 406);
    await chmod(file, 0);
    const head = await request('/assets/app.js', undefined, 'HEAD');
    assert.equal(head.statusCode, 200); assert.equal(head.body.length, 0); assert.equal(head.headers['Content-Length'], content.length);
    assert.match((await request('/')).body.toString(), /href="\/mounted\/"/);
    assert.equal((await request('/missing')).statusCode, 404);
    assert.equal((await request('/../outside')).statusCode, 403);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
