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
