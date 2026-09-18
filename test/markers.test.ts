import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Markers } from '../server/markers.ts';

test('combined prompt payload accepts wrapped base64 and embedded newlines', () => {
  const events: unknown[] = [];
  const parser = new Markers('nonce', event => events.push(event), () => {});
  const payload = Buffer.from('/tmp/a\nb\0  12 echo hello').toString('base64').replace(/.{8}/g, '$&\n');
  const record = `\x1b]777;termai;nonce;prompt;0;${payload}\x07`;
  for (const char of record) assert.equal(parser.feed(char), '');
  assert.deepEqual(events, [{ cwd: '/tmp/a\nb', code: 0, history: '  12 echo hello' }]);
});
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
