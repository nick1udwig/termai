import { test } from 'node:test';
import assert from 'node:assert/strict';
import { expandSymbols, symbolNames } from '../server/speech.ts';
import { repair } from '../server/repair.ts';
const catalog = { cwd: '/project', commands: ['ls', 'echo', 'cd'], paths: [], history: [] };

test('every supplied Urbit pronunciation maps to its symbol, case-insensitively', () => {
  for (const [word, symbol] of Object.entries(symbolNames)) {
    assert.equal(expandSymbols(word), symbol);
    assert.equal(expandSymbols(word.toUpperCase()), symbol);
  }
  assert.equal(expandSymbols('echo constructor'), 'echo constructor');
});
test('symbol names join paths, flags, variables, quotes, and operators without changing quoted literal words', () => {
  assert.equal(expandSymbols('cd ~ fas git fas pebble agent'), 'cd ~/git/pebble agent');
  assert.equal(repair('ls hep l', catalog)[0].command, 'ls -l');
  assert.equal(repair('ls hep hep all', catalog)[0].command, 'ls --all');
  assert.equal(repair('ls shed all', catalog)[0].command, 'ls --all');
  assert.equal(repair('echo buc HOME', catalog)[0].command, 'echo $HOME');
  assert.equal(repair('echo doq buc HOME doq', catalog)[0].command, 'echo "$HOME"');
  assert.equal(expandSymbols('echo soq hello world soq'), "echo 'hello world'");
  assert.equal(expandSymbols('echo one mic echo two'), 'echo one ; echo two');
  assert.equal(expandSymbols('echo foo pat example.com'), 'echo foo@example.com');
  assert.equal(expandSymbols('echo "hep fas buc"'), 'echo "hep fas buc"');
  assert.equal(expandSymbols('echo shedding'), 'echo shedding');
  assert.equal(expandSymbols('echo fas'), 'echo /');
  assert.equal(repair('ls wut', catalog)[0].command, 'ls ?');
  assert.equal(repair('echo doq hello world doq', catalog)[0].command, 'echo "hello world"');
  assert.equal(repair('echo one mic echo two', catalog).at(-1)?.command, 'echo one mic echo two');
});
