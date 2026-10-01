import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Session } from '../server/session.ts';

test('output window stays bounded through duplicate, partial and invalid acknowledgements', () => {
  const session = new Session('/tmp', []) as any;
  const sent: number[] = [];
  session.socket = { readyState: 1, send: (raw: string) => sent.push(JSON.parse(raw).seq) };
  session.process = { pause() {}, resume() {} };
  for (let seq = 1; seq <= 100; seq++) session.pending.push({ seq, data: 'x'.repeat(4096), bytes: 4096 });
  session.flush(); assert.equal(sent.length, 32);
  session.receive({ type: 'ack', seq: 16 }); assert.equal(sent.length, 48);
  session.receive({ type: 'ack', seq: 16 }); assert.equal(sent.length, 48);
  session.receive({ type: 'ack', seq: 48 }); assert.equal(sent.length, 80);
  session.receive({ type: 'ack', seq: 80 }); assert.equal(sent.length, 100);
  assert.equal(session.outstandingBytes, 20 * 4096);
  session.receive({ type: 'ack', seq: 101 }); assert.equal(session.outstandingBytes, 20 * 4096);
  session.receive({ type: 'ack', seq: 100 }); assert.equal(session.outstandingBytes, 0);
  assert.deepEqual(sent, Array.from({ length: 100 }, (_, i) => i + 1));
  assert.equal(session.pending.length, 0);
  assert.equal(session.paused, false);
});

test('a new shell stream replays from the start even when its sequence numbers overlap', () => {
  const session = new Session('/tmp', []) as any, messages: any[] = [];
  session.process = { pause() {}, resume() {} };
  session.pushContext = async () => {};
  session.seq = 3;
  for (let seq = 1; seq <= 3; seq++) session.outputs.push({ seq, data: String(seq), bytes: 1 });
  const socket = { readyState: 1, send: (raw: string) => messages.push(JSON.parse(raw)), on() {}, close() {} };
  session.attach(socket, 2, () => {}, 'previous-server-stream');
  assert.equal(messages[0].reset, true);
  assert.equal(messages[0].truncated, false);
  assert.equal(messages[0].streamId, session.streamId);
  assert.deepEqual(messages.filter(m => m.type === 'output').map(m => m.seq), [1, 2, 3]);
  messages.length = 0;
  session.attach(socket, 2, () => {}, session.streamId);
  assert.equal(messages[0].reset, false);
  assert.deepEqual(messages.filter(m => m.type === 'output').map(m => m.seq), [3]);
});
