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

test('Readline snapshots preserve UTF-8 text and cursor prefixes across split records', () => {
  const text = 'echo 界😀 tail', prefix = Buffer.from('echo 界😀').toString('base64');
  const record = `\x1b]777;termai;secret;input-line;${prefix};${Buffer.from(text).toString('base64')}\x07`;
  for (let split = 0; split <= record.length; split++) {
    const lines: unknown[] = [], parser = new Markers('secret', () => {}, () => {});
    parser.onInputLine = (text, cursor) => lines.push({ text, cursor });
    assert.equal(parser.feed(record.slice(0, split)) + parser.feed(record.slice(split)), '');
    assert.deepEqual(lines, [{ text, cursor: 'echo 界😀'.length }]);
  }
});

test('captured Readline commands survive split chunks and cannot use another shell nonce', () => {
  const line = "ssh -i '/tmp/key with spaces' user@server";
  const marker = '\x1b]777;termai;secret;ssh;' + Buffer.from(line).toString('base64') + '\x07';
  for (let split = 0; split < marker.length; split++) {
    const captured: string[] = []; const parser = new Markers('secret', () => {}, () => {}, line => captured.push(line));
    assert.equal(parser.feed(marker.slice(0, split)) + parser.feed(marker.slice(split)), ''); assert.deepEqual(captured, [line]);
  }
  const captured: string[] = []; const parser = new Markers('other', () => {}, () => {}, line => captured.push(line));
  assert.equal(parser.feed(marker), marker); assert.deepEqual(captured, []);
});

test('reading notifications survive split chunks and accept only private capture filenames', () => {
  const name = Buffer.from('git diff').toString('base64');
  const marker = '\x1b]777;termai;secret;reading-capture;read.aB123456;' + name + ';7\x07';
  for (let split = 0; split < marker.length; split++) {
    const events: unknown[] = [];
    const parser = new Markers('secret', () => {}, () => {}, undefined, event => events.push(event));
    assert.equal(parser.feed(marker.slice(0, split)) + parser.feed(marker.slice(split)), '');
    assert.deepEqual(events, [{ type: 'capture', file: 'read.aB123456', name: 'git diff', exitCode: 7 }]);
  }
  const events: unknown[] = [], parser = new Markers('secret', () => {}, () => {}, undefined, event => events.push(event));
  parser.feed(marker.replace('read.aB123456', '../private'));
  assert.deepEqual(events, []);
  parser.feed(marker.replace(';7\x07', ';999\x07'));
  assert.deepEqual(events, []);
  parser.feed('\x1b]777;termai;secret;reading-file;' + Buffer.from('/tmp/a b.md').toString('base64') + '\x07');
  assert.deepEqual(events, [{ type: 'file', path: '/tmp/a b.md' }]);
});
