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
async function connectNew(page, name) { await page.getByRole('button', { name: new RegExp('^Terminals for ' + name + ' ') }).click(); await page.getByRole('menuitem', { name: 'Connect new terminal', exact: true }).click(); }
async function command(frame, text) { const prompt = await frame.evaluate(() => window.__shellState.prompt); await frame.locator('#terminal textarea').focus(); await frame.page().keyboard.type(text); await frame.page().keyboard.press('Enter'); await frame.waitForFunction(prompt => window.__shellState.ready && window.__shellState.prompt > prompt, prompt); }
try {
  await mkdir(fixture + '/remote/git/pebble-agent', { recursive: true });
  await writeFile(fixture + '/remote/hello_world.py', "import argparse\np=argparse.ArgumentParser()\np.add_argument('--myarg')\n");
  const hostKey = ssh2.utils.generateKeyPairSync('ed25519'); await writeFile(fixture + '/host', hostKey.private, { mode: 0o600 }); await writeFile(fixture + '/authorized', '');
  await writeFile(fixture + '/sshd_config', `Port ${sshPort}\nListenAddress 127.0.0.1\nHostKey ${fixture}/host\nPidFile ${fixture}/pid\nAuthorizedKeysFile ${fixture}/authorized\nStrictModes no\nUsePAM no\nPasswordAuthentication no\nKbdInteractiveAuthentication no\nAllowUsers ${os.userInfo().username}\nSetEnv HOME=${fixture}/remote\nSubsystem sftp internal-sftp\n`);
  start('/usr/bin/sshd', ['-D', '-e', '-f', fixture + '/sshd_config']);
  const backendSpecs = [[3153, 'primary', ''], [3154, 'secondary', 'test-backend-token-123456789']];
  const startBackend = ([port, name, token]) => start(process.execPath, ['server/index.ts'], { NODE_ENV: 'production', HOST: '127.0.0.1', PORT: String(port), TERMAI_BASE_PATH: '', TERMAI_ALLOWED_HOSTS: '127.0.0.1,localhost', TERMAI_ALLOWED_ORIGINS: origin, TERMAI_TOKEN: token, TERMAI_ENGINE: 'server', TERMAI_NO_RC: '1', TERMAI_CWD: fixture, HOME: fixture, TERMAI_DATA_DIR: fixture + '/' + name, TERMAI_HISTORY_FILE: fixture + '/no-history', TERMAI_ETERNAL_HISTORY_FILE: fixture + '/no-history' });
  const backends = backendSpecs.map(startBackend);
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
  assert.equal(await page.locator('#terminal-options').count(), 0);
  await page.locator('#terminal-back').click(); await page.locator('#nav-settings').click();
  assert.equal(await page.locator('#settings-pane').isVisible(), true); assert.equal(await page.locator('#terminal-stack').isVisible(), false); assert.equal(await page.locator('dialog[open]').count(), 0);
  assert.equal(await page.locator('#font-size').inputValue(), '10');
  await page.locator('#font-size').fill('14'); await frame.waitForFunction(() => document.querySelector('#font-size').value === '14');
  await page.locator('#auto-alternatives').uncheck(); await frame.waitForFunction(() => !document.querySelector('#auto-alternatives').checked);
  await page.locator('#auto-alternatives').check(); await page.locator('#tap-alternate-send').uncheck(); await frame.waitForFunction(() => !document.querySelector('#tap-alternate-send').checked); await page.locator('#tap-alternate-send').check();
  await page.locator('#customize-shortcuts').click(); assert.equal(await page.locator('dialog[open]').count(), 0);
  await page.locator('#add-shortcut').click();
  const shortcut = page.locator('.shortcut-row').last(); await shortcut.locator('.shortcut-label').fill('Help'); await shortcut.locator('select').selectOption('keys'); await shortcut.locator('.binding').fill('Ctrl+H');
  await page.getByRole('button', { name: 'Save shortcuts', exact: true }).click(); await frame.waitForFunction(() => document.querySelector('#shortcut-buttons').textContent.includes('Help'));
  await page.screenshot({ path: root + '/.test-artifacts/workspace-settings.png' });
  await page.locator('#font-size').fill('10'); await page.locator('#nav-terminals').click();
  assert.equal(await page.locator('[role=tab]').count(), 1); await activeFrame(page);
  let sessionCreates = 0;
  page.on('request', request => { if (request.method() === 'POST' && request.url().endsWith('/api/sessions')) sessionCreates++; });
  const firstSession = new URL(frame.url()).searchParams.get('session');
  await page.locator('#add-tab').click();
  assert.equal(await page.getByRole('button', { name: 'Terminals for This machine (1 open)', exact: true }).count(), 1);
  await page.getByRole('button', { name: 'This machine HTTP' }).click(); frame = await activeFrame(page);
  assert.equal(new URL(frame.url()).searchParams.get('session'), firstSession); assert.equal(sessionCreates, 0);
  await page.locator('#add-tab').click(); await connectNew(page, 'This machine'); frame = await activeFrame(page);
  assert.equal(sessionCreates, 1);
  assert.equal(await frame.locator('#font-size').inputValue(), '10'); assert.ok((await frame.locator('#shortcut-buttons').textContent()).includes('Help'));
  const secondSession = new URL(frame.url()).searchParams.get('session'); assert.notEqual(secondSession, firstSession);
  await page.locator('#add-tab').click();
  await page.getByRole('button', { name: 'Terminals for This machine (2 open)', exact: true }).click();
  await page.screenshot({ path: root + '/.test-artifacts/workspace-host-menu.png' });
  assert.equal(await page.getByRole('menuitem', { name: 'This machine (2)', exact: true }).count(), 1);
  await page.getByRole('menuitem', { name: 'This machine', exact: true }).click(); frame = await activeFrame(page);
  assert.equal(new URL(frame.url()).searchParams.get('session'), firstSession);
  await page.locator('#add-tab').click(); await page.getByRole('button', { name: 'This machine HTTP' }).click(); frame = await activeFrame(page);
  assert.equal(new URL(frame.url()).searchParams.get('session'), firstSession); assert.equal(sessionCreates, 1);
  await page.locator('#add-tab').click(); await page.getByRole('button', { name: 'Terminals for This machine (2 open)', exact: true }).click();
  await page.keyboard.press('Escape'); assert.equal(await page.locator('#host-terminal-menu').isVisible(), false);
  assert.equal(await page.getByRole('button', { name: 'Terminals for This machine (2 open)', exact: true }).evaluate(el => document.activeElement === el), true);
  await page.getByRole('button', { name: 'Terminals for This machine (2 open)', exact: true }).click();
  await page.getByRole('menuitem', { name: 'This machine (2)', exact: true }).click(); frame = await activeFrame(page);
  assert.equal(new URL(frame.url()).searchParams.get('session'), secondSession); assert.equal(sessionCreates, 1);
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
  const sshSession = new URL(frame.url()).searchParams.get('session'), createsBeforeReuse = sessionCreates;
  await page.locator('#add-tab').click();
  assert.equal(await page.getByRole('button', { name: 'Terminals for Remote shell (1 open)', exact: true }).count(), 1);
  await page.getByRole('button', { name: 'Remote shell SSH' }).click(); frame = await activeFrame(page);
  assert.equal(new URL(frame.url()).searchParams.get('session'), sshSession); assert.equal(sessionCreates, createsBeforeReuse);
  assert.equal(await page.locator('#ssh-dialog').isVisible(), false);
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
  await page.locator('#add-tab').click();
  assert.equal(await page.getByRole('button', { name: 'Terminals for Remote shell (0 open)', exact: true }).count(), 1);
  await connectNew(page, 'This machine'); frame = await activeFrame(page);
  const endedFrameId = await page.locator('#terminal-stack iframe:visible').getAttribute('id');
  await frame.locator('#terminal textarea').focus(); await page.keyboard.type('exit'); await page.keyboard.press('Enter');
  await frame.waitForFunction(() => window.__shellState?.exited);
  await page.locator('#add-tab').click();
  await page.getByRole('button', { name: 'Terminals for This machine (2 open)', exact: true }).waitFor();
  const createsBeforeEnded = sessionCreates;
  await page.getByRole('button', { name: 'This machine HTTP' }).click(); frame = await activeFrame(page);
  assert.notEqual(await page.locator('#terminal-stack iframe:visible').getAttribute('id'), endedFrameId); assert.equal(sessionCreates, createsBeforeEnded);
  await page.locator(`[role=tab][aria-controls="${endedFrameId}"] .tab-close`).click();
  // A changed pin must fail even if the caller supplies trust for the new key.
  const backendToken = await page.evaluate(url => sessionStorage.getItem('termai.access:' + url + '/'), secondary);
  const remoteVault = new Vault(fixture + '/secondary'), remoteKey = (await remoteVault.list()).keys[0];
  await remoteVault.forget('127.0.0.1', sshPort); await remoteVault.trust('127.0.0.1', sshPort, 'SHA256:changed-fixture');
  const changed = await request(secondary, 'sessions', backendToken, { name: 'changed host', ssh: { host: '127.0.0.1', port: sshPort, username: os.userInfo().username, keyId: remoteKey.id, passphrase: 'test-key-passphrase', trust: 'ignored' } });
  assert.equal(changed.status, 409); assert.equal((await changed.json()).changed, true);
  // A phone may resume on Hosts with cached credentials after its backend restarted.
  // Remove terminal documents so their independent reconnect cannot conceal a stale
  // workspace credential. Keep the workspace itself alive throughout both restarts.
  await page.locator('#add-tab').click();
  await page.locator('#terminal-stack iframe').evaluateAll(frames => frames.forEach(frame => frame.remove()));
  const restart = async index => {
    const stopped = new Promise(resolve => backends[index].once('exit', resolve)); backends[index].kill('SIGTERM'); await stopped;
    backends[index] = startBackend(backendSpecs[index]);
    await until(async () => { try { return (await fetch(index ? secondary : origin)).ok; } catch { return false; } });
  };
  let unauthorizedCreates = 0, successfulCreates = 0;
  page.on('response', response => { if (response.request().method() === 'POST' && response.url().endsWith('/api/sessions')) { if (response.status() === 401) unauthorizedCreates++; if (response.ok()) successfulCreates++; } });
  await restart(0);
  await connectNew(page, 'This machine');
  await page.locator('#terminal-header').waitFor({ state: 'visible', timeout: 10000 }); frame = await activeFrame(page);
  await command(frame, 'printf recovered > recovered-primary.txt'); assert.equal(await readFile(fixture + '/recovered-primary.txt', 'utf8'), 'recovered');
  assert.equal(unauthorizedCreates, 1); assert.equal(successfulCreates, 1);
  await page.locator('#add-tab').click(); await restart(1);
  await connectNew(page, 'Build server');
  await page.locator('#backend-login').waitFor({ state: 'visible', timeout: 10000 });
  await page.locator('#backend-token').fill('test-backend-token-123456789'); await page.locator('#backend-login-form button[type=submit]').click();
  await page.locator('#terminal-header').waitFor({ state: 'visible' }); frame = await activeFrame(page);
  await command(frame, 'printf recovered > recovered-secondary.txt'); assert.equal(await readFile(fixture + '/recovered-secondary.txt', 'utf8'), 'recovered');
  assert.equal(unauthorizedCreates, 2); assert.equal(successfulCreates, 2);
  assert.deepEqual(errors, []);
  console.log('PASS workspace: terminal-first, settings pane and shared preferences, 10 pt, persistent isolated tabs, host reuse/count/menu, explicit new terminals, ended-shell exclusion, background output, direct cross-origin backend, encrypted keychain, verified OpenSSH, automatic routing, remote directory/Python repair, SSH reconnect and close, CORS, owner isolation, single-use tickets, changed-host rejection and stale-auth recovery after backend restarts');
} catch (error) { console.error(logs.join('')); console.error(error); console.error(JSON.stringify(facts)); if (browser) { const pages = browser.contexts()[0]?.pages(); if (pages?.[0]) { await pages[0].screenshot({ path: root + '/.test-artifacts/workspace-failure.png' }); console.error(await pages[0].locator('body').innerText()); } } process.exitCode = 1; }
finally { await browser?.close(); for (const proc of processes) proc.kill('SIGTERM'); await delay(500); for (const proc of processes) if (proc.exitCode === null) proc.kill('SIGKILL'); await rm(fixture, { recursive: true, force: true }); }
