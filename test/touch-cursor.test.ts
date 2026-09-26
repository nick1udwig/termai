import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cursorSteps } from '../src/touch-cursor.ts';

const cells = (text: string) => (position: number) => position < 0 ? undefined : ({ getChars: () => text[position] || '', getWidth: () => 1 });
test('tap moves within a line, clamps prompt/end, and ignores other output rows', () => {
  const cell = cells('$ echo hello');
  assert.equal(cursorSteps('echo hello', 10, 12, 7, 80, cell), -5);
  assert.equal(cursorSteps('echo hello', 5, 7, 11, 80, cell), 4);
  assert.equal(cursorSteps('echo hello', 10, 12, 0, 80, cell), -10);
  assert.equal(cursorSteps('echo hello', 5, 7, 50, 80, cell), 5);
  assert.equal(cursorSteps('echo hello', 5, 7, 90, 80, cell), undefined);
  assert.equal(cursorSteps('stale', 5, 12, 7, 80, cell), undefined);
});
test('wrapped lines and wide characters use displayed cells, not byte offsets', () => {
  assert.equal(cursorSteps('echo hello', 10, 12, 3, 8, cells('$ echo hello')), -9);
  const chars = ['$', ' ', 'a', '界', '', 'b'];
  const cell = (p: number) => ({ getChars: () => chars[p], getWidth: () => p === 3 ? 2 : p === 4 ? 0 : 1 });
  assert.equal(cursorSteps('a界b', 3, 6, 4, 80, cell), -2);
  assert.equal(cursorSteps('a界b', 1, 3, 5, 80, cell), 1);
});
