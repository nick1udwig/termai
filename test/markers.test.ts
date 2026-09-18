import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Markers } from '../server/markers.ts';
test('markers survive every possible PTY chunk boundary without leaking into output', () => {
  const record = `before\x1b]777;termai;secret;prompt;7;${Buffer.from('/a folder').toString('base64')};${Buffer.from('  3  echo hi').toString('base64')}\x07after`;
  for (let split = 0; split <= record.length; split++) {
    const prompts: unknown[] = [];
    const parser = new Markers('secret', e => prompts.push(e), () => {});
    const visible = parser.feed(record.slice(0, split)) + parser.feed(record.slice(split));
    assert.equal(visible, 'beforeafter');
    assert.deepEqual(prompts, [{ cwd: '/a folder', code: 7, history: '  3  echo hi' }]);
  }
});
test('unrelated OSCs pass through; busy records change state', () => {
  let busy = 0;
  const parser = new Markers('secret', () => {}, () => busy++);
  assert.equal(parser.feed('\x1b]0;title\x07'), '\x1b]0;title\x07');
  assert.equal(parser.feed('\x1b]777;termai;secret;busy\x07'), '');
  assert.equal(busy, 1);
});
