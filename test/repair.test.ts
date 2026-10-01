import { test } from 'node:test';
import assert from 'node:assert/strict';
import { repair, shellQuote, discoveryTarget } from '../src/engine/repair.ts';
import { flagsFromHelp } from '../server/catalog.ts';
import type { Catalog } from '../src/protocol.ts';
const catalog: Catalog = { cwd: '/project', commands: ['python3', 'ls', 'git', 'echo', 'cat'], paths: ['hello_world.py', 'notes.txt', 'My Notes.txt'], history: [] };
const flags = [{ name: '--myarg', takesValue: true }];
test('command spelling and fused letter sounds are derived from the executable catalog', () => {
  const known = { ...catalog, commands: ['ls', 'l', 'llc', 'less', 'alias', 'cd', 'cp', 'mv', 'pwd', 'ssh', 'npm', 'qvx', 'echo'] };
  for (const [input, expected] of [
    ['Alice', 'ls'], ['Ellis', 'ls'], ['L S', 'ls'], ['L. S.', 'ls'], ['ell ess', 'ls'],
    ['C D', 'cd'], ['C. T.', 'cd'], ['see dee', 'cd'], ['ct', 'cd'], ['sea pea', 'cp'], ['movie', 'mv'],
    ['pee double you dee', 'pwd'], ['S S H', 'ssh'], ['N P M', 'npm'], ['cue vee ex', 'qvx'],
    ['Alice -l', 'ls -l'], ['Alice notes.txt', 'ls notes.txt'], ['Alice aeiou', 'ls aeiou'],
  ]) {
    assert.equal(repair(input, known)[0].command, expected, input);
    assert.equal(discoveryTarget(input, known).split(' ')[0], expected.split(' ')[0], input);
  }
  assert.equal(repair('Alice', { ...known, commands: [...known.commands, 'alice'] })[0].command, 'alice');
  assert.ok(repair('Alice', { ...known, commands: ['echo'] }).every(candidate => candidate.literal));
  for (const input of ['echo Alice', 'echo L S', 'ls -- Alice', 'Alice | cat', '"Alice"'])
    assert.equal(repair(input, known)[0].command, input);
  assert.equal(repair('echo "Alice"', known)[0].command, "echo 'Alice'");
  assert.ok(!repair('cat a', { ...known, commands: ['cat', 'kt'] }).some(candidate => candidate.command === 'kt'));
});
test('dictation resolves executable, filename, and an omitted flag without rewriting a free-form value', () => {
  const result = repair('Python three hello world dot py myarg food', catalog, flags);
  assert.equal(result[0].command, 'python3 hello_world.py --myarg food');
  assert.ok(result[0].changes.length >= 3);
});
test('spoken dashes and hep hep map only to known flags', () => {
  for (const spoken of ['dash dash myarg', 'hep hep myarg', 'dash-myarg'])
    assert.equal(repair(`python3 HelloWorld.py ${spoken} food`, catalog, flags)[0].command, 'python3 hello_world.py --myarg food');
  assert.ok(!repair('python3 hello_world.py unknown food', catalog, flags)[0].command.includes('--unknown'));
});

test('GitHub authentication dictation preserves option values and repairs both spoken dashes', () => {
  const metadata = { flags: { 'gh auth refresh': [{ name: '-h', takesValue: true }, { name: '-s', takesValue: true }] }, subcommands: { gh: ['auth'], 'gh auth': ['refresh'] } };
  const input = 'gh auth refresh dash h github.com dash s workflow';
  const result = repair(input, { ...catalog, commands: ['gh'] }, undefined, metadata);
  assert.equal(result[0].command, 'gh auth refresh -h github.com -s workflow');
  assert.equal(result.at(-1)?.command, input);
  assert.equal(result.at(-1)?.literal, true);
});
test('both real filename variants remain reviewable', () => {
  const result = repair('Python three hello world dot py', { ...catalog, paths: ['hello_world.py', 'hello-world.py'] });
  assert.ok(result.some(r => r.command === 'python3 hello_world.py'));
  assert.ok(result.some(r => r.command === 'python3 hello-world.py'));
});
test('quotes, explicit flags, free-form values, shell syntax, and case survive', () => {
  assert.equal(repair('ls -R', catalog)[0].command, 'ls -R');
  assert.equal(repair('python3 hello_world.py --myarg FOOD', catalog, flags)[0].command, 'python3 hello_world.py --myarg FOOD');
  assert.equal(repair('echo "Hello World"', catalog)[0].command, "echo 'Hello World'");
  for (const value of ['echo $HOME', 'ls | head -5', 'echo "unfinished', 'echo first\necho second', 'echo `pwd`']) assert.equal(repair(value, catalog)[0].command, value);
  assert.equal(shellQuote("a'b"), "'a'\\''b'");
});
test('filename spaces become one shell argument', () => {
  assert.equal(repair('cat my notes dot txt', catalog)[0].command, "cat 'My Notes.txt'");
});
test('stop processing options after -- and preserve quoted arguments', () => {
  assert.equal(repair('python3 hello_world.py -- myarg food', catalog, flags)[0].command, 'python3 hello_world.py -- myarg food');
  assert.equal(repair('python3 hello_world.py "myarg" food', catalog, flags)[0].command, `python3 hello_world.py 'myarg' food`);
});
test('help metadata recognizes value-taking flags', () => {
  assert.deepEqual(flagsFromHelp('  --verbose  More detail\n  -o, --output FILE  Destination'), [
    { name: '--verbose', takesValue: false }, { name: '-o', takesValue: true }, { name: '--output', takesValue: true },
  ]);
});

test('quoted tilde stays quoted and Git subcommands scope their flags', () => {
  assert.equal(repair('echo "~"', catalog)[0].command, "echo '~'");
  assert.equal(repair('Git Status short', catalog)[0].command, 'git status --short');
  assert.equal(repair('git commit message FOOD', catalog)[0].command, 'git commit --message FOOD');
  assert.equal(repair('git commit message FOOD.', catalog)[0].command, 'git commit --message FOOD.');
  assert.ok(!repair('git status oneline', catalog)[0].command.includes('--oneline'));
});

test('lowercase spoken versions resolve, and history does not replace an exact filename', () => {
  const withBoth = { ...catalog, commands: ['python', 'python3'], paths: ['hello_world.py', 'hello-world.py'], history: Array(100).fill('python3 hello-world.py') };
  assert.equal(repair('python three hello world dot py', withBoth)[0].command, 'python3 hello-world.py');
  assert.equal(repair('python3 hello_world.py', withBoth)[0].command, 'python3 hello_world.py');
});

test('spoken punctuation is not swallowed as part of the executable name', () => {
  const result = repair('ls dash all', catalog);
  assert.equal(result[0].command, 'ls --all');
  assert.ok(result.every(candidate => ['ls --all', 'ls dash all'].includes(candidate.command)));
});

test('file matches do not rewrite unrestricted text arguments', () => {
  const withFile = { ...catalog, paths: ['foo', 'HelloWorld.py'] };
  assert.equal(repair('echo food', withFile)[0].command, 'echo food');
  assert.equal(repair('echo hello world dot py', withFile)[0].command, 'echo hello world dot py');
});

test('dictated command/flag boundaries and casing are grounded in known commands and flags', () => {
  const metadata = { flags: { ls: [{ name: '-l', takesValue: false }, { name: '-L', takesValue: false }, { name: '--all', takesValue: false }] }, subcommands: {} };
  for (const input of ['LS-L', 'LS - L', 'LS–L', 'LS−L', 'ls-L', 'lS-L']) {
    const candidates = repair(input, catalog, undefined, metadata);
    assert.deepEqual(candidates.filter(c => !c.literal).map(c => c.command), ['ls -l', 'ls -L']);
    assert.equal(candidates.at(-1)?.command, input);
    assert.equal(candidates.at(-1)?.literal, true);
  }
  assert.equal(repair('ls-l', catalog, undefined, metadata)[0].command, 'ls -l');
  assert.equal(repair('ls -L', catalog, undefined, metadata)[0].command, 'ls -L');
  assert.ok(repair('ls -L', catalog, undefined, metadata).some(candidate => candidate.command === 'ls -l' && !candidate.literal));
  assert.equal(repair('LS--ALL', catalog, undefined, metadata)[0].command, 'ls --all');
});

test('command case matching cannot introduce a leading underscore, even with history', () => {
  const withCompletion = { ...catalog, commands: ['_cd', 'cd', '_ls', 'ls'], history: Array(50).fill('_cd ~/git/pebble agent') };
  assert.equal(repair('Cd ~/git/pebble agent', withCompletion)[0].command, 'cd ~/git/pebble agent');
  assert.ok(repair('Cd ~/git/pebble agent', withCompletion).every(candidate => !candidate.command.startsWith('_cd')));
  assert.equal(repair('_cd', withCompletion)[0].command, '_cd');
});

test('existing hyphenated executables are not split and nonexistent names are not invented', () => {
  const known = { ...catalog, commands: ['ls', 'ls-l', 'fixture-tool'] };
  assert.equal(repair('ls-l', known)[0].command, 'ls-l');
  assert.equal(repair('FIXTURE-TOOL', known)[0].command, 'fixture-tool');
  assert.equal(discoveryTarget('FIXTURE-TOOL--UNKNOWN', known), 'fixture-tool --UNKNOWN');
  assert.equal(discoveryTarget('MADEUP-L', known), '');
  assert.ok(repair('MADEUP-L', known).every(candidate => candidate.literal));
});

test('missing dashes and spaces are recovered from real command/flag boundaries', () => {
  const metadata = { flags: { ls: ['-l', '-L', '-a', '--all'].map(name => ({ name, takesValue: false })) }, subcommands: {} };
  for (const input of ['LSL', 'lsl']) {
    const candidates = repair(input, catalog, undefined, metadata);
    assert.equal(candidates[0].command, 'ls -l');
    assert.ok(candidates.some(candidate => candidate.command === 'ls -L'));
    assert.equal(candidates.at(-1)?.command, input);
  }
  assert.equal(repair('LSLA notes.txt', catalog, undefined, metadata)[0].command, 'ls -la notes.txt');
  assert.equal(repair('LSALL', catalog, undefined, metadata)[0].command, 'ls --all');
  assert.ok(repair('LSZ', catalog, undefined, metadata).every(candidate => candidate.literal));
  assert.equal(repair('LSL', { ...catalog, commands: [...catalog.commands, 'lsl'] }, undefined, metadata)[0].command, 'lsl');
  assert.equal(repair('echo LSL', catalog)[0].command, 'echo LSL');
  const unknown = { ...catalog, commands: ['fixture'] };
  assert.equal(discoveryTarget('FIXTUREV', unknown), 'fixture');
  assert.ok(repair('FIXTUREV', unknown).every(candidate => !candidate.command.includes('-v')));
  assert.equal(repair('FIXTUREV', unknown, undefined, { flags: { fixture: [{ name: '-v', takesValue: false }] }, subcommands: {} })[0].command, 'fixture -v');
  assert.deepEqual(repair('', catalog), []);
});

test('unverified options stay literal; known bundles and attached values remain intact', () => {
  assert.ok(repair('ls --not-a-real-option', catalog).every(candidate => candidate.literal));
  assert.equal(repair('ls -al', catalog)[0].command, 'ls -al');
  const withTool = { ...catalog, commands: ['tool'] };
  const metadata = { flags: { tool: [{ name: '--output', takesValue: true }, { name: '-o', takesValue: true }] }, subcommands: {} };
  assert.equal(repair('TOOL --OUTPUT=MyFile.TXT', withTool, undefined, metadata)[0].command, 'tool --output=MyFile.TXT');
  assert.equal(repair('TOOL -oMyFile.TXT', withTool, undefined, metadata)[0].command, 'tool -oMyFile.TXT');
  assert.ok(repair('tool --output', withTool, undefined, metadata).every(candidate => candidate.literal));
});
