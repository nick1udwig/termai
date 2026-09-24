import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, stat, writeFile, rm } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { WebSocket } from 'ws';
import { pairingToken, Pairings } from '../server/pairing.ts';

test('pairing tokens are generated privately, reused, and cannot be disabled by empty configuration', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'termai-pairing-'));
  try {
    const data = path.join(directory, 'data');
    const token = pairingToken(data);
    assert.match(token, /^[a-f0-9]{64}$/);
    assert.equal((await stat(path.join(data, 'pairing-token'))).mode & 0o777, 0o600);
    assert.equal((await stat(data)).mode & 0o777, 0o700);
    assert.equal(pairingToken(data, ''), token);
    assert.equal(pairingToken(data), token);
    const configured = 'explicit-pairing-token-123456789';
    assert.equal(pairingToken(data, configured), configured);
    assert.equal(pairingToken(data), token, 'an override must not overwrite the generated token');
    assert.throws(() => pairingToken(data, 'short'), /at least 24/);
    assert.throws(() => pairingToken(data, ' '.repeat(24)), /whitespace/);
    await writeFile(path.join(data, 'pairing-token'), '');
    assert.throws(() => pairingToken(data), /at least 24/, 'corrupt token files must fail closed');
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('paired device credentials survive reloads, remain backend-specific, and are revoked by code rotation', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'termai-paired-clients-'));
  try {
    const code = 'original-pairing-code-123456789';
    const registry = new Pairings(directory, code), first = registry.issue(), second = registry.issue();
    assert.notEqual(first, second);
    const restored = new Pairings(directory, code);
    assert.ok(restored.has(first)); assert.ok(restored.has(second));
    assert.equal(restored.has('0'.repeat(64)), false);
    assert.equal(restored.has(code), false);
    const disk = await readFile(path.join(directory, 'paired-clients.json'), 'utf8');
    assert.ok(!disk.includes(first) && !disk.includes(second) && !disk.includes(code));
    for (const hash of JSON.parse(disk).credentials) assert.equal(restored.has(hash), false, 'stored hashes are not usable bearer tokens');
    assert.equal((await stat(path.join(directory, 'paired-clients.json'))).mode & 0o777, 0o600);
    assert.equal(new Pairings(path.join(directory, 'other-backend'), code).has(first), false);
    const rotated = new Pairings(directory, 'replacement-pairing-code-123456789');
    assert.equal(rotated.has(first), false); assert.equal(rotated.has(second), false);
    assert.equal(new Pairings(directory, code).has(first), false, 'changing back must not restore revoked credentials');
    await writeFile(path.join(directory, 'paired-clients.json'), '{}');
    assert.throws(() => new Pairings(directory, code), /Invalid paired-clients/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('the original localhost backend requires pairing for cookies, bearer access and websocket tickets', { timeout: 20000 }, async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'termai-pairing-http-'));
  const reservation = net.createServer();
  reservation.listen(0, '127.0.0.1'); await once(reservation, 'listening');
  const port = (reservation.address() as net.AddressInfo).port;
  await new Promise<void>(resolve => reservation.close(() => resolve()));
  const origin = `http://127.0.0.1:${port}`, base = origin + '/paired';
  const frontend = 'https://frontend.example';
  const server = spawn(process.execPath, ['server/index.ts'], {
    cwd: path.resolve(import.meta.dirname, '..'),
    env: { ...process.env, NODE_ENV: 'production', HOST: '127.0.0.1', PORT: String(port), TERMAI_TOKEN: '',
      TERMAI_DATA_DIR: directory, TERMAI_ALLOWED_HOSTS: '127.0.0.1', TERMAI_ALLOWED_ORIGINS: frontend,
      TERMAI_BASE_PATH: '/paired', TERMAI_ENGINE: 'server' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const exited = once(server, 'exit');
  try {
    await new Promise<void>((resolve, reject) => {
      let output = '';
      const timer = setTimeout(() => reject(new Error('Server startup timed out: ' + output)), 10000);
      server.once('error', error => { clearTimeout(timer); reject(error); });
      server.once('exit', () => { clearTimeout(timer); reject(new Error('Server exited: ' + output)); });
      server.stderr.on('data', chunk => output += chunk);
      server.stdout.on('data', chunk => {
        output += chunk;
        if (output.includes('Pairing token:')) { clearTimeout(timer); resolve(); }
      });
    });
    const token = (await readFile(path.join(directory, 'pairing-token'), 'utf8')).trim();
    const connect = (data: unknown, headers: Record<string, string> = {}) => fetch(base + '/api/connect', {
      method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(data),
    });
    for (const input of [{}, { noSession: true }, { token: '' }, { token: 'wrong' }, { token: 'f'.repeat(64) }, { token: 123 }]) {
      const response = await connect(input);
      assert.equal(response.status, 401);
      assert.equal(response.headers.get('set-cookie'), null);
      assert.match((await response.json()).error, /pairing token/);
    }
    assert.equal((await connect({ token, noSession: true }, { Origin: 'https://untrusted.example' })).status, 403);
    assert.equal((await connect({ noSession: true }, { Origin: frontend })).status, 401);
    for (const endpoint of ['ping', 'sessions', 'keychain', 'context']) {
      assert.equal((await fetch(base + '/api/' + endpoint)).status, 401);
    }
    assert.equal((await fetch(base + '/api/ticket', { method: 'POST', headers: { Origin: origin } })).status, 401);
    await new Promise<void>((resolve, reject) => {
      const socket = new WebSocket(base.replace('http:', 'ws:') + '/ws', { origin });
      socket.once('open', () => { socket.close(); reject(new Error('Unpaired websocket accepted')); });
      socket.once('error', error => { try { assert.match(error.message, /403/); resolve(); } catch (failure) { reject(failure); } });
    });
    const paired = await connect({ token, noSession: true });
    assert.equal(paired.status, 200);
    const { accessToken } = await paired.json();
    assert.match(accessToken, /^[a-f0-9]{64}$/);
    assert.notEqual(accessToken, token);
    const cookie = paired.headers.get('set-cookie')!;
    assert.match(cookie, /Path=\/paired\/; HttpOnly; SameSite=Strict/);
    assert.match(cookie, /Max-Age=31536000/);
    assert.equal((await connect({ noSession: true }, { Cookie: cookie.split(';')[0] })).status, 200);
    const resumed = await connect({ noSession: true }, { Authorization: 'Bearer ' + accessToken, Origin: frontend });
    assert.equal(resumed.status, 200);
    assert.match(resumed.headers.get('set-cookie')!, /Max-Age=31536000; Secure/, 'bearer reconnect must renew the persistent cookie');
    const sessions = await fetch(base + '/api/sessions', { headers: { Authorization: 'Bearer ' + accessToken } });
    assert.deepEqual(await sessions.json(), [], 'pairing must not create a shell');
    assert.equal((await connect({ noSession: true }, { Authorization: 'Bearer ' + token })).status, 401);
  } finally {
    server.kill('SIGTERM'); await exited;
    await rm(directory, { recursive: true, force: true });
  }
});
