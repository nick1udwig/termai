import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { pipelineParts } from '../src/engine/pipeline.ts';
import { Discovery } from '../server/discovery.ts';
import { suggest } from '../server/suggestions.ts';
import type { MetadataDiscovery } from '../src/engine/host.ts';
test('pipeline splitting respects quotes, escapes and shell control syntax', () => {
  assert.deepEqual(pipelineParts('ls pipe through grep hello'), ['ls', 'grep hello']);
  assert.deepEqual(pipelineParts('ls piped through look at'), ['ls', 'look at']);
  assert.deepEqual(pipelineParts('echo "a | b" | grep b'), ['echo "a | b"', 'grep b']);
  assert.deepEqual(pipelineParts('echo a\\|b | cat'), ['echo a\\|b', 'cat']);
  assert.deepEqual(pipelineParts('echo $(echo a | cat) | cat'), ['echo $(echo a | cat)', 'cat']);
  for (const input of ['echo "pipe through"', 'ls || pwd', 'ls |& cat', 'ls && pwd | cat', 'ls |', '| cat', 'ls ; pwd | cat', 'echo "a | cat', 'echo x # | cat', 'a | b | c | d | e | f | g']) assert.equal(pipelineParts(input), undefined, input);
});
test('each pipeline stage gets executable, flag, filesystem and dictation alternatives', async () => {
  const cwd = await mkdtemp('/tmp/termai-pipeline-');
  const metadata = { flags: {}, subcommands: {}, requiredPositionals: {} };
  const discovery: MetadataDiscovery = { cached: () => metadata, discover: async () => ({ metadata }) };
  const catalog = { cwd, commands: ['ls', 'grep', 'sort', 'cat', 'wc', 'echo', 'download'], paths: [], history: [] };
  try {
    await writeFile(cwd + '/hello_world.py', 'hello');
    for (const [input, expected] of [
      ['ls pipe grep hello', 'ls | grep hello'], ['ls pipe through grep hello', 'ls | grep hello'], ['ls piped through grep hello', 'ls | grep hello'],
      ['Ls Pipe Grepp Law', 'ls | grep Law'], ['Ls | Grepp Law', 'ls | grep Law'],
      ['ls pipe through grep dash i hello pipe sort', 'ls | grep -i hello | sort'],
      ['echo hi pipe cat hello world dot py', 'echo hi | cat hello_world.py'],
      ['cat hello world dot py pipe through Grepp hello pipe through download result.txt', 'cat hello_world.py | grep hello | download result.txt'],
      ['echo "pipe through" | Grepp hi', 'echo "pipe through" | grep hi'],
    ]) {
      const result = await suggest(input, catalog, { HOME: cwd }, discovery);
      assert.ok(result.some(candidate => !candidate.literal && candidate.command === expected), JSON.stringify({ input, expected, result }));
      assert.equal(result.at(-1)?.command, input); assert.equal(result.at(-1)?.literal, true);
      assert.ok(result.length <= 4);
    }
    const missing = await suggest('echo hi pipe cat missing.py', catalog, { HOME: cwd }, discovery);
    assert.equal(missing.some(c => !c.literal && c.command.includes('missing.py')), false);
  } finally { await rm(cwd, { recursive: true, force: true }); }
});


test('real grep metadata keeps the spelling correction ahead of an invented -P flag', async () => {
  const discovery = new Discovery();
  const catalog = { cwd: '/tmp', commands: ['ls', 'grep'], paths: [], history: [] };
  try {
    const result = await suggest('Ls pipe through Grepp hello_world', catalog, process.env, discovery);
    assert.equal(result[0].command, 'ls | grep hello_world');
    assert.equal(result.at(-1)?.command, 'Ls pipe through Grepp hello_world');
  } finally { discovery.dispose(); }
});
