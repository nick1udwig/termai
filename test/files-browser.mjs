import { chromium } from 'playwright-core';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import ssh2 from 'ssh2';
const root = path.resolve(import.meta.dirname, '..'), fixture = await mkdtemp('/tmp/termai-files-');
const origin = 'http://127.0.0.1:3181', base = origin + '/t/', second = 'http://127.0.0.1:3182/t/', sshPort = 3183;
const processes = []; let logs = '', browser;
const delay = ms => new Promise(r => setTimeout(r, ms));
function start(cmd, args, env = {}) { const p = spawn(cmd, args, { cwd: root, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] }); processes.push(p); p.stdout.on('data', b => logs += b); p.stderr.on('data', b => logs += b); return p; }
const request = (target, route, owner, data) => fetch(target + route, { method: data === undefined ? 'GET' : 'POST', headers: { Origin: origin, ...(owner ? { Authorization: 'Bearer ' + owner } : {}), ...(data === undefined ? {} : { 'Content-Type': 'application/json' }) }, ...(data === undefined ? {} : { body: JSON.stringify(data) }) });
const bytes = Buffer.from([0, 255, 1, 2, 3, 10, 13, 90]);
try {
  for (const dir of ['local/docs', 'remote/docs', 'secondary/docs']) await mkdir(fixture + '/' + dir, { recursive: true });
  for (const dir of ['local', 'remote', 'secondary']) { await writeFile(`${fixture}/${dir}/docs/über file.bin`, bytes); await writeFile(`${fixture}/${dir}/.hidden`, 'hidden'); await symlink('docs', `${fixture}/${dir}/linked`); }
  const hostKey = ssh2.utils.generateKeyPairSync('ed25519'), key = ssh2.utils.generateKeyPairSync('ed25519');
  await writeFile(fixture + '/host', hostKey.private, { mode: 0o600 }); await writeFile(fixture + '/authorized', key.public);
  await writeFile(fixture + '/sshd_config', `Port ${sshPort}\nListenAddress 127.0.0.1\nHostKey ${fixture}/host\nPidFile ${fixture}/pid\nAuthorizedKeysFile ${fixture}/authorized\nStrictModes no\nUsePAM no\nPasswordAuthentication no\nKbdInteractiveAuthentication no\nAllowUsers ${os.userInfo().username}\nSetEnv HOME=${fixture}/remote\nSubsystem sftp internal-sftp\n`);
  start('/usr/bin/sshd', ['-D', '-e', '-f', fixture + '/sshd_config']);
  for (const [port, dir] of [[3181, 'local'], [3182, 'secondary']]) start(process.execPath, ['server/index.ts'], { NODE_ENV: 'production', HOST: '127.0.0.1', PORT: String(port), TERMAI_BASE_PATH: '/t', TERMAI_ALLOWED_ORIGINS: origin, TERMAI_TOKEN: 'files-feature-test-123456789', TERMAI_CWD: fixture + '/' + dir, TERMAI_DATA_DIR: fixture + '/data-' + dir, TERMAI_NO_RC: '1', HOME: fixture + '/' + dir });
  for (let n = 0; n < 200; n++) { try { if ((await fetch(base)).ok && (await fetch(second)).ok) break; } catch {} await delay(50); }
  const owner = (await (await request(base, 'api/connect', undefined, { token: 'files-feature-test-123456789', noSession: true })).json()).accessToken;
  const other = (await (await request(base, 'api/connect', undefined, { token: 'files-feature-test-123456789', noSession: true })).json()).accessToken;
  const local = await (await request(base, 'api/sessions', owner, { name: 'Local files', files: true })).json();
  assert.equal((await request(base, 'api/files/list?session=' + local.id, other)).status, 404);
  assert.equal((await request(base, 'api/files/list?session=' + local.id)).status, 401);
  assert.equal((await request(base, 'api/ticket?session=' + local.id, owner, {})).status, 404, 'Files sessions have no shell');
  assert.equal((await fetch(base + 'api/files/upload?session=' + local.id, { method: 'POST', headers: { Origin: 'http://untrusted.invalid', Authorization: 'Bearer ' + owner }, body: 'x' })).status, 403);
  const ssh = { host: '127.0.0.1', port: sshPort, username: os.userInfo().username, privateKey: key.private, passphrase: 'test-passphrase-123' };
  const trust = await (await request(base, 'api/sessions', owner, { name: 'Remote', files: true, ssh })).json(); assert.ok(trust.fingerprint, JSON.stringify(trust)); ssh.trust = trust.fingerprint;
  const remote = await (await request(base, 'api/sessions', owner, { name: 'Remote', files: true, ssh })).json(); assert.ok(remote.id, JSON.stringify(remote));
  for (const [id, dir] of [[local.id, 'local'], [remote.id, 'remote']]) {
    const folder = fixture + '/' + dir;
    const created = await request(base, 'api/files/mkdir?session=' + id, owner, { path: folder, name: 'New folder' }); assert.equal(created.status, 200);
    assert.equal((await request(base, 'api/files/mkdir?session=' + id, owner, { path: folder, name: '../escape' })).status, 400);
    const listing = await (await request(base, 'api/files/list?session=' + id + '&path=' + encodeURIComponent(folder), owner)).json();
    assert.equal(listing.entries.find(e => e.name === 'linked').directory, true); assert.ok(listing.entries.find(e => e.name === '.hidden'));
    const send = (name, body = bytes) => fetch(base + 'api/files/upload?' + new URLSearchParams({ session: id, path: folder, name }), { method: 'POST', headers: { Origin: origin, Authorization: 'Bearer ' + owner, 'Content-Type': 'application/octet-stream' }, body });
    assert.equal((await send('uploaded.bin')).status, 200); assert.deepEqual(await readFile(folder + '/uploaded.bin'), bytes);
    assert.equal((await send('../escape')).status, 400); assert.equal((await send('uploaded.bin', 'overwrite')).ok, false); assert.deepEqual(await readFile(folder + '/uploaded.bin'), bytes);
    const ticket = await (await request(base, 'api/files/download?session=' + id, owner, { path: folder + '/uploaded.bin' })).json();
    const download = await fetch(base + 'api/files/download?ticket=' + ticket.ticket); assert.match(download.headers.get('content-disposition'), /attachment/); assert.deepEqual(Buffer.from(await download.arrayBuffer()), bytes);
    assert.equal((await fetch(base + 'api/files/download?ticket=' + ticket.ticket)).status, 404);
    assert.equal((await request(base, 'api/files/download?session=' + id, owner, { path: folder })).status, 400);
  }
  browser = await chromium.launch({ executablePath: '/usr/bin/chromium', headless: true });
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  await context.route('**/api/dictation', route => route.fulfill({ json: { installed: true, available: true } }));
  const page = await context.newPage(); page.on('response', async r => { if (r.url().includes('/api/files') && !r.ok()) console.log('File error', r.status(), await r.text().catch(() => '')); }); const errors = []; page.on('pageerror', e => errors.push(String(e))); page.on('dialog', d => d.accept());
  await page.goto(base); await page.locator('#backend-token').fill('files-feature-test-123456789'); await page.locator('#backend-login-form button[type=submit]').click();
  await page.locator('#terminal-back').click(); await page.getByRole('button', { name: /^Terminals for This machine/ }).click();
  await page.getByRole('menuitem', { name: 'Connect SFTP / Files', exact: true }).click();
  const view = page.locator('.file-browser:visible');
  await view.getByRole('button', { name: 'Open folder docs', exact: true }).waitFor();
  assert.equal(await view.locator('.file-breadcrumbs button:not([aria-haspopup])').count(), 2);
  await view.getByRole('button', { name: 'Earlier directories' }).click();
  assert.ok(await view.getByRole('menuitem', { name: '/', exact: true }).count());
  await page.keyboard.press('Escape'); assert.equal(await view.getByRole('menu').count(), 0);
  assert.equal(await view.getByRole('button', { name: 'Download .hidden', exact: true }).count(), 0);
  await view.getByRole('button', { name: 'File options' }).click(); await view.getByRole('menuitemcheckbox', { name: 'Hidden files' }).click();
  await view.getByRole('button', { name: 'Download .hidden', exact: true }).waitFor();
  await view.getByRole('button', { name: 'File options' }).click(); await view.getByRole('menuitem', { name: 'New folder' }).click();
  await view.getByRole('textbox', { name: 'Folder name' }).fill('From device'); await view.getByRole('button', { name: 'Create', exact: true }).click();
  await view.getByRole('button', { name: 'Open folder From device', exact: true }).waitFor();
  await view.getByRole('button', { name: 'File options' }).click(); await view.getByRole('menuitemradio', { name: 'Sort by name', exact: true }).click();
  assert.equal(await view.locator('.file-row').nth(1).getAttribute('aria-label'), 'Open folder New folder');
  await view.getByRole('button', { name: 'File options' }).click(); await view.getByRole('menuitemradio', { name: 'Sort by name', exact: true }).click();
  await view.getByRole('button', { name: 'File options' }).click(); await page.screenshot({ path: '/tmp/termai-files-options.png' }); await page.keyboard.press('Escape');
  await view.getByRole('button', { name: 'Open folder docs', exact: true }).click();
  const downloadEvent = page.waitForEvent('download'); await view.getByRole('button', { name: 'Download über file.bin', exact: true }).click();
  const downloaded = await downloadEvent; assert.equal(downloaded.suggestedFilename(), 'über file.bin'); assert.deepEqual(await readFile(await downloaded.path()), bytes);
  await view.locator('input[type=file]').setInputFiles({ name: 'device.txt', mimeType: 'text/plain', buffer: Buffer.from('from device') });
  await view.getByRole('button', { name: 'Download device.txt', exact: true }).waitFor(); assert.equal(await readFile(fixture + '/local/docs/device.txt', 'utf8'), 'from device');
  await view.locator('input[type=file]').setInputFiles({ name: 'device.txt', mimeType: 'text/plain', buffer: Buffer.from('oops') }); await view.locator('.file-status.error').waitFor();
  await page.reload(); await view.getByRole('button', { name: 'Download device.txt', exact: true }).waitFor();
  await view.getByRole('button', { name: 'Search files', exact: true }).click(); await view.getByRole('searchbox').fill('device'); assert.equal(await view.locator('.file-row').count(), 2);
  await page.screenshot({ path: '/tmp/termai-files-mobile.png' });
  // The same component uses bearer authentication against an independent backend.
  const secondOwner = (await (await request(second, 'api/connect', undefined, { token: 'files-feature-test-123456789', noSession: true })).json()).accessToken;
  const secondSession = await (await request(second, 'api/sessions', secondOwner, { files: true })).json();
  await page.evaluate(({ owner, remote, fixture, second, secondOwner, secondSession }) => {
    localStorage.setItem('termai.backends', JSON.stringify([{ id: 'second', name: 'Other backend', url: second }]));
    localStorage.setItem('termai.tabs', JSON.stringify([{ id: 'remote-files', name: 'SSH files', mode: 'files', backendId: 'primary', session: remote.id, directory: fixture + '/remote' }, { id: 'direct-files', name: 'Direct files', mode: 'files', backendId: 'second', session: secondSession.id }]));
    localStorage.setItem('termai.activeTab', JSON.stringify('remote-files'));
    localStorage.setItem('termai.access:' + second, secondOwner);
  }, { owner, remote, fixture, second, secondOwner, secondSession });
  // Switch primary pairing to the owner of the SSH fixture.
  await context.addCookies([{ name: 'termai', value: owner, url: base }]);
  await page.evaluate(() => { localStorage.removeItem('termai.access:' + new URL('.', document.baseURI).href); });
  await page.reload(); await view.getByRole('button', { name: 'Download uploaded.bin', exact: true }).waitFor();
  await view.locator('input[type=file]').setInputFiles({ name: 'remote-device.txt', mimeType: 'text/plain', buffer: Buffer.from('remote device') });
  await view.getByRole('button', { name: 'Download remote-device.txt', exact: true }).waitFor(); assert.equal(await readFile(fixture + '/remote/remote-device.txt', 'utf8'), 'remote device');
  await page.getByRole('tab').filter({ hasText: 'Direct files' }).click();
  await view.getByRole('button', { name: 'Open folder docs', exact: true }).click();
  await view.getByRole('button', { name: 'Download über file.bin', exact: true }).waitFor();
  await view.locator('input[type=file]').setInputFiles({ name: 'cross-origin.txt', mimeType: 'text/plain', buffer: Buffer.from('cross origin') });
  await page.waitForFunction(() => { const e = document.querySelector('.file-browser:not([hidden]) .file-status'); return e?.textContent.includes('uploaded') || e?.classList.contains('error'); });
  assert.equal(await view.locator('.file-status').textContent(), '1 file uploaded.');
  await view.getByRole('button', { name: 'Download cross-origin.txt', exact: true }).waitFor();
  const crossDownload = page.waitForEvent('download'); await view.getByRole('button', { name: 'Download cross-origin.txt', exact: true }).click();
  assert.equal(await readFile(await (await crossDownload).path(), 'utf8'), 'cross origin');
  assert.deepEqual(errors, []);
  console.log('PASS files: local and real SFTP browsing, binary uploads/downloads, Unicode names, symlink folders, duplicate protection, owner/origin isolation, one-use links, no shell in Files tabs, mobile menu and restored directory');
} catch (e) { console.error(logs); throw e; }
finally { await browser?.close(); for (const p of processes) p.kill('SIGTERM'); await delay(200); await rm(fixture, { recursive: true, force: true }); }
