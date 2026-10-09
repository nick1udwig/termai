import net, { type Socket } from 'node:net';
import { once } from 'node:events';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';

/** Disposable socket API and command; never touches a user's Herdr server. */
export async function herdrFixture() {
  const directory = await mkdtemp('/tmp/termai-herdr-'), socketPath = directory + '/herdr.sock';
  const sockets = new Set<Socket>(), subscribers = new Set<Socket>();
  const actions: any[] = [];
  let closeError = '';
  const remove = <T>(items: T[], matches: (item: T) => boolean) => { for (let i = items.length - 1; i >= 0; i--) if (matches(items[i])) items.splice(i, 1); };
  const snapshot = { version: 'test', protocol: 22,
    workspaces: [{ workspace_id: 'w1', label: 'Termai', active_tab_id: 't1' }] as any[],
    tabs: ['api-refactor', 'tests', 'docs'].map((label, i) => ({ tab_id: 't' + (i + 1), workspace_id: 'w1', label })) as any[],
    panes: ['api-refactor', 'tests', 'docs'].map((label, i) => ({ pane_id: 'w1:p' + i, terminal_id: 'term_' + i, workspace_id: 'w1', tab_id: 't' + (i + 1), focused: true, label, cwd: '/workspace' })) as any[],
    agents: ['api-refactor', 'tests', 'docs'].map((name, i) => ({
      terminal_id: 'term_' + i, pane_id: 'w1:p' + i, workspace_id: 'w1', tab_id: 't' + (i + 1),
      agent: 'claude', name, agent_status: i === 1 ? 'working' : 'idle', state_change_seq: i + 1, revision: 1, cwd: '/workspace',
    })) as any[],
  };
  const screens = new Map(snapshot.agents.map(a => [a.pane_id, (snapshot.panes.find(p => p.pane_id === a.pane_id)?.label || 'Agent') + '\nLive Herdr terminal\n']));
  const dimensions = new Map<string, { width: number; height: number }>();
  const send = (socket: Socket, value: unknown) => { if (!socket.destroyed) socket.write(JSON.stringify(value) + '\n'); };
  const event = () => { for (const socket of subscribers) send(socket, { type: 'event', event: { type: 'pane.agent_status_changed' } }); };
  const updateFrame = async (paneId: string, cursor?: { x: number; y: number; visible?: boolean }) => {
    const pane = snapshot.panes.find(p => p.pane_id === paneId);
    if (!pane) return;
    const size = dimensions.get(paneId), width = size?.width || 80, height = size?.height || 24;
    // Explicit frames retain ANSI paint for responsive-widget tests. Their
    // source rows already fit the supplied native dimensions.
    const rows = size ? (screens.get(paneId) || '').replace(/\r?\n$/, '').split(/\r?\n/).slice(-height)
      : (screens.get(paneId) || '').replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '').replace(/\n$/, '').split('\n').flatMap(line => line ? line.match(/.{1,80}/gu) || [''] : ['']).slice(-24);
    const point = cursor || { x: Math.min(79, rows.at(-1)?.length || 0), y: Math.max(0, rows.length - 1), visible: true };
    const bytes = '\x1b[2J' + rows.map((row, i) => '\x1b[' + (i + 1) + ';1H' + row).join('') + '\x1b[' + (point.y + 1) + ';' + (point.x + 1) + 'H\x1b[?25' + (point.visible === false ? 'l' : 'h');
    await writeFile(directory + '/' + pane.terminal_id + '.json', JSON.stringify({ type: 'terminal.frame', encoding: 'ansi', width, height, full: true, bytes: Buffer.from(bytes).toString('base64') }) + '\n');
  };
  const addTerminal = (workspaceId: string, name: string, isAgent = true) => {
    const i = snapshot.panes.length, pane = { pane_id: workspaceId + ':p' + i, terminal_id: 'term_' + i, workspace_id: workspaceId, tab_id: 't' + (i + 1), focused: true, label: name, cwd: '/workspace' };
    snapshot.panes.push(pane); snapshot.tabs.push({ tab_id: pane.tab_id, workspace_id: workspaceId, label: name }); screens.set(pane.pane_id, name + '\nLive Herdr terminal\n');
    if (isAgent) snapshot.agents.push({ ...pane, name, agent: 'codex', agent_status: 'idle', state_change_seq: 1, revision: 1 });
    void updateFrame(pane.pane_id); event(); return pane;
  };
  const server = net.createServer(socket => {
    sockets.add(socket); let pending = ''; socket.setEncoding('utf8');
    socket.on('error', () => {});
    socket.on('close', () => { sockets.delete(socket); subscribers.delete(socket); });
    socket.on('data', data => {
      pending += data; let end;
      while ((end = pending.indexOf('\n')) !== -1) {
        const line = pending.slice(0, end); pending = pending.slice(end + 1);
        const request = JSON.parse(line), p = request.params || {}, agent = snapshot.panes.find(a => a.pane_id === p.target || a.pane_id === p.pane_id || a.terminal_id === p.terminalId);
        const reply = (result: unknown) => send(socket, { id: request.id, result });
        if (request.method === 'server.agent_manifests') reply({ manifests: [{ agent: 'codex' }, { agent: 'claude' }, { agent: 'pi' }] });
        else if (request.method === 'tab.create') { actions.push(request); const pane = addTerminal(p.workspace_id, p.label, false); reply({ tab: snapshot.tabs.at(-1), root_pane: pane }); }
        else if (request.method === 'agent.start' && agent) { actions.push(request); const created = { ...agent, name: p.name, agent: p.kind, agent_status: 'idle', state_change_seq: 1, revision: 1 }; snapshot.agents.push(created); reply({ type: 'agent_started', agent: created }); event(); }
        else if (request.method === 'workspace.rename') { actions.push(request); snapshot.workspaces.find(w => w.workspace_id === p.workspace_id).label = p.label; reply({ type: 'ok' }); event(); }
        else if (request.method === 'pane.close' && agent) {
          actions.push(request);
          if (closeError) { send(socket, { id: request.id, error: { message: closeError } }); continue; }
          remove(snapshot.agents, a => a.terminal_id === agent.terminal_id); remove(snapshot.panes, pane => pane.pane_id === agent.pane_id);
          if (!snapshot.panes.some(pane => pane.tab_id === agent.tab_id)) remove(snapshot.tabs, tab => tab.tab_id === agent.tab_id);
          if (!snapshot.panes.some(pane => pane.workspace_id === agent.workspace_id)) remove(snapshot.workspaces, workspace => workspace.workspace_id === agent.workspace_id);
          screens.delete(agent.pane_id); reply({ type: 'ok' }); event();
        }
        else if (request.method === 'workspace.close') {
          actions.push(request);
          if (closeError) { send(socket, { id: request.id, error: { message: closeError } }); continue; }
          remove(snapshot.agents, a => a.workspace_id === p.workspace_id); remove(snapshot.panes, pane => pane.workspace_id === p.workspace_id);
          remove(snapshot.tabs, tab => tab.workspace_id === p.workspace_id); remove(snapshot.workspaces, workspace => workspace.workspace_id === p.workspace_id);
          reply({ type: 'ok' }); event();
        }
        else if (request.method === 'session.snapshot') reply({ type: 'session_snapshot', snapshot });
        else if (request.method === 'events.subscribe') {
          if (p.subscriptions.some((s: any) => s.type === 'pane.agent_status_changed' && !s.pane_id)) send(socket, { id: request.id, error: { message: 'pane_id required' } });
          else { subscribers.add(socket); reply({ type: 'subscribed' }); }
        }
        else if (request.method === 'pane.read' && agent) { actions.push(request); if (p.source !== 'recent_unwrapped') send(socket, { id: request.id, error: { message: 'Invalid read source' } }); else reply({ type: 'pane_read', read: { text: screens.get(agent.pane_id), revision: agent.revision, truncated: false } }); }
        else if (['pane.send_text', 'pane.send_input'].includes(request.method) && agent) { actions.push(request); screens.set(agent.pane_id, screens.get(agent.pane_id) + p.text); void updateFrame(agent.pane_id); reply({ type: 'ok' }); }
        else if (request.method === 'pane.rename' && agent) { actions.push(request); snapshot.panes.find(pane => pane.pane_id === agent.pane_id)!.label = p.label; reply({ type: 'pane_info' }); event(); }
        else send(socket, { id: request.id, error: { code: 'unsupported', message: 'Unsupported fixture method' } });
      }
    });
  });
  server.listen(socketPath); await once(server, 'listening');
  const binary = directory + '/herdr';
  await writeFile(directory + '/observe.mjs', `import { readFile } from 'node:fs/promises'; const file = new URL(process.argv[2] + '.json', import.meta.url); let last = ''; setInterval(async () => { try { const text = await readFile(file, 'utf8'); if (text !== last) { last = text; process.stdout.write(text); } } catch {} }, 50);`);
  await writeFile(binary, '#!/bin/sh\nif [ "$1" = terminal ]; then exec ' + process.execPath + ' ' + directory + '/observe.mjs "$4"; fi\nprintf "Fixture Herdr command\\n"\n', { mode: 0o700 });
  await Promise.all(snapshot.panes.map(p => updateFrame(p.pane_id)));
  return { directory, socketPath, binary, snapshot, actions,
    rename(index: number, label: string) { snapshot.panes[index].label = label; event(); },
    setScreen(index: number, text: string, cursor?: { x: number; y: number; visible?: boolean }, size?: { width: number; height: number }) { const pane = snapshot.panes[index]; if (size) dimensions.set(pane.pane_id, size); screens.set(pane.pane_id, text); void updateFrame(pane.pane_id, cursor); },
    addTerminal,
    rejectClose(message = '') { closeError = message; },
    addSpace(id: string, name: string) { snapshot.workspaces.push({ workspace_id: id, label: name, active_tab_id: '' }); event(); },
    update(index: number, status: string) {
      const agent = snapshot.agents[index], previous = agent.agent_status;
      agent.agent_status = status; ++agent.state_change_seq;
      if ((status === 'idle' || status === 'done') && previous === 'working') agent.completion_seq = agent.state_change_seq;
      event();
    },
    async close() { for (const socket of sockets) socket.destroy(); await new Promise<void>(resolve => server.close(() => resolve())); await rm(directory, { recursive: true, force: true }); },
  };
}
