import { herdrName, type HerdrAgent, type HerdrMessage, type HerdrSpace } from './herdr-protocol.ts';
import { HerdrState, type HerdrNotification } from './herdr-state.ts';
import { tabGestures } from './tab-gestures.ts';
import './herdr.css';

interface Host {
  url: string; session: string; source?: string; key: string;
  token(): string | undefined; authenticate(): Promise<void>;
  api<T>(path: string, data?: unknown): Promise<T>;
  changed(attention: number): void; notification(event: HerdrNotification): void;
  notice(message: string): void;
  notificationDevice?(): string | undefined;
}
type StripItem = HerdrAgent & { space?: HerdrSpace };
interface Preferences { order: string[]; spaceOrder?: string[]; spaceTerminals?: Record<string, string>; selected?: string; state?: ReturnType<HerdrState['checkpoint']> }
const node = <K extends keyof HTMLElementTagNameMap>(tag: K, className = '', text = '') => {
  const element = document.createElement(tag); element.className = className; element.textContent = text; return element;
};
export class HerdrView {
  readonly element = node('section', 'herdr-view');
  private strip = node('div', 'herdr-agent-strip');
  private screen = node('div', 'herdr-screen');
  private frame?: HTMLIFrameElement;
  private frameSession = crypto.randomUUID();
  private status = node('div', 'herdr-connection');
  private empty = node('div', 'herdr-empty');
  private menu = node('div', 'herdr-tab-menu');
  private tracker = new HerdrState();
  private preferences: Preferences;
  private ws?: WebSocket;
  private reconnect?: ReturnType<typeof setTimeout>;
  private connecting = false;
  private disposed = false;
  private visible = false;
  private connected = false;
  private quietSnapshot = true;
  private selected = '';
  private requestedTerminal = '';
  private presenceTimer?: ReturnType<typeof setInterval>;
  private presenceDevice = '';
  private terminals: HerdrAgent[] = [];
  private spaces: HerdrSpace[] = [];
  private rendered = false;
  private held = false;
  private dragOrderChanged = false;
  private closing = new Set<string>();
  private unsubscribers: (() => void)[] = [];
  private host: Host;
  constructor(host: Host) {
    this.host = host;
    try { this.preferences = JSON.parse(localStorage.getItem(host.key) || 'null') || { order: [] }; }
    catch { this.preferences = { order: [] }; }
    if (!Array.isArray(this.preferences.order)) this.preferences = { order: [] };
    this.preferences.order = this.preferences.order.filter(id => typeof id === 'string');
    this.preferences.spaceOrder = (this.preferences.spaceOrder || []).filter(id => typeof id === 'string');
    this.preferences.spaceTerminals ||= {};
    delete (this.preferences as any).hidden; delete (this.preferences as any).hiddenSpaces;
    this.tracker = new HerdrState(this.preferences.state);
    this.selected = this.preferences.selected || '';
    this.element.setAttribute('aria-label', 'Herdr connection');
    this.element.role = 'tabpanel'; this.screen.id = 'herdr-terminal-' + crypto.randomUUID(); this.screen.role = 'tabpanel'; this.screen.setAttribute('aria-label', 'Agent terminal');
    this.strip.role = 'tablist'; this.strip.setAttribute('aria-label', 'Herdr agents');
    this.menu.role = 'menu'; this.menu.hidden = true;
    this.status.setAttribute('role', 'status');
    this.screen.append(this.status, this.empty);
    this.element.append(this.strip, this.screen, this.menu);
    const viewed = () => { if (this.visible && this.rendered && !document.hidden && document.hasFocus() && this.tracker.viewed(this.selected)) { this.save(); this.render(); } };
    const messages = (event: MessageEvent) => {
      if (event.source !== this.frame?.contentWindow || event.origin !== location.origin || event.data?.session !== this.frameSession) return;
      if (event.data.type === 'terminal-loaded') {
        this.post({ type: 'authorize', accessToken: this.host.token() });
        this.post({ type: 'tab-visibility', visible: this.visible });
      }
      if (event.data.type === 'terminal-rendered') { this.rendered = true; viewed(); }
      if (event.data.type === 'terminal-notice') this.host.notice(event.data.message);
      if (event.data.type === 'terminal-locked') void this.host.authenticate().then(() => this.post({ type: 'authorize', accessToken: this.host.token() })).catch(error => this.host.notice(error.message));
    };
    document.addEventListener('visibilitychange', viewed); window.addEventListener('focus', viewed); window.addEventListener('message', messages);
    this.unsubscribers.push(() => document.removeEventListener('visibilitychange', viewed), () => window.removeEventListener('focus', viewed), () => window.removeEventListener('message', messages));
    const presence = () => this.updatePresence();
    document.addEventListener('visibilitychange', presence); window.addEventListener('focus', presence); window.addEventListener('blur', presence);
    this.unsubscribers.push(() => document.removeEventListener('visibilitychange', presence), () => window.removeEventListener('focus', presence), () => window.removeEventListener('blur', presence));
    this.presenceTimer = setInterval(presence, 15000);
    const outside = (event: PointerEvent) => { if (!this.menu.contains(event.target as Node) && !(event.target as HTMLElement).closest('.herdr-agent-tab')) this.menu.hidden = true; };
    document.addEventListener('pointerdown', outside); this.unsubscribers.push(() => document.removeEventListener('pointerdown', outside));
    this.menu.onkeydown = event => {
      if (event.key === 'Escape') { this.menu.hidden = true; this.strip.querySelector<HTMLButtonElement>('[aria-selected=true]')?.focus(); }
      if (['ArrowDown', 'ArrowUp'].includes(event.key)) { event.preventDefault(); const items = [...this.menu.querySelectorAll('button')], index = items.indexOf(document.activeElement as HTMLButtonElement); items[(index + (event.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length]?.focus(); }
    };
    this.render(); void this.connect();
  }
  setVisible(visible: boolean) {
    this.visible = visible; this.element.hidden = !visible;
    if (!visible) this.menu.hidden = true;
    this.mountTerminal(); this.post({ type: 'tab-visibility', visible });
  }
  private post(message: object) { this.frame?.contentWindow?.postMessage(message, location.origin); }
  private mountTerminal() {
    if (!this.selected) { this.frame?.remove(); this.frame = undefined; this.rendered = false; return; }
    const agent = this.terminals.find(agent => agent.terminalId === this.selected);
    if (!agent || this.frame?.dataset.terminal === this.selected && this.frame.dataset.pane === agent.paneId || !this.visible || this.disposed) return;
    this.frame?.remove(); this.rendered = false; this.frameSession = crypto.randomUUID();
    const frame = node('iframe', 'herdr-terminal'); frame.title = 'Herdr agent terminal'; frame.dataset.terminal = this.selected; frame.dataset.pane = agent.paneId;
    frame.allow = 'microphone; clipboard-read; clipboard-write';
    const url = new URL('terminal.html', document.baseURI);
    url.search = new URLSearchParams({ embedded: '1', backend: this.host.url, session: this.frameSession, herdrTerminal: this.selected, herdrSession: this.host.session, ...(this.host.source ? { herdrSource: this.host.source } : {}) }).toString();
    frame.src = url.href; this.frame = frame; this.screen.append(frame);
  }
  private endpoint(name: string) { const url = new URL(name, this.host.url); if (this.host.session) url.searchParams.set('herdrSession', this.host.session); if (this.host.source) url.searchParams.set('herdrSource', this.host.source); return url; }
  private async connect() {
    if (this.disposed || this.connecting) return; this.connecting = true;
    try {
      const { ticket } = await this.host.api<{ ticket: string }>('api/herdr/ticket', {});
      if (this.disposed) return;
      const url = this.endpoint('herdr/ws'); url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'; url.searchParams.set('ticket', ticket);
      const ws = new WebSocket(url); this.ws = ws;
      ws.onopen = () => { if (this.ws !== ws) return; this.connected = true; this.quietSnapshot = true; this.status.textContent = ''; this.updatePresence(); this.render(); };
      ws.onmessage = event => { if (this.ws === ws) this.receive(JSON.parse(event.data)); };
      ws.onclose = () => {
        if (this.ws !== ws || this.disposed) return;
        this.connected = false; this.status.textContent = 'Herdr disconnected. Reconnecting…'; this.render();
        this.reconnect = setTimeout(() => void this.connect(), 2000);
      };
    } catch (error: any) { if (!this.disposed) { this.status.textContent = error.message; this.reconnect = setTimeout(() => void this.connect(), 3000); } }
    finally { this.connecting = false; }
  }
  private receive(message: HerdrMessage) {
    if (message.type === 'error') { this.status.textContent = message.message; return; }
    if (message.type !== 'snapshot') return;
    this.status.textContent = '';
    this.terminals = message.snapshot.terminals || message.snapshot.agents; this.spaces = message.snapshot.spaces || [];
    const notifications = this.tracker.update(message.snapshot);
    this.acknowledge(this.quietSnapshot ? this.currentNotifications() : notifications);
    if (!this.quietSnapshot) for (const event of notifications) this.host.notification(event);
    this.quietSnapshot = false;
    const live = this.tracker.agents.map(agent => agent.terminalId);
    this.preferences.order = [...this.preferences.order.filter(id => live.includes(id)), ...live.filter(id => !this.preferences.order.includes(id))];
    const spaces = this.spaces.map(space => 'space:' + space.id);
    this.preferences.spaceOrder = [...this.preferences.spaceOrder!.filter(id => spaces.includes(id)), ...spaces.filter(id => !this.preferences.spaceOrder!.includes(id))];
    this.ensureSelection();
    if (this.requestedTerminal && this.terminals.some(agent => agent.terminalId === this.requestedTerminal)) { this.selected = this.requestedTerminal; this.requestedTerminal = ''; }
    this.save(); this.render(); this.mountTerminal();
    requestAnimationFrame(() => { if (this.visible && this.rendered && !document.hidden && document.hasFocus() && this.tracker.viewed(this.selected)) { this.save(); this.render(); } });
  }
  private get spaceMode() { try { return JSON.parse(localStorage.getItem('termai.herdrStrip') || 'null') === 'spaces'; } catch { return false; } }
  private get order() { return this.spaceMode ? this.preferences.spaceOrder! : this.preferences.order; }
  private set order(value: string[]) { if (this.spaceMode) this.preferences.spaceOrder = value; else this.preferences.order = value; }
  private get stripSelection() {
    const terminal = this.terminals.find(t => t.terminalId === this.selected);
    return this.spaceMode && terminal ? 'space:' + terminal.workspaceId : this.selected;
  }
  private entries(): StripItem[] {
    if (!this.spaceMode) return this.tracker.agents;
    return this.spaces.map(space => ({ terminalId: 'space:' + space.id, paneId: '', workspace: space.name, name: space.name, kind: 'Space', status: 'idle', sequence: 0, cwd: '', space }));
  }
  private statusFor(item: StripItem) {
    if (!item.space) return this.tracker.status(item);
    const statuses = this.tracker.agents.filter(agent => item.space!.terminalIds.includes(agent.terminalId)).map(agent => this.tracker.status(agent));
    return (['blocked', 'done', 'working'] as const).find(status => statuses.includes(status)) || 'idle';
  }
  private terminalFor(item?: StripItem) {
    if (!item) return '';
    if (!item.space) return item.terminalId;
    const remembered = this.preferences.spaceTerminals![item.space.id];
    return (item.space.terminalIds.includes(remembered) ? remembered : item.space.selectedTerminalId) || item.space.terminalIds[0] || '';
  }
  private ensureSelection() {
    if (!this.terminals.some(t => t.terminalId === this.selected) || !this.ordered().some(item => item.terminalId === this.stripSelection)) this.selected = this.terminalFor(this.ordered()[0]);
  }
  private select(id: string) {
    const item = this.entries().find(item => item.terminalId === id);
    if (item?.space && this.stripSelection === id && item.space.terminalIds.length > 1) {
      const anchor = this.strip.querySelector<HTMLElement>('[data-terminal="' + CSS.escape(id) + '"]');
      if (anchor) this.openAgents(anchor, item.space.id); return;
    }
    this.selectTerminal(item ? this.terminalFor(item) : id);
  }
  private selectTerminal(id: string) {
    this.menu.hidden = true;
    const terminal = this.terminals.find(t => t.terminalId === id);
    if (terminal?.workspaceId) this.preferences.spaceTerminals![terminal.workspaceId] = id;
    if (id === this.selected) { this.post({ type: 'focus-terminal' }); return; }
    this.selected = id; this.save(); this.render(); this.mountTerminal();
  }
  private ordered() {
    const entries = this.entries();
    return this.order.map(id => entries.find(item => item.terminalId === id)).filter((item): item is StripItem => !!item);
  }
  private save() {
    this.preferences.selected = this.selected;
    this.preferences.state = this.tracker.checkpoint();
    try { localStorage.setItem(this.host.key, JSON.stringify(this.preferences)); } catch { /* This view still works without persistence. */ }
  }
  private render() {
    this.host.changed(this.tracker.attention);
    this.strip.setAttribute('aria-label', this.spaceMode ? 'Herdr spaces' : 'Herdr agents');
    this.empty.hidden = !!this.selected;
    this.empty.textContent = this.spaceMode ? 'Choose a space, or create an agent with +.' : 'Create or open an agent with + in the strip above.';
    if (this.held) {
      for (const tab of this.strip.querySelectorAll<HTMLElement>('.herdr-agent-tab')) {
        const agent = this.entries().find(agent => agent.terminalId === tab.dataset.terminal);
        if (agent) tab.dataset.status = this.statusFor(agent);
      }
      return;
    }
    const scroll = this.strip.scrollLeft; this.strip.replaceChildren();
    const agents = this.ordered();
    for (const agent of agents) {
      const tab = node('button', 'herdr-agent-tab'); tab.type = 'button'; tab.role = 'tab'; tab.dataset.terminal = agent.terminalId; tab.dataset.status = this.statusFor(agent);
      tab.setAttribute('aria-selected', String(agent.terminalId === this.stripSelection)); tab.tabIndex = agent.terminalId === this.stripSelection ? 0 : -1;
      tab.setAttribute('aria-controls', this.screen.id); tab.setAttribute('aria-haspopup', 'menu');
      tab.setAttribute('aria-label', agent.name + ' · ' + this.statusFor(agent) + ' · ' + agent.workspace);
      tab.title = agent.name + ' · ' + agent.kind + ' · ' + this.statusFor(agent) + ' · ' + agent.workspace;
      tab.append(node('span', 'herdr-status-dot'), node('span', 'herdr-agent-name', agent.name + (agent.space && agent.space.terminalIds.length > 1 ? ' ▾' : '')));
      tab.addEventListener('pointerdown', event => { if (event.button === 0) this.held = true; });
      tabGestures(tab, {
        select: () => this.select(agent.terminalId), hold: () => this.openMenu(tab, agent), scroll: this.strip,
        dragging: () => this.menu.hidden = true,
        drag: x => {
          if (x < this.strip.getBoundingClientRect().left + 24) this.strip.scrollLeft -= 10;
          if (x > this.strip.getBoundingClientRect().right - 24) this.strip.scrollLeft += 10;
          const siblings = [...this.strip.querySelectorAll<HTMLElement>('.herdr-agent-tab')], index = siblings.indexOf(tab);
          const target = siblings.find((item, i) => { const rect = item.getBoundingClientRect(); return i !== index && x >= rect.left && x <= rect.right && (i < index ? x < rect.left + rect.width / 2 : x > rect.left + rect.width / 2); });
          if (!target) return;
          const targetIndex = siblings.indexOf(target); this.strip.insertBefore(tab, targetIndex > index ? target.nextSibling : target);
          const visible = [...this.strip.querySelectorAll<HTMLElement>('.herdr-agent-tab')].map(item => item.dataset.terminal!);
          this.order = [...visible, ...this.order.filter(id => !visible.includes(id))]; this.dragOrderChanged = true;
        },
        finish: () => { this.held = false; if (this.dragOrderChanged) { this.save(); this.dragOrderChanged = false; } setTimeout(() => { if (!this.disposed) this.render(); }, 0); },
      });
      tab.onkeydown = event => {
        if (!['ArrowLeft', 'ArrowRight'].includes(event.key)) return;
        event.preventDefault(); const index = agents.indexOf(agent), next = agents[(index + (event.key === 'ArrowRight' ? 1 : agents.length - 1)) % agents.length];
        if (event.altKey) {
          const a = this.order.indexOf(agent.terminalId), b = this.order.indexOf(next.terminalId);
          const order = [...this.order]; [order[a], order[b]] = [order[b], order[a]]; this.order = order; this.save(); this.render();
          this.strip.querySelector<HTMLButtonElement>('[data-terminal="' + CSS.escape(agent.terminalId) + '"]')?.focus();
        } else { this.select(next.terminalId); this.strip.querySelector<HTMLButtonElement>('[aria-selected=true]')?.focus(); }
      };
      this.strip.append(tab);
    }
    const add = node('button', 'herdr-agent-add', '+'); add.type = 'button'; add.setAttribute('aria-label', this.spaceMode ? 'Open a terminal' : 'Open an agent'); add.onclick = () => this.openAgents(add); this.strip.append(add); this.strip.scrollLeft = scroll;
  }
  private popup(anchor: HTMLElement) {
    this.menu.hidden = false;
    const parent = this.element.getBoundingClientRect(), rect = anchor.getBoundingClientRect();
    this.menu.style.left = Math.max(8, Math.min(rect.left - parent.left, parent.width - this.menu.offsetWidth - 8)) + 'px';
    this.menu.style.top = rect.bottom - parent.top + 5 + 'px';
  }
  private openMenu(anchor: HTMLElement, agent: StripItem) {
    this.menu.replaceChildren();
    this.menu.setAttribute('aria-label', agent.name + ' tab actions');
    const rename = node('button', '', 'Rename'); rename.role = 'menuitem'; rename.onclick = () => void this.rename(agent);
    const close = node('button', '', 'Close tab'); close.role = 'menuitem'; close.disabled = this.closing.has(agent.terminalId); close.onclick = () => void this.closeTab(agent);
    this.menu.append(rename, close); this.popup(anchor); rename.focus({ preventScroll: true });
  }
  private async closeTab(item: StripItem) {
    if (this.closing.has(item.terminalId)) return;
    this.closing.add(item.terminalId); this.menu.hidden = true;
    try {
      await this.host.api('api/herdr/action', item.space
        ? { action: 'close-space', workspaceId: item.space.id }
        : { action: 'close', terminalId: item.terminalId });
      if (!this.disposed) this.receive({ type: 'snapshot', snapshot: await this.host.api('api/herdr/snapshot') });
    } catch (error: any) { if (!this.disposed) this.host.notice(error.message); }
    finally { this.closing.delete(item.terminalId); }
  }
  private openAgents(anchor: HTMLElement, spaceId?: string) {
    this.menu.replaceChildren();
    const create = node('button', '', 'Create agent'); create.role = 'menuitem'; create.onclick = () => void this.createAgent(spaceId);
    this.menu.append(create, node('p', 'herdr-menu-hint', this.spaceMode ? 'Open existing terminal' : 'Open existing agent'));
    const terminals = (this.spaceMode ? this.terminals : this.tracker.agents).filter(agent => !spaceId || agent.workspaceId === spaceId);
    if (!terminals.length) this.menu.append(node('p', 'herdr-menu-hint', 'No terminals are running here.'));
    for (const agent of terminals) {
      const item = node('button', '', agent.name + ' · ' + agent.workspace); item.role = 'menuitem';
      item.onclick = () => {
        this.selectTerminal(agent.terminalId); this.save(); this.render();
      };
      this.menu.append(item);
    }
    this.popup(anchor);
  }
  private async createAgent(spaceId?: string) {
    this.menu.hidden = true;
    const modal = node('dialog'), form = node('form'), title = node('h2', '', 'Create agent');
    const name = node('input'), kind = node('select'), space = node('select'), cwd = node('input'), error = node('p', 'form-error'), actions = node('div', 'actions');
    name.required = true; name.maxLength = 100; name.value = 'New agent'; name.setAttribute('aria-label', 'Agent name');
    kind.setAttribute('aria-label', 'Agent type'); space.setAttribute('aria-label', 'Space'); cwd.setAttribute('aria-label', 'Working directory'); cwd.placeholder = 'Use the space’s directory';
    for (const value of this.spaces) { const option = node('option', '', value.name); option.value = value.id; space.append(option); }
    space.value = spaceId || this.terminals.find(t => t.terminalId === this.selected)?.workspaceId || this.spaces[0]?.id || '';
    const setDirectory = () => { cwd.value = this.terminals.find(t => t.workspaceId === space.value)?.cwd || ''; }; setDirectory(); space.onchange = setDirectory;
    const cancel = node('button', 'secondary', 'Cancel'), create = node('button', 'primary', 'Create agent'); cancel.type = 'button'; create.type = 'submit'; create.disabled = true; cancel.onclick = () => modal.close();
    const field = (text: string, control: HTMLElement) => { const label = node('label', '', text); label.append(control); return label; };
    actions.append(cancel, create); form.append(title, field('Name', name), field('Agent type', kind), field('Space', space), field('Working directory', cwd), error, actions); modal.append(form); document.body.append(modal); modal.onclose = () => modal.remove();
    modal.showModal(); name.focus(); name.select();
    try {
      const options = await this.host.api<{ kinds: string[] }>('api/herdr/options');
      for (const value of options.kinds) { const option = node('option', '', value); option.value = value; kind.append(option); }
      const current = this.terminals.find(t => t.terminalId === this.selected)?.kind;
      kind.value = options.kinds.includes(current || '') ? current! : options.kinds.includes('codex') ? 'codex' : options.kinds[0] || '';
      create.disabled = !kind.value || !space.value;
      if (!kind.value) error.textContent = 'This Herdr server has no supported agent types.';
    } catch (reason: any) { error.textContent = reason.message; }
    form.onsubmit = async event => {
      event.preventDefault(); if (create.disabled) return; create.disabled = true; cancel.disabled = true;
      try {
        const result = await this.host.api<{ terminalId: string; error?: string }>('api/herdr/action', { action: 'create', name: herdrName(name.value), kind: kind.value, workspaceId: space.value, ...(cwd.value.trim() ? { cwd: cwd.value.trim() } : {}) });
        this.receive({ type: 'snapshot', snapshot: await this.host.api('api/herdr/snapshot') });
        this.selectTerminal(result.terminalId); modal.close();
        if (result.error) this.host.notice('Created a terminal, but the agent could not start: ' + result.error);
      } catch (reason: any) { error.textContent = reason.message; }
      finally { create.disabled = false; cancel.disabled = false; }
    };
  }
  private async rename(agent: StripItem) {
    this.menu.hidden = true;
    const modal = node('dialog', 'herdr-rename'), form = node('form'), title = node('h2', '', agent.space ? 'Rename space' : 'Rename agent tab'), input = node('input'), error = node('p', 'form-error'), actions = node('div', 'actions');
    input.value = agent.name; input.maxLength = 100; input.required = true; input.setAttribute('aria-label', 'Agent tab name');
    const hint = node('p', 'hint', 'This changes the name in the desktop Herdr session too.');
    const cancel = node('button', 'secondary', 'Cancel'), save = node('button', 'primary', 'Save'); cancel.type = 'button'; save.type = 'submit'; cancel.onclick = () => modal.close();
    actions.append(cancel, save); form.append(title, input, hint, error, actions); modal.append(form); document.body.append(modal);
    modal.onclose = () => modal.remove();
    form.onsubmit = async event => {
      event.preventDefault(); save.disabled = true;
      try { await this.host.api('api/herdr/action', { action: agent.space ? 'rename-space' : 'rename', terminalId: agent.terminalId, workspaceId: agent.space?.id, name: herdrName(input.value) }); this.receive({ type: 'snapshot', snapshot: await this.host.api('api/herdr/snapshot') }); modal.close(); }
      catch (reason: any) { error.textContent = reason.message; } finally { save.disabled = false; }
    };
    modal.showModal(); input.focus(); input.select();
  }
  applySettings() { this.ensureSelection(); this.save(); this.render(); this.mountTerminal(); this.post({ type: 'settings-changed' }); }
  private currentNotifications(): HerdrNotification[] {
    const receipts: HerdrNotification[] = [], states = this.tracker.checkpoint();
    for (const agent of this.tracker.agents) {
      if (agent.status === 'blocked') receipts.push({ terminalId: agent.terminalId, kind: 'request', sequence: agent.sequence });
      else if ((agent.status === 'idle' || agent.status === 'done') && states[agent.terminalId]?.completion !== undefined) receipts.push({ terminalId: agent.terminalId, kind: 'done', sequence: states[agent.terminalId].completion! });
    }
    return receipts;
  }
  private acknowledge(events: HerdrNotification[]) {
    const device = this.host.notificationDevice?.();
    if (device && this.ws?.readyState === WebSocket.OPEN && !document.hidden && document.hasFocus()) for (const event of events) this.ws.send(JSON.stringify({ type: 'notification-ack', device, event }));
  }
  updatePresence() {
    const device = this.host.notificationDevice?.();
    if (device && this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ type: 'notification-presence', device, focused: !document.hidden && document.hasFocus() }));
      if (device !== this.presenceDevice) { this.presenceDevice = device; this.acknowledge(this.currentNotifications()); }
    }
  }
  openTerminal(id: string) { if (this.terminals.some(agent => agent.terminalId === id)) this.selectTerminal(id); else this.requestedTerminal = id; }
  copySelection() { this.post({ type: 'settings-action', action: 'copy-selection' }); }
  dispose() {
    if (this.disposed) return; this.disposed = true;
    clearTimeout(this.reconnect); clearInterval(this.presenceTimer); this.ws?.close(); this.frame?.remove(); this.element.remove();
    for (const unsubscribe of this.unsubscribers) unsubscribe();
  }
}
