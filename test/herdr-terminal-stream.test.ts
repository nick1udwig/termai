import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { HerdrTerminalStream, type TerminalSize, type TerminalStream } from '../server/herdr-terminal-stream.ts';

const wait = async (check: () => boolean) => { for (let i = 0; i < 200; i++) { if (check()) return; await new Promise(resolve => setTimeout(resolve, 5)); } assert.fail('Terminal stream did not settle'); };
test('mobile viewers share a scoped controller, update geometry, and release it back to observers', async () => {
  const opened: (TerminalStream & { output: PassThrough; size?: TerminalSize; closed: boolean; commands: any[] })[] = [];
  let removed = 0;
  const resource = new HerdrTerminalStream(async size => {
    const output = new PassThrough(), input = size ? new PassThrough() : undefined;
    const stream = { output, input, size, closed: false, commands: [] as any[], async close() { stream.closed = true; output.destroy(); input?.destroy(); } };
    input?.on('data', data => stream.commands.push(JSON.parse(String(data)))); opened.push(stream); return stream;
  }, () => removed++);
  const frames: any[][] = [[], [], []];
  const desktop = resource.subscribe(message => frames[0].push(message)); await wait(() => opened.length === 1);
  const first = resource.subscribe(message => frames[1].push(message)); first.resize({ cols: 42, rows: 31 });
  await wait(() => opened.length === 2);
  assert.equal(opened[0].closed, true); assert.deepEqual(opened[1].size, { cols: 42, rows: 31 });
  opened[1].output.write(JSON.stringify({ type: 'terminal.frame', encoding: 'ansi', width: 42, height: 31, full: true, bytes: 'YWJj' }) + '\n');
  await wait(() => frames.every((inbox, i) => i === 2 || inbox.at(-1)?.width === 42));
  const second = resource.subscribe(message => frames[2].push(message)); assert.equal(frames[2].at(-1).width, 42, 'New viewers receive a complete native frame');
  second.resize({ cols: 58, rows: 22 }); await wait(() => opened[1].commands.length === 1);
  assert.deepEqual(opened[1].commands[0], { type: 'terminal.resize', cols: 58, rows: 22 });
  first.resize({ cols: 39, rows: 19 }); await wait(() => opened[1].commands.length === 2);
  first.resize(); await wait(() => opened[1].commands.length === 3);
  assert.equal(opened[1].commands.at(-1).cols, 58, 'A hidden viewer releases geometry to the remaining mobile');
  second.dispose(); await wait(() => opened.length === 3);
  assert.equal(opened[1].closed, true); assert.equal(opened[2].size, undefined, 'The final mobile releases control while desktops keep observing');
  first.dispose(); desktop.dispose(); await wait(() => removed === 1);
  assert.ok(opened.every(stream => stream.closed));
});

test('a controller opened during a rapid disconnect is closed before a replacement starts', async () => {
  let complete!: (stream: TerminalStream) => void;
  let opened = 0, closed = 0, removed = 0;
  const resource = new HerdrTerminalStream(() => { opened++; return new Promise(resolve => complete = resolve); }, () => removed++);
  const view = resource.subscribe(() => {}); view.resize({ cols: 40, rows: 20 }); await wait(() => opened === 1);
  view.dispose(); complete({ output: new PassThrough(), async close() { closed++; } });
  await wait(() => removed === 1); assert.equal(closed, 1);
});

test('failed controllers report a bounded retry and stop retrying when their viewer leaves', async () => {
  let opened = 0, removed = 0; const messages: any[] = [];
  const resource = new HerdrTerminalStream(async () => { opened++; throw new Error('Unavailable'); }, () => removed++);
  const view = resource.subscribe(message => messages.push(message)); view.resize({ cols: 40, rows: 20 });
  await wait(() => messages.some(m => m.type === 'reading-error'));
  assert.equal(opened, 1); view.dispose(); await wait(() => removed === 1);
});

test('app scroll waits for mobile control, clamps cells and cannot come from a released viewer', async () => {
  const commands: any[] = [];
  const resource = new HerdrTerminalStream(async size => {
    const output = new PassThrough(), input = size ? new PassThrough() : undefined;
    let pending = '';
    input?.on('data', data => { pending += data; let end; while ((end = pending.indexOf('\n')) >= 0) { commands.push(JSON.parse(pending.slice(0, end))); pending = pending.slice(end + 1); } });
    return { output, input, async close() { output.destroy(); input?.destroy(); } };
  }, () => {});
  const desktop = resource.subscribe(() => {});
  await desktop.scroll({ lines: -2, column: 1, row: 2 });
  assert.deepEqual(commands, [], 'An observer cannot scroll through someone else’s controller');
  const phone = resource.subscribe(() => {}); phone.resize({ cols: 40, rows: 20 });
  await phone.scroll({ lines: -3, column: 99, row: 99 });
  assert.deepEqual(commands, Array(3).fill({ type: 'terminal.scroll', source: 'wheel', direction: 'up', lines: 1, column: 39, row: 19 }));
  await phone.scroll({ lines: 1, column: 3, row: 4 });
  assert.deepEqual(commands.at(-1), { type: 'terminal.scroll', source: 'wheel', direction: 'down', lines: 1, column: 3, row: 4 });
  phone.resize(); await phone.scroll({ lines: 10, column: 0, row: 0 }); assert.equal(commands.length, 4);
  phone.dispose(); desktop.dispose();
});
