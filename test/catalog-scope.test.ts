import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Session } from '../server/session.ts';

test('directory context skips general path collection without poisoning the full catalog cache', async () => {
  const session = new Session('/tmp', ['cd']);
  const internals = session as any;
  internals.historyReadAt = Date.now();
  internals.shellContext = { get: async () => ({ commands: ['cd'], functions: [], environment: {} }) };
  let reads = 0;
  internals.paths = async () => { reads++; return ['known-file']; };
  assert.deepEqual((await session.catalog(false)).paths, []);
  assert.equal(reads, 0);
  assert.deepEqual((await session.catalog()).paths, ['known-file']);
  assert.equal(reads, 1);
  await session.catalog();
  assert.equal(reads, 1);
  assert.deepEqual((await session.catalog(false)).paths, []);
  assert.equal(reads, 1);
});
