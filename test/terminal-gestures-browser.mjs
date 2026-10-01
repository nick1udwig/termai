import { chromium } from 'playwright-core';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';

const root = path.resolve(import.meta.dirname, '..');
const fixture = await mkdtemp(path.join(os.tmpdir(), 'termai-gestures-'));
const port = Number(process.env.TEST_PORT || 3182), base = `http://127.0.0.1:${port}`;
const token = 'gesture-test-pairing-token-123456789';
const server = spawn(process.execPath, ['server/index.ts'], { cwd: root, env: { ...process.env, HOME: fixture, XDG_DATA_HOME: path.join(fixture, 'data'), NODE_ENV: 'production', HOST: '127.0.0.1', PORT: String(port), TERMAI_TOKEN: token, TERMAI_ALLOWED_HOSTS: '127.0.0.1', TERMAI_NO_RC: '1', TERMAI_CWD: fixture }, stdio: ['ignore', 'pipe', 'pipe'] });
let logs = '', browser;
server.stdout.on('data', b => logs += b); server.stderr.on('data', b => logs += b);
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
try {
  for (let i = 0; i < 100; i++) {
    if (await fetch(base).then(r => r.ok, () => false)) break;
    if (server.exitCode !== null) throw new Error(logs);
    await delay(100);
  }
  browser = await chromium.launch({ executablePath: process.env.CHROMIUM || '/usr/bin/chromium', headless: true, args: ['--use-gl=angle', '--use-angle=gl'] });
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, permissions: ['clipboard-read', 'clipboard-write'] });
  await context.route('**/api/dictation**', route => route.fulfill({ json: { installed: true, available: true } }));
  await context.route('**/assets/terminal-*.js', async route => {
    const response = await route.fetch(), original = await response.text();
    const body = original.replace(/new ([\w$]+)\(\{ghostty:/, 'window.__testTerminal=new $1({ghostty:');
    assert.notEqual(body, original); await route.fulfill({ response, body });
  });
  await context.addInitScript(() => {
    window.__sent = [];
    window.__inputFocusCalls = 0;
    const nativeFocus = HTMLElement.prototype.focus;
    HTMLElement.prototype.focus = function (...args) {
      if (this.matches('#terminal textarea')) window.__inputFocusCalls++;
      return nativeFocus.apply(this, args);
    };
    const Original = WebSocket;
    window.WebSocket = class extends Original {
      constructor(...args) { super(...args); this.addEventListener('message', e => { const m = JSON.parse(e.data); if (m.type === 'state') window.__state = m.state; if (m.type === 'output') window.__outputSeq = m.seq; }); }
      send(data) { if (typeof data === 'string') window.__sent.push(JSON.parse(data)); super.send(data); }
    };
  });
  const page = await context.newPage(), errors = []; page.on('pageerror', e => errors.push(String(e)));
  await page.goto(base + '/terminal.html');
  await page.locator('#token').fill(token); await page.locator('#login-form button').click();
  await page.waitForFunction(() => window.__state?.ready);
  await page.locator('#terminal textarea').focus();
  await page.keyboard.type("printf 'ROW-%03d alpha beta gamma\\n' {1..180}");
  const prompt = await page.evaluate(() => window.__state.prompt);
  await page.keyboard.press('Enter'); await page.waitForFunction(prompt => window.__state.ready && window.__state.prompt > prompt, prompt);
  await delay(150);
  const cdp = await context.newCDPSession(page);
  const touch = (type, point) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: point ? [{ ...point, id: 1 }] : [] });
  const focused = () => page.locator('#terminal textarea').evaluate(el => el === document.activeElement);
  await page.locator('#terminal textarea').evaluate(el => el.blur());
  async function checkScrollbar(scope) {
    const track = scope.getByRole('scrollbar', { name: 'Terminal history' });
    const edge = await track.boundingBox(), thumb = await scope.locator('.terminal-scrollbar-thumb').boundingBox();
    assert.equal(thumb.width, 3, 'The visible scrollbar must be thin');
    assert.equal(thumb.x + thumb.width, 390, 'The scrollbar must touch the screen edge');
    assert.equal(edge.x + edge.width, thumb.x + thumb.width);
    const before = await scope.evaluate(() => ({ focus: window.__inputFocusCalls, input: window.__sent.filter(m => m.type === 'input').length }));
    const maximum = await scope.evaluate(() => window.__testTerminal.buffer.active.length - window.__testTerminal.rows);
    const x = edge.x + edge.width - 10;
    // Pointer capture must keep touch dragging active outside the thin thumb/track.
    await touch('touchStart', { x, y: thumb.y + thumb.height / 2 });
    await touch('touchMove', { x: x - 30, y: edge.y + thumb.height / 2 }); await touch('touchEnd');
    assert.ok(Math.abs(await scope.evaluate(() => window.__testTerminal.getViewportY()) - maximum) < .01, 'Touch dragging must reach the oldest history');
    assert.equal(await track.getAttribute('aria-valuenow'), '0');
    await touch('touchStart', { x, y: edge.y + thumb.height / 2 });
    await touch('touchMove', { x, y: edge.y + edge.height - thumb.height / 2 }); await touch('touchEnd');
    assert.equal(await scope.evaluate(() => window.__testTerminal.getViewportY()), 0, 'Touch dragging must return to live output');
    await touch('touchStart', { x, y: edge.y + edge.height / 2 }); await touch('touchEnd');
    assert.ok(Math.abs(await scope.evaluate(() => window.__testTerminal.getViewportY()) - maximum / 2) < .01, 'Tapping the track must jump to that position');
    const middle = await scope.locator('.terminal-scrollbar-thumb').boundingBox();
    await touch('touchStart', { x, y: middle.y + middle.height / 2 }); await touch('touchCancel');
    assert.equal(await track.evaluate(el => el.classList.contains('dragging')), false, 'Cancelled drags must release the scrollbar');
    await page.mouse.move(x, middle.y + middle.height / 2); await page.mouse.down();
    await page.mouse.move(x - 30, edge.y + middle.height / 2); await page.mouse.up();
    assert.ok(Math.abs(await scope.evaluate(() => window.__testTerminal.getViewportY()) - maximum) < .01, 'Mouse dragging must also scroll history');
    await track.focus(); await page.keyboard.press('End');
    assert.equal(await scope.evaluate(() => window.__testTerminal.getViewportY()), 0);
    await page.keyboard.press('ArrowUp');
    assert.equal(await scope.evaluate(() => window.__testTerminal.getViewportY()), 1);
    await page.keyboard.press('Home');
    assert.equal(await scope.evaluate(() => window.__testTerminal.getViewportY()), maximum);
    await page.keyboard.press('End');
    assert.equal(await scope.locator('#terminal textarea').evaluate(el => el === document.activeElement), false, 'Scrollbar interaction must leave the keyboard closed');
    assert.deepEqual(await scope.evaluate(() => ({ focus: window.__inputFocusCalls, input: window.__sent.filter(m => m.type === 'input').length })), before, 'Scrollbar gestures and keys must not focus or type into the shell');
    await scope.evaluate(() => window.__testTerminal.write('\x1b[?1049h'));
    await track.waitFor({ state: 'hidden' });
    await scope.evaluate(() => window.__testTerminal.write('\x1b[?1049l'));
    await track.waitFor({ state: 'visible' });
  }
  await checkScrollbar(page);
  const canvas = await page.locator('#terminal canvas').boundingBox();
  const start = { x: canvas.x + canvas.width * .6, y: canvas.y + canvas.height * .35 };
  const focusCalls = await page.evaluate(() => window.__inputFocusCalls);
  await touch('touchStart', start); await delay(25);
  await touch('touchMove', { x: start.x, y: start.y + 8 });
  assert.ok(await page.evaluate(() => window.__testTerminal.getViewportY() > 0), 'An 8px drag must already scroll');
  assert.equal(await focused(), false);
  await delay(20); await touch('touchMove', { x: start.x, y: start.y + 90 }); await touch('touchEnd');
  // Dispatch a fast swipe in one task so CDP round-trip delays cannot turn it into a hold.
  await page.locator('#terminal canvas').evaluate((el, point) => {
    const options = { bubbles: true, cancelable: true, pointerType: 'touch', isPrimary: true, pointerId: 98, clientX: point.x, clientY: point.y };
    el.dispatchEvent(new PointerEvent('pointerdown', options));
    el.dispatchEvent(new PointerEvent('pointermove', { ...options, clientY: point.y + 60 }));
    el.dispatchEvent(new PointerEvent('pointerup', { ...options, clientY: point.y + 60 }));
  }, start);
  const released = await page.evaluate(() => window.__testTerminal.getViewportY());
  await delay(120);
  assert.ok(await page.evaluate(() => window.__testTerminal.getViewportY()) > released, 'A swipe should coast after release');
  assert.equal(await focused(), false, 'Scrolling must leave the keyboard closed');
  await page.locator('#terminal canvas').evaluate(el => {
    const options = { bubbles: true, cancelable: true, sourceCapabilities: new InputDeviceCapabilities({ firesTouchEvents: true }) };
    for (const type of ['mousedown', 'mouseup', 'click']) el.dispatchEvent(new MouseEvent(type, options));
  });
  assert.equal(await focused(), false, 'Compatibility mouse events after a swipe must not reopen input');
  // A library callback can focus input independently of the release event.
  await page.locator('#terminal').evaluate(el => {
    el.focus();
    setTimeout(() => el.querySelector('textarea').focus(), 0);
  });
  await delay(25);
  assert.equal(await focused(), false, 'Delayed automatic focus after release must stay blocked');
  assert.equal(await page.evaluate(() => window.__inputFocusCalls), focusCalls, 'A swipe must not invoke native input focus at all');
  // Some browsers coalesce movement: the release alone must disqualify a tap.
  await page.locator('#terminal canvas').evaluate((el, point) => {
    const options = { bubbles: true, cancelable: true, pointerType: 'touch', isPrimary: true, pointerId: 99, clientX: point.x, clientY: point.y };
    el.dispatchEvent(new PointerEvent('pointerdown', options));
    el.dispatchEvent(new PointerEvent('pointerup', { ...options, clientY: point.y + 20 }));
    el.parentElement.querySelector('textarea').focus();
  }, start);
  assert.equal(await focused(), false, 'A release displaced from the press must never be treated as an input tap');
  // Stop momentum with a new touch, then select text from scrollback.
  await touch('touchStart', start); await touch('touchCancel');
  await page.evaluate(() => window.__testTerminal.scrollToLine(40));
  const rowPoint = await page.evaluate(() => {
    const term = window.__testTerminal, bounds = document.querySelector('#terminal canvas').getBoundingClientRect();
    const top = term.buffer.active.length - term.rows - Math.floor(term.getViewportY());
    for (let row = 2; row < term.rows - 2; row++) {
      if (term.buffer.active.getLine(top + row)?.translateToString(true).startsWith('ROW-'))
        return { x: bounds.left + 8.5 * bounds.width / term.cols, y: bounds.top + (row + .5) * bounds.height / term.rows, cell: bounds.width / term.cols };
    }
    throw new Error('Missing visible scrollback row');
  });
  const from = { x: rowPoint.x, y: rowPoint.y };
  await touch('touchStart', from); await delay(400);
  await page.locator('#terminal canvas').evaluate((el, point) => el.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: point.x, clientY: point.y })), from);
  assert.equal(await focused(), false, 'The native long-press menu must not focus terminal input');
  await touch('touchEnd');
  assert.equal(await focused(), false);
  assert.equal(await page.locator('#terminal textarea').evaluate(el => el.readOnly), true, 'A closed input must be non-editable throughout selection and release');
  // Native browser focus does not call the element's JavaScript focus override.
  await page.locator('#terminal textarea').evaluate(el => HTMLElement.prototype.focus.call(el));
  assert.equal(await focused(), false, 'Browser-native focus after long press must not activate the input');
  await page.getByRole('button', { name: 'Copy', exact: true }).click();
  assert.equal(await page.evaluate(() => navigator.clipboard.readText()), 'alpha');
  // Horizontal dragging immediately selects an exact range and exposes Copy.
  await page.getByRole('button', { name: 'Clear', exact: true }).click();
  await touch('touchStart', from); await touch('touchMove', { x: from.x + 9 * rowPoint.cell, y: from.y }); await touch('touchEnd');
  assert.equal(await page.locator('.selection-handle:visible').count(), 2);
  await page.getByRole('button', { name: 'Copy', exact: true }).click();
  assert.equal(await page.evaluate(() => navigator.clipboard.readText()), 'alpha beta');
  assert.equal(await focused(), false, 'Selection and Copy must leave the keyboard closed');
  const endHandle = await page.getByRole('button', { name: 'Selection end', exact: true }).boundingBox();
  await page.mouse.move(endHandle.x + 16, endHandle.y + 16); await page.mouse.down();
  await page.mouse.move(endHandle.x + 16 + 6 * rowPoint.cell, endHandle.y + 16); await page.mouse.up();
  await page.getByRole('button', { name: 'Copy', exact: true }).click();
  assert.equal(await page.evaluate(() => navigator.clipboard.readText()), 'alpha beta gamma');
  assert.equal(await focused(), false, 'Adjusting handles must leave the keyboard closed');
  await page.screenshot({ path: path.join(root, '.test-artifacts/terminal-selection.png') });
  await page.getByRole('button', { name: 'Clear', exact: true }).click();
  // The canvas has side padding and unused space below its final row.
  const surface = await page.locator('#terminal').boundingBox();
  const padding = { x: surface.x + 1, y: surface.y + surface.height * .3 };
  const beforePadding = await page.evaluate(() => window.__testTerminal.getViewportY());
  await touch('touchStart', padding); await touch('touchMove', { x: padding.x, y: padding.y + 40 }); await touch('touchEnd');
  assert.ok(await page.evaluate(() => window.__testTerminal.getViewportY()) > beforePadding, 'Swipes starting in terminal padding must scroll');
  assert.equal(await focused(), false);
  await touch('touchStart', padding); await touch('touchCancel');
  // Simulate an Android keyboard opening and closing with a real PTY resize/redraw.
  await page.evaluate(() => window.__testTerminal.focus());
  await page.setViewportSize({ width: 390, height: 460 });
  await page.waitForFunction(() => document.querySelector('#terminal canvas').getBoundingClientRect().height < 450);
  await delay(150);
  const smallCanvas = await page.locator('#terminal canvas').boundingBox();
  const withKeyboard = { x: smallCanvas.x + smallCanvas.width * .6, y: smallCanvas.y + smallCanvas.height * .3 };
  const focusedCalls = await page.evaluate(() => window.__inputFocusCalls);
  await touch('touchStart', withKeyboard); await touch('touchMove', { x: withKeyboard.x, y: withKeyboard.y + 60 }); await touch('touchEnd');
  assert.equal(await focused(), true, 'Scrolling must also leave an already open keyboard alone');
  await page.locator('#terminal textarea').evaluate(el => el.focus());
  assert.equal(await page.evaluate(() => window.__inputFocusCalls), focusedCalls, 'A still-focused input must not be refocused on release after Android hides its keyboard');
  await touch('touchStart', withKeyboard); await touch('touchCancel');
  const view = await page.evaluate(() => {
    const term = window.__testTerminal, row = term.buffer.active.length - term.rows - Math.floor(term.getViewportY());
    return { rows: term.rows, row, text: term.buffer.active.getLine(row).translateToString(true), output: window.__outputSeq };
  });
  // Android Back can dismiss the IME while leaving its textarea focused.
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForFunction(rows => window.__testTerminal.rows > rows, view.rows);
  await page.waitForFunction(seq => window.__outputSeq > seq, view.output);
  await delay(200);
  assert.deepEqual(await page.evaluate(() => {
    const term = window.__testTerminal, row = term.buffer.active.length - term.rows - Math.floor(term.getViewportY());
    return { row, text: term.buffer.active.getLine(row).translateToString(true) };
  }), { row: view.row, text: view.text }, 'Closing the keyboard must keep the same history at the top through Bash redraws');
  assert.equal(await focused(), false);
  assert.equal(await page.locator('#terminal textarea').evaluate(el => el.readOnly), true, 'Keyboard dismissal must disarm the still-focused input');
  // A tap still opens input, and the next physical/mobile deletion each sends once.
  await touch('touchStart', from); await touch('touchEnd'); assert.equal(await focused(), true);
  assert.equal(await page.locator('#terminal textarea').evaluate(el => el.readOnly), false, 'An intentional input tap must re-enable the keyboard');
  assert.ok(await page.evaluate(() => window.__testTerminal.getViewportY()) > 0, 'Opening input alone must not jump out of history');
  await page.keyboard.type('x'); await page.keyboard.press('Backspace');
  assert.equal(await page.evaluate(() => window.__testTerminal.getViewportY()), 0, 'Typing must return to the editable prompt');
  await page.locator('#terminal textarea').evaluate(el => {
    el.dispatchEvent(new InputEvent('beforeinput', { inputType: 'insertText', data: 'y', bubbles: true, cancelable: true }));
    el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Unidentified', keyCode: 229, bubbles: true }));
    el.dispatchEvent(new InputEvent('beforeinput', { inputType: 'deleteContentBackward', isComposing: true, bubbles: true, cancelable: true }));
  });
  assert.deepEqual(await page.evaluate(() => window.__sent.filter(m => m.type === 'input').slice(-4).map(m => m.data)), ['x', '\x7f', 'y', '\x7f']);
  await page.getByRole('button', { name: 'Ctrl', exact: true }).click();
  await page.keyboard.press('Backspace'); assert.equal(await page.getByRole('button', { name: 'Ctrl', exact: true }).getAttribute('aria-pressed'), 'false');
  // Repeat the release and keyboard-close checks in the workspace iframe used on phones.
  await page.goto(base + '/');
  const frame = await (await page.locator('#terminal-stack iframe:visible').elementHandle()).contentFrame();
  await frame.waitForFunction(() => window.__state?.ready);
  await frame.evaluate(() => window.__testTerminal.focus());
  await page.keyboard.type("printf 'EMBEDDED-%03d alpha beta gamma\\n' {1..180}");
  const embeddedPrompt = await frame.evaluate(() => window.__state.prompt);
  await page.keyboard.press('Enter');
  await frame.waitForFunction(prompt => window.__state.ready && window.__state.prompt > prompt, embeddedPrompt);
  await delay(150);
  await frame.locator('#terminal textarea').evaluate(el => el.blur());
  await checkScrollbar(frame);
  const embeddedCanvas = await frame.locator('#terminal canvas').boundingBox();
  const embeddedStart = { x: embeddedCanvas.x + embeddedCanvas.width * .6, y: embeddedCanvas.y + embeddedCanvas.height * .3 };
  await touch('touchStart', embeddedStart); await touch('touchMove', { x: embeddedStart.x, y: embeddedStart.y + 60 }); await touch('touchEnd');
  await delay(100);
  assert.equal(await frame.locator('#terminal textarea').evaluate(el => el === document.activeElement), false, 'Embedded swipes must leave input closed');
  await touch('touchStart', embeddedStart); await touch('touchCancel');
  await frame.evaluate(() => window.__testTerminal.focus());
  await page.setViewportSize({ width: 390, height: 460 });
  await frame.waitForFunction(() => document.querySelector('#terminal canvas').getBoundingClientRect().height < 410);
  await delay(150);
  await frame.evaluate(() => window.__testTerminal.scrollLines(-15));
  const embeddedView = await frame.evaluate(() => {
    const term = window.__testTerminal, row = term.buffer.active.length - term.rows - Math.floor(term.getViewportY());
    return { rows: term.rows, row, text: term.buffer.active.getLine(row).translateToString(true), output: window.__outputSeq };
  });
  // Keep focus, as Android does when Back dismisses the keyboard inside an iframe.
  await page.setViewportSize({ width: 390, height: 844 });
  await frame.waitForFunction(rows => window.__testTerminal.rows > rows, embeddedView.rows);
  await frame.waitForFunction(seq => window.__outputSeq > seq, embeddedView.output);
  await delay(200);
  assert.deepEqual(await frame.evaluate(() => {
    const term = window.__testTerminal, row = term.buffer.active.length - term.rows - Math.floor(term.getViewportY());
    return { row, text: term.buffer.active.getLine(row).translateToString(true) };
  }), { row: embeddedView.row, text: embeddedView.text }, 'Workspace keyboard dismissal must preserve the visible history');
  assert.equal(await frame.locator('#terminal textarea').evaluate(el => el === document.activeElement), false);
  assert.equal(await frame.locator('#terminal textarea').evaluate(el => el.readOnly), true, 'The parent viewport must disarm embedded input after keyboard dismissal');
  assert.deepEqual(errors, []);
  await page.screenshot({ path: path.join(root, '.test-artifacts/terminal-gestures.png') });
  console.log('PASS: thin screen-edge scrollbar with touch/mouse/keyboard controls, standalone/workspace touch release, long-press menus, compatibility mouse events, keyboard dismissal with preserved history, sensitive scrolling, selection, Copy and Backspace');
} catch (error) { console.error(logs); throw error; }
finally { await browser?.close(); server.kill('SIGTERM'); await delay(100); await rm(fixture, { recursive: true, force: true }); }
