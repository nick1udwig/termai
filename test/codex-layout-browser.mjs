import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { readFile, mkdir } from 'node:fs/promises';
import { herdrFixture } from './herdr-fixture.ts';
import { codexScreen, nativeColumns } from './codex-layout-fixture.ts';

const fixture = await herdrFixture(), root = new URL('../', import.meta.url).pathname;
fixture.snapshot.agents[0].agent = 'codex';
let screen = codexScreen();
fixture.setScreen(0, screen.text, { x: 2, y: screen.composer }, { width: 512, height: 256 });
const origin = 'http://127.0.0.1:3171', base = origin + '/codex-layout-test';
const backend = spawn(process.execPath, ['server/index.ts'], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'], env: {
  ...process.env, NODE_ENV: 'production', HOST: '127.0.0.1', PORT: '3171', TERMAI_BASE_PATH: '/codex-layout-test',
  TERMAI_ALLOWED_HOSTS: '127.0.0.1', TERMAI_ALLOWED_ORIGINS: origin, TERMAI_DATA_DIR: fixture.directory + '/termai',
  TERMAI_NO_RC: '1', TERMAI_CWD: fixture.directory, HOME: fixture.directory, PATH: fixture.directory + ':' + process.env.PATH,
  TERMAI_TOKEN: '', HERDR_SOCKET_PATH: fixture.socketPath,
} });
const exited = once(backend, 'exit'); let browser, page, logs = '';
backend.stdout.on('data', b => logs += b); backend.stderr.on('data', b => logs += b);
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, name) { for (const end = Date.now() + 12000; Date.now() < end;) { if (await check()) return; await delay(30); } throw new Error('Timed out: ' + name); }
try {
  await until(async () => { try { return (await fetch(base)).ok; } catch { return false; } }, 'fixture backend');
  const token = (await readFile(fixture.directory + '/termai/pairing-token', 'utf8')).trim();
  browser = await chromium.launch({ executablePath: process.env.CHROMIUM || '/usr/bin/chromium', headless: true, args: ['--use-gl=angle', '--use-angle=gl'] });
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, permissions: ['clipboard-read', 'clipboard-write'] });
  await context.route('**/assets/terminal-*.js', async route => {
    const response = await route.fetch(), original = await response.text();
    const body = original.replace(/new ([\w$]+)\(\{ghostty:/, 'window.__testTerminal=new $1({ghostty:').replace(/([\w$]+)=([\w$]+)\?new ([\w$]+)\(([\w$]+),([\w$]+)\):void 0/, '$1=$2?(window.__testProjection=new $3($4,$5)):void 0');
    assert.notEqual(body, original); assert.ok(body.includes('window.__testProjection')); await route.fulfill({ response, body });
  });
  page = await context.newPage(); const errors = []; page.on('pageerror', e => errors.push(e.message));
  await page.goto(base); await page.locator('#backend-token').fill(token); await page.locator('#backend-login-form button[type=submit]').click();
  const shell = await (await page.locator('#terminal-stack > iframe').elementHandle()).contentFrame();
  await shell.waitForFunction(() => window.__testTerminal && document.querySelector('#connection-label').textContent === 'Connected');
  await shell.locator('#terminal textarea').focus(); await page.keyboard.type('herdr'); await page.keyboard.press('Enter');
  await page.locator('.herdr-terminal').waitFor();
  const terminal = await (await page.locator('.herdr-terminal').elementHandle()).contentFrame();
  await terminal.waitForFunction(() => window.__testTerminal && window.__testProjection?.nativeColumns === 152);
  const rows = () => terminal.evaluate(() => { const b = window.__testTerminal.buffer.active; return Array.from({ length: b.length }, (_, i) => b.getLine(i)?.translateToString(true) || ''); });
  const caret = () => terminal.evaluate(() => {
    const t = window.__testTerminal, b = t.buffer.active, line = b.getLine(b.length - t.rows + b.cursorY), cell = line?.getCell(b.cursorX);
    return { x: b.cursorX, text: line?.translateToString(true), character: cell?.getChars(), background: cell?.getBgColor(), cols: t.cols };
  });
  await until(async () => (await caret()).character === 'A', 'real cursor inside compact composer');
  let rendered = await rows(), input = rendered.findIndex(r => r.startsWith('› Ask'));
  assert.equal(rendered[input - 1], ''); assert.equal(rendered[input + 1], '');
  assert.equal(rendered.filter(r => r.includes('GPT-6.1-Sol')).length, 1);
  assert.ok(rendered[input + 2].startsWith('GPT-6.1-Sol xhigh · …/mobile-demo'));
  assert.ok(rendered.some(r => r === '⚠ 1 warning · f2 to view'));
  const recap = rendered.slice(rendered.findIndex(r => r.startsWith('↳ Recap:')), input);
  assert.ok(!recap.some(r => /^ {3,}\S/.test(r))); assert.ok(recap.map(r => r.trim()).join(' ').includes('Tests and browser validation passed.'));
  assert.equal((await caret()).background, 0x353640);
  await mkdir(root + 'output/codex-layout', { recursive: true });
  await page.screenshot({ path: root + 'output/codex-layout/mobile.png' });

  const desktop = await context.newPage(); await desktop.setViewportSize({ width: 1440, height: 900 });
  await desktop.goto(base + '/terminal.html?herdrTerminal=term_0&backend=' + encodeURIComponent(base + '/'));
  await desktop.waitForFunction(() => window.__testProjection?.nativeColumns === 152 && window.__testTerminal.buffer.active.length > 50);
  const desktopSize = await desktop.evaluate(() => ({ cols: window.__testTerminal.cols, rows: window.__testTerminal.rows, length: window.__testTerminal.buffer.active.length }));
  await desktop.screenshot({ path: root + 'output/codex-layout/desktop.png' });
  await page.bringToFront(); await page.setViewportSize({ width: 360, height: 800 }); await delay(250);
  assert.deepEqual(await desktop.evaluate(() => ({ cols: window.__testTerminal.cols, rows: window.__testTerminal.rows, length: window.__testTerminal.buffer.active.length })), desktopSize);
  assert.equal((await caret()).x, 2); assert.equal((await caret()).character, 'A');
  await page.setViewportSize({ width: 390, height: 844 }); await desktop.close();

  const draft = 'Improve this paragraph with careful mobile wrapping and keep the cursor inside the input area.';
  screen = codexScreen(draft); fixture.setScreen(0, screen.text, { x: 32, y: screen.composer });
  await until(async () => (await caret()).character === draft[30], 'caret while editing a wrapped draft');
  assert.equal((await caret()).background, 0x353640);
  await terminal.locator('#terminal textarea').focus(); await page.keyboard.type('edit');
  await until(() => fixture.actions.filter(a => a.method === 'pane.send_text').map(a => a.params.text).join('') === 'edit', 'shared terminal input');
  screen = codexScreen(); fixture.setScreen(0, screen.text, { x: 2, y: screen.composer });
  await until(async () => (await caret()).character === 'A', 'restored composer');
  await terminal.locator('#terminal textarea').evaluate(el => el.blur());

  // Selection and copying still go through the ordinary terminal gestures.
  const point = await terminal.evaluate(() => {
    const t = window.__testTerminal, b = t.buffer.active, rect = document.querySelector('#terminal canvas').getBoundingClientRect();
    for (let y = 0; y < t.rows; y++) {
      const x = b.getLine(b.length - t.rows + y)?.translateToString(true).indexOf('Recap') ?? -1;
      if (x >= 0) return { x: (x + 2) * rect.width / t.cols, y: (y + .5) * rect.height / t.rows };
    }
    throw new Error('Recap not visible');
  });
  const canvas = await terminal.locator('#terminal canvas').boundingBox(); point.x += canvas.x; point.y += canvas.y;
  const cdp = await context.newCDPSession(page);
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ ...point, id: 1 }] }); await delay(450);
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await terminal.locator('.selection-notice').waitFor({ state: 'visible' });
  assert.equal(await terminal.evaluate(() => navigator.clipboard.readText()), 'Recap:');

  await page.locator('#terminal-back').click(); await page.locator('#nav-settings').click(); await page.locator('#herdr-layout').selectOption('full-width'); await page.locator('#page-back').click();
  await until(async () => (await caret()).cols === nativeColumns, 'original-width fallback');
  assert.equal((await caret()).character, 'A');
  await page.screenshot({ path: root + 'output/codex-layout/full-width.png' });
  await page.locator('#terminal-back').click(); await page.locator('#nav-settings').click(); await page.locator('#herdr-layout').selectOption('reflow'); await page.locator('#page-back').click();
  await until(async () => (await caret()).cols < nativeColumns && (await caret()).character === 'A', 'return to mobile layout');
  assert.ok(!fixture.actions.some(a => /attach|resize/.test(a.method)), 'Independent observation never resizes the server PTY');
  assert.deepEqual(errors, []);
  console.log('PASS: compact Codex controls/prose, native caret, Unicode unit coverage, shared input/copy, independent desktop, full-width backup.');
} catch (error) {
  await page?.screenshot({ path: '/tmp/termai-codex-layout-failure.png' }).catch(() => {});
  console.error(error); process.exitCode = 1;
}
finally { await browser?.close(); backend.kill(); await exited; await fixture.close(); }
