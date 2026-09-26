import { chromium } from 'playwright-core';
import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, mkdir, rm, access } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { WebSocketServer } from 'ws';
const root = path.resolve(import.meta.dirname, '..');
const fixture = await mkdtemp(path.join(os.tmpdir(), 'termai-dictation-browser-'));
await mkdir(path.join(fixture, 'source/scripts'), { recursive: true });
await writeFile(path.join(fixture, 'source/scripts/install'), 'touch ' + path.join(fixture, 'installed'));
const daemon = new WebSocketServer({ host: '127.0.0.1', port: 0 }); await once(daemon, 'listening');
let audioBytes = 0;
daemon.on('connection', (socket, request) => {
  assert.equal(request.headers.authorization, 'Bearer ' + 'secret'.repeat(8));
  assert.equal(request.headers.origin, undefined);
  if (request.url === '/v1/capabilities') { socket.send(JSON.stringify({ type: 'capabilities', protocol: 1, dictation: true, sample_rate: 16000, channels: 1, format: 'pcm_s16le', results: ['partial', 'final'] })); return; }
  socket.send(JSON.stringify({ type: 'ready', protocol: 1, sample_rate: 16000, channels: 1, format: 'pcm_s16le', max_seconds: 300 }));
  socket.on('message', (bytes, binary) => {
    if (binary) audioBytes += bytes.length;
    else if (JSON.parse(bytes.toString()).type === 'finish') {
      socket.send(JSON.stringify({ type: 'partial', text: 'never forward this preview' }));
      socket.send(JSON.stringify({ type: 'final', text: 'echo VOICE_BACKEND' }));
    }
  });
});
const port = Number(process.env.TEST_PORT || 3176), base = `http://127.0.0.1:${port}`;
const server = spawn(process.execPath, ['server/index.ts'], { cwd: root, env: { ...process.env, HOME: fixture, XDG_DATA_HOME: path.join(fixture, 'data'), NODE_ENV: 'production', HOST: '127.0.0.1', PORT: String(port), TERMAI_TOKEN: 'feature-test-pairing-token-123456789', TERMAI_ALLOWED_HOSTS: '127.0.0.1', TERMAI_NO_RC: '1', TERMAI_CWD: fixture, TERMAI_VOXTYPE_SOURCE: path.join(fixture, 'source'), TERMAI_VOXTYPE_TOKEN_FILE: path.join(fixture, 'token'), TERMAI_VOXTYPE_URL: `ws://127.0.0.1:${daemon.address().port}/v1/dictate` }, stdio: ['ignore', 'pipe', 'pipe'] });
let logs = ''; server.stdout.on('data', b => logs += b); server.stderr.on('data', b => logs += b);
let browser;
try {
  for (let i = 0; i < 100; i++) { if (await fetch(base).then(r => r.ok, () => false)) break; if (server.exitCode !== null) throw new Error(logs); await new Promise(r => setTimeout(r, 100)); }
  browser = await chromium.launch({ executablePath: process.env.CHROMIUM || '/usr/bin/chromium', headless: true, args: ['--use-gl=angle', '--use-angle=gl', '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'] });
  const page = await browser.newPage({ viewport: { width: 600, height: 850 }, hasTouch: true });
  const errors = []; page.on('pageerror', error => errors.push(String(error)));
  await page.addInitScript(() => {
    window.__messages = []; window.__out = ''; window.__paint = [];
    const paint = CanvasRenderingContext2D.prototype.fillText;
    CanvasRenderingContext2D.prototype.fillText = function(text, x, y, ...args) { window.__paint.push({ text, x, y }); return paint.call(this, text, x, y, ...args); };
    const Original = WebSocket;
    window.WebSocket = class extends Original {
      constructor(...args) { super(...args); this.addEventListener('message', event => { const m = JSON.parse(event.data); window.__messages.push(m); if (m.type === 'output') window.__out += m.data; if (m.type === 'state') window.__state = m.state; }); }
      send(data) { if (typeof data === 'string') { const m = JSON.parse(data); if (m.type === 'resize') window.__size = m; } super.send(data); }
    };
  });
  page.setDefaultTimeout(20000);
  await page.goto(base + '/terminal.html');
  await page.locator('#token').fill('feature-test-pairing-token-123456789'); await page.locator('#login-form button').click();
  await page.waitForFunction(() => window.__state?.ready);
  await page.locator('#dictation-install').waitFor({ state: 'visible' });
  await page.locator('#dictation-install input').check();
  await page.locator('[data-install]').click();
  await page.waitForFunction(() => window.__out.includes('/scripts/install'));
  assert.equal(await access(path.join(fixture, 'installed')).then(() => true, () => false), false, 'Install must not execute');
  await page.locator('#terminal textarea').focus(); await page.keyboard.press('Control+u');
  await page.reload(); await page.waitForFunction(() => window.__state?.ready);
  await page.waitForTimeout(300); assert.equal(await page.locator('#dictation-install').isVisible(), false);
  await page.locator('#terminal textarea').focus(); await page.keyboard.press('Enter');
  await page.waitForFunction(() => window.__state?.ready && window.__state.prompt > 1);
  // Touch an editable cell, then type there. The running command proves real Readline movement.
  await page.locator('#terminal textarea').focus(); await page.keyboard.type('echo Z12345');
  await page.waitForTimeout(250);
  const point = await page.evaluate(() => {
    const mark = window.__paint.filter(p => p.text === '3').at(-1); if (!mark) throw new Error('Missing terminal glyph');
    const canvas = document.querySelector('#terminal canvas'), rect = canvas.getBoundingClientRect();
    return { x: rect.left + mark.x / (canvas.width / rect.width) + 1, y: rect.top + mark.y / (canvas.height / rect.height) - 3 };
  });
  await page.touchscreen.tap(point.x, point.y); await page.keyboard.type('Q'); await page.keyboard.press('Enter');
  await page.waitForFunction(() => window.__out.includes('Z12Q345\r\n'));
  await writeFile(path.join(fixture, 'token'), 'secret'.repeat(8), { mode: 0o600 });
  await page.reload(); await page.locator('#termai-dictation').waitFor({ state: 'visible' });
  assert.equal(await page.locator('#dictation-install').isVisible(), false);
  await page.locator('#termai-dictation').click();
  await page.waitForFunction(() => window.__messages.some(m => m.type === 'dictation' && m.state === 'ready'));
  await page.waitForTimeout(350);
  await page.locator('#termai-dictation').click();
  await page.waitForFunction(() => window.__messages.some(m => m.type === 'dictation' && m.state === 'done'));
  assert.ok(audioBytes > 0);
  assert.equal(await page.evaluate(() => window.__messages.some(m => m.type === 'partial' || m.type === 'final')), false);
  assert.equal(await page.evaluate(() => window.__out.includes('never forward')), false);
  assert.equal(await page.evaluate(() => window.__state.ready), true, 'Dictation must not submit the command');
  await page.locator('#terminal textarea').focus(); await page.keyboard.press('Enter');
  await page.waitForFunction(() => window.__out.includes('\rVOICE_BACKEND\r\n'));
  // Cancellation must not insert anything; editing during a recording rejects its late final.
  await page.waitForFunction(() => window.__state.ready);
  await page.evaluate(() => { window.__messages = []; });
  await page.locator('#termai-dictation').click();
  await page.waitForFunction(() => window.__messages.some(m => m.type === 'dictation' && m.state === 'ready'));
  await page.getByLabel('Cancel dictation', { exact: true }).click();
  assert.equal(await page.locator('#termai-dictation').getAttribute('aria-pressed'), 'false');
  await page.evaluate(() => { window.__messages = []; });
  await page.locator('#termai-dictation').click();
  await page.waitForFunction(() => window.__messages.some(m => m.type === 'dictation' && m.state === 'ready'));
  await page.locator('#terminal textarea').focus(); await page.keyboard.type('echo preserved');
  await page.locator('#termai-dictation').click();
  await page.waitForFunction(() => window.__messages.some(m => m.type === 'dictation' && m.state === 'error' && m.message.includes('terminal changed')));
  assert.equal(await page.evaluate(() => window.__messages.some(m => m.type === 'pasted')), false);
  assert.deepEqual(errors, []);
  console.log('PASS: paste-only installation, dismissal, touch cursor, microphone PCM and direct backend dictation');
} catch (error) { console.error(logs); if (browser) console.error(await browser.contexts()[0]?.pages()[0]?.evaluate(() => ({ messages: window.__messages, out: window.__out, paint: window.__paint?.slice(-40) }))); throw error; }
finally { await browser?.close(); server.kill('SIGTERM'); for (const socket of daemon.clients) socket.terminate(); await new Promise(resolve => daemon.close(resolve)); await rm(fixture, { recursive: true, force: true }); }
