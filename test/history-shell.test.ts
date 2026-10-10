import { localBash } from '../server/shell.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { HISTORY_SHELL } from '../server/history-shell.ts';
import { Session } from '../server/session.ts';

test('history suppression recognizes utilities and pipelines while preserving quoted text and comments', async () => {
  const cases: [string, boolean][] = [
    ['upload', true], ['download "file with spaces.txt"', true], ['look at notes.md', true], ['__termai_read notes.md', true],
    ["printf 'data' | download result.txt", true], ['git diff | look at', true], ['upload; cd docs', true], ['pwd && look at notes.md', true],
    ['\tupload', true], [' upload', true], ['echo upload', false], ["echo 'upload | download | look at file'", false],
    ['echo "data | download"', false], ['echo data # | download', false], ['# upload', false],
    ['echo data \\| download', false], ["printf '%s' $(echo 'data | download')", false], ['look words file', false], ['read value', false],
  ];
  const script = HISTORY_SHELL + '\nfor line in "$@"; do if __termai_history_special "$line"; then printf "yes\\n"; else printf "no\\n"; fi; done';
  const result = await promisify(execFile)(localBash(), ['--noprofile', '--norc', '-c', script, 'history-test', ...cases.map(([line]) => line)], { env: { PATH: '/usr/bin:/bin', BASH_ENV: '/dev/null' } });
  assert.deepEqual(result.stdout.trim().split('\n'), cases.map(([, special]) => special ? 'yes' : 'no'));
});

test('typed and generated utilities execute with a space prefix and stay out of Bash and suggestion history', async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'termai-history-'));
  await writeFile(path.join(cwd, 'payload.txt'), 'payload'); await writeFile(path.join(cwd, 'initial-history'), '');
  const saved = { noRC: process.env.TERMAI_NO_RC, history: process.env.TERMAI_HISTORY_FILE };
  process.env.TERMAI_NO_RC = '1'; process.env.TERMAI_HISTORY_FILE = path.join(cwd, 'initial-history');
  const session = new Session(cwd, [], 'client') as any, messages: any[] = [];
  session.send = (message: any) => messages.push(message);
  const until = async (check: () => boolean) => {
    for (let i = 0; i < 250; i++) { if (check()) return; await new Promise(resolve => setTimeout(resolve, 20)); }
    throw new Error('Shell did not return to its prompt');
  };
  const execute = async (command: string, generated = false) => {
    const prompt = session.state.prompt;
    if (generated) session.receive({ type: 'command', id: command, command, prompt });
    else session.receive({ type: 'input', data: command + '\r' });
    await until(() => session.state.ready && session.state.prompt > prompt);
    assert.equal(session.state.exitCode, 0, command);
  };
  try {
    await session.start(); await until(() => session.state.ready);
    await execute('echo keep-before');
    for (const command of ['upload', 'download payload.txt', 'look at payload.txt', "printf 'piped data' | download result.txt", "printf 'read output' | look at"])
      await execute(command);
    await execute('download payload.txt', true); await execute('look at payload.txt', true);
    await execute("echo 'upload | download | look at payload.txt'"); await execute('echo keep-after');
    await execute(' builtin history > bash-history');
    const expected = ['echo keep-before', "echo 'upload | download | look at payload.txt'", 'echo keep-after'];
    assert.deepEqual(session.history, expected);
    const history = (await readFile(path.join(cwd, 'bash-history'), 'utf8')).trim().split('\n').map(line => line.replace(/^\s*\d+\s+/, ''));
    assert.deepEqual(history, expected);
    assert.ok(messages.some(message => message.type === 'transfer'), 'Transfer commands must still run');
    assert.ok(messages.some(message => message.type === 'reading-file'), 'Reading commands must still run');
  } finally {
    await session.dispose();
    if (saved.noRC === undefined) delete process.env.TERMAI_NO_RC; else process.env.TERMAI_NO_RC = saved.noRC;
    if (saved.history === undefined) delete process.env.TERMAI_HISTORY_FILE; else process.env.TERMAI_HISTORY_FILE = saved.history;
    await rm(cwd, { recursive: true, force: true });
  }
});
