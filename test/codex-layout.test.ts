import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { Ghostty, CellFlags, type Terminal } from 'ghostty-web';
import { codexColumns, layoutCodex } from '../src/codex-layout.ts';
import { TerminalProjection } from '../src/terminal-projection.ts';
import { codexScreen, nativeColumns } from './codex-layout-fixture.ts';

const wasm = await readFile(new URL('../node_modules/ghostty-web/dist/ghostty-vt.wasm', import.meta.url));
const newGhostty = () => Ghostty.load('data:application/wasm;base64,' + wasm.toString('base64'));
let ghostty: Ghostty;
function source(text: string) {
  const terminal = ghostty.createTerminal(nativeColumns, 256, { scrollbackLimit: 10000 }), starts: number[] = [];
  const lines = text.replace(/\r?\n/g, '\r\n').replace(/\r\n$/, '').split('\r\n');
  for (let i = 0; i < lines.length; i++) {
    starts.push(terminal.getScrollbackLength() + terminal.getCursor().y);
    if (lines[i]) terminal.write(lines[i]); if (i < lines.length - 1) terminal.write('\r\n');
  }
  return { terminal, starts };
}
const plain = (text: string) => text.replace(/\x1b(?:\[[0-?]*[ -/]*[@-~]|\][\s\S]*?(?:\x07|\x1b\\))/g, '');

test('Codex mobile layout compacts painted input rows and footer while retaining alerts', async () => {
  ghostty = await newGhostty();
  const screen = codexScreen(), s = source(screen.text);
  try {
    assert.equal(codexColumns(screen.text), nativeColumns);
    assert.equal(codexColumns('plain code with 152 spaces ' + ' '.repeat(152)), undefined);
    const layout = layoutCodex(s.terminal, s.starts, 42, { row: screen.composer, x: 2 })!;
    const rows = plain(layout.text).split('\r\n'), input = rows.findIndex(r => r.startsWith('› '));
    assert.equal(rows[input - 1], ''); assert.equal(rows[input + 1], '');
    assert.equal(rows[input], '› Ask Codex to do anything');
    assert.equal(rows[input + 2], 'GPT-6.1-Sol xhigh · …/mobile-demo · Revie…');
    assert.ok(rows.every(r => [...r].length <= 42));
    assert.deepEqual(rows.slice(-2), ['← for agents · ? for shortcuts', '⚠ 1 warning · f2 to view']);
    assert.deepEqual(layout.cursor(screen.composer, 2), { row: input, x: 2 });
    assert.equal(layoutCodex(s.terminal, s.starts, nativeColumns), undefined, 'Original-width layout is untouched');
  } finally { s.terminal.free(); }
});

test('Codex Recap continuations reflow as prose without desktop hanging padding', async () => {
  ghostty = await newGhostty();
  const s = source(codexScreen().text);
  try {
    const rows = plain(layoutCodex(s.terminal, s.starts, 42)!.text).split('\r\n');
    const recap = rows.slice(rows.findIndex(r => r.startsWith('↳ Recap:'))).filter(Boolean).slice(0, 8);
    assert.ok(recap.map(r => r.trim()).join(' ').includes('and browser validation passed.'));
    assert.ok(!recap.some(r => /^ {3,}/.test(r)));
    assert.ok(rows.some(r => r.startsWith("    const example")), 'Code indentation remains intact');
    assert.ok(!rows.some(r => /paragraph\r|paragra$/.test(r)), 'Ordinary words wrap at spaces');
  } finally { s.terminal.free(); }
});

test('Codex draft cursor tracks words, Unicode cells, trailing spaces and explicit newlines', async () => {
  for (const draft of ['hello world', '日本 😀 é editable text', 'hello  ', 'A long draft that wraps at word boundaries while the caret remains inside the composer']) {
    ghostty = await newGhostty();
    const screen = codexScreen(draft, 0), s = source(screen.text);
    const probe = ghostty.createTerminal(nativeColumns, 2); probe.write('› ' + draft);
    const col = probe.getCursor().x;
    try {
      const layout = layoutCodex(s.terminal, s.starts, 24, { row: screen.composer, x: col })!, point = layout.cursor(screen.composer, col)!;
      const local = ghostty.createTerminal(24, 256); local.write(layout.text);
      assert.ok(point.row >= 0 && point.x >= 0 && point.x < 24);
      const row = (local.getLine(point.row) || []).map((c, x) => c.width ? local.getGraphemeString(point.row, x) || ' ' : '').join('');
      assert.equal(local.getLine(point.row)?.[point.x]?.bg_r, 53, 'Caret stays in the shaded composer');
      if (draft === 'hello  ') assert.equal(point.x, 9, 'Typed trailing spaces remain editable');
      assert.ok(row.trim().length || draft.length > 24); local.free();
    } finally { probe.free(); s.terminal.free(); }
  }
  ghostty = await newGhostty();
  const base = codexScreen('first line', 0), multiline = base.text.replace('› first line' + ' '.repeat(140), '› first line' + ' '.repeat(140) + '\x1b[0m\n\x1b[48;2;53;54;64m  second line' + ' '.repeat(139));
  const s = source(multiline);
  try {
    const layout = layoutCodex(s.terminal, s.starts, 42, { row: base.composer + 1, x: 5 })!;
    const p = layout.cursor(base.composer + 1, 5)!;
    assert.ok(plain(layout.text).split('\r\n')[p.row].includes('second line'));
    assert.equal(p.x, 5);
  } finally { s.terminal.free(); }
});

test('Codex projection preserves ANSI styles and hyperlinks and declines unrecognized layouts', async () => {
  ghostty = await newGhostty();
  const screen = codexScreen('hello', 0), s = source('\x1b]8;;https://example.com/path\x1b\\\x1b[1;4;38;2;10;20;30mRead documentation\x1b[0m\x1b]8;;\x1b\\\n' + screen.text);
  try {
    const layout = layoutCodex(s.terminal, s.starts, 42)!, local = ghostty.createTerminal(42, 256);
    local.write(layout.text);
    assert.equal(local.getHyperlinkUri(0, 0), 'https://example.com/path');
    const first = local.getLine(0)![0]; assert.equal(first.fg_r, 10); assert.ok(first.flags & CellFlags.BOLD); assert.ok(first.flags & CellFlags.UNDERLINE);
    local.free();
  } finally { s.terminal.free(); }
  const unrelated = source('Codex\n╭────────────────╮\n│ edit a file    │\n╰────────────────╯\n');
  try { assert.equal(layoutCodex(unrelated.terminal, unrelated.starts, 42), undefined); } finally { unrelated.terminal.free(); }
});

test('Read-only Codex projection maps a caret beyond the default observer height and retains full-width backup', async () => {
  ghostty = await newGhostty();
  const screen = codexScreen('hello', 45), display = ghostty.createTerminal(42, 36, { scrollbackLimit: 5000 });
  const term = { cols: 42, rows: 36, buffer: { active: { type: 'normal' } }, getViewportY: () => 0, write: (text: string) => display.write(text) } as unknown as Terminal;
  const projection = new TerminalProjection(term, ghostty);
  try {
    projection.update(screen.text, false, 'codex');
    projection.frame({ width: 512, height: 256, full: true, bytes: Buffer.from('\x1b[H' + screen.text.replace(/\n/g, '\r\n').replace(/\r\n$/, '') + `\x1b[${screen.composer + 1};3H\x1b[?25h`).toString('base64') });
    assert.equal(projection.nativeColumns, nativeColumns);
    const caret = display.getCursor(); assert.ok(caret.visible); assert.equal(caret.x, 2);
    assert.equal(display.getGraphemeString(caret.y, caret.x), 'h');
    assert.equal(display.getLine(caret.y)![caret.x].bg_r, 53);
    term.cols = nativeColumns; display.resize(nativeColumns, 36); projection.resize();
    assert.ok(display.getCursor().visible); assert.equal(display.getCursor().x, 2);
    assert.equal(display.getGraphemeString(display.getCursor().y, 2), 'h');
  } finally { projection.dispose(); display.free(); }
});
