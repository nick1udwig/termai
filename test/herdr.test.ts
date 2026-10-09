import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { WebSocket, WebSocketServer } from 'ws';
import { herdrSession, herdrName, type HerdrAgent } from '../src/herdr-protocol.ts';
import { HerdrState } from '../src/herdr-state.ts';
import { herdrSocket, normalizeHerdrSnapshot, herdrSnapshot, herdrAction, HerdrConnection, HerdrTerminalConnection } from '../server/herdr.ts';
import { herdrFixture } from './herdr-fixture.ts';

const agent = (status: HerdrAgent['status'], sequence: number, completion?: number): HerdrAgent => ({ terminalId: 'a', paneId: 'p', workspace: 'w', name: 'API', kind: 'claude', status, sequence, completion, cwd: '/' });
const update = (state: HerdrState, value: HerdrAgent) => state.update({ version: 'test', protocol: 22, agents: [value] });
test('Herdr names and session paths cannot escape the selected server', () => {
  assert.equal(herdrName(' API refactor '), 'API refactor'); assert.equal(herdrSession('default'), '');
  for (const value of ['../other', 'foo/bar', '-argument', 'a b', 'x'.repeat(65)]) assert.throws(() => herdrSession(value));
  for (const value of ['', ' ', 'a\nb', 'x'.repeat(101)]) assert.throws(() => herdrName(value));
  const env = { HOME: '/home/test', XDG_CONFIG_HOME: '/tmp/config', HERDR_SOCKET_PATH: '/tmp/custom.sock', HERDR_CONFIG_PATH: '/elsewhere/config.toml' };
  assert.equal(herdrSocket('', env), '/tmp/custom.sock');
  assert.equal(herdrSocket('work', env), '/tmp/config/herdr/sessions/work/herdr.sock');
});
test('unread completion belongs to this viewer and survives desktop focus and reload', () => {
  const state = new HerdrState();
  assert.deepEqual(update(state, agent('working', 1)), []);
  assert.deepEqual(update(state, agent('idle', 2)), [{ terminalId: 'a', kind: 'done', sequence: 2 }]);
  assert.equal(state.status(state.agents[0]), 'done');
  assert.deepEqual(update(state, agent('idle', 3)), []); // Another client acknowledged it.
  assert.equal(state.attention, 1);
  assert.equal(state.viewed('a'), true); assert.equal(state.status(state.agents[0]), 'idle');
  assert.equal(state.viewed('a'), false);
  const restored = new HerdrState(state.checkpoint()); update(restored, agent('idle', 3));
  assert.equal(restored.attention, 0);
  update(restored, agent('working', 4));
  assert.deepEqual(update(restored, agent('done', 5, 5)), [{ terminalId: 'a', kind: 'done', sequence: 5 }]);
  assert.equal(restored.attention, 1);
});
test('requests notify once per transition; reconnect snapshots and fresh occupants are quiet', () => {
  const state = new HerdrState();
  assert.deepEqual(update(state, agent('blocked', 10)), []);
  assert.equal(state.status(state.agents[0]), 'blocked');
  assert.deepEqual(update(state, agent('blocked', 10)), []);
  update(state, agent('working', 11));
  assert.deepEqual(update(state, agent('blocked', 12)), [{ terminalId: 'a', kind: 'request', sequence: 12 }]);
  assert.deepEqual(update(state, agent('blocked', 12)), []);
  assert.deepEqual(update(state, agent('idle', 1)), []); assert.equal(state.attention, 0);
  const complete = new HerdrState(); update(complete, agent('idle', 15, 15)); assert.equal(complete.attention, 1);
});
test('shared terminal transport supports simultaneous input without acquiring resize authority', { timeout: 20000 }, async () => {
  const fixture = await herdrFixture(), oldSocket = process.env.HERDR_SOCKET_PATH;
  process.env.HERDR_SOCKET_PATH = fixture.socketPath;
  const server = new WebSocketServer({ port: 0, host: '127.0.0.1' }), clients: WebSocket[] = [], messages: any[][] = [];
  server.on('connection', async (ws, req) => {
    if (req.url === '/terminal') new HerdrTerminalConnection(ws, '', (await herdrSnapshot('')).agents[0]);
    else new HerdrConnection(ws, '');
  });
  const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
  const wait = async (condition: () => boolean) => { for (let i = 0; i < 150; i++) { if (condition()) return; await delay(30); } assert.fail('Timed out: ' + JSON.stringify(messages)); };
  const open = async (suffix = '') => {
    const ws = new WebSocket('ws://127.0.0.1:' + (server.address() as { port: number }).port + suffix), inbox: any[] = [];
    clients.push(ws); messages.push(inbox); ws.on('message', data => inbox.push(JSON.parse(data.toString()))); await once(ws, 'open'); return { ws, inbox };
  };
  try {
    await once(server, 'listening');
    assert.equal((await herdrSnapshot('')).agents[0].name, 'api-refactor');
    assert.throws(() => normalizeHerdrSnapshot({}));
    await assert.rejects(herdrAction('', { action: 'rename', terminalId: 'outside', name: 'No' }), /ended/);
    await herdrAction('', { action: 'rename', terminalId: 'term_0', name: 'API routes' });
    assert.equal(fixture.snapshot.panes[0].label, 'API routes');
    assert.equal(fixture.snapshot.agents[0].name, 'api-refactor', 'Agent addresses stay independent of desktop labels');
    assert.equal((await herdrSnapshot('')).agents[0].name, 'API routes');
    const metadata = await open(); await wait(() => metadata.inbox.some(m => m.type === 'snapshot'));
    const first = await open('/terminal'), second = await open('/terminal');
    await wait(() => first.inbox.some(m => m.type === 'screen') && second.inbox.some(m => m.type === 'screen'));
    for (const client of [first, second]) { client.ws.send(JSON.stringify({ type: 'resize', cols: 30, rows: 40 })); client.ws.send(JSON.stringify({ type: 'input', data: client === first ? 'mobile' : 'desktop' })); }
    await wait(() => fixture.actions.filter(a => a.method === 'pane.send_text').length === 2);
    assert.deepEqual(fixture.actions.filter(a => a.method === 'pane.send_text').map(a => a.params.text).sort(), ['desktop', 'mobile']);
    assert.ok(!fixture.actions.some(a => /resize|attach/.test(a.method)));
    fixture.setScreen(0, 'One long logical line ' + 'abc'.repeat(80) + '\nHistory');
    await wait(() => first.inbox.some(m => m.type === 'screen' && m.text.includes('History')) && second.inbox.some(m => m.type === 'screen' && m.text.includes('History')));
    first.ws.send(JSON.stringify({ type: 'command', id: 'cmd', command: 'review' }));
    await wait(() => first.inbox.some(m => m.type === 'result' && m.accepted));
    assert.equal(fixture.actions.filter(a => a.method === 'pane.send_text').at(-1).params.text, 'review\r');
    fixture.update(1, 'idle'); await wait(() => metadata.inbox.some(m => m.type === 'snapshot' && m.snapshot.agents[1].status === 'idle'));
    fixture.snapshot.agents[0].terminal_id = 'replacement'; fixture.snapshot.panes[0].terminal_id = 'replacement';
    first.ws.send(JSON.stringify({ type: 'input', data: 'stale-input' }));
    await wait(() => first.inbox.some(m => m.type === 'reading-error' && /ended or moved/.test(m.message)));
    assert.ok(!fixture.actions.some(a => a.method === 'pane.send_text' && a.params.text === 'stale-input'), 'An old view cannot type into a replacement occupying the same pane');
    first.ws.close(); second.ws.close(); await delay(250);
    const reads = fixture.actions.filter(a => a.method === 'pane.read').length; await delay(300);
    assert.equal(fixture.actions.filter(a => a.method === 'pane.read').length, reads, 'Closed views stop reading history');
  } finally {
    for (const ws of clients) ws.terminate();
    await new Promise<void>(resolve => server.close(() => resolve())); await fixture.close();
    if (oldSocket === undefined) delete process.env.HERDR_SOCKET_PATH; else process.env.HERDR_SOCKET_PATH = oldSocket;
  }
});

test('spaces include ordinary terminals and creating an agent preserves existing panes', async () => {
  const fixture = await herdrFixture(), target = { session: '', socketPath: fixture.socketPath, binary: fixture.binary };
  try {
    fixture.addSpace('w2', 'Scratch'); const shell = fixture.addTerminal('w2', 'Shell', false);
    const snapshot = await herdrSnapshot(target);
    assert.equal(snapshot.agents.length, 3); assert.equal(snapshot.terminals!.length, 4);
    assert.deepEqual(snapshot.spaces!.find(s => s.id === 'w2')!.terminalIds, [shell.terminal_id]);
    await assert.rejects(herdrAction(target, { action: 'create', name: 'New', kind: 'unsupported', workspaceId: 'w2' }), /supported/);
    await assert.rejects(herdrAction(target, { action: 'create', name: 'New', kind: 'codex', workspaceId: 'missing' }), /space/);
    await assert.rejects(herdrAction(target, { action: 'create', name: 'New', kind: 'codex', workspaceId: 'w2', cwd: '../relative' }), /absolute/);
    assert.ok(!fixture.actions.some(a => a.method === 'tab.create'));
    const result = await herdrAction(target, { action: 'create', name: 'Mobile review', kind: 'codex', workspaceId: 'w2', cwd: '/workspace' });
    assert.equal(result.terminalId, 'term_4');
    assert.deepEqual(fixture.actions.find(a => a.method === 'tab.create').params, { workspace_id: 'w2', label: 'Mobile review', focus: false, cwd: '/workspace' });
    const start = fixture.actions.filter(a => a.method === 'agent.start'); assert.equal(start.length, 1);
    assert.equal(start[0].params.pane_id, 'w2:p4'); assert.equal(start[0].params.kind, 'codex');
    assert.equal((await herdrSnapshot(target)).agents.at(-1)!.name, 'Mobile review');
    assert.equal(fixture.snapshot.panes[0].label, 'api-refactor');
    await herdrAction(target, { action: 'rename-space', workspaceId: 'w2', name: 'Review space' });
    assert.equal((await herdrSnapshot(target)).spaces!.at(-1)!.name, 'Review space');
  } finally { await fixture.close(); }
});


test('closing panes and spaces changes the server while rejected or stale closes leave survivors intact', async () => {
  const fixture = await herdrFixture(), target = { session: '', socketPath: fixture.socketPath };
  try {
    fixture.addSpace('w2', 'Scratch');
    const shell = fixture.addTerminal('w2', 'Shell', false), agent = fixture.addTerminal('w2', 'Review');
    await assert.rejects(herdrAction(target, { action: 'close', terminalId: 'missing' }), /ended/);
    await assert.rejects(herdrAction(target, { action: 'close-space', workspaceId: 'missing' }), /closed/);
    assert.ok(!fixture.actions.some(a => /\.close$/.test(a.method)));
    fixture.rejectClose('Server refused to close pane.');
    await assert.rejects(herdrAction(target, { action: 'close', terminalId: agent.terminal_id }), /refused/);
    assert.ok((await herdrSnapshot(target)).agents.some(a => a.terminalId === agent.terminal_id));
    fixture.rejectClose();
    await herdrAction(target, { action: 'close', terminalId: agent.terminal_id });
    let snapshot = await herdrSnapshot(target);
    assert.ok(!snapshot.terminals!.some(t => t.terminalId === agent.terminal_id));
    assert.ok(snapshot.terminals!.some(t => t.terminalId === shell.terminal_id));
    await assert.rejects(herdrAction(target, { action: 'close', terminalId: agent.terminal_id }), /ended/);
    await herdrAction(target, { action: 'close-space', workspaceId: 'w2' });
    snapshot = await herdrSnapshot(target);
    assert.ok(!snapshot.spaces!.some(s => s.id === 'w2')); assert.equal(snapshot.terminals!.length, 3);
    assert.deepEqual(fixture.actions.filter(a => a.method === 'workspace.close').at(-1).params, { workspace_id: 'w2', close_group: false });
    assert.equal(snapshot.agents[0].name, 'api-refactor');
  } finally { await fixture.close(); }
});

test('mobile geometry controls the selected native terminal, shares frames, and restores on disconnect', { timeout: 20000 }, async () => {
  const fixture = await herdrFixture(), target = { session: '', socketPath: fixture.socketPath, binary: fixture.binary };
  const server = new WebSocketServer({ port: 0, host: '127.0.0.1' }), clients: WebSocket[] = [];
  server.on('connection', async ws => new HerdrTerminalConnection(ws, target, (await herdrSnapshot(target)).agents[0]));
  const wait = async (check: () => boolean) => { for (let i = 0; i < 200; i++) { if (check()) return; await new Promise(resolve => setTimeout(resolve, 20)); } assert.fail('Native geometry did not settle'); };
  const open = async () => {
    const ws = new WebSocket('ws://127.0.0.1:' + (server.address() as { port: number }).port), inbox: any[] = [];
    ws.on('message', data => inbox.push(JSON.parse(String(data)))); clients.push(ws); await once(ws, 'open'); await wait(() => inbox.some(m => m.type === 'screen'));
    return { ws, inbox, resize(cols: number, rows: number, mobile = true) { ws.send(JSON.stringify({ type: 'resize', cols, rows, mobile })); } };
  };
  try {
    await once(server, 'listening');
    const desktop = await open(), phone = await open(); desktop.resize(120, 40, false); phone.resize(42, 31);
    await wait(() => phone.inbox.at(-1)?.width === 42 && desktop.inbox.some(m => m.width === 42));
    phone.resize(38, 17); await wait(() => desktop.inbox.some(m => m.width === 38 && m.height === 17));
    assert.equal(fixture.actions.filter(a => a.method === 'fixture.terminal.open' && a.params.mode === 'control').length, 1, 'Keyboard/orientation changes reuse the controller');
    assert.equal(fixture.actions.find(a => a.method === 'fixture.terminal.resize').params.cols, 38);
    const tablet = await open(); tablet.resize(65, 25); await wait(() => phone.inbox.some(m => m.width === 65));
    assert.equal(fixture.actions.filter(a => a.method === 'fixture.terminal.open' && a.params.mode === 'control').length, 1);
    tablet.ws.close(); await wait(() => phone.inbox.at(-1)?.width === 38);
    phone.resize(38, 17, false); await wait(() => desktop.inbox.at(-1)?.width === 80);
    assert.ok(fixture.actions.some(a => a.method === 'fixture.terminal.release'));
    assert.equal(fixture.actions.find(a => a.method === 'fixture.terminal.open' && a.params.mode === 'control').params.terminalId, 'term_0');
    phone.resize(41, 28); await wait(() => desktop.inbox.at(-1)?.width === 41); phone.ws.close(); await wait(() => desktop.inbox.at(-1)?.width === 80);
    const invalid = await open(); invalid.resize(0, 40); const [code] = await once(invalid.ws, 'close'); assert.equal(code, 1008);
    assert.ok(!fixture.actions.some(a => a.method === 'fixture.terminal.resize' && a.params.cols === 0));
  } finally { for (const ws of clients) ws.terminate(); await new Promise<void>(resolve => server.close(() => resolve())); await new Promise(resolve => setTimeout(resolve, 100)); await fixture.close(); }
});
