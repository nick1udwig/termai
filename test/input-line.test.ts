import { test } from 'node:test';
import assert from 'node:assert/strict';
import { InputLine } from '../src/input-line.ts';
test('known cursor edits preserve command prefixes and unicode characters', () => {
  const line = new InputLine(); line.reset('echo hi');
  line.feed('\x1b[D'); line.feed('X');
  assert.equal(line.text, 'echo hXi');
  line.feed('\x05'); line.feed('😀'); line.feed('\x7f');
  assert.equal(line.text, 'echo hXi');
  line.feed('\x01'); line.feed('\x1b[3~');
  assert.equal(line.text, 'cho hXi');
});
test('history, completion, and unknown control sequences suspend repairs', () => {
  for (const input of ['\x12', '\t', '\x1b[A', '\r', '\x1b[200~paste\x1b[201~']) {
    const line = new InputLine(); line.reset('echo test'); line.feed(input); line.feed('next');
    assert.equal(line.known, false);
    assert.equal(line.text, 'echo test');
    line.reset(); assert.equal(line.known, true);
  }
});
