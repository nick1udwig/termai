import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { HERDR_SHELL, parseHerdrCommand } from '../server/herdr-capture.ts';
import { Markers } from '../server/markers.ts';

test('Herdr discovery diverts plain launches while preserving other shell commands', async () => {
  const directory = await mkdtemp('/tmp/termai-herdr-capture-');
  try {
    await writeFile(directory + '/herdr', '#!/bin/sh\necho EXECUTED\n', { mode: 0o700 });
    for (const [command, expected] of [['herdr', true], ['  herdr  ', true], ['herdr --session project', true], ['herdr session attach work', true], [directory + '/herdr', true], ['herdr --help', false], ['herdr api snapshot', false], ['herdr; echo second', false], ['herdr | cat', false], ['herdr --session ../other', false], ['herdr --session "work"', false], ['herdr $ARGS', false]] as const) {
      const script = HERDR_SHELL + '\nREADLINE_LINE="$1" READLINE_POINT=5 TERMAI_NONCE=test\nif __termai_capture_herdr; then printf CAPTURED; else printf NATIVE; fi';
      const result = await promisify(execFile)('/bin/bash', ['--noprofile', '--norc', '-c', script, 'test', command], { env: { PATH: directory + ':/usr/bin:/bin' } });
      assert.equal(result.stdout.endsWith('CAPTURED'), expected, command); assert.ok(!result.stdout.includes('EXECUTED'));
      if (expected) {
        const captures: string[] = [], markers = new Markers('test', () => {}, () => {}); markers.onHerdr = value => captures.push(value);
        for (const character of result.stdout) markers.feed(character);
        assert.deepEqual(captures, [command]);
      }
    }
    for (const definition of ['herdr() { printf CUSTOM; }', "alias herdr='echo custom'"]) {
      const result = await promisify(execFile)('/bin/bash', ['--noprofile', '--norc', '-c', 'shopt -s expand_aliases\n' + definition + '\n' + HERDR_SHELL + '\nREADLINE_LINE=herdr; __termai_capture_herdr || printf NATIVE'], { env: { PATH: directory + ':/usr/bin:/bin' } });
      assert.equal(result.stdout, 'NATIVE');
    }
    assert.deepEqual(parseHerdrCommand('herdr', { HERDR_SESSION: 'work' }), { binary: 'herdr', session: 'work' });
    assert.equal(parseHerdrCommand('herdr --session default', { HERDR_SESSION: 'work' }).session, '');
    assert.throws(() => parseHerdrCommand('herdr --session ../other', {}));
  } finally { await rm(directory, { recursive: true, force: true }); }
});
