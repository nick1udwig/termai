import './workspace.css';
import { BrowserVault } from './browser-vault.ts';
import type { BrowserKeyInfo } from './browser-key.ts';
import { defaults, validateShortcuts } from './shortcuts.ts';
import { shortcutEditor } from './shortcut-editor.ts';
import { backendURL, sshAddress, type BackendProfile, type HostProfile, type TerminalTab, type KeyInfo, type KnownHost, type SSHConnection } from './connections.ts';
const browserVault = new BrowserVault();
const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const input = (id: string) => $<HTMLInputElement>(id);
const select = (id: string) => $<HTMLSelectElement>(id);
const dialog = (id: string) => $<HTMLDialogElement>(id);
const primary: BackendProfile = { id: 'primary', name: 'Primary backend', url: new URL('.', document.baseURI).href };
function saved<T>(key: string, fallback: T): T { try { const value = JSON.parse(localStorage.getItem('termai.' + key) || 'null'); return value === null || (Array.isArray(fallback) ? !Array.isArray(value) : typeof value !== typeof fallback) ? fallback : value; } catch { return fallback; } }
let backends: BackendProfile[] = saved<BackendProfile[]>('backends', []).filter(b => { try { return b && typeof b.id === 'string' && b.id !== 'primary' && typeof b.name === 'string' && backendURL(b.url) === b.url; } catch { return false; } });
backends.unshift(primary);
let hosts: HostProfile[] = saved<HostProfile[]>('hosts', [{ id: 'local', name: 'This machine', kind: 'http', backendId: 'primary' }]).filter(h => h && typeof h.id === 'string' && typeof h.name === 'string' && ['http', 'ssh'].includes(h.kind) && backends.some(b => b.id === h.backendId));
let tabs: TerminalTab[] = saved<TerminalTab[]>('tabs', []).filter(t => t && typeof t.id === 'string' && typeof t.name === 'string' && backends.some(b => b.id === t.backendId) && (t.session === 'default' || /^[a-f0-9-]{36}$/.test(t.session)));
let active = saved<string>('activeTab', '') || tabs[0]?.id || '';
let page: 'terminal' | 'hosts' | 'vault' | 'keychain' | 'backends' | 'known' | 'settings' = 'terminal';
let alphabetical = false, editingHost: string | undefined, keyDetail: { backend?: BackendProfile; key: KeyInfo | BrowserKeyInfo } | undefined;
const frames = new Map<string, HTMLIFrameElement>(), tokens = new Map<string, string>(), vaults = new Map<string, { keys: KeyInfo[]; knownHosts: KnownHost[] }>();
const authenticating = new Map<string, Promise<void>>();
let notification: ReturnType<typeof setTimeout>;
function notice(message: string) { $('notice').textContent = message; $('notice').hidden = false; clearTimeout(notification); notification = setTimeout(() => $('notice').hidden = true, 6000); }
function store() { try { for (const [key, value] of Object.entries({ backends: backends.filter(b => b.id !== 'primary'), hosts, tabs, activeTab: active })) localStorage.setItem('termai.' + key, JSON.stringify(value)); } catch { notice('Browser storage is unavailable. Connections will last for this page only.'); } }
function tokenFor(backend: BackendProfile) { if (tokens.has(backend.id)) return tokens.get(backend.id); try { return sessionStorage.getItem('termai.access:' + backend.url) || undefined; } catch { return undefined; } }
async function api<T>(backend: BackendProfile, name: string, data?: unknown, session?: string, recoverAuth = true): Promise<T> {
  const url = new URL(name, backend.url); if (session) url.searchParams.set('session', session);
  const token = tokenFor(backend);
  const response = await fetch(url, { method: data === undefined ? 'GET' : 'POST', cache: 'no-store', credentials: 'same-origin', signal: AbortSignal.timeout(['api/sessions', 'api/ssh/captured'].includes(name) ? 25000 : 12000),
    headers: { ...(token ? { Authorization: 'Bearer ' + token } : {}), ...(data === undefined ? {} : { 'Content-Type': 'application/json' }) }, ...(data === undefined ? {} : { body: JSON.stringify(data) }) });
  const result = await response.json();
  // A backend restart invalidates access tokens while the workspace can stay open.
  // Retry only an explicit authentication rejection: the server has not performed
  // the requested action. Never replay a timeout or an uncertain connection failure.
  if (response.status === 401 && name !== 'api/connect' && recoverAuth) {
    if (tokenFor(backend) === token) await authenticate(backend, true);
    else await authenticating.get(backend.id); // Another request may already be refreshing it.
    return api<T>(backend, name, data, session, false);
  }
  if (!response.ok) throw Object.assign(new Error(result.error || 'Request failed'), result, { status: response.status });
  return result;
}
let loginQueue: Promise<unknown> = Promise.resolve();
function authenticate(backend: BackendProfile, force = false): Promise<void> {
  if (!force && tokens.has(backend.id)) return Promise.resolve();
  if (authenticating.has(backend.id)) return authenticating.get(backend.id)!;
  const work = (async () => {
    if (force) { tokens.delete(backend.id); try { sessionStorage.removeItem('termai.access:' + backend.url); } catch {} }
    const save = (accessToken: string) => { tokens.set(backend.id, accessToken); try { sessionStorage.setItem('termai.access:' + backend.url, accessToken); } catch {} };
    try { const result = await api<{ accessToken: string }>(backend, 'api/connect', { noSession: true }); save(result.accessToken); return; }
    catch (error: any) { if (error.status !== 401) throw new Error(`Cannot reach ${backend.name}. Check its URL, network access, and allowed frontend origin.`); }
    const prompt = loginQueue.then(() => new Promise<void>((resolve, reject) => {
      $('backend-login-name').textContent = backend.name + ' · ' + backend.url; $('backend-login-error').textContent = ''; input('backend-token').value = '';
      const modal = dialog('backend-login');
      const close = () => { modal.removeEventListener('close', close); reject(new Error('Backend login cancelled.')); };
      modal.addEventListener('close', close);
      $<HTMLFormElement>('backend-login-form').onsubmit = async event => {
        event.preventDefault();
        try { const result = await api<{ accessToken: string }>(backend, 'api/connect', { noSession: true, token: input('backend-token').value }); save(result.accessToken); input('backend-token').value = ''; modal.removeEventListener('close', close); modal.close(); resolve(); }
        catch (error: any) { $('backend-login-error').textContent = error.message; }
      };
      modal.showModal();
    }));
    loginQueue = prompt.catch(() => {}); await prompt;
  })().finally(() => authenticating.delete(backend.id));
  authenticating.set(backend.id, work); return work;
}
const backendFor = (id: string) => backends.find(b => b.id === id)!;
function populate(id: string, selected = 'primary', extra = false, browser = false) {
  const element = select(id); element.replaceChildren();
  if (browser) element.add(new Option('This browser', 'browser'));
  for (const backend of backends) element.add(new Option(backend.name, backend.id));
  if (extra) element.add(new Option('New direct backend…', 'new'));
  element.value = selected; if (!element.value) element.value = browser ? 'browser' : 'primary';
}
function show(view: typeof page) {
  closeHostMenu();
  const previous = page; page = view; for (const [id, frame] of frames) frame.contentWindow?.postMessage({ type: 'tab-visibility', visible: id === active && view === 'terminal' }, location.origin); const terminal = view === 'terminal';
  $('terminal-header').hidden = !terminal; $('terminal-stack').hidden = !terminal; $('library').hidden = terminal;
  if (terminal) { renderTabs(); return; }
  $('settings-pane').hidden = view !== 'settings'; $('library-content').hidden = view === 'settings';
  for (const [id, selected] of [['nav-vault', view !== 'settings'], ['nav-settings', view === 'settings']] as const) { if (selected) $(id).setAttribute('aria-current', 'page'); else $(id).removeAttribute('aria-current'); }
  $('page-title').textContent = { settings: 'Settings', hosts: 'Hosts', vault: 'Vault', keychain: 'Keychain', backends: 'Backends', known: 'Known hosts' }[view];
  $('page-back').querySelector('span')!.textContent = ['vault', 'settings'].includes(view) ? 'Terminal' : 'Vault';
  $('sort-hosts').hidden = !['hosts', 'keychain'].includes(view);
  $('search-label').hidden = ['vault', 'settings'].includes(view); input('search').placeholder = 'Search ' + $('page-title').textContent!.toLowerCase(); input('search').value = '';
  $('backend-filter-label').hidden = !['keychain', 'known'].includes(view); populate('backend-filter', view === 'keychain' && previous !== 'keychain' ? 'browser' : select('backend-filter').value || 'primary', false, view === 'keychain');
  $('library-add').hidden = ['vault', 'known', 'settings'].includes(view); $('library-add').setAttribute('aria-label', view === 'keychain' ? 'Add SSH key' : view === 'backends' ? 'Add backend' : 'Add host');
  if (view === 'settings') { renderSettings(); return; }
  void renderCards();
}
function button(text: string, action: () => void, className = '') { const b = document.createElement('button'); b.type = 'button'; b.textContent = text; b.className = className; b.onclick = action; return b; }
function card(name: string, detail: string, icon: string, action: () => void, edit?: () => void, badge?: string) {
  const row = document.createElement('div'); row.className = 'card';
  const main = button('', action, 'card-main'), glyph = document.createElement('span'); glyph.className = 'card-icon'; glyph.textContent = icon; glyph.setAttribute('aria-hidden', 'true');
  const text = document.createElement('span'); text.className = 'card-text';
  const title = document.createElement('span'); title.className = 'card-name'; title.textContent = name;
  if (badge) { const tag = document.createElement('span'); tag.className = 'badge'; tag.textContent = badge; title.append(document.createTextNode(' '), tag); }
  const subtitle = document.createElement('span'); subtitle.className = 'card-detail'; subtitle.textContent = detail;
  text.append(title, subtitle); main.append(glyph, text); row.append(main);
  if (edit) { const b = button('•••', edit, 'card-edit'); b.setAttribute('aria-label', 'Edit ' + name); row.append(b); }
  $('cards').append(row); return row;
}
function hostTabs(host: HostProfile) { return tabs.filter(tab => tab.hostId === host.id && !tab.ended); }
function tabLabel(tab: TerminalTab) {
  const peers = tabs.filter(other => other.hostId === tab.hostId && other.name === tab.name);
  const index = peers.indexOf(tab); return index > 0 ? `${tab.name} (${index + 1})` : tab.name;
}
const hostMenu = document.createElement('div'); hostMenu.id = 'host-terminal-menu'; hostMenu.className = 'host-terminal-menu'; hostMenu.role = 'menu'; hostMenu.hidden = true; document.body.append(hostMenu);
let menuAnchor: HTMLButtonElement | undefined;
function closeHostMenu(focus = false) {
  hostMenu.hidden = true; menuAnchor?.setAttribute('aria-expanded', 'false');
  if (focus) menuAnchor?.focus(); menuAnchor = undefined;
}
function openHostMenu(host: HostProfile, anchor: HTMLButtonElement) {
  if (menuAnchor === anchor) { closeHostMenu(true); return; }
  closeHostMenu(); menuAnchor = anchor; anchor.setAttribute('aria-expanded', 'true'); hostMenu.replaceChildren();
  hostMenu.setAttribute('aria-label', host.name + ' terminals');
  const item = (label: string, action: () => void) => {
    const control = button(label, () => { closeHostMenu(); action(); }); control.role = 'menuitem'; control.setAttribute('aria-label', label); hostMenu.append(control); return control;
  };
  item('Connect new terminal', () => void openHost(host, true).catch(error => notice(error.message)));
  const open = hostTabs(host);
  if (open.length) {
    hostMenu.append(document.createElement('hr'));
    for (const tab of open) {
      const control = item(tabLabel(tab), () => activate(tab.id));
      if (tab.id === active) { control.classList.add('current'); control.setAttribute('aria-current', 'true'); }
    }
  }
  hostMenu.append(document.createElement('hr')); item('Edit host', () => editHost(host));
  hostMenu.hidden = false;
  const rect = anchor.getBoundingClientRect(), viewport = window.visualViewport;
  const left = viewport?.offsetLeft || 0, top = viewport?.offsetTop || 0, width = viewport?.width || innerWidth, height = viewport?.height || innerHeight;
  hostMenu.style.maxHeight = `${height - 24}px`;
  const size = hostMenu.getBoundingClientRect();
  hostMenu.style.left = `${Math.max(left + 12, Math.min(rect.right - size.width, left + width - size.width - 12))}px`;
  hostMenu.style.top = `${Math.max(top + 12, Math.min(rect.bottom + 4, top + height - size.height - 12))}px`;
  hostMenu.querySelector('button')?.focus();
}
hostMenu.onkeydown = event => {
  if (event.key === 'Escape') { event.preventDefault(); closeHostMenu(true); return; }
  if (event.key === 'Tab') { closeHostMenu(true); return; }
  if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
  event.preventDefault(); const items = [...hostMenu.querySelectorAll('button')], index = items.indexOf(document.activeElement as HTMLButtonElement);
  items[event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : (index + (event.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length]?.focus();
};
document.addEventListener('pointerdown', event => { if (!hostMenu.contains(event.target as Node) && !menuAnchor?.contains(event.target as Node)) closeHostMenu(); });
$('library-content').addEventListener('scroll', () => closeHostMenu(), { passive: true });
window.addEventListener('resize', () => closeHostMenu());
let rendering = 0;
async function renderCards() {
  closeHostMenu();
  const generation = ++rendering; $('cards').replaceChildren(); $('list-empty').hidden = true;
  const query = input('search').value.trim().toLowerCase();
  const matches = (value: string) => value.toLowerCase().includes(query);
  const items = <T extends { name: string }>(values: T[]) => alphabetical ? [...values].sort((a, b) => a.name.localeCompare(b.name)) : values;
  $('list-heading').textContent = { terminal: '', settings: '', hosts: 'Saved hosts', vault: 'Your workspace', keychain: 'SSH keys', backends: 'Direct backends', known: 'Verified fingerprints' }[page];
  if (page === 'vault') {
    for (const [name, detail, icon, view] of [['Hosts', `${hosts.length} saved`, '▤', 'hosts'], ['Keychain', 'Encrypted SSH keys', '⚿', 'keychain'], ['Backends', `${backends.length} available`, '⌘', 'backends'], ['Known hosts', 'SSH host fingerprints', '◎', 'known']] as const) card(name, detail, icon, () => show(view)).classList.add('vault-card');
  } else if (page === 'hosts') {
    for (const host of items(hosts).filter(h => matches(h.name + ' ' + (h.hostname || backendFor(h.backendId).url)))) {
      const row = card(host.name, host.kind === 'ssh' ? `${host.username}@${host.hostname} · ${host.route === 'fixed' ? backendFor(host.backendId).name : 'Automatic route'}` : backendFor(host.backendId).url, '▤', () => void openHost(host).catch(error => notice(error.message)), undefined, host.kind.toUpperCase());
      const count = hostTabs(host).length, menu = button('', () => openHostMenu(host, menu), 'host-terminals');
      menu.setAttribute('aria-label', `Terminals for ${host.name} (${count} open)`); menu.setAttribute('aria-haspopup', 'menu'); menu.setAttribute('aria-expanded', 'false'); menu.setAttribute('aria-controls', hostMenu.id);
      const number = document.createElement('span'); number.className = 'host-terminal-count'; number.textContent = String(count);
      const arrow = document.createElement('span'); arrow.textContent = '▾'; arrow.setAttribute('aria-hidden', 'true'); menu.append(number, arrow); row.append(menu);
    }
  } else if (page === 'backends') {
    for (const backend of backends.filter(b => matches(b.name + ' ' + b.url))) card(backend.name, backend.url, '⌘', () => void authenticate(backend).then(() => notice('Connected to ' + backend.name)).catch(error => notice(error.message)), backend.id === 'primary' ? undefined : () => {
      if (tabs.some(t => t.backendId === backend.id)) { notice('Close this backend’s terminal tabs before removing it.'); return; }
      if (confirm('Remove this backend and its saved hosts? Its SSH keys will stay on the server.')) { backends = backends.filter(b => b.id !== backend.id); hosts = hosts.filter(h => h.backendId !== backend.id); routes.clear(); tokens.delete(backend.id); try { sessionStorage.removeItem('termai.access:' + backend.url); } catch {} store(); void renderCards(); }
    }, 'HTTP');
  } else if (page === 'keychain' || page === 'known') {
    const backend = backendFor(select('backend-filter').value);
    try {
      if (page === 'keychain' && select('backend-filter').value === 'browser') {
        const keys = await browserVault.list(); if (generation !== rendering) return;
        for (const key of items(keys).filter(k => matches(k.name))) card(key.name, key.publicKey.split(' ')[0].replace('ssh-', '').toUpperCase() + ' · This browser', '⚿', () => keyDetails(undefined, key));
      } else {
        await authenticate(backend); const vault = await api<{ keys: KeyInfo[]; knownHosts: KnownHost[] }>(backend, 'api/keychain'); vaults.set(backend.id, vault);
        if (generation !== rendering) return;
        if (page === 'keychain') for (const key of items(vault.keys).filter(k => matches(k.name))) card(key.name, key.publicKey.split(' ')[0].replace('ssh-', '').toUpperCase() + ' · ' + (key.reference ? key.reference.type === 'file' ? 'Backend file' : 'Backend agent' : backend.name), '⚿', () => keyDetails(backend, key));
        else for (const item of vault.knownHosts.filter(k => matches(k.host))) card(item.host + ':' + item.port, item.fingerprint, '◎', () => notice(item.fingerprint), () => {
          if (confirm('Forget this SSH host fingerprint? Verify its identity again before your next connection.')) void api(backend, 'api/keychain', { action: 'forget', host: item.host, port: item.port }).then(() => renderCards()).catch(error => notice(error.message));
        });
      }
    } catch (error: any) { if (generation === rendering) notice(error.message); }
  }
  if (!$('cards').children.length) { $('list-empty').textContent = query ? 'No matches.' : page === 'keychain' ? 'Add an SSH key to connect securely. New keys are stored encrypted in this browser.' : page === 'known' ? 'Verified SSH hosts will appear here after you connect.' : 'Add a host to open your next terminal.'; $('list-empty').hidden = false; }
}
function renderTabs() {
  $('tabs').replaceChildren();
  for (const tab of tabs) {
    const el = document.createElement('div'); el.className = 'tab'; el.role = 'tab'; el.tabIndex = tab.id === active ? 0 : -1; el.setAttribute('aria-selected', String(tab.id === active)); el.setAttribute('aria-controls', 'frame-' + tab.id); el.title = tabLabel(tab) + ' · ' + backendFor(tab.backendId).name;
    const icon = document.createElement('span'); icon.className = 'tab-icon'; icon.textContent = '▤'; const name = document.createElement('span'); name.className = 'tab-name'; name.textContent = tabLabel(tab);
    const close = button('×', () => void closeTab(tab).catch(error => notice(error.message)), 'tab-close'); close.setAttribute('aria-label', 'Close ' + tab.name); close.addEventListener('click', event => event.stopPropagation());
    el.append(icon, name, close); el.onclick = () => activate(tab.id); el.onkeydown = event => {
      if (['Enter', ' '].includes(event.key)) { event.preventDefault(); activate(tab.id); }
      if (['ArrowLeft', 'ArrowRight'].includes(event.key)) { event.preventDefault(); const index = tabs.indexOf(tab), next = tabs[(index + (event.key === 'ArrowRight' ? 1 : tabs.length - 1)) % tabs.length]; activate(next.id); ($('tabs').querySelector('[aria-selected=true]') as HTMLElement)?.focus(); }
    }; $('tabs').append(el);
  }
  for (const [id, frame] of frames) { frame.hidden = id !== active; frame.contentWindow?.postMessage({ type: 'tab-visibility', visible: id === active && page === 'terminal' }, location.origin); }
  $('empty-terminal').hidden = !!tabs.length;
  requestAnimationFrame(() => $('tabs').querySelector('[aria-selected=true]')?.scrollIntoView({ block: 'nearest', inline: 'nearest' }));
}
function activate(id: string) { const tab = tabs.find(tab => tab.id === id); if (tab) tab.lastUsed = Date.now(); active = id; store(); show('terminal'); frames.get(id)?.contentWindow?.postMessage({ type: 'focus-terminal' }, location.origin); }
async function mount(tab: TerminalTab) {
  const backend = backendFor(tab.backendId);
  if (frames.has(tab.id) || !tabs.some(t => t.id === tab.id)) return;
  const frame = document.createElement('iframe'); frame.title = tab.name + ' terminal'; frame.id = 'frame-' + tab.id; frame.allow = 'clipboard-read; clipboard-write';
  const url = new URL('terminal.html', document.baseURI); url.search = new URLSearchParams({ embedded: '1', backend: backend.url, session: tab.session }).toString();
  frame.src = url.href; frames.set(tab.id, frame); $('terminal-stack').append(frame); renderTabs();
}
async function addTerminal(backend: BackendProfile, session: string, name: string, hostId?: string, parentTabId?: string) {
  const names = new Set(tabs.filter(tab => tab.hostId === hostId).map(tabLabel));
  const base = name; for (let n = 2; names.has(name); n++) name = `${base} (${n})`;
  const tab = { id: crypto.randomUUID(), backendId: backend.id, session, name, hostId, parentTabId, lastUsed: Date.now() }; tabs.push(tab); active = tab.id; store(); show('terminal'); await mount(tab);
}
async function closeTab(tab: TerminalTab) {
  if (!confirm('Close ' + tab.name + '? Running programs in this terminal will stop.')) return;
  const backend = backendFor(tab.backendId); await authenticate(backend); await api(backend, 'api/sessions/close', {}, tab.session);
  frames.get(tab.id)?.remove(); frames.delete(tab.id); const index = tabs.indexOf(tab); tabs = tabs.filter(t => t.id !== tab.id);
  if (active === tab.id) active = tabs.find(t => t.id === tab.parentTabId)?.id || tabs[Math.min(index, tabs.length - 1)]?.id || '';
  store(); renderTabs(); if (!tabs.length) { $('empty-terminal').querySelector('p')!.textContent = 'Open a saved host to start a terminal.'; }
}
window.addEventListener('message', event => {
  if (event.origin !== location.origin) return;
  const entry = [...frames].find(([, frame]) => frame.contentWindow === event.source); if (!entry) return;
  const tab = tabs.find(tab => tab.id === entry[0]); if (!tab) return;
  const backend = backendFor(tab.backendId), frame = entry[1];
  if (event.data?.type === 'terminal-authorized' && typeof event.data.accessToken === 'string' && /^[a-f0-9]{64}$/.test(event.data.accessToken)) { tokens.set(backend.id, event.data.accessToken); try { sessionStorage.setItem('termai.access:' + backend.url, event.data.accessToken); } catch {} }
  if (event.data?.type === 'terminal-loaded') { frame.contentWindow!.postMessage({ type: 'authorize', accessToken: tokenFor(backend) }, location.origin); frame.contentWindow!.postMessage({ type: 'tab-visibility', visible: tab.id === active && page === 'terminal' }, location.origin); }
  if (event.data?.type === 'terminal-locked') void authenticate(backend, true).then(() => frame.contentWindow?.postMessage({ type: 'authorize', accessToken: tokenFor(backend) }, location.origin)).catch(error => notice(error.message));
  if (event.data?.type === 'ssh-command' && typeof event.data.id === 'string' && typeof event.data.command === 'string') void capturedSSH(backend, tab, event.data.id, event.data.command);
  if (event.data?.type === 'terminal-notice' && typeof event.data.message === 'string') notice(event.data.message);
  if (event.data?.type === 'terminal-ended' || (event.data?.type === 'terminal-state' && typeof event.data.state?.exited === 'boolean')) {
    const ended = event.data.type === 'terminal-ended' || event.data.state.exited;
    if (ended && !tab.ended && active === tab.id && tabs.some(parent => parent.id === tab.parentTabId)) activate(tab.parentTabId!);
    if (!!tab.ended !== ended) { tab.ended = ended; store(); if (page === 'hosts') void renderCards(); }
    if (event.data.type === 'terminal-ended') notice(tab.name + ' has ended. Open its saved host to reconnect.');
  }
});
const captureRequests = new Set<string>();
let captureQueue: Promise<unknown> = Promise.resolve();
function capturedSSH(backend: BackendProfile, parent: TerminalTab, id: string, command: string) {
  const key = backend.id + ':' + id; if (captureRequests.has(key)) return; captureRequests.add(key);
  const work = captureQueue.then(async () => {
    const request = (data: object) => api<{ native?: boolean; message?: string; id: string; name: string; host: string; port: number; username: string; key?: KeyInfo }>(backend, 'api/ssh/captured', { id, ...data }, parent.session);
    let trust: string | undefined;
    const attempt = async (passphrase?: string) => {
      let result;
      try { result = await request({ passphrase, trust }); }
      catch (error: any) {
        if (error.status !== 409 || !error.fingerprint || error.changed) throw error;
        if (!confirm(`Verify the SSH host fingerprint through ${backend.name}:\n\n${error.fingerprint}\n\nTrust this host and connect?`)) { await request({ action: 'cancel' }); return true; }
        trust = error.fingerprint; result = await request({ passphrase, trust });
      }
      if (result.native) { await request({ action: 'ack' }); if (result.message) notice(result.message); return true; }
      const existing = tabs.find(tab => tab.backendId === backend.id && tab.session === result.id);
      if (existing) { activate(existing.id); await request({ action: 'ack' }); return true; }
      let host = hosts.find(h => h.kind === 'ssh' && h.backendId === backend.id && h.hostname === result.host && h.port === result.port && h.username === result.username);
      if (!host) { host = { id: crypto.randomUUID(), name: result.name, kind: 'ssh', backendId: backend.id, hostname: result.host, port: result.port, username: result.username, route: 'fixed' }; hosts.push(host); }
      if (result.key) { host.keyFingerprint = result.key.fingerprint; host.backendKeyId = result.key.reference ? result.key.id : undefined; host.browserKeyId = undefined; }
      store(); await addTerminal(backend, result.id, host.name, host.id, parent.id); await request({ action: 'ack' }); return true;
    };
    try { await attempt(); return; } catch (error: any) {
      $('captured-ssh-error').textContent = error.message;
      $('captured-ssh-secret-label').hidden = !error.needsSecret;
      input('captured-ssh-secret').required = !!error.needsSecret;
    }
    await new Promise<void>(resolve => {
      const modal = dialog('captured-ssh-dialog'); $('captured-ssh-command').textContent = command; input('captured-ssh-secret').value = '';
      const controls = [...modal.querySelectorAll<HTMLButtonElement>('button')];
      const finish = () => { input('captured-ssh-secret').value = ''; modal.close(); resolve(); };
      const act = async (action: () => Promise<unknown>) => {
        controls.forEach(button => button.disabled = true);
        try { await action(); finish(); } catch (error: any) { $('captured-ssh-error').textContent = error.message; $('captured-ssh-secret-label').hidden = !error.needsSecret; input('captured-ssh-secret').required = !!error.needsSecret; }
        finally { input('captured-ssh-secret').value = ''; controls.forEach(button => button.disabled = false); }
      };
      $<HTMLFormElement>('captured-ssh-form').onsubmit = event => { event.preventDefault(); void act(() => attempt(input('captured-ssh-secret').value || undefined)); };
      $('captured-ssh-cancel').onclick = () => void act(() => request({ action: 'cancel' }));
      $('captured-ssh-native').onclick = () => void act(() => request({ action: 'native' }));
      modal.oncancel = event => { event.preventDefault(); if (!controls[0].disabled) $('captured-ssh-cancel').click(); };
      modal.showModal();
    });
  }).catch(error => { captureRequests.delete(key); notice(error.message); });
  captureQueue = work; return work;
}
function editHost(host?: HostProfile) {
  editingHost = host?.id; $('host-dialog-title').textContent = host ? 'Edit host' : 'New host'; input('host-name').value = host?.name || ''; select('host-kind').value = host?.kind || 'http';
  populate('host-backend', host?.backendId || 'primary', true); input('host-url').value = backendFor(host?.backendId || 'primary').url;
  input('host-address').value = host?.hostname || ''; input('host-user').value = host?.username || ''; input('host-port').value = String(host?.port || 22); select('host-route').value = host?.route || 'auto';
  $('delete-host').hidden = !host; $('host-error').textContent = ''; hostFields(); dialog('host-dialog').showModal();
}
function hostFields() {
  const ssh = select('host-kind').value === 'ssh'; $('direct-fields').hidden = ssh; $('ssh-fields').hidden = !ssh;
  input('host-url').required = !ssh; input('host-address').required = input('host-user').required = ssh;
  const newOption = select('host-backend').querySelector<HTMLOptionElement>('option[value=new]')!; newOption.disabled = ssh;
  if (ssh && select('host-backend').value === 'new') select('host-backend').value = 'primary';
}
select('host-kind').onchange = hostFields;
select('host-backend').onchange = () => { input('host-url').value = select('host-backend').value === 'new' ? '' : backendFor(select('host-backend').value).url; };
$<HTMLFormElement>('host-form').onsubmit = event => {
  event.preventDefault();
  try {
    const name = input('host-name').value.trim(); if (!name) throw new Error('Name this host.');
    const kind = select('host-kind').value as HostProfile['kind']; let backendId = select('host-backend').value;
    if (kind === 'http') { const url = backendURL(input('host-url').value); let backend = backends.find(b => b.url === url); if (!backend) { backend = { id: crypto.randomUUID(), name, url }; backends.push(backend); } backendId = backend.id; }
    const host: HostProfile = { id: editingHost || crypto.randomUUID(), name, kind, backendId };
    if (kind === 'ssh') { const address = sshAddress({ host: input('host-address').value, username: input('host-user').value, port: Number(input('host-port').value) }); Object.assign(host, { hostname: address.host, username: address.username, port: address.port, route: select('host-route').value }); }
    const index = hosts.findIndex(h => h.id === editingHost); if (index >= 0) { host.keyFingerprint = hosts[index].keyFingerprint; host.browserKeyId = hosts[index].browserKeyId; host.backendKeyId = hosts[index].backendKeyId; hosts[index] = host; } else hosts.push(host);
    routes.clear(); store(); dialog('host-dialog').close(); show('hosts');
  } catch (error: any) { $('host-error').textContent = error.message; }
};
$('delete-host').onclick = () => { if (confirm('Delete this saved host? Open terminals will keep running.')) { hosts = hosts.filter(h => h.id !== editingHost); routes.clear(); store(); dialog('host-dialog').close(); void renderCards(); } };
$<HTMLFormElement>('backend-form').onsubmit = event => {
  event.preventDefault(); try { const url = backendURL(input('backend-url').value); if (backends.some(b => b.url === url)) throw new Error('This backend is already saved.'); backends.push({ id: crypto.randomUUID(), name: input('backend-name').value.trim(), url }); store(); dialog('backend-dialog').close(); void renderCards(); } catch (error: any) { $('backend-error').textContent = error.message; }
};
let sshHost: HostProfile | undefined;
const keyValue = (key: KeyInfo) => key.reference ? 'backend:' + key.id : key.fingerprint;
const selectedBackendKey = () => vaults.get(sshHost?.backendId || '')?.keys.find(key => keyValue(key) === select('ssh-key').value);
let selectedRoute: { backend: BackendProfile; keyId?: string } | undefined, routeGeneration = 0;
const openingHosts = new Map<string, Promise<void>>();
async function openHost(host: HostProfile, createNew = false) {
  if (!createNew) {
    const open = hostTabs(host), existing = open.find(tab => tab.id === active) || open.sort((a, b) => (b.lastUsed || 0) - (a.lastUsed || 0))[0];
    if (existing) { activate(existing.id); return; }
  }
  if (openingHosts.has(host.id)) return openingHosts.get(host.id);
  const work = connectHost(host).finally(() => openingHosts.delete(host.id)); openingHosts.set(host.id, work); return work;
}
async function connectHost(host: HostProfile) {
  const backend = backendFor(host.backendId); await authenticate(backend);
  if (host.kind === 'http') { const result = await api<{ id: string }>(backend, 'api/sessions', { name: host.name }); await addTerminal(backend, result.id, host.name, host.id); return; }
  const vault = await api<{ keys: KeyInfo[]; knownHosts: KnownHost[] }>(backend, 'api/keychain'); vaults.set(backend.id, vault); sshHost = host;
  $('ssh-title').textContent = host.name; $('ssh-destination').textContent = `${host.username}@${host.hostname}:${host.port} · ${backend.name}`;
  select('ssh-key').replaceChildren(); const browserKeys = await browserVault.list();
  for (const key of browserKeys) select('ssh-key').add(new Option(key.name + ' · This browser', 'browser:' + key.id));
  for (const key of vault.keys) select('ssh-key').add(new Option(key.name + ' · ' + (key.reference ? key.reference.type === 'file' ? 'Backend file' : 'Backend agent' : backend.name), keyValue(key))); select('ssh-key').add(new Option('Account password', 'password'));
  const preferred = browserKeys.find(k => k.id === host.browserKeyId) || browserKeys.find(k => k.fingerprint === host.keyFingerprint);
  if (host.backendKeyId && vault.keys.some(key => key.id === host.backendKeyId)) select('ssh-key').value = keyValue(vault.keys.find(key => key.id === host.backendKeyId)!);
  else if (preferred) select('ssh-key').value = 'browser:' + preferred.id;
  else if (host.keyFingerprint && vault.keys.some(k => k.fingerprint === host.keyFingerprint)) select('ssh-key').value = keyValue(vault.keys.find(key => key.fingerprint === host.keyFingerprint)!);
  input('ssh-secret').value = ''; input('ssh-show-secret').checked = false; input('ssh-secret').type = 'password'; $('ssh-error').textContent = ''; $('ssh-progress').textContent = ''; sshSecretLabel();
  if (selectedBackendKey()?.reference) {
    await prepareRoute(); if (selectedRoute) { await connectSSH(); return; }
  }
  dialog('ssh-dialog').showModal(); void prepareRoute();
}
function sshSecretLabel() { input('ssh-secret').required = !selectedBackendKey()?.reference; $('ssh-secret-label').textContent = select('ssh-key').value === 'password' ? 'Account password' : 'Key passphrase'; }
select('ssh-key').onchange = () => { sshSecretLabel(); input('ssh-secret').value = ''; void prepareRoute(); };
input('ssh-show-secret').onchange = () => input('ssh-secret').type = input('ssh-show-secret').checked ? 'text' : 'password';
const routes = new Map<string, { at: number; backend: BackendProfile; keyId?: string }>();
async function chooseRoute(host: HostProfile, keyFingerprint: string): Promise<{ backend: BackendProfile; keyId?: string }> {
  const selected = backendFor(host.backendId), localKey = vaults.get(selected.id)?.keys.find(k => keyValue(k) === keyFingerprint);
  const portable = keyFingerprint === 'password' || keyFingerprint.startsWith('browser:');
  if (!portable && !localKey) throw new Error('Choose a key on this backend.');
  if (host.route === 'fixed' || localKey?.reference) return { backend: selected, keyId: localKey?.id };
  const key = JSON.stringify([host.id, keyFingerprint]), cached = routes.get(key); if (cached && Date.now() - cached.at < 60000) return cached;
  const candidates = backends.filter(b => b.id === selected.id || !!tokenFor(b));
  const measurements = await Promise.all(candidates.map(async backend => {
    try {
      const matching = portable ? undefined : (await api<{ keys: KeyInfo[] }>(backend, 'api/keychain')).keys.find(k => keyValue(k) === keyFingerprint); if (!portable && !matching) return;
      const samples: number[] = [];
      for (let i = 0; i < 2; i++) { const start = performance.now(); await api(backend, 'api/ssh/probe', { host: host.hostname, port: host.port, username: host.username }); samples.push(performance.now() - start); }
      return { backend, keyId: matching?.id, latency: (samples[0] + samples[1]) / 2 };
    } catch { return undefined; }
  }));
  const best = measurements.filter((m): m is NonNullable<typeof m> => !!m).sort((a, b) => a.latency - b.latency)[0];
  if (!best) throw new Error('No connected backend can reach this SSH host with the selected credentials.');
  routes.set(key, { ...best, at: Date.now() }); return best;
}
async function prepareRoute() {
  if (!sshHost) return;
  const generation = ++routeGeneration;
  selectedRoute = undefined; input('ssh-secret').disabled = true; $<HTMLButtonElement>('ssh-connect').disabled = true;
  $('ssh-error').textContent = ''; $('ssh-progress').textContent = 'Measuring available routes…';
  try {
    const route = await chooseRoute(sshHost, select('ssh-key').value);
    if (generation !== routeGeneration) return;
    selectedRoute = route; $('ssh-progress').textContent = 'Connect through ' + route.backend.name;
    $('ssh-secret-label').textContent = select('ssh-key').value === 'password' ? 'Account password' : select('ssh-key').value.startsWith('browser:') ? 'Key passphrase' : 'Key passphrase on ' + route.backend.name;
    input('ssh-secret').disabled = false; $<HTMLButtonElement>('ssh-connect').disabled = false; sshSecretLabel();
  } catch (error: any) { if (generation === routeGeneration) { $('ssh-error').textContent = error.message; $('ssh-progress').textContent = ''; } }
}
$<HTMLFormElement>('ssh-form').onsubmit = event => { event.preventDefault(); void connectSSH(); };
async function connectSSH() {
  if (!sshHost || !selectedRoute) return; const host = sshHost, control = $<HTMLButtonElement>('ssh-connect'); control.disabled = true; $('ssh-error').textContent = ''; $('ssh-progress').textContent = 'Choosing a route…';
  let ssh: SSHConnection | undefined;
  try {
    const selected = select('ssh-key').value, route = selectedRoute;
    $('ssh-progress').textContent = 'Connecting through ' + route.backend.name + '…';
    ssh = { host: host.hostname!, port: host.port!, username: host.username!, ...(selected.startsWith('browser:') ? { privateKey: await browserVault.unlock(selected.slice(8), input('ssh-secret').value), passphrase: input('ssh-secret').value } : route.keyId ? { keyId: route.keyId, passphrase: input('ssh-secret').value } : { password: input('ssh-secret').value }) };
    const create = () => api<{ id: string }>(route.backend, 'api/sessions', { name: host.name, ssh });
    let result;
    try { result = await create(); } catch (error: any) {
      if (error.status !== 409 || !error.fingerprint || error.changed) throw error;
      if (!confirm(`Verify the fingerprint for ${ssh.host}:${ssh.port} through ${route.backend.name}:\n\n${error.fingerprint}\n\nTrust this host and connect?`)) throw new Error('Host verification cancelled.');
      ssh.trust = error.fingerprint; result = await create();
    }
    host.browserKeyId = selected.startsWith('browser:') ? selected.slice(8) : undefined;
    host.backendKeyId = selected.startsWith('backend:') ? selected.slice(8) : undefined;
    host.keyFingerprint = host.backendKeyId ? selectedBackendKey()?.fingerprint : host.browserKeyId ? (await browserVault.list()).find(k => k.id === host.browserKeyId)?.fingerprint : selected === 'password' ? undefined : selected; store(); dialog('ssh-dialog').close();
    await addTerminal(route.backend, result.id, host.name, host.id);
  } catch (error: any) { if (!dialog('ssh-dialog').open) dialog('ssh-dialog').showModal(); if (error.needsSecret) input('ssh-secret').required = true; $('ssh-error').textContent = error.message + (error.changed ? '\nVerify the new fingerprint before removing its Known hosts entry: ' + error.fingerprint : ''); }
  finally { if (ssh) { delete ssh.privateKey; delete ssh.passphrase; delete ssh.password; } input('ssh-secret').value = ''; control.disabled = false; $('ssh-progress').textContent = ''; }
};
function keyDetails(backend: BackendProfile | undefined, key: KeyInfo | BrowserKeyInfo) {
  keyDetail = { backend, key }; input('key-rename').value = key.name; $('key-fingerprint').textContent = key.fingerprint; $<HTMLTextAreaElement>('public-key').value = key.publicKey;
  const backups = 'backups' in key ? key.backups : [];
  $('key-storage').textContent = backend ? key.reference ? backend.name + ' · ' + key.reference.type + ': ' + key.reference.path : 'Stored on ' + backend.name : 'Source of truth: this browser.' + (backups.length ? ' Last backed up to: ' + backups.map(b => b.backendName + ' (' + new Date(b.savedAt).toLocaleDateString() + ')').join(', ') + '.' : ' No device backups yet.');
  for (const id of ['export-key-backup', 'export-private-key', 'backup-key']) $(id).hidden = !!backend;
  $('restore-backend-key').hidden = !backend || !!key.reference;
  $('delete-key').textContent = key.reference ? 'Remove reference' : 'Delete key';
  if (!dialog('key-details').open) dialog('key-details').showModal();
}
function downloadKey(contents: string, name: string, extension: string) {
  const url = URL.createObjectURL(new Blob([contents], { type: 'application/octet-stream' })), link = document.createElement('a');
  link.href = url; link.download = (name.replace(/[^a-zA-Z0-9_-]/g, '_') || 'ssh-key') + extension; link.click(); setTimeout(() => URL.revokeObjectURL(url), 60000);
}
$('copy-key').onclick = () => void navigator.clipboard.writeText($<HTMLTextAreaElement>('public-key').value).then(() => notice('Public key copied.')).catch(() => notice('Select the public key to copy it.'));
$('rename-key').onclick = () => {
  if (!keyDetail) return; const { backend, key } = keyDetail;
  void (backend ? api(backend, 'api/keychain', { action: 'rename', id: key.id, name: input('key-rename').value }) : browserVault.rename(key.id, input('key-rename').value)).then(() => { dialog('key-details').close(); void renderCards(); }).catch(error => notice(error.message));
};
$('delete-key').onclick = () => {
  if (!keyDetail) return; const { backend, key } = keyDetail;
  if (confirm(key.reference ? 'Remove this key reference? Its original file or agent identity will stay unchanged.' : 'Delete this private key from ' + (backend?.name || 'this browser') + '? Copies on other devices and existing SSH sessions will stay.')) void (backend ? api(backend, 'api/keychain', { action: 'delete', id: key.id }) : browserVault.remove(key.id)).then(() => { routes.clear(); dialog('key-details').close(); void renderCards(); }).catch(error => notice(error.message));
};
$('export-key-backup').onclick = () => { if (keyDetail && !keyDetail.backend) { const key = keyDetail.key; void browserVault.export(key.id).then(text => downloadKey(text, key.name, '.termai-key.json')).catch(error => notice(error.message)); } };
let transferMode: 'backup' | 'private' | 'restore' = 'backup';
function openTransfer(mode: typeof transferMode) {
  if (!keyDetail) return; transferMode = mode;
  $('key-transfer-title').textContent = { backup: 'Back up to devices', private: 'Export SSH private key', restore: 'Restore to this browser' }[mode];
  $('key-transfer-hint').textContent = { backup: 'Choose the backends that should keep an encrypted backup. This browser stays the source of truth. Unselected backups are left as they are.', private: 'This exports the original SSH key file. Generated keys are unencrypted in this format. Use “Export encrypted backup” for a password-protected copy.', restore: 'Unlock the backend copy and save it encrypted in this browser. The backend copy will remain as a backup.' }[mode];
  $('backup-devices').replaceChildren();
  if (mode === 'backup') for (const backend of backends) {
    const label = document.createElement('label'); label.className = 'toggle'; const check = document.createElement('input'); check.type = 'checkbox'; check.value = backend.id;
    const exists = 'backups' in keyDetail.key && keyDetail.key.backups.some(b => b.backendURL === backend.url);
    label.append(check, document.createTextNode(backend.name + ' · ' + backend.url + (exists ? ' (refresh backup)' : ''))); $('backup-devices').append(label);
  }
  $('key-transfer-submit').textContent = mode === 'backup' ? 'Back up selected devices' : mode === 'private' ? 'Download private key' : 'Restore key';
  $('key-transfer-error').textContent = ''; input('key-transfer-passphrase').value = ''; dialog('key-transfer').showModal();
}
$('backup-key').onclick = () => openTransfer('backup'); $('export-private-key').onclick = () => openTransfer('private'); $('restore-backend-key').onclick = () => openTransfer('restore');
$<HTMLFormElement>('key-transfer-form').onsubmit = async event => {
  event.preventDefault(); if (!keyDetail) return; const { backend, key } = keyDetail, mode = transferMode, passphrase = input('key-transfer-passphrase').value;
  const control = $<HTMLButtonElement>('key-transfer-submit'); control.disabled = true; $('key-transfer-error').textContent = '';
  try {
    if (mode === 'restore' && backend) {
      await authenticate(backend);
      const result = await api<KeyInfo & { privateKey: string }>(backend, 'api/keychain', { action: 'export', id: key.id, passphrase });
      const local = (await browserVault.list()).find(k => k.fingerprint === key.fingerprint) || await browserVault.create(key.name, passphrase, result);
      await browserVault.rememberBackup(local.id, { backendURL: backend.url, backendName: backend.name, keyId: key.id, savedAt: new Date().toISOString() });
      select('backend-filter').value = 'browser'; keyDetails(undefined, (await browserVault.list()).find(k => k.id === local.id)!);
    } else if (!backend) {
      const destinations = [...$('backup-devices').querySelectorAll<HTMLInputElement>('input:checked')].map(el => backendFor(el.value));
      if (mode === 'backup' && !destinations.length) throw new Error('Select a device to back up to.');
      const privateKey = await browserVault.unlock(key.id, passphrase);
      if (mode === 'private') downloadKey(privateKey, key.name, '.key');
      else {
        const failures: string[] = [];
        for (const device of destinations) {
          try {
            await authenticate(device);
            const local = (await browserVault.list()).find(k => k.id === key.id)!;
            const copy = await api<KeyInfo>(device, 'api/keychain', { action: 'backup', name: local.name, privateKey, passphrase, replaceId: local.backups.find(b => b.backendURL === device.url)?.keyId });
            await browserVault.rememberBackup(key.id, { backendURL: device.url, backendName: device.name, keyId: copy.id, savedAt: new Date().toISOString() });
          } catch (error: any) { failures.push(device.name + ': ' + error.message); }
        }
        keyDetails(undefined, (await browserVault.list()).find(k => k.id === key.id)!);
        if (failures.length) throw new Error('Successful backups were saved. Could not back up to: ' + failures.join('; '));
        notice('Backed up to ' + destinations.map(b => b.name).join(', ') + '.');
      }
    }
    dialog('key-transfer').close(); void renderCards();
  } catch (error: any) { $('key-transfer-error').textContent = error.message; }
  finally { input('key-transfer-passphrase').value = ''; control.disabled = false; }
};
select('key-method').onchange = () => { $('key-import-label').hidden = select('key-method').value !== 'import'; $<HTMLTextAreaElement>('key-import').required = select('key-method').value === 'import'; };
input('key-import-file').onchange = async () => {
  const file = input('key-import-file').files?.[0]; if (!file) return;
  $<HTMLTextAreaElement>('key-import').value = ''; $('key-error').textContent = '';
  if (file.size > 100000) { $('key-error').textContent = 'This key file is too large.'; input('key-import-file').value = ''; return; }
  try { const text = await file.text(); if (dialog('key-dialog').open && input('key-import-file').files?.[0] === file) $<HTMLTextAreaElement>('key-import').value = text; }
  catch { $('key-error').textContent = 'Could not read this key file.'; }
};
$<HTMLFormElement>('key-form').onsubmit = async event => {
  event.preventDefault(); const control = $('key-form').querySelector<HTMLButtonElement>('[type=submit]')!; control.disabled = true; $('key-error').textContent = '';
  try {
    const passphrase = input('key-passphrase').value, name = input('key-name').value;
    if (passphrase !== input('key-confirm').value) throw new Error('Passphrases do not match.');
    let key: BrowserKeyInfo;
    if (select('key-method').value === 'import') {
      const raw = $<HTMLTextAreaElement>('key-import').value.trim();
      if (raw.startsWith('{')) key = await browserVault.restore(raw, passphrase, name);
      else { await authenticate(primary); const info = await api<{ publicKey: string; fingerprint: string }>(primary, 'api/keychain', { action: 'inspect', privateKey: raw, passphrase }); key = await browserVault.create(name, passphrase, { privateKey: raw, ...info }); }
    } else key = await browserVault.create(name, passphrase);
    dialog('key-dialog').close(); select('backend-filter').value = 'browser'; void renderCards(); keyDetails(undefined, key);
  } catch (error: any) { $('key-error').textContent = error.message; }
  finally { input('key-passphrase').value = input('key-confirm').value = ''; $<HTMLTextAreaElement>('key-import').value = ''; input('key-import-file').value = ''; control.disabled = false; }
};
for (const element of document.querySelectorAll<HTMLElement>('[data-close]')) element.onclick = () => dialog(element.dataset.close!).close();
for (const id of ['ssh-dialog', 'key-dialog', 'backend-login', 'key-transfer']) dialog(id).addEventListener('close', () => { for (const secret of dialog(id).querySelectorAll<HTMLInputElement>('input[type=password]')) secret.value = ''; input('ssh-secret').value = ''; $<HTMLTextAreaElement>('key-import').value = ''; input('key-import-file').value = ''; });
$('terminal-back').onclick = $('add-tab').onclick = $('empty-open').onclick = () => show('hosts');
$('page-back').onclick = () => show(['vault', 'settings'].includes(page) ? 'terminal' : 'vault');
$('nav-vault').onclick = () => show('vault'); $('nav-terminals').onclick = () => show('terminal');
$('nav-settings').onclick = () => show('settings');
function preferencesChanged(key: string, value: unknown) {
  try { localStorage.setItem('termai.' + key, JSON.stringify(value)); }
  catch { notice('Browser storage is unavailable. Settings could not be saved.'); return; }
  for (const frame of frames.values()) frame.contentWindow?.postMessage({ type: 'settings-changed' }, location.origin);
}
function currentShortcuts() { try { return validateShortcuts(saved('shortcuts', defaults)); } catch { return structuredClone(defaults); } }
function renderSettings() {
  input('font-size').value = String(saved('fontSizePt', 10)); if (!input('font-size').checkValidity()) input('font-size').value = '10';
  input('auto-alternatives').checked = saved('autoAlternatives', true) && !saved('justRun', false); input('tap-alternate-send').checked = saved('tapAlternateSend', true);
  const tab = tabs.find(tab => tab.id === active); $('settings-terminal').hidden = !tab;
  $('settings-terminal-name').textContent = tab ? tabLabel(tab) + ' · ' + backendFor(tab.backendId).name : '';
}
input('font-size').oninput = () => { if (input('font-size').checkValidity()) preferencesChanged('fontSizePt', input('font-size').valueAsNumber); };
input('font-size').onchange = () => { if (!input('font-size').checkValidity()) input('font-size').value = String(saved('fontSizePt', 10)); };
input('auto-alternatives').onchange = () => { try { localStorage.removeItem('termai.justRun'); } catch {} preferencesChanged('autoAlternatives', input('auto-alternatives').checked); };
input('tap-alternate-send').onchange = () => preferencesChanged('tapAlternateSend', input('tap-alternate-send').checked);
const prepareEditor = shortcutEditor(currentShortcuts, value => preferencesChanged('shortcuts', value), () => $('shortcut-settings').hidden = true);
$('customize-shortcuts').onclick = () => { prepareEditor(); $('shortcut-settings').hidden = false; $('shortcut-settings').scrollIntoView({ block: 'nearest' }); };
$('cancel-shortcuts').onclick = () => $('shortcut-settings').hidden = true;
for (const [id, action] of [['settings-copy', 'copy-selection'], ['settings-restart', 'new-shell']]) $(id).onclick = () => frames.get(active)?.contentWindow?.postMessage({ type: 'settings-action', action }, location.origin);

$('library-add').onclick = () => {
  if (page === 'hosts') editHost();
  else if (page === 'backends') { $<HTMLFormElement>('backend-form').reset(); $('backend-error').textContent = ''; dialog('backend-dialog').showModal(); }
  else { $<HTMLFormElement>('key-form').reset(); $('key-import-label').hidden = true; $<HTMLTextAreaElement>('key-import').required = false; $('key-error').textContent = ''; dialog('key-dialog').showModal(); }
};
input('search').oninput = () => void renderCards(); select('backend-filter').onchange = () => void renderCards();
$('sort-hosts').onclick = () => { alphabetical = !alphabetical; $('sort-hosts').setAttribute('aria-pressed', String(alphabetical)); void renderCards(); };
function viewport() { document.documentElement.style.setProperty('--height', `${window.visualViewport?.height || innerHeight}px`); }
window.visualViewport?.addEventListener('resize', viewport); window.addEventListener('resize', viewport); viewport();
show('terminal');
async function boot() {
  try {
    if (!tabs.length) { await addTerminal(primary, 'default', 'This machine', 'local'); }
    else { if (!tabs.some(tab => tab.id === active)) active = tabs[0].id; renderTabs(); await Promise.all(tabs.map(tab => mount(tab).catch(error => notice(error.message)))); }
  } catch (error: any) { $('empty-terminal').querySelector('p')!.textContent = error.message; }
}
void boot();
if (import.meta.env.PROD && 'serviceWorker' in navigator) navigator.serviceWorker.register(new URL('sw.js', document.baseURI), { scope: new URL('.', document.baseURI).pathname }).catch(() => {});
