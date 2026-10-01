import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TerminalGestures } from '../src/terminal-gestures.ts';

function selection(lines: { chars: string[]; widths?: number[]; wrapped?: boolean }[], start: { row: number; col: number }, end: { row: number; col: number }) {
  return Object.assign(Object.create(TerminalGestures.prototype), {
    start, end, term: { cols: 8, getSelection: () => '', buffer: { active: { getLine: (row: number) => lines[row] && ({
      isWrapped: lines[row].wrapped, getCell: (col: number) => ({ getChars: () => lines[row].chars[col] || '', getWidth: () => lines[row].widths?.[col] ?? 1 }),
    }) } } },
  }).text;
}

test('copy preserves spaces at wrapped boundaries and newlines between output lines', () => {
  const lines = [{ chars: [...'one two '] }, { chars: [...'three'], wrapped: true }, { chars: [...'next'] }];
  assert.equal(selection(lines, { row: 0, col: 0 }, { row: 2, col: 3 }), 'one two three\nnext');
  assert.equal(selection(lines, { row: 2, col: 3 }, { row: 0, col: 0 }), 'one two three\nnext');
});

test('copy includes wide Unicode characters once and honors exact selected columns', () => {
  const lines = [{ chars: ['a', '界', '', '😀', '', 'b'], widths: [1, 2, 0, 2, 0, 1] }];
  assert.equal(selection(lines, { row: 0, col: 1 }, { row: 0, col: 4 }), '界😀');
});
