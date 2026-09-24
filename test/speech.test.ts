import { test } from 'node:test';
import assert from 'node:assert/strict';
import { expandSymbols, symbolAlternatives, symbolNames } from '../src/engine/speech.ts';
import { repair } from '../src/engine/repair.ts';
const catalog = { cwd: '/project', commands: ['ls', 'echo', 'cd'], paths: [], history: [] };

test('every supported symbol name maps to its symbol, case-insensitively', () => {
  for (const [word, symbol] of Object.entries(symbolNames)) {
    assert.equal(expandSymbols(word), symbol);
    assert.equal(expandSymbols(word.toUpperCase()), symbol);
  }
  assert.equal(expandSymbols('echo constructor'), 'echo constructor');
});

test('general symbol names compose paths, punctuation, flags, quotes and shell operators', () => {
  for (const [spoken, expanded] of [
    ['cd tilde forward slash projects forward slash my underscore app', 'cd ~/projects/my_app'],
    ['python3 hello hyphen world dot py', 'python3 hello-world.py'],
    ['ls double dash all', 'ls --all'],
    ['echo dollar sign HOME', 'echo $HOME'],
    ['echo single quote hello world single quote', "echo 'hello world'"],
    ['echo open double quote hello close double quote', 'echo "hello"'],
    ['echo hi pipe cat', 'echo hi | cat'],
    ['echo hi semicolon pwd', 'echo hi ; pwd'],
    ['true double ampersand pwd', 'true && pwd'],
    ['ls asterisk dot txt', 'ls *.txt'],
    ['echo open square bracket abc close square bracket', 'echo [abc]'],
    ['echo user at sign example dot com', 'echo user@example.com'],
    ['echo hi double greater than output dot txt', 'echo hi >> output.txt'],
  ]) assert.equal(expandSymbols(spoken), expanded);
  assert.equal(expandSymbols('dash --version'), 'dash --version', 'an executable named after a symbol must stay intact');
});

test('nearby symbol names produce bounded alternatives without touching quoted words or identifiers', () => {
  assert.ok(symbolAlternatives('cd tilda slach git slach termei').includes('cd ~/git/termei'));
  assert.deepEqual(symbolAlternatives('ls told a slash git'), ['ls ~/git']);
  assert.deepEqual(symbolAlternatives('cd told a forward slash git'), ['cd ~/git']);
  assert.deepEqual(symbolAlternatives('echo "told a slash git"'), []);
  assert.ok(symbolAlternatives('echo told a story').every(candidate => !candidate.includes('~')));
  assert.ok(symbolAlternatives('ls asterix dot txt').includes('ls *.txt'));
  assert.ok(symbolAlternatives('echo carrot').includes('echo ^'));
  assert.ok(symbolAlternatives('echo hi semi colon pwd').includes('echo hi ; pwd'));
  assert.ok(symbolAlternatives('echo cash').includes('echo -'));
  assert.ok(symbolAlternatives('echo cash').includes('echo #'));
  for (const input of ['slach --help', 'git status', 'echo "slach tilda dollar sign"', "echo 'slach tilda'", 'cat slach.txt', 'echo constructor']) assert.deepEqual(symbolAlternatives(input), []);
  assert.ok(symbolAlternatives('echo cash cash cash cash cash cash cash cash').length <= 3);
  assert.deepEqual(symbolAlternatives('echo ' + 'slach '.repeat(65)), []);
});
test('symbol names join paths, flags, variables, quotes, and operators without changing quoted literal words', () => {
  assert.equal(expandSymbols('cd ~ fas git fas pebble agent'), 'cd ~/git/pebble agent');
  assert.equal(expandSymbols('cd tilde slash git slash termei'), 'cd ~/git/termei');
  assert.equal(expandSymbols('CD TILDE SLASH git SLASH termei'), 'CD ~/git/termei');
  assert.equal(expandSymbols('cd tilde'), 'cd ~');
  assert.equal(expandSymbols('cd tilde fas git slash termei'), 'cd ~/git/termei');
  assert.equal(expandSymbols('echo "tilde slash"'), 'echo "tilde slash"');
  assert.equal(expandSymbols("cd 'tilde slash git slash termei'"), "cd 'tilde slash git slash termei'");
  assert.equal(expandSymbols('echo slashes tilde.txt'), 'echo slashes tilde.txt');
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
