import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ProbePool, SharedTask, probe } from '../server/probes.ts';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => resolve = done);
  return { promise, resolve };
}
test('probe pool bounds concurrency and removes abandoned queued work', async () => {
  const pool = new ProbePool(1), first = deferred<void>(), signal = new AbortController().signal;
  const running = pool.run(signal, () => first.promise);
  const cancelled = new AbortController();
  let started = false;
  const queued = pool.run(cancelled.signal, async () => { started = true; });
  cancelled.abort();
  await assert.rejects(queued, { name: 'AbortError' });
  first.resolve(); await running;
  assert.equal(started, false);
  assert.equal(pool.busy, false);
  assert.equal(await pool.run(signal, async () => 42), 42);
});
test('shared tasks survive one cancellation and stop when their final subscriber leaves', async () => {
  const work = deferred<number>();
  const task = new SharedTask(async () => work.promise);
  const first = new AbortController(), second = new AbortController();
  const a = task.wait(first.signal), b = task.wait(second.signal);
  first.abort(); await assert.rejects(a, { name: 'AbortError' });
  assert.equal(task.aborted, false);
  work.resolve(7); assert.equal(await b, 7);
  const orphan = new SharedTask(async signal => new Promise<void>((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true })));
  const pending = orphan.wait(second.signal);
  await Promise.resolve(); second.abort();
  await assert.rejects(pending, { name: 'AbortError' });
  assert.equal(orphan.aborted, true);
});
test('active subprocesses honor request cancellation', async () => {
  const controller = new AbortController();
  const running = probe(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { timeout: 10000 }, controller.signal);
  controller.abort();
  await assert.rejects(running, { name: 'AbortError' });
});
