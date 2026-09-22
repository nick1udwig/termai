import { chromium } from 'playwright-core';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import ssh2 from 'ssh2';
import { WebSocket } from 'ws';
import { Vault } from '../server/vault.ts';
const root = path.resolve(import.meta.dirname, '..'), fixture = await mkdtemp('/tmp/termai-workspace-');
const origin = 'http://127.0.0.1:3153', secondary = 'http://127.0.0.1:3154', sshPort = 3158;
const processes = [], logs = [], errors = [], facts = [];
let browser;
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(fn, timeout = 15000) { const start = Date.now(); while (Date.now() - start < timeout) { if (await fn()) return; await delay(40); } throw new Error('Timed out'); }
function start(command, args, env = {}) { const proc = spawn(command, args, { cwd: root, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] }); processes.push(proc); proc.stdout.on('data', b => logs.push(String(b))); proc.stderr.on('data', b => logs.push(String(b))); return proc; }
async function activeFrame(page) { const iframe = await page.locator('#terminal-stack iframe:visible').elementHandle(); const frame = await iframe.contentFrame(); await frame.waitForFunction(() => window.__shellState?.ready); return frame; }
async function command(frame, text) { const prompt = await frame.evaluate(() => window.__shellState.prompt); await frame.locator('#terminal textarea').focus(); await frame.page().keyboard.type(text); await frame.page().keyboard.press('Enter'); await frame.waitForFunction(prompt => window.__shellState.ready && window.__shellState.prompt > prompt, prompt); }
try {
  await mkdir(fixture + '/remote/git/pebble-agent', { recursive: true });
  await writeFile(fixture + '/remote/hello_world.py', "import argparse\np=argparse.ArgumentParser()\np.add_argument('--myarg')\n");
  const hostKey = ssh2.utils.generateKeyPairSync('ed25519'); await writeFile(fixture + '/host', hostKey.private, { mode: 0o600 }); await writeFile(fixture + '/authorized', '');
  await writeFile(fixture + '/sshd_config', `Port ${sshPort}\nListenAddress 127.0.0.1\nHostKey ${fixture}/host\nPidFile ${fixture}/pid\nAuthorizedKeysFile ${fixture}/authorized\nStrictModes no\nUsePAM no\nPasswordAuthentication no\nKbdInteractiveAuthentication no\nAllowUsers ${os.userInfo().username}\nSetEnv HOME=${fixture}/remote\nSubsystem sftp internal-sftp\n`);
  start('/usr/bin/sshd', ['-D', '-e', '-f', fixture + '/sshd_config']);
  for (const [port, name, token] of [[3153, 'primary', ''], [3154, 'secondary', 'test-backend-token-123456789']]) start(process.execPath, ['server/index.ts'], { NODE_ENV: 'production', HOST: '127.0.0.1', PORT: String(port), TERMAI_BASE_PATH: '', TERMAI_ALLOWED_HOSTS: '127.0.0.1,localhost', TERMAI_ALLOWED_ORIGINS: origin, TERMAI_TOKEN: token, TERMAI_ENGINE: 'server', TERMAI_NO_RC: '1', TERMAI_CWD: fixture, HOME: fixture, TERMAI_DATA_DIR: fixture + '/' + name, TERMAI_HISTORY_FILE: fixture + '/no-history', TERMAI_ETERNAL_HISTORY_FILE: fixture + '/no-history' });
  await until(async () => { try { return (await fetch(origin)).ok && (await fetch(secondary)).ok; } catch { return false; } });
  const request = (base, api, token, data, from = origin) => fetch(base + '/api/' + api, { method: data === undefined ? 'GET' : 'POST', headers: { Origin: from, ...(token ? { Authorization: 'Bearer ' + token } : {}), ...(data === undefined ? {} : { 'Content-Type': 'application/json' }) }, ...(data === undefined ? {} : { body: JSON.stringify(data) }) });
  assert.equal((await request(secondary, 'keychain')).status, 401);
  assert.equal((await request(secondary, 'connect', undefined, { token: 'wrong' })).status, 401);
  assert.equal((await request(origin, 'connect', undefined, {}, 'http://untrusted.invalid')).status, 403);
  const preflight = await fetch(secondary + '/api/connect', { method: 'OPTIONS', headers: { Origin: origin, 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'authorization,content-type' } });
  assert.equal(preflight.status, 204); assert.equal(preflight.headers.get('Access-Control-Allow-Origin'), origin);
  const ownerA = (await (await request(origin, 'connect', undefined, { noSession: true })).json()).accessToken;
  const ownerB = (await (await request(origin, 'connect', undefined, { noSession: true })).json()).accessToken;
  const isolated = (await (await request(origin, 'sessions', ownerA, { name: 'isolation fixture' })).json()).id;
  assert.equal((await request(origin, 'context?session=' + isolated, ownerB)).status, 404);
  assert.equal((await request(origin, 'ticket?session=' + isolated, ownerB, {})).status, 404);
  const ticket = (await (await request(origin, 'ticket?session=' + isolated, ownerA, {})).json()).ticket;
  const socketURL = origin.replace('http:', 'ws:') + '/ws?session=' + isolated + '&ticket=' + ticket;
  await new Promise((resolve, reject) => { const socket = new WebSocket(socketURL, { origin }); socket.once('open', () => { socket.close(); resolve(); }); socket.once('error', reject); });
  await new Promise((resolve, reject) => { const socket = new WebSocket(socketURL, { origin }); socket.once('open', () => { socket.close(); reject(new Error('Reused websocket ticket was accepted')); }); socket.once('error', error => { assert.match(error.message, /403/); resolve(); }); });
  await request(origin, 'sessions/close?session=' + isolated, ownerA, {});
  browser = await chromium.launch({ executablePath: process.env.CHROMIUM || '/usr/bin/chromium', headless: true, args: ['--use-gl=angle', '--use-angle=gl'] });
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } }), page = await context.newPage();
  page.on('response', async response => { if (response.url().includes('/api/facts')) { const request = response.request().postDataJSON(); const value = await response.json().catch(() => undefined); facts.push({ request, status: response.status(), result: request.kind === 'context' ? { home: value?.home, cwd: value?.catalog?.cwd, cd: value?.catalog?.commands.includes('cd'), prompt: value?.prompt } : value }); } });
  page.on('pageerror', error => errors.push(String(error))); page.on('dialog', d => d.accept());
  await context.addInitScript(() => {
    const Original = window.WebSocket; window.WebSocket = class extends Original {
      constructor(...args) { super(...args); this.addEventListener('message', event => { const m = JSON.parse(event.data); if (m.type === 'state') window.__shellState = m.state; if (m.type === 'hello') window.__engine = m.engine; if (m.type === 'output') window.__output = (window.__output || '') + m.data; }); }
    };
  });
  await page.goto(origin); let frame = await activeFrame(page); assert.equal(await page.locator('[role=tab]').count(), 1);
  await command(frame, 'export TAB_ID=first');
  await page.locator('#terminal-options').click(); assert.equal(await frame.locator('#font-size').inputValue(), '10'); await frame.getByRole('button', { name: 'Close session options' }).click();
  await page.locator('#add-tab').click(); await page.getByRole('button', { name: 'This machine HTTP' }).click(); frame = await activeFrame(page);
  await command(frame, 'export TAB_ID=second'); assert.equal(await page.locator('[role=tab]').count(), 2);
  await page.locator('[role=tab]').first().click(); frame = await activeFrame(page); await command(frame, "printf '%s' \"$TAB_ID\" > first-tab.txt"); assert.equal(await readFile(fixture + '/first-tab.txt', 'utf8'), 'first');
  await page.reload(); frame = await activeFrame(page); assert.equal(await page.locator('[role=tab]').count(), 2); await command(frame, "printf '%s' \"$TAB_ID\" > restored-tab.txt"); assert.equal(await readFile(fixture + '/restored-tab.txt', 'utf8'), 'first');
  // A background terminal must keep draining output while another tab is visible.
  await command(frame, `python3 -c 'import time; time.sleep(1); print("background line\\n" * 30000); open("background-done", "w").write("ok")' &`);
  await page.locator('[role=tab]').nth(1).click(); await until(async () => (await readFile(fixture + '/background-done', 'utf8').catch(() => '')) === 'ok');
  await page.locator('#add-tab').click(); await page.locator('#library-add').click(); await page.locator('#host-name').fill('Build server'); await page.locator('#host-backend').selectOption('new'); await page.locator('#host-url').fill(secondary + '/'); await page.getByRole('button', { name: 'Save host', exact: true }).click();
  await page.getByRole('button', { name: 'Build server HTTP' }).click(); await page.locator('#backend-token').fill('test-backend-token-123456789'); await page.locator('#backend-login-form button[type=submit]').click(); frame = await activeFrame(page);
  await command(frame, 'printf routed > direct-backend.txt'); assert.equal(await readFile(fixture + '/direct-backend.txt', 'utf8'), 'routed');
  await page.locator('#add-tab').click(); await page.locator('#page-back').click(); await page.getByRole('button', { name: /Keychain Encrypted/ }).click(); await page.locator('#library-add').click(); await page.locator('#key-name').fill('Personal SSH key'); await page.locator('#key-passphrase').fill('test-key-passphrase'); await page.locator('#key-confirm').fill('test-key-passphrase'); await page.getByRole('button', { name: 'Save key', exact: true }).click(); await page.locator('#key-details').waitFor({ state: 'visible' });
  const publicKey = await page.locator('#public-key').inputValue(); assert.match(publicKey, /^ssh-ed25519 /); await writeFile(fixture + '/authorized', publicKey + '\n');
  const disk = await readFile(fixture + '/primary/vault.json', 'utf8'); assert.ok(!disk.includes('PRIVATE KEY') && !disk.includes('test-key-passphrase'));
  // Explicitly install the same test key on a second backend to exercise route eligibility.
  const primaryVault = new Vault(fixture + '/primary'), info = (await primaryVault.list()).keys[0], privateKey = await primaryVault.unlock(info.id, 'test-key-passphrase');
  await new Vault(fixture + '/secondary').create('Same test identity', 'test-key-passphrase', privateKey.toString()); privateKey.fill(0);
  await page.getByRole('button', { name: 'Close key details' }).click(); await page.screenshot({ path: root + '/.test-artifacts/workspace-keychain.png' });
  await page.locator('#page-back').click(); await page.screenshot({ path: root + '/.test-artifacts/workspace-vault.png' }); await page.getByRole('button', { name: /^Hosts/ }).click();
  await page.locator('#library-add').click(); await page.locator('#host-name').fill('Remote shell'); await page.locator('#host-kind').selectOption('ssh'); await page.locator('#host-address').fill('127.0.0.1'); await page.locator('#host-user').fill(os.userInfo().username); await page.locator('#host-port').fill(String(sshPort)); await page.getByRole('button', { name: 'Save host', exact: true }).click();
  await page.screenshot({ path: root + '/.test-artifacts/workspace-hosts.png' });
  await context.route(origin + '/api/ssh/probe', async route => { await delay(150); await route.continue(); });
  await page.getByRole('button', { name: 'Remote shell SSH' }).click(); await page.locator('#ssh-secret').fill('test-key-passphrase'); await page.screenshot({ path: root + '/.test-artifacts/workspace-passphrase.png' }); await page.locator('#ssh-connect').click();
  await page.locator('#ssh-dialog').waitFor({ state: 'hidden', timeout: 30000 }); frame = await activeFrame(page); assert.equal(await frame.evaluate(() => window.__engine), 'client');
  assert.ok(await page.locator('[role=tab][aria-selected=true]').getAttribute('title').then(title => title.includes('Build server')), 'The eligible lower-latency backend should carry SSH');
  await command(frame, 'printf ssh-connected > ssh-result.txt'); assert.equal(await readFile(fixture + '/remote/ssh-result.txt', 'utf8'), 'ssh-connected');
  await frame.locator('#terminal textarea').evaluate(el => el.dispatchEvent(new InputEvent('beforeinput', { inputType: 'insertText', data: 'Python three hello world dot py myarg food', bubbles: true, cancelable: true })));
  await frame.waitForFunction(() => document.querySelector('.alternative-choice.selected .choice-command')?.textContent === 'python3 hello_world.py --myarg food', {}, { timeout: 15000 });
  const pythonPrompt = await frame.evaluate(() => window.__shellState.prompt); await page.keyboard.press('Control+c');
  await frame.waitForFunction(prompt => window.__shellState.ready && window.__shellState.prompt > prompt, pythonPrompt);
  await frame.locator('#terminal textarea').evaluate(el => el.dispatchEvent(new InputEvent('beforeinput', { inputType: 'insertText', data: 'Cd ~ fas get fas pebble agent', bubbles: true, cancelable: true })));
  await frame.waitForFunction(() => document.querySelector('.alternative-choice.selected .choice-command')?.textContent === 'cd ~/git/pebble-agent', {}, { timeout: 15000 });
  await page.keyboard.press('Enter'); await frame.waitForFunction(() => window.__shellState.ready && window.__shellState.cwd.endsWith('/git/pebble-agent'));
  await page.screenshot({ path: root + '/.test-artifacts/workspace-terminal.png' });
  const lastSession = new URL(frame.url()).searchParams.get('session'); await page.reload(); frame = await activeFrame(page); assert.equal(new URL(frame.url()).searchParams.get('session'), lastSession); assert.ok((await frame.evaluate(() => window.__shellState.cwd)).endsWith('/git/pebble-agent'));
  await page.locator('[role=tab][aria-selected=true] .tab-close').click(); await until(async () => await page.locator('[role=tab]').count() === 3);
  // A changed pin must fail even if the caller supplies trust for the new key.
  const backendToken = await page.evaluate(url => sessionStorage.getItem('termai.access:' + url + '/'), secondary);
  const remoteVault = new Vault(fixture + '/secondary'), remoteKey = (await remoteVault.list()).keys[0];
  await remoteVault.forget('127.0.0.1', sshPort); await remoteVault.trust('127.0.0.1', sshPort, 'SHA256:changed-fixture');
  const changed = await request(secondary, 'sessions', backendToken, { name: 'changed host', ssh: { host: '127.0.0.1', port: sshPort, username: os.userInfo().username, keyId: remoteKey.id, passphrase: 'test-key-passphrase', trust: 'ignored' } });
  assert.equal(changed.status, 409); assert.equal((await changed.json()).changed, true);
  assert.deepEqual(errors, []);
  console.log('PASS workspace: terminal-first, 10 pt, persistent isolated tabs, background output, direct cross-origin backend, encrypted keychain, verified OpenSSH, automatic routing, remote directory/Python repair, SSH reconnect and close, CORS, owner isolation, single-use tickets and changed-host rejection');
} catch (error) { console.error(logs.join('')); console.error(error); console.error(JSON.stringify(facts)); if (browser) { const pages = browser.contexts()[0]?.pages(); if (pages?.[0]) { await pages[0].screenshot({ path: root + '/.test-artifacts/workspace-failure.png' }); console.error(await pages[0].locator('body').innerText()); } } process.exitCode = 1; }
finally { await browser?.close(); for (const proc of processes) proc.kill('SIGTERM'); await delay(500); for (const proc of processes) if (proc.exitCode === null) proc.kill('SIGKILL'); await rm(fixture, { recursive: true, force: true }); }
