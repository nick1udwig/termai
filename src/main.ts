import './workspace.css';
import { backendURL, sshAddress, type BackendProfile, type HostProfile, type TerminalTab, type KeyInfo, type KnownHost, type SSHConnection } from './connections.ts';
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
let page: 'terminal' | 'hosts' | 'vault' | 'keychain' | 'backends' | 'known' = 'terminal';
let alphabetical = false, editingHost: string | undefined, keyDetail: { backend: BackendProfile; key: KeyInfo } | undefined;
const frames = new Map<string, HTMLIFrameElement>(), tokens = new Map<string, string>(), vaults = new Map<string, { keys: KeyInfo[]; knownHosts: KnownHost[] }>();
const authenticating = new Map<string, Promise<void>>();
let notification: ReturnType<typeof setTimeout>;
function notice(message: string) { $('notice').textContent = message; $('notice').hidden = false; clearTimeout(notification); notification = setTimeout(() => $('notice').hidden = true, 6000); }
function store() { try { for (const [key, value] of Object.entries({ backends: backends.filter(b => b.id !== 'primary'), hosts, tabs, activeTab: active })) localStorage.setItem('termai.' + key, JSON.stringify(value)); } catch { notice('Browser storage is unavailable. Connections will last for this page only.'); } }
function tokenFor(backend: BackendProfile) { if (tokens.has(backend.id)) return tokens.get(backend.id); try { return sessionStorage.getItem('termai.access:' + backend.url) || undefined; } catch { return undefined; } }
async function api<T>(backend: BackendProfile, name: string, data?: unknown, session?: string): Promise<T> {
  const url = new URL(name, backend.url); if (session) url.searchParams.set('session', session);
  const token = tokenFor(backend);
  const response = await fetch(url, { method: data === undefined ? 'GET' : 'POST', cache: 'no-store', credentials: 'same-origin', signal: AbortSignal.timeout(name === 'api/sessions' ? 25000 : 12000),
    headers: { ...(token ? { Authorization: 'Bearer ' + token } : {}), ...(data === undefined ? {} : { 'Content-Type': 'application/json' }) }, ...(data === undefined ? {} : { body: JSON.stringify(data) }) });
  const result = await response.json();
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
function populate(id: string, selected = 'primary', extra = false) {
  const element = select(id); element.replaceChildren();
  for (const backend of backends) element.add(new Option(backend.name, backend.id));
  if (extra) element.add(new Option('New direct backend…', 'new'));
  element.value = selected;
}
function show(view: typeof page) {
  page = view; for (const [id, frame] of frames) frame.contentWindow?.postMessage({ type: 'tab-visibility', visible: id === active && view === 'terminal' }, location.origin); const terminal = view === 'terminal';
  $('terminal-header').hidden = !terminal; $('terminal-stack').hidden = !terminal; $('library').hidden = terminal;
  if (terminal) { renderTabs(); return; }
  $('page-title').textContent = { hosts: 'Hosts', vault: 'Vault', keychain: 'Keychain', backends: 'Backends', known: 'Known hosts' }[view];
  $('page-back').querySelector('span')!.textContent = view === 'vault' ? 'Terminal' : 'Vault';
  $('sort-hosts').hidden = !['hosts', 'keychain'].includes(view);
  $('search-label').hidden = view === 'vault'; input('search').placeholder = 'Search ' + $('page-title').textContent!.toLowerCase(); input('search').value = '';
  $('backend-filter-label').hidden = !['keychain', 'known'].includes(view); populate('backend-filter', select('backend-filter').value || 'primary');
  $('library-add').hidden = ['vault', 'known'].includes(view); $('library-add').setAttribute('aria-label', view === 'keychain' ? 'Add SSH key' : view === 'backends' ? 'Add backend' : 'Add host');
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
let rendering = 0;
async function renderCards() {
  const generation = ++rendering; $('cards').replaceChildren(); $('list-empty').hidden = true;
  const query = input('search').value.trim().toLowerCase();
  const matches = (value: string) => value.toLowerCase().includes(query);
  const items = <T extends { name: string }>(values: T[]) => alphabetical ? [...values].sort((a, b) => a.name.localeCompare(b.name)) : values;
  $('list-heading').textContent = { terminal: '', hosts: 'Saved hosts', vault: 'Your workspace', keychain: 'SSH keys', backends: 'Direct backends', known: 'Verified fingerprints' }[page];
  if (page === 'vault') {
    for (const [name, detail, icon, view] of [['Hosts', `${hosts.length} saved`, '▤', 'hosts'], ['Keychain', 'Encrypted SSH keys', '⚿', 'keychain'], ['Backends', `${backends.length} available`, '⌘', 'backends'], ['Known hosts', 'SSH host fingerprints', '◎', 'known']] as const) card(name, detail, icon, () => show(view)).classList.add('vault-card');
  } else if (page === 'hosts') {
    for (const host of items(hosts).filter(h => matches(h.name + ' ' + (h.hostname || backendFor(h.backendId).url)))) card(host.name, host.kind === 'ssh' ? `${host.username}@${host.hostname} · ${host.route === 'fixed' ? backendFor(host.backendId).name : 'Automatic route'}` : backendFor(host.backendId).url, '▤', () => void openHost(host).catch(error => notice(error.message)), () => editHost(host), host.kind.toUpperCase());
  } else if (page === 'backends') {
    for (const backend of backends.filter(b => matches(b.name + ' ' + b.url))) card(backend.name, backend.url, '⌘', () => void authenticate(backend).then(() => notice('Connected to ' + backend.name)).catch(error => notice(error.message)), backend.id === 'primary' ? undefined : () => {
      if (tabs.some(t => t.backendId === backend.id)) { notice('Close this backend’s terminal tabs before removing it.'); return; }
      if (confirm('Remove this backend and its saved hosts? Its SSH keys will stay on the server.')) { backends = backends.filter(b => b.id !== backend.id); hosts = hosts.filter(h => h.backendId !== backend.id); routes.clear(); tokens.delete(backend.id); try { sessionStorage.removeItem('termai.access:' + backend.url); } catch {} store(); void renderCards(); }
    }, 'HTTP');
  } else if (page === 'keychain' || page === 'known') {
    const backend = backendFor(select('backend-filter').value);
    try {
      await authenticate(backend); const vault = await api<{ keys: KeyInfo[]; knownHosts: KnownHost[] }>(backend, 'api/keychain'); vaults.set(backend.id, vault);
      if (generation !== rendering) return;
      if (page === 'keychain') for (const key of items(vault.keys).filter(k => matches(k.name))) card(key.name, key.publicKey.split(' ')[0].replace('ssh-', '').toUpperCase() + ' · ' + backend.name, '⚿', () => keyDetails(backend, key));
      else for (const item of vault.knownHosts.filter(k => matches(k.host))) card(item.host + ':' + item.port, item.fingerprint, '◎', () => notice(item.fingerprint), () => {
        if (confirm('Forget this SSH host fingerprint? Verify its identity again before your next connection.')) void api(backend, 'api/keychain', { action: 'forget', host: item.host, port: item.port }).then(() => renderCards()).catch(error => notice(error.message));
      });
    } catch (error: any) { if (generation === rendering) notice(error.message); }
  }
  if (!$('cards').children.length) { $('list-empty').textContent = query ? 'No matches.' : page === 'keychain' ? 'Add an SSH key to connect securely. Your private keys stay encrypted on the selected backend.' : page === 'known' ? 'Verified SSH hosts will appear here after you connect.' : 'Add a host to open your next terminal.'; $('list-empty').hidden = false; }
}
function renderTabs() {
  $('tabs').replaceChildren();
  for (const tab of tabs) {
    const el = document.createElement('div'); el.className = 'tab'; el.role = 'tab'; el.tabIndex = tab.id === active ? 0 : -1; el.setAttribute('aria-selected', String(tab.id === active)); el.setAttribute('aria-controls', 'frame-' + tab.id); el.title = tab.name + ' · ' + backendFor(tab.backendId).name;
    const icon = document.createElement('span'); icon.className = 'tab-icon'; icon.textContent = '▤'; const name = document.createElement('span'); name.className = 'tab-name'; name.textContent = tab.name;
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
function activate(id: string) { active = id; store(); show('terminal'); frames.get(id)?.contentWindow?.postMessage({ type: 'focus-terminal' }, location.origin); }
async function mount(tab: TerminalTab) {
  const backend = backendFor(tab.backendId);
  if (frames.has(tab.id) || !tabs.some(t => t.id === tab.id)) return;
  const frame = document.createElement('iframe'); frame.title = tab.name + ' terminal'; frame.id = 'frame-' + tab.id; frame.allow = 'clipboard-read; clipboard-write';
  const url = new URL('terminal.html', document.baseURI); url.search = new URLSearchParams({ embedded: '1', backend: backend.url, session: tab.session }).toString();
  frame.src = url.href; frames.set(tab.id, frame); $('terminal-stack').append(frame); renderTabs();
}
async function addTerminal(backend: BackendProfile, session: string, name: string, hostId?: string) {
  const tab = { id: crypto.randomUUID(), backendId: backend.id, session, name, hostId }; tabs.push(tab); active = tab.id; store(); show('terminal'); await mount(tab);
}
async function closeTab(tab: TerminalTab) {
  if (!confirm('Close ' + tab.name + '? Running programs in this terminal will stop.')) return;
  const backend = backendFor(tab.backendId); await authenticate(backend); await api(backend, 'api/sessions/close', {}, tab.session);
  frames.get(tab.id)?.remove(); frames.delete(tab.id); const index = tabs.indexOf(tab); tabs = tabs.filter(t => t.id !== tab.id);
  if (active === tab.id) active = tabs[Math.min(index, tabs.length - 1)]?.id || '';
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
  if (event.data?.type === 'terminal-ended') notice(tab.name + ' has ended. Open its saved host to reconnect.');
});
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
    const index = hosts.findIndex(h => h.id === editingHost); if (index >= 0) { host.keyFingerprint = hosts[index].keyFingerprint; hosts[index] = host; } else hosts.push(host);
    routes.clear(); store(); dialog('host-dialog').close(); show('hosts');
  } catch (error: any) { $('host-error').textContent = error.message; }
};
$('delete-host').onclick = () => { if (confirm('Delete this saved host? Open terminals will keep running.')) { hosts = hosts.filter(h => h.id !== editingHost); routes.clear(); store(); dialog('host-dialog').close(); void renderCards(); } };
$<HTMLFormElement>('backend-form').onsubmit = event => {
  event.preventDefault(); try { const url = backendURL(input('backend-url').value); if (backends.some(b => b.url === url)) throw new Error('This backend is already saved.'); backends.push({ id: crypto.randomUUID(), name: input('backend-name').value.trim(), url }); store(); dialog('backend-dialog').close(); void renderCards(); } catch (error: any) { $('backend-error').textContent = error.message; }
};
let sshHost: HostProfile | undefined;
let selectedRoute: { backend: BackendProfile; keyId?: string } | undefined, routeGeneration = 0;
async function openHost(host: HostProfile) {
  const backend = backendFor(host.backendId); await authenticate(backend);
  if (host.kind === 'http') { const result = await api<{ id: string }>(backend, 'api/sessions', { name: host.name }); await addTerminal(backend, result.id, host.name, host.id); return; }
  const vault = await api<{ keys: KeyInfo[]; knownHosts: KnownHost[] }>(backend, 'api/keychain'); vaults.set(backend.id, vault); sshHost = host;
  $('ssh-title').textContent = host.name; $('ssh-destination').textContent = `${host.username}@${host.hostname}:${host.port} · ${backend.name}`;
  select('ssh-key').replaceChildren(); for (const key of vault.keys) select('ssh-key').add(new Option(key.name, key.fingerprint)); select('ssh-key').add(new Option('Account password', 'password'));
  if (host.keyFingerprint && vault.keys.some(k => k.fingerprint === host.keyFingerprint)) select('ssh-key').value = host.keyFingerprint;
  input('ssh-secret').value = ''; input('ssh-show-secret').checked = false; input('ssh-secret').type = 'password'; $('ssh-error').textContent = ''; $('ssh-progress').textContent = ''; sshSecretLabel(); dialog('ssh-dialog').showModal(); void prepareRoute();
}
function sshSecretLabel() { $('ssh-secret-label').textContent = select('ssh-key').value === 'password' ? 'Account password' : 'Key passphrase'; }
select('ssh-key').onchange = () => { sshSecretLabel(); input('ssh-secret').value = ''; void prepareRoute(); };
input('ssh-show-secret').onchange = () => input('ssh-secret').type = input('ssh-show-secret').checked ? 'text' : 'password';
const routes = new Map<string, { at: number; backend: BackendProfile; keyId?: string }>();
async function chooseRoute(host: HostProfile, keyFingerprint: string): Promise<{ backend: BackendProfile; keyId?: string }> {
  const selected = backendFor(host.backendId), localKey = vaults.get(selected.id)?.keys.find(k => k.fingerprint === keyFingerprint);
  if (keyFingerprint !== 'password' && !localKey) throw new Error('Choose a key on this backend.');
  if (host.route === 'fixed') return { backend: selected, keyId: localKey?.id };
  const key = JSON.stringify([host.id, keyFingerprint]), cached = routes.get(key); if (cached && Date.now() - cached.at < 60000) return cached;
  const candidates = backends.filter(b => b.id === selected.id || !!tokenFor(b));
  const measurements = await Promise.all(candidates.map(async backend => {
    try {
      const vault = await api<{ keys: KeyInfo[]; knownHosts: KnownHost[] }>(backend, 'api/keychain');
      const matching = vault.keys.find(k => k.fingerprint === keyFingerprint); if (keyFingerprint !== 'password' && !matching) return;
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
    $('ssh-secret-label').textContent = select('ssh-key').value === 'password' ? 'Account password' : 'Key passphrase on ' + route.backend.name;
    input('ssh-secret').disabled = false; $<HTMLButtonElement>('ssh-connect').disabled = false;
  } catch (error: any) { if (generation === routeGeneration) { $('ssh-error').textContent = error.message; $('ssh-progress').textContent = ''; } }
}
$<HTMLFormElement>('ssh-form').onsubmit = async event => {
  event.preventDefault(); if (!sshHost || !selectedRoute) return; const host = sshHost, control = $<HTMLButtonElement>('ssh-connect'); control.disabled = true; $('ssh-error').textContent = ''; $('ssh-progress').textContent = 'Choosing a route…';
  try {
    const selected = select('ssh-key').value, route = selectedRoute;
    $('ssh-progress').textContent = 'Connecting through ' + route.backend.name + '…';
    const ssh: SSHConnection = { host: host.hostname!, port: host.port!, username: host.username!, ...(route.keyId ? { keyId: route.keyId, passphrase: input('ssh-secret').value } : { password: input('ssh-secret').value }) };
    const create = () => api<{ id: string }>(route.backend, 'api/sessions', { name: host.name, ssh });
    let result;
    try { result = await create(); } catch (error: any) {
      if (error.status !== 409 || !error.fingerprint || error.changed) throw error;
      if (!confirm(`Verify the fingerprint for ${ssh.host}:${ssh.port} through ${route.backend.name}:\n\n${error.fingerprint}\n\nTrust this host and connect?`)) throw new Error('Host verification cancelled.');
      ssh.trust = error.fingerprint; result = await create();
    }
    host.keyFingerprint = selected === 'password' ? undefined : selected; store(); dialog('ssh-dialog').close();
    await addTerminal(route.backend, result.id, host.name, host.id);
  } catch (error: any) { $('ssh-error').textContent = error.message + (error.changed ? '\nVerify the new fingerprint before removing its Known hosts entry: ' + error.fingerprint : ''); }
  finally { input('ssh-secret').value = ''; control.disabled = false; $('ssh-progress').textContent = ''; }
};
function keyDetails(backend: BackendProfile, key: KeyInfo) { keyDetail = { backend, key }; input('key-rename').value = key.name; $('key-fingerprint').textContent = key.fingerprint; $<HTMLTextAreaElement>('public-key').value = key.publicKey; dialog('key-details').showModal(); }
$('copy-key').onclick = () => void navigator.clipboard.writeText($<HTMLTextAreaElement>('public-key').value).then(() => notice('Public key copied.')).catch(() => notice('Select the public key to copy it.'));
$('rename-key').onclick = () => { if (keyDetail) void api(keyDetail.backend, 'api/keychain', { action: 'rename', id: keyDetail.key.id, name: input('key-rename').value }).then(() => { dialog('key-details').close(); void renderCards(); }).catch(error => notice(error.message)); };
$('delete-key').onclick = () => { if (keyDetail && confirm('Delete this private key from ' + keyDetail.backend.name + '? Existing SSH sessions will stay open.')) void api(keyDetail.backend, 'api/keychain', { action: 'delete', id: keyDetail.key.id }).then(() => { routes.clear(); dialog('key-details').close(); void renderCards(); }).catch(error => notice(error.message)); };
select('key-method').onchange = () => { $('key-import-label').hidden = select('key-method').value !== 'import'; $<HTMLTextAreaElement>('key-import').required = select('key-method').value === 'import'; };
$<HTMLFormElement>('key-form').onsubmit = async event => {
  event.preventDefault(); const control = $('key-form').querySelector<HTMLButtonElement>('[type=submit]')!; control.disabled = true; $('key-error').textContent = '';
  try {
    if (input('key-passphrase').value !== input('key-confirm').value) throw new Error('Passphrases do not match.');
    const backend = backendFor(select('key-backend').value); await authenticate(backend);
    const key = await api<KeyInfo>(backend, 'api/keychain', { action: 'create', name: input('key-name').value, passphrase: input('key-passphrase').value, ...(select('key-method').value === 'import' ? { privateKey: $<HTMLTextAreaElement>('key-import').value } : {}) });
    dialog('key-dialog').close(); select('backend-filter').value = backend.id; void renderCards(); keyDetails(backend, key);
  } catch (error: any) { $('key-error').textContent = error.message; }
  finally { input('key-passphrase').value = input('key-confirm').value = ''; $<HTMLTextAreaElement>('key-import').value = ''; control.disabled = false; }
};
for (const element of document.querySelectorAll<HTMLElement>('[data-close]')) element.onclick = () => dialog(element.dataset.close!).close();
for (const id of ['ssh-dialog', 'key-dialog', 'backend-login']) dialog(id).addEventListener('close', () => { for (const secret of dialog(id).querySelectorAll<HTMLInputElement>('input[type=password]')) secret.value = ''; input('ssh-secret').value = ''; $<HTMLTextAreaElement>('key-import').value = ''; });
$('terminal-back').onclick = $('add-tab').onclick = $('empty-open').onclick = () => show('hosts');
$('page-back').onclick = () => show(page === 'vault' ? 'terminal' : 'vault');
$('nav-vault').onclick = () => show('vault'); $('nav-terminals').onclick = () => show('terminal');
$('terminal-options').onclick = $('nav-settings').onclick = () => { if (!active) { notice('Open a terminal to adjust its settings.'); return; } show('terminal'); frames.get(active)?.contentWindow?.postMessage({ type: 'options' }, location.origin); };
$('library-add').onclick = () => {
  if (page === 'hosts') editHost();
  else if (page === 'backends') { $<HTMLFormElement>('backend-form').reset(); $('backend-error').textContent = ''; dialog('backend-dialog').showModal(); }
  else { $<HTMLFormElement>('key-form').reset(); populate('key-backend', select('backend-filter').value || 'primary'); $('key-import-label').hidden = true; $<HTMLTextAreaElement>('key-import').required = false; $('key-error').textContent = ''; dialog('key-dialog').showModal(); }
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
