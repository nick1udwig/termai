import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import * as pty from 'node-pty';
import { READING_SHELL } from '../server/reading-shell.ts';
import { Markers, type ReadingEvent } from '../server/markers.ts';

async function shell(cwd: string, command: string, interruptOn?: string) {
  const events: ReadingEvent[] = [];
  const parser = new Markers('reader-test', () => {}, () => {}, undefined, event => events.push(event));
  const child = pty.spawn('/bin/bash', ['--noprofile', '--norc', '-c', READING_SHELL + '\n' + command], {
    cwd, env: { ...process.env, TERMAI_NONCE: 'reader-test', TERMAI_READING_DIR: cwd }, cols: 80, rows: 24,
  });
  let output = '';
  child.onData(data => {
    output += parser.feed(data);
    if (interruptOn && output.includes(interruptOn)) { interruptOn = undefined; child.write('\x03'); }
  });
  const code = await new Promise<number>((resolve, reject) => {
    const timer = setTimeout(() => { child.kill(); reject(new Error('Reader utility timed out')); }, 10000);
    child.onExit(({ exitCode }) => { clearTimeout(timer); resolve(exitCode); });
  });
  return { output, events, code };
}

test('reader utility captures the current shell function, quoted arguments and exit status', async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'termai-reader-shell-'));
  try {
    const result = await shell(cwd, `set -euo pipefail
export READER_VALUE=works
report() { printf x >> counter; printf '%s/%s' "$READER_VALUE" "$1"; printf 'problem' >&2; return 7; }
look at report 'two words'`);
    assert.equal(result.code, 7);
    assert.equal(result.output, 'problem');
    assert.equal(await readFile(path.join(cwd, 'counter'), 'utf8'), 'x', 'The command must run exactly once');
    assert.equal(result.events.length, 1);
    const event = result.events[0]; assert.equal(event.type, 'capture');
    if (event.type === 'capture') { assert.equal(event.exitCode, 7); assert.equal(await readFile(path.join(cwd, event.file), 'utf8'), 'works/two words'); }
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

test('reader pipe preserves binary bytes and existing files win over commands', async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'termai-reader-pipe-'));
  try {
    const result = await shell(cwd, "set -u; printf '\\000\\377ABC' | look at");
    assert.equal(result.code, 0); assert.equal(result.output, '');
    const event = result.events[0]; assert.equal(event.type, 'capture');
    if (event.type === 'capture') { assert.equal(event.exitCode, 0); assert.deepEqual(await readFile(path.join(cwd, event.file)), Buffer.from([0, 255, 65, 66, 67])); }
    await writeFile(path.join(cwd, 'printf text'), 'A file');
    const file = await shell(cwd, 'look at printf text');
    assert.deepEqual(file.events, [{ type: 'file', path: cwd + '/printf text' }]);
    const command = await shell(cwd, 'look at --command printf text');
    assert.equal(command.events[0]?.type, 'capture');
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

test('reader stops oversized streams and cleans their temporary files', async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'termai-reader-limit-'));
  try {
    const result = await shell(cwd, 'head -c 20971521 /dev/zero | look at');
    assert.equal(result.code, 1); assert.match(result.output, /20 MB limit/);
    assert.deepEqual(result.events, []); assert.deepEqual(await readdir(cwd), []);
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

test('interrupting a running reader leaves no snapshot or temporary file', async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'termai-reader-interrupt-'));
  try {
    const result = await shell(cwd, `produce() { printf stream-ready >&2; while :; do printf line; sleep 1; done; }
look at produce`, 'stream-ready');
    assert.equal(result.code, 130);
    assert.deepEqual(result.events, []); assert.deepEqual(await readdir(cwd), []);
  } finally { await rm(cwd, { recursive: true, force: true }); }
});
