import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Queue } from '../src/queue.ts';

test('FIFO preserves order across compaction, refill and reset', () => {
  const queue = new Queue<number>();
  for (let round = 0; round < 10; round++) {
    for (let i = 0; i < 3000; i++) queue.push(round * 3000 + i);
    for (let i = 0; i < 2000; i++) assert.equal(queue.shift(), round * 2000 + i);
  }
  assert.equal(queue.length, 10000);
  assert.equal(queue.peek(), 20000);
  assert.deepEqual([...queue], Array.from({ length: 10000 }, (_, i) => 20000 + i));
  queue.clear(); assert.equal(queue.shift(), undefined);
  queue.push(42); assert.equal(queue.shift(), 42); assert.equal(queue.length, 0);
  queue.push(43); assert.equal(queue.peek(), 43);
});
