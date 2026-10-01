import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Session } from '../server/session.ts';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

test('Ctrl-D edits keep the prompt eligible for dictation and snapshot requests are guarded', () => {
  const session = new Session('/tmp', []) as any, writes: string[] = [], messages: any[] = [];
  session.process = { write: (text: string) => writes.push(text) };
  session.send = (message: any) => messages.push(message);
  Object.assign(session.state, { ready: true, prompt: 1, inputTarget: 'shell' });
  session.receive({ type: 'input', data: '\x04' });
  assert.equal(session.state.ready, true); assert.equal(session.state.inputTarget, 'shell');
  session.receive({ type: 'input-line', id: 'stale', prompt: 1, revision: 0 });
  assert.equal(messages.at(-1).text, undefined); assert.deepEqual(writes, ['\x04']);
  session.receive({ type: 'input-line', id: 'current', prompt: 1, revision: 1 });
  assert.deepEqual(writes, ['\x04', '\x18\x12']);
  assert.equal(session.state.inputRevision, 1, 'Reading a line must not change its revision');
});

test('real Readline snapshots recover history and completion without executing or changing input', async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'termai-input-'));
  const noRC = process.env.TERMAI_NO_RC; process.env.TERMAI_NO_RC = '1';
  const session = new Session(cwd, [], 'client') as any, messages: any[] = [];
  session.send = (message: any) => messages.push(structuredClone(message));
  const until = async (check: () => boolean) => {
    for (let i = 0; i < 250; i++) { if (check()) return; await new Promise(resolve => setTimeout(resolve, 20)); }
    throw new Error('Readline did not respond');
  };
  try {
    await session.start(); await until(() => session.state.ready);
    session.receive({ type: 'input', data: 'echo 界😀\r' });
    await until(() => session.state.ready && session.state.prompt === 2);
    session.receive({ type: 'input', data: '\x1b[A' });
    const snapshot = async (id: string) => {
      session.receive({ type: 'input-line', id, prompt: session.state.prompt, revision: session.state.inputRevision });
      await until(() => messages.some(message => message.type === 'input-line' && message.id === id));
      return messages.find(message => message.type === 'input-line' && message.id === id);
    };
    const history = await snapshot('history');
    assert.equal(history.text, 'echo 界😀'); assert.equal(history.cursor, 'echo 界😀'.length);
    session.receive({ type: 'input', data: '\x01\x04' });
    assert.equal(session.state.ready, true);
    const edited = await snapshot('edited'); assert.equal(edited.text, 'cho 界😀'); assert.equal(edited.cursor, 0);
    session.receive({ type: 'input', data: '\x15\x05\x15echo comp\t' });
    const completed = await snapshot('completion'); assert.equal(completed.text, 'echo comp');
    assert.equal(session.state.prompt, 2, 'Snapshots must not execute the editable line');
  } finally {
    session.dispose();
    if (noRC === undefined) delete process.env.TERMAI_NO_RC; else process.env.TERMAI_NO_RC = noRC;
    await rm(cwd, { recursive: true, force: true });
  }
});
