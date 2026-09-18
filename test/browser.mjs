import { chromium } from 'playwright-core';
import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, readFile, access, mkdir, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { WebSocket } from 'ws';
const root = path.resolve(import.meta.dirname, '..');
const fixture = await mkdtemp(path.join(os.tmpdir(), 'termai-browser-'));
await mkdir(path.join(fixture, 'subfolder'));
await mkdir(path.join(fixture, 'bin'));
await mkdir(path.join(fixture, 'git', 'pebble-agent'), { recursive: true });
await writeFile(path.join(fixture, 'bin', 'contexttool'), `#!/bin/sh
if [ "$1" = '--help' ]; then
  printf 'probe\\n' >> help-probes.txt
  printf '  --say VALUE  Message\\n'
else
  printf '%s %s\\n' "$1" "$2" >> auto-runs.txt
fi
`, { mode: 0o700 });
await writeFile(path.join(fixture, 'hello_world.py'), `import argparse\nfrom pathlib import Path\np=argparse.ArgumentParser()\np.add_argument('--myarg')\na=p.parse_args()\nwith Path('executions.txt').open('a') as f: f.write(a.myarg+'\\n')\nprint('HELLO_VALUE='+a.myarg)\n`);
await writeFile(path.join(fixture, 'history'), "echo remembered-command\ngit c . m 'add init commit'\n");
await writeFile(path.join(fixture, '.gitconfig'), '[alias]\n c = commit\n');
await writeFile(path.join(fixture, 'eternal-history'), '#1234567890\ngit init\n');
const port = Number(process.env.TEST_PORT || 3123);
const origin = `http://127.0.0.1:${port}`;
const mount = process.env.TEST_BASE_PATH || '';
const base = origin + mount;
const server = spawn(process.execPath, ['server/index.ts'], { cwd: root, env: { ...process.env, HOME: fixture, NODE_ENV: 'production', TERMAI_BASE_PATH: mount, HOST: '127.0.0.1', PORT: String(port), TERMAI_TOKEN: '', TERMAI_ALLOWED_HOSTS: '127.0.0.1,localhost', PATH: path.join(fixture, 'bin') + path.delimiter + process.env.PATH, TERMAI_NO_RC: '1', TERMAI_CWD: fixture, TERMAI_HISTORY_FILE: path.join(fixture, 'history'), TERMAI_ETERNAL_HISTORY_FILE: path.join(fixture, 'eternal-history') }, stdio: ['ignore', 'pipe', 'pipe'] });
let logs = ''; server.stdout.on('data', b => logs += b); server.stderr.on('data', b => logs += b);
let browser;
const delay = ms => new Promise(r => setTimeout(r, ms));
async function until(fn, timeout = 12000) { const start = Date.now(); while (Date.now()-start < timeout) { if (await fn()) return; await delay(50); } throw new Error('Timed out waiting for condition'); }
async function focusTerminal(page) { await page.locator('#terminal textarea').evaluate(el => el.focus()); }
async function shellPrompt(page) { return page.evaluate(() => window.__shellState.prompt); }
async function ready(page, previous = -1) { await page.waitForFunction(previous => window.__shellState?.ready && window.__shellState.prompt > previous, previous); }
async function dictate(page, text, inputType = 'insertText') {
  await focusTerminal(page);
  await page.locator('#terminal textarea').evaluate((el, { inputType, text }) => el.dispatchEvent(new InputEvent('beforeinput', { inputType, data: text, bubbles: true, cancelable: true })), { inputType, text });
}
async function command(page, text) {
  const before = await shellPrompt(page); await focusTerminal(page);
  await page.keyboard.type(text); await page.keyboard.press('Enter'); await ready(page, before);
}
try {
  await until(async () => { try { return (await fetch(base)).ok; } catch { if (server.exitCode !== null) throw new Error(logs); return false; } });
  browser = await chromium.launch({ executablePath: process.env.CHROMIUM || '/usr/bin/chromium', headless: true, args: ['--use-gl=angle', '--use-angle=gl'] });
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await context.newPage(); const errors = []; page.on('pageerror', e => errors.push(String(e)));
  await page.addInitScript(() => {
    const Original = window.WebSocket;
    window.WebSocket = class extends Original {
      constructor(...args) { super(...args); this.addEventListener('message', event => { const message = JSON.parse(event.data); if (message.type === 'state') window.__shellState = message.state; if (message.type === 'output') window.__terminalOutput = (window.__terminalOutput || '') + message.data; }); }
    };
  });
  await page.goto(base); await ready(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await mkdir(path.join(root, '.test-artifacts'), { recursive: true });
  // A completion helper is a shell function, not a spoken git subcommand.
  await command(page, '_git_init() { printf bad > helper-was-run; }');
  const catalog = await page.evaluate(async () => (await fetch(new URL('api/context', document.baseURI))).json());
  assert.ok(catalog.functions.includes('_git_init'));
  assert.ok(catalog.history.includes('git init'), 'Eternal history participates in context');
  await dictate(page, 'Get in it.');
  await page.waitForFunction(() => document.querySelector('.alternative-choice.selected .choice-command')?.textContent === 'git init');
  assert.deepEqual(await page.locator('.alternative-choice .choice-command').allTextContents(), ['git init', 'Get in it.']);
  assert.equal(existsSync(path.join(fixture, '.git')), false, 'Validation must not execute git init');
  assert.equal(existsSync(path.join(fixture, 'helper-was-run')), false);
  await page.screenshot({ path: path.join(root, '.test-artifacts/git-init-repair.png') });
  const gitPrompt = await shellPrompt(page); await page.keyboard.press('Control+c'); await ready(page, gitPrompt);
  // A bad historical match must not change an explicit -m into punctuation.
  await dictate(page, 'Git c -m "add init commit"');
  await page.waitForFunction(() => document.querySelector('.alternative-choice.selected .choice-command')?.textContent === "git c -m 'add init commit'");
  assert.ok((await page.locator('.alternative-choice .choice-command').allTextContents()).every(text => !text.includes('. m')));
  assert.equal(existsSync(path.join(fixture, '.git')), false);
  await page.screenshot({ path: path.join(root, '.test-artifacts/git-alias-message.png') });
  const aliasPrompt = await shellPrompt(page); await page.keyboard.press('Control+c'); await ready(page, aliasPrompt);
  // First-device regression: glued uppercase dictation must discover real ls options.
  await dictate(page, 'LSL');
  await page.waitForFunction(() => document.querySelector('.alternative-choice.selected .choice-command')?.textContent === 'ls -l');
  assert.deepEqual(await page.locator('.alternative-choice .choice-command').allTextContents(), ['ls -l', 'ls -L', 'LSL']);
  await page.screenshot({ path: path.join(root, '.test-artifacts/dictation-ls-l.png') });
  const firstPrompt = await shellPrompt(page);
  await page.keyboard.press('Enter'); await ready(page, firstPrompt);
  assert.equal(await page.evaluate(async () => (await (await fetch(new URL('api/context', document.baseURI))).json()).history.at(-1)), 'ls -l');
  // Tapping sends by default, including literal rows. Repeated taps cannot run twice.
  assert.equal(await page.locator('#edit-shortcuts').count(), 0);
  await dictate(page, 'contexttool say tapped');
  await page.waitForFunction(() => document.querySelector('.alternative-choice.selected .choice-command')?.textContent === 'contexttool --say tapped');
  let tappedPrompt = await shellPrompt(page);
  await page.locator('.alternative-choice.selected').evaluate(button => { button.click(); button.click(); });
  await ready(page, tappedPrompt);
  assert.equal(await readFile(path.join(fixture, 'auto-runs.txt'), 'utf8'), '--say tapped\n');
  assert.equal(await page.locator('#alternatives-toggle').isVisible(), false);
  await dictate(page, 'contexttool say raw');
  await page.waitForFunction(() => document.querySelector('.alternative-choice.selected .choice-command')?.textContent === 'contexttool --say raw');
  tappedPrompt = await shellPrompt(page); await page.locator('.literal-choice').click(); await ready(page, tappedPrompt);
  assert.equal(await readFile(path.join(fixture, 'auto-runs.txt'), 'utf8'), '--say tapped\nsay raw\n');
  await rm(path.join(fixture, 'auto-runs.txt'));
  await page.locator('#menu-button').click();
  assert.equal(await page.locator('#tap-alternate-send').isChecked(), true);
  await page.locator('#tap-alternate-send').uncheck();
  await page.getByRole('button', { name: 'Close session options' }).click();
  await page.route('**/api/suggest', async route => { await delay(400); await route.continue().catch(() => {}); });
  await dictate(page, 'Python three hello world dot py myarg food');
  await page.waitForSelector('#alternatives-toggle.loading');
  await page.waitForTimeout(80);
  await page.screenshot({ path: path.join(root, '.test-artifacts/inline-loading.png') });
  await page.waitForFunction(() => document.querySelector('.alternative-choice.selected .choice-command')?.textContent === 'python3 hello_world.py --myarg food');
  assert.equal(existsSync(path.join(fixture, 'executions.txt')), false, 'Discovery and selection must not execute the line');
  assert.equal(await page.locator('.literal-choice .choice-command').textContent(), 'Python three hello world dot py myarg food');
  await page.screenshot({ path: path.join(root, '.test-artifacts/inline-ready.png') });
  let before = await shellPrompt(page);
  await page.keyboard.press('Enter'); await ready(page, before);
  assert.equal(await readFile(path.join(fixture, 'executions.txt'), 'utf8'), 'food\n');
  await page.unroute('**/api/suggest');
  // Literal and alternative selection edit the real shell line, without submitting.
  await dictate(page, 'contexttool say literal');
  await page.waitForFunction(() => document.querySelector('.alternative-choice.selected .choice-command')?.textContent === 'contexttool --say literal');
  await page.locator('.literal-choice').click();
  assert.equal(existsSync(path.join(fixture, 'auto-runs.txt')), false);
  assert.equal(await page.locator('#alternatives-menu').isVisible(), false);
  assert.equal(await page.locator('#alternatives-toggle').isVisible(), true);
  await page.locator('#alternatives-toggle').click();
  assert.equal(await page.locator('#alternatives-menu').isVisible(), true);
  await page.locator('#terminal canvas').click({ position: { x: 10, y: 300 } });
  assert.equal(await page.locator('#alternatives-menu').isVisible(), false);
  assert.equal(await page.locator('#alternatives-toggle').isVisible(), true);
  await page.locator('#alternatives-toggle').click();
  await page.keyboard.press('Escape');
  assert.equal(await page.locator('#alternatives-menu').isVisible(), false);
  assert.equal(await page.locator('#alternatives-toggle').isVisible(), true);
  before = await shellPrompt(page); await page.keyboard.press('Enter'); await ready(page, before);
  assert.equal(await readFile(path.join(fixture, 'auto-runs.txt'), 'utf8'), 'say literal\n');
  // Collapsed by default still repairs the line and can be expanded at the cursor.
  await page.locator('#menu-button').click(); await page.locator('#auto-alternatives').uncheck();
  await page.getByRole('button', { name: 'Close session options' }).click();
  await dictate(page, 'contexttool say hello');
  await page.waitForFunction(() => document.querySelector('.alternative-choice.selected .choice-command')?.textContent === 'contexttool --say hello');
  assert.equal(await page.locator('#alternatives-menu').isVisible(), false);
  await page.locator('#alternatives-toggle').click();
  assert.equal(await page.locator('#alternatives-menu').isVisible(), true);
  before = await shellPrompt(page); await page.keyboard.press('Enter'); await ready(page, before);
  assert.equal(await readFile(path.join(fixture, 'auto-runs.txt'), 'utf8'), 'say literal\n--say hello\n');
  assert.equal(await readFile(path.join(fixture, 'help-probes.txt'), 'utf8'), 'probe\n', 'Background help is cached');
  // A late response cannot replace text the user has edited or submitted.
  await page.route('**/api/suggest', async route => { await delay(500); await route.continue().catch(() => {}); });
  await dictate(page, 'echo original');
  await page.waitForSelector('#alternatives-toggle.loading');
  await page.keyboard.type(' edited');
  before = await shellPrompt(page); await page.keyboard.press('Enter'); await ready(page, before);
  await delay(650);
  assert.equal(await page.evaluate(async () => (await (await fetch(new URL('api/context', document.baseURI))).json()).history.at(-1)), 'echo original edited');
  assert.equal(await page.locator('#alternatives-toggle').isVisible(), false);
  await page.unroute('**/api/suggest');
  // Composition commits are inserted once even if the browser follows with beforeinput.
  await focusTerminal(page);
  await page.locator('#terminal textarea').evaluate(el => el.dispatchEvent(new CompositionEvent('compositionstart', { data: '', bubbles: true })));
  await page.locator('#terminal textarea').evaluate(el => el.dispatchEvent(new CompositionEvent('compositionend', { data: 'echo composition', bubbles: true })));
  await page.locator('#terminal textarea').evaluate(el => el.dispatchEvent(new InputEvent('beforeinput', { data: 'echo composition', inputType: 'insertText', bubbles: true, cancelable: true })));
  await page.waitForFunction(() => document.querySelector('.alternative-choice.selected .choice-command')?.textContent === 'echo composition');
  before = await shellPrompt(page); await page.keyboard.press('Enter'); await ready(page, before);
  assert.equal(await page.evaluate(async () => (await (await fetch(new URL('api/context', document.baseURI))).json()).history.at(-1)), 'echo composition');
  // Android-style word composition streams each edit, and is not mistaken for dictation.
  await dictate(page, 'echo typed');
  await page.waitForFunction(() => document.querySelector('.alternative-choice.selected .choice-command')?.textContent === 'echo typed');
  await page.locator('#terminal').evaluate(el => el.focus());
  assert.equal(await page.locator('#terminal textarea').evaluate(el => el === document.activeElement), true);
  await page.locator('#terminal textarea').evaluate(el => el.dispatchEvent(new InputEvent('beforeinput', { inputType: 'insertText', data: ' ', bubbles: true, cancelable: true })));
  await page.locator('#terminal textarea').evaluate(el => {
    window.__terminalOutput = '';
    el.dispatchEvent(new CompositionEvent('compositionstart', { data: '', bubbles: true }));
    el.dispatchEvent(new CompositionEvent('compositionupdate', { data: 'w', bubbles: true }));
    el.dispatchEvent(new InputEvent('beforeinput', { inputType: 'insertCompositionText', data: 'w', isComposing: true, bubbles: true, cancelable: true }));
  });
  assert.equal(await page.locator('#alternatives-toggle').isVisible(), false);
  // Capture the shell output before composition commits: the first letter is already sent.
  await page.waitForFunction(() => window.__terminalOutput.includes('w'));
  await page.locator('#terminal textarea').evaluate(el => {
    for (const data of ['wo', 'wox', 'wor', 'word']) {
      el.dispatchEvent(new CompositionEvent('compositionupdate', { data, bubbles: true }));
      el.dispatchEvent(new InputEvent('beforeinput', { inputType: 'insertCompositionText', data, isComposing: true, bubbles: true, cancelable: true }));
    }
    el.dispatchEvent(new CompositionEvent('compositionend', { data: 'word', bubbles: true }));
    el.dispatchEvent(new InputEvent('beforeinput', { inputType: 'insertText', data: 'word', bubbles: true, cancelable: true }));
    el.dispatchEvent(new InputEvent('beforeinput', { inputType: 'insertText', data: 's', bubbles: true, cancelable: true }));
  });
  before = await shellPrompt(page); await page.keyboard.press('Enter'); await ready(page, before);
  assert.equal(await page.evaluate(async () => (await (await fetch(new URL('api/context', document.baseURI))).json()).history.at(-1)), 'echo typed words');
  // The IME must have a preceding character to issue Backspace after PTY-only dictation.
  await dictate(page, 'echo dictatedXYZ');
  await page.waitForFunction(() => document.querySelector('.alternative-choice.selected .choice-command')?.textContent === 'echo dictatedXYZ');
  for (let i = 0; i < 3; i++) {
    assert.equal(await page.locator('#terminal textarea').evaluate(el => {
      if (!el.value || !el.selectionStart) return false;
      el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Unidentified', keyCode: 229, bubbles: true }));
      el.dispatchEvent(new InputEvent('beforeinput', { inputType: 'deleteContentBackward', data: null, bubbles: true, cancelable: true }));
      return true;
    }), true);
  }
  assert.equal(await page.locator('#alternatives-toggle').isVisible(), false);
  await page.locator('#terminal textarea').evaluate(el => {
    el.dispatchEvent(new CompositionEvent('compositionstart', { data: '', bubbles: true }));
    el.dispatchEvent(new InputEvent('beforeinput', { inputType: 'deleteContentBackward', data: null, isComposing: true, bubbles: true, cancelable: true }));
    el.dispatchEvent(new CompositionEvent('compositionend', { data: '', bubbles: true }));
  });
  await page.keyboard.type('d');
  before = await shellPrompt(page); await page.keyboard.press('Enter'); await ready(page, before);
  assert.equal(await page.evaluate(async () => (await (await fetch(new URL('api/context', document.baseURI))).json()).history.at(-1)), 'echo dictated');
  // Backspace cancels an in-flight repair instead of allowing the deleted text back in.
  await page.route('**/api/suggest', async route => { await delay(400); await route.continue().catch(() => {}); });
  await dictate(page, 'echo pendingX');
  await page.waitForSelector('#alternatives-toggle.loading');
  await page.locator('#terminal textarea').evaluate(el => el.dispatchEvent(new InputEvent('beforeinput', { inputType: 'deleteContentBackward', bubbles: true, cancelable: true })));
  await delay(500);
  before = await shellPrompt(page); await page.keyboard.press('Enter'); await ready(page, before);
  assert.equal(await page.evaluate(async () => (await (await fetch(new URL('api/context', document.baseURI))).json()).history.at(-1)), 'echo pending');
  await page.unroute('**/api/suggest');
  // Exact flag case can remain the top hit while offering its lowercase alternative.
  await dictate(page, 'ls -L');
  await page.waitForFunction(() => !document.querySelector('#alternatives-toggle').classList.contains('loading'));
  assert.equal(await page.locator('.alternative-choice.selected .choice-command').textContent(), 'ls -L');
  assert.ok((await page.locator('.alternative-choice .choice-command').allTextContents()).includes('ls -l'));
  before = await shellPrompt(page); await page.keyboard.press('Control+c'); await ready(page, before);
  // Spoken separators and a misheard home-directory component resolve to a real directory.
  await dictate(page, 'Cd ~ fas get fas pebble agent');
  await page.waitForFunction(() => document.querySelector('.alternative-choice.selected .choice-command')?.textContent === 'cd ~/git/pebble-agent');
  before = await shellPrompt(page); await page.keyboard.press('Enter'); await ready(page, before);
  assert.equal(await page.locator('#cwd').textContent(), path.join(fixture, 'git', 'pebble-agent'));
  await command(page, `cd ${fixture}`);
  // Persisted preference, no replayed commands after reload.
  await page.reload(); await ready(page);
  await page.locator('#menu-button').click(); assert.equal(await page.locator('#auto-alternatives').isChecked(), false);
  assert.equal(await page.locator('#tap-alternate-send').isChecked(), false);
  await page.locator('#auto-alternatives').check(); await page.getByRole('button', { name: 'Close session options' }).click();
  assert.equal(await readFile(path.join(fixture, 'executions.txt'), 'utf8'), 'food\n');
  // Saved command and key shortcuts remain available in the always-terminal view.
  await page.locator('#menu-button').click(); await page.locator('#customize-shortcuts').click(); await page.locator('#add-shortcut').click();
  await page.locator('.shortcut-row').last().locator('.shortcut-label').fill('Saved command');
  await page.locator('.shortcut-row').last().locator('.binding').fill('printf shortcut >> shortcuts.txt');
  await page.getByRole('button', { name: 'Save shortcuts', exact: true }).click();
  before = await shellPrompt(page); await page.getByRole('button', { name: 'Saved command', exact: true }).click(); await ready(page, before);
  assert.equal(await readFile(path.join(fixture, 'shortcuts.txt'), 'utf8'), 'shortcut');
  await focusTerminal(page); await page.keyboard.type('sleep 5'); await page.keyboard.press('Enter');
  await page.waitForFunction(() => !window.__shellState.ready);
  assert.equal(await page.getByRole('button', { name: 'Saved command', exact: true }).isDisabled(), true);
  before = await shellPrompt(page); await page.getByRole('button', { name: 'Ctrl C', exact: true }).click(); await ready(page, before);
  await command(page, 'cd subfolder');
  assert.ok((await page.locator('#cwd').textContent()).endsWith('/subfolder'));
  before = await shellPrompt(page); await page.getByRole('button', { name: 'Ctrl R', exact: true }).click();
  await page.keyboard.type('remembered'); await page.keyboard.press('Enter'); await ready(page, before);
  assert.equal(await page.evaluate(async () => (await (await fetch(new URL('api/context', document.baseURI))).json()).history.at(-1)), 'echo remembered-command');
  await dictate(page, 'ls dash all');
  await page.waitForFunction(() => document.querySelector('.alternative-choice.selected .choice-command')?.textContent === 'ls --all');
  await page.screenshot({ path: path.join(root, '.test-artifacts/mobile.png') });
  assert.equal(await page.locator('#terminal').evaluate(el => el.getBoundingClientRect().top), 0);
  assert.equal(await page.locator('#composer-panel, #compose-mode, #raw-mode').count(), 0);
  assert.ok(await page.locator('.input-dock').evaluate(el => el.clientHeight) <= 54);
  await page.setViewportSize({ width: 390, height: 460 });
  await page.screenshot({ path: path.join(root, '.test-artifacts/keyboard-viewport.png') });
  await page.waitForFunction(() => { const r = document.querySelector('#alternatives-menu').getBoundingClientRect(); return r.left >= 0 && r.right <= innerWidth && r.bottom <= document.querySelector('.input-dock').getBoundingClientRect().top; });
  await page.screenshot({ path: path.join(root, '.test-artifacts/keyboard-viewport.png') });
  await page.keyboard.press('Control+c'); await ready(page);
  await page.evaluate(() => navigator.serviceWorker.ready);
  await page.reload(); await ready(page);
  await context.setOffline(true); await page.reload(); await page.waitForSelector('#terminal');
  await context.setOffline(false); await page.waitForFunction(() => document.querySelector('#connection-label').textContent === 'Connected', {}, { timeout: 15000 });
  assert.deepEqual(errors, []);
  console.log('PASS browser: inline loading/top-hit/literal, actual Readline editing, collapsed menu, stale-response cancellation, IME deduplication, shortcuts, Ctrl-R, mobile/keyboard layout, reconnect/offline');

  assert.equal((await fetch(base + '/api/context')).status, 401);
  assert.equal((await fetch(base + '/api/connect', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'https://evil.invalid' }, body: '{}' })).status, 403);
  const login = await fetch(base + '/api/connect', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: origin }, body: '{}' });
  const cookie = login.headers.get('set-cookie').split(';')[0];
  const socket = new WebSocket(base.replace('http:', 'ws:') + '/ws?after=0', { headers: { Origin: origin, Cookie: cookie } });
  const messages = []; let lastState; let allOutput = '';
  socket.on('message', raw => { const m = JSON.parse(raw.toString()); messages.push(m); if (m.type === 'state') lastState = m.state; if (m.type === 'output') { allOutput += m.data; socket.send(JSON.stringify({ type: 'ack', seq: m.seq })); } });
  await until(() => lastState?.ready);
  const editPrompt = lastState.prompt, revision = lastState.inputRevision;
  socket.send(JSON.stringify({ type: 'replace', text: 'echo draft', id: 'draft', prompt: editPrompt, revision }));
  await until(() => messages.some(m => m.type === 'edit-result' && m.id === 'draft'));
  assert.equal(messages.find(m => m.type === 'edit-result' && m.id === 'draft').accepted, true);
  socket.send(JSON.stringify({ type: 'replace', text: 'echo stale', id: 'stale-edit', prompt: editPrompt, revision }));
  await until(() => messages.some(m => m.type === 'edit-result' && m.id === 'stale-edit'));
  assert.equal(messages.find(m => m.type === 'edit-result' && m.id === 'stale-edit').accepted, false);
  assert.ok(lastState.ready, 'Replacing a line must not submit it');
  const prompt = lastState.prompt;
  const message = { type: 'command', id: 'deduplicate', command: 'printf x >> dedup.txt', prompt };
  socket.send(JSON.stringify(message)); socket.send(JSON.stringify(message));
  await until(() => lastState.ready && lastState.prompt > prompt);
  assert.equal(await readFile(path.join(fixture, 'dedup.txt'), 'utf8'), 'x');
  socket.send(JSON.stringify({ ...message, id: 'stale' }));
  await until(() => messages.some(m => m.type === 'result' && m.id === 'stale'));
  assert.equal(messages.find(m => m.type === 'result' && m.id === 'stale').accepted, false);
  const floodPrompt = lastState.prompt;
  socket.send(JSON.stringify({ type: 'command', id: 'flood', command: "python3 -c 'print(\"output line\\n\" * 30000); print(\"FLOOD_DONE\")'", prompt: floodPrompt }));
  await until(() => allOutput.includes('FLOOD_DONE') && lastState.ready && lastState.prompt > floodPrompt, 20000);
  assert.ok(allOutput.length > 300000);
  socket.close();
  console.log('PASS transport: origin/auth checks, command deduplication, stale-prompt rejection, 300KB+ output with acknowledgements');
} catch (error) {
  console.error('Server log:', logs); throw error;
} finally {
  await browser?.close(); server.kill('SIGTERM');
  await Promise.race([new Promise(resolve => server.once('exit', resolve)), delay(4000)]);
  if (server.exitCode === null) server.kill('SIGKILL');
  await rm(fixture, { recursive: true, force: true });
}
