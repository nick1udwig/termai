import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import pty from 'node-pty';
import { chromium } from 'playwright-core';
import { herdrRequest, herdrSnapshot } from '../server/herdr.ts';
import { shellQuote } from '../src/engine/repair.ts';

const root = new URL('../', import.meta.url).pathname, dir = await mkdtemp('/tmp/termai-herdr-app-scroll-');
const target = { session: '', socketPath: dir + '/herdr.sock' }, base = 'http://127.0.0.1:3173';
const env = { ...process.env, HOME: dir, XDG_CONFIG_HOME: dir + '/config', XDG_DATA_HOME: dir + '/data', XDG_STATE_HOME: dir + '/state', HERDR_SOCKET_PATH: target.socketPath, HERDR_SESSION: '', HERDR_ENV: '', SHELL: '/bin/bash', TERM: 'xterm-256color' };
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const wait = async (check, label) => { for (let end = Date.now() + 15000; Date.now() < end;) { if (await check()) return; await delay(30); } throw new Error('Timed out: ' + label); };
const state = async () => { try { return JSON.parse(await readFile(dir + '/state.json', 'utf8')); } catch { return {}; } };
let herdr, desktop, backend, browser;
try {
  await mkdir(dir + '/config', { recursive: true });
  // A generic fullscreen TUI: its transcript lives in the application, while
  // the terminal's alternate buffer has no scrollback. No Codex heuristics.
  await writeFile(dir + '/app.mjs', `
    import { writeFileSync } from 'node:fs';
    let offset = 0, wheels = 0, pending = '';
    const draw = () => { const cols = process.stdout.columns, rows = process.stdout.rows;
      writeFileSync(${JSON.stringify(dir + '/state.json')}, JSON.stringify({ cols, rows, offset, wheels }));
      let screen = '\\x1b[2J\\x1b[HApplication transcript\\r\\n';
      for (let row = 0; row < rows - 7; row++) screen += 'ROW-' + (100 - offset + row) + ' alpha beta gamma\\r\\n';
      screen += '╭' + '─'.repeat(cols - 2) + '╮\\r\\n│ › type here' + ' '.repeat(Math.max(0, cols - 14)) + '│\\r\\n╰' + '─'.repeat(cols - 2) + '╯';
      process.stdout.write(screen + '\\x1b[' + (rows - 4) + ';5H\\x1b[?25h'); };
    process.stdout.write('\\x1b[?1049h\\x1b[?1000h\\x1b[?1006h');
    process.stdin.setRawMode(true); process.stdin.resume(); process.stdin.on('data', data => {
      pending += data; const events = [...pending.matchAll(/\\x1b\\[<(\\d+);(\\d+);(\\d+)[Mm]/g)];
      for (const event of events) { const button = Number(event[1]); if (button === 64) offset = Math.min(90, offset + 1); if (button === 65) offset = Math.max(0, offset - 1); wheels++; }
      if (events.length) { pending = pending.slice(events.at(-1).index + events.at(-1)[0].length); draw(); }
      if (pending.includes('\\x03')) process.exit();
    });
    draw(); process.on('SIGWINCH', () => setImmediate(draw)); setInterval(() => {}, 10000);
  `);
  herdr = spawn(process.env.HERDR_BINARY || '/usr/bin/herdr', ['server'], { cwd: dir, env, stdio: 'ignore' });
  await wait(async () => { try { await herdrSnapshot(target); return true; } catch { return false; } }, 'isolated Herdr');
  desktop = pty.spawn(process.env.HERDR_BINARY || '/usr/bin/herdr', [], { cwd: dir, env, cols: 150, rows: 45, name: 'xterm-256color' }); desktop.onData(() => {});
  const created = await herdrRequest(target, 'workspace.create', { cwd: dir, label: 'App scroll fixture', focus: true });
  const terminal = (await herdrSnapshot(target)).terminals.find(t => t.workspaceId === created.workspace.workspace_id); assert.ok(terminal);
  await delay(400); await herdrRequest(target, 'pane.send_text', { pane_id: terminal.paneId, text: [process.execPath, dir + '/app.mjs'].map(shellQuote).join(' ') + '\r' });
  await wait(async () => (await state()).cols > 80, 'native app');
  backend = spawn(process.execPath, ['server/index.ts'], { cwd: root, env: { ...env, NODE_ENV: 'production', HOST: '127.0.0.1', PORT: '3173', TERMAI_BASE_PATH: '/', TERMAI_ALLOWED_HOSTS: '127.0.0.1', TERMAI_ALLOWED_ORIGINS: base, TERMAI_DATA_DIR: dir + '/termai', TERMAI_TOKEN: '', TERMAI_NO_RC: '1', TERMAI_CWD: dir }, stdio: 'ignore' });
  await wait(async () => { try { return (await fetch(base)).ok; } catch { return false; } }, 'isolated backend');
  const token = (await readFile(dir + '/termai/pairing-token', 'utf8')).trim();
  browser = await chromium.launch({ executablePath: process.env.CHROMIUM || '/usr/bin/chromium', headless: true, args: ['--use-gl=angle', '--use-angle=gl'] });
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, permissions: ['clipboard-read', 'clipboard-write'] });
  await context.route('**/assets/terminal-*.js', async route => {
    const response = await route.fetch(), original = await response.text(), body = original.replace(/new ([\w$]+)\(\{ghostty:/, 'window.__terminal=new $1({ghostty:');
    assert.notEqual(body, original); await route.fulfill({ response, body });
  });
  const page = await context.newPage(), errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto(base + '/terminal.html?herdrTerminal=' + terminal.terminalId);
  await page.locator('#token').fill(token); await page.locator('#login-form button[type=submit]').click();
  await page.waitForFunction(() => window.__terminal && document.querySelector('#connection-label').textContent === 'Connected');
  await wait(async () => (await state()).cols === await page.evaluate(() => window.__terminal.cols), 'mobile app geometry');
  await page.waitForFunction(() => window.__terminal.buffer.active.getLine(1)?.translateToString(true).includes('ROW-100'));
  assert.equal((await herdrSnapshot(target)).terminals[0]?.terminalId, terminal.terminalId);
  const pane = await herdrRequest(target, 'pane.get', { pane_id: terminal.paneId }); assert.equal(pane.pane.scroll.max_offset_from_bottom, 0);
  assert.equal(await page.evaluate(() => window.__terminal.buffer.active.length), await page.evaluate(() => window.__terminal.rows));
  const cdp = await context.newCDPSession(page), touch = (type, x, y) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: ['touchEnd', 'touchCancel'].includes(type) ? [] : [{ x, y, id: 1 }] });
  const drag = async (from, to) => { await touch('touchStart', 150, from); for (let i = 1; i <= 5; i++) { await delay(25); await touch('touchMove', 150, from + (to - from) * i / 5); } await delay(120); await touch('touchEnd'); };
  await drag(180, 300);
  await wait(async () => (await state()).offset > 3, 'touch scroll reaches app wheel handler');
  const older = await state(); assert.ok(older.wheels > 3, 'Fast drags deliver multiple native wheel events');
  await page.waitForFunction(() => !window.__terminal.buffer.active.getLine(1)?.translateToString(true).includes('ROW-100'));
  assert.equal(await page.evaluate(() => window.__terminal.getViewportY()), 0, 'The application, rather than local scrollback, moves');
  // Holding the displayed app text must continue to use local selection/copy.
  const word = await page.evaluate(() => { const t = window.__terminal, r = document.querySelector('#terminal canvas').getBoundingClientRect(), col = t.buffer.active.getLine(1).translateToString(true).indexOf('alpha'); return { x: r.x + (col + .5) * r.width / t.cols, y: r.y + 1.5 * r.height / t.rows }; });
  await touch('touchStart', word.x, word.y); await delay(450); await touch('touchEnd'); await page.locator('.selection-notice').filter({ hasText: 'Copied 5 characters' }).waitFor({ state: 'visible' });
  assert.equal(await page.evaluate(() => navigator.clipboard.readText()), 'alpha');
  assert.equal((await state()).offset, older.offset, 'Selecting does not scroll the app');
  await drag(300, 180); await wait(async () => (await state()).offset < older.offset, 'reverse drag scrolls toward latest output');
  assert.equal(await page.locator('#terminal textarea').evaluate(el => el === document.activeElement), false);
  assert.deepEqual(errors, []);
  console.log('PASS: real Herdr fullscreen TUI with zero terminal scrollback receives multi-line touch wheel events in both directions while hold/copy stays local and the keyboard stays closed.');
} finally {
  await browser?.close(); if (backend) { const exited = once(backend, 'exit'); backend.kill(); await exited; }
  desktop?.kill(); await herdrRequest(target, 'server.stop').catch(() => {}); herdr?.kill(); await rm(dir, { recursive: true, force: true });
}
