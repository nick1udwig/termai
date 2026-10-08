import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createReadStream } from 'node:fs';
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { HISTORY_BYTES, HISTORY_ENTRIES, readHistory, readlineHistorySource } from '../server/history.ts';
import { Session } from '../server/session.ts';
import { SSHHost } from '../server/ssh.ts';

test('Readline prefers eternal history, falls back to standard history, and honors explicit overrides', async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'termai-history-source-'));
  const standard = path.join(home, '.bash_history'), eternal = path.join(home, '.bash_eternal_history');
  try {
    await writeFile(standard, 'echo standard\n');
    assert.equal(await readlineHistorySource({ HOME: home }), standard);
    await mkdir(eternal);
    assert.equal(await readlineHistorySource({ HOME: home }), standard, 'Directories are not history files');
    await rm(eternal, { recursive: true });
    await writeFile(eternal, 'echo eternal\n');
    assert.equal(await readlineHistorySource({ HOME: home }), eternal);
    assert.equal(await readlineHistorySource({ HOME: home, TERMAI_ETERNAL_HISTORY_FILE: '/custom/eternal' }), '/custom/eternal');
    assert.equal(await readlineHistorySource({ HOME: home, TERMAI_HISTORY_FILE: '/custom/history', TERMAI_ETERNAL_HISTORY_FILE: '/custom/eternal' }), '/custom/history');
  } finally { await rm(home, { recursive: true, force: true }); }
});

test('real Ctrl-R searches eternal history beyond 1000 entries and keeps the latest 5000', async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'termai-history-readline-'));
  const keys = ['HOME', 'INPUTRC', 'HISTSIZE', 'TERMAI_NO_RC', 'TERMAI_HISTORY_FILE', 'TERMAI_ETERNAL_HISTORY_FILE'];
  const saved = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  const lines = Array.from({ length: HISTORY_ENTRIES + 500 }, (_, i) => `echo eternal-${i}`);
  lines[600] = 'echo termai-eternal-needle';
  await writeFile(path.join(home, '.bash_history'), 'echo standard-only\n');
  await writeFile(path.join(home, '.bash_eternal_history'), '#123456789\n' + lines.join('\n') + '\n');
  process.env.HOME = home; process.env.INPUTRC = '/dev/null'; process.env.HISTSIZE = '20'; process.env.TERMAI_NO_RC = '1';
  delete process.env.TERMAI_HISTORY_FILE; delete process.env.TERMAI_ETERNAL_HISTORY_FILE;
  const session = new Session(home, [], 'client') as any, messages: any[] = [];
  session.send = (message: any) => messages.push(message);
  const until = async (check: () => boolean) => {
    for (let i = 0; i < 250; i++) { if (check()) return; await new Promise(resolve => setTimeout(resolve, 20)); }
    throw new Error('Readline did not respond');
  };
  try {
    await session.start(); await until(() => session.state.ready);
    session.receive({ type: 'input', data: '\x12termai-eternal-needle\x05' });
    session.receive({ type: 'input-line', id: 'search', prompt: session.state.prompt, revision: session.state.inputRevision });
    await until(() => messages.some(message => message.type === 'input-line' && message.id === 'search'));
    assert.equal(messages.find(message => message.type === 'input-line' && message.id === 'search').text, lines[600]);
    assert.equal(session.state.prompt, 1, 'Searching must not execute the command');
    session.receive({ type: 'input', data: '\x15 builtin history > bash-history\r' });
    await until(() => session.state.ready && session.state.prompt === 2);
    const history = (await readFile(path.join(home, 'bash-history'), 'utf8')).trim().split('\n').map(line => line.replace(/^\s*\d+\s+/, ''));
    assert.deepEqual(history, lines.slice(-HISTORY_ENTRIES));
  } finally {
    await session.dispose();
    for (const key of keys) { if (saved[key] === undefined) delete process.env[key]; else process.env[key] = saved[key]; }
    await rm(home, { recursive: true, force: true });
  }
});

test('SSH history prefers eternal history and reads large files using the same bounded tail as local history', async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'termai-history-ssh-'));
  const standard = path.join(home, '.bash_history'), eternal = path.join(home, '.bash_eternal_history');
  const remote = new SSHHost() as any;
  remote.home = home;
  remote.sftp = {
    stat: (file: string, callback: (error: unknown, info?: unknown) => void) => stat(file).then(info => callback(null, info), error => callback(error)),
    createReadStream: (file: string, range: { start: number; end: number }) => createReadStream(file, { ...range, highWaterMark: range.end - range.start > 1024 ? 65536 : 7 }),
  };
  try {
    await writeFile(standard, 'echo standard-only\n');
    await writeFile(eternal, 'x'.repeat(HISTORY_BYTES + 100) + '\n#123456789\necho eternal 界😀\n private command\n');
    await remote.loadHistory();
    assert.deepEqual(remote.history(), ['echo eternal 界😀']);
    assert.deepEqual(remote.history(), await readHistory(eternal));
    await writeFile(eternal, 'echo eternal 界😀\n');
    await remote.loadHistory();
    assert.deepEqual(remote.history(), ['echo eternal 界😀'], 'UTF-8 commands survive split stream chunks');
    await rm(eternal);
    await remote.loadHistory();
    assert.deepEqual(remote.history(), ['echo standard-only']);
    await rm(standard);
    await remote.loadHistory();
    assert.deepEqual(remote.history(), []);
  } finally { await remote.dispose(); await rm(home, { recursive: true, force: true }); }
});
