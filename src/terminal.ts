import { Ghostty, Terminal, FitAddon } from 'ghostty-web';
import type { ClientMessage, ServerMessage, ShellState } from './protocol.ts';
import './style.css';
import { Queue } from './queue.ts';
import { SuggestionClient } from './suggestion-client.ts';
import { InlineSuggestions } from './inline-suggestions.ts';
import { defaults, keySequence, validateShortcuts, type Shortcut } from './shortcuts.ts';
const params = new URLSearchParams(location.search);
const embedded = params.get('embedded') === '1' && parent !== window;
const baseURL = new URL(params.get('backend') || document.baseURI);
const session = params.get('session') || 'default';
let accessToken: string | undefined;
function endpoint(name: string) { const url = new URL(name.replace(/^\//, ''), baseURL); if (session !== 'default') url.searchParams.set('session', session); return url; }
function notify(type: string, data: object = {}) { if (embedded) parent.postMessage({ type, ...data }, location.origin); }
if (embedded) document.documentElement.classList.add('embedded-terminal');
const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
let state: ShellState = { cwd: '', inputRevision: 0, promptRevision: 0, ready: false, prompt: 0, exited: false };
let ws: WebSocket | undefined;
let after = 0;
let reconnectTimer: ReturnType<typeof setTimeout>;
let pendingCommand: { id: string } | undefined;
const edits = new Map<string, (accepted: boolean) => void>();
let shortcuts: Shortcut[] = structuredClone(defaults);
try {
  const saved = localStorage.getItem('termai.shortcuts');
  if (saved) shortcuts = validateShortcuts(JSON.parse(saved));
} catch { /* Use defaults when storage is unavailable or stale. */ }
function persist(key: string, value: unknown) {
  try { localStorage.setItem('termai.' + key, JSON.stringify(value)); } catch { toast('Browser storage is unavailable. Settings will last for this page only.'); }
}
let ctrl = false;
let toastTimer: ReturnType<typeof setTimeout>;
const queue = new Queue<Extract<ServerMessage, { type: 'output' }>>();
let frameQueued = false;
let tabVisible = true, outputFrame = 0, outputTimer: ReturnType<typeof setTimeout>;
function scheduleDrain() { frameQueued = true; if (embedded && !tabVisible) outputTimer = setTimeout(drain, 16); else outputFrame = requestAnimationFrame(drain); }
let reconnectDelay = 1000;
function toast(message: string) {
  $('toast').textContent = message; $('toast').hidden = false;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => $('toast').hidden = true, 5500);
}
function connection(label: string, online = false) {
  $('connection-label').textContent = label;
  $('reconnect-banner').textContent = label === 'Session ended' ? 'This terminal has ended. Open its saved host to reconnect.' : 'Reconnecting to your terminal…';
  $('reconnect-banner').hidden = online || label === 'Connecting' || label === 'Locked';
  updateRun();
}
function updateRun() {
  const available = state.ready && !state.exited && ws?.readyState === WebSocket.OPEN && !pendingCommand;
  $('shell-status').textContent = state.exited ? 'Exited' : state.ready ? 'At prompt' : 'Running';
  for (const button of document.querySelectorAll<HTMLButtonElement>('.command-shortcut')) button.disabled = !available;
}
async function api<T>(url: string, data?: unknown, signal?: AbortSignal): Promise<T> {
  const response = await fetch(endpoint(url), { method: data === undefined ? 'GET' : 'POST', credentials: 'same-origin', cache: 'no-store',
    headers: { ...(accessToken ? { Authorization: 'Bearer ' + accessToken } : {}), ...(data === undefined ? {} : { 'Content-Type': 'application/json' }) }, ...(data === undefined ? {} : { body: JSON.stringify(data) }), signal });
  const result = await response.json();
  if (!response.ok) throw Object.assign(new Error(result.error || 'Request failed'), { status: response.status });
  return result;
}
function send(message: ClientMessage): boolean {
  if (ws?.readyState !== WebSocket.OPEN) return false;
  ws.send(JSON.stringify(message)); return true;
}
const fontSizeInput = $<HTMLInputElement>('font-size');
try {
  const saved = JSON.parse(localStorage.getItem('termai.fontSizePt') || 'null');
  if (typeof saved === 'number') fontSizeInput.value = String(saved);
} catch { /* Use the default when storage is unavailable or stale. */ }
if (!fontSizeInput.checkValidity()) fontSizeInput.value = fontSizeInput.defaultValue;
const fontFamily = getComputedStyle(document.documentElement).fontFamily;
// Load the font before Ghostty measures cells, in parallel with its WASM.
const [ghostty] = await Promise.all([Ghostty.load(), document.fonts.load(`14px ${fontFamily}`).catch(() => {})]);
const term = new Terminal({ ghostty, fontSize: fontSizeInput.valueAsNumber * 4 / 3, fontFamily,
  scrollback: 5000, cursorBlink: true, smoothScrollDuration: 0,
  theme: { background: '#0c1310', foreground: '#d7e6d9', cursor: '#bbf6b4', selectionBackground: '#3c6242', green: '#bbf6b4', cyan: '#9bcec3', blue: '#92b8d6', yellow: '#e5cf91', red: '#e6a68b' } });
term.open($('terminal'));
// Only the textarea owns mobile input. Focusing Ghostty's outer contenteditable
// otherwise bypasses its textarea-only beforeinput handler.
$('terminal').removeAttribute('contenteditable');
$('terminal').addEventListener('focus', () => term.textarea?.focus({ preventScroll: true }));
term.blur();
const fit = new FitAddon(); term.loadAddon(fit);
// Keep output outside UI state. Ghostty parses synchronously; its callback is an rAF.
function drain() {
  frameQueued = false;
  let budget = 0, last = after;
  const chunks: string[] = [];
  while (queue.length && budget < 65536) {
    const item = queue.shift()!;
    if (item.seq <= last) continue;
    chunks.push(item.data); last = item.seq; budget += item.data.length;
  }
  if (chunks.length) {
    term.write(chunks.join('')); after = last;
    send({ type: 'ack', seq: after });
  }
  inline.refresh();
  if (queue.length) scheduleDrain();
}
function sizeTerminal() {
  try { fit.fit(); send({ type: 'resize', cols: term.cols, rows: term.rows }); inline.refresh(); } catch { /* hidden during layout */ }
}
fontSizeInput.oninput = () => {
  if (!fontSizeInput.checkValidity() || fontSizeInput.valueAsNumber * 4 / 3 === term.options.fontSize) return;
  term.options.fontSize = fontSizeInput.valueAsNumber * 4 / 3;
  sizeTerminal();
  persist('fontSizePt', fontSizeInput.valueAsNumber);
};
fontSizeInput.onchange = () => { fontSizeInput.value = String(term.options.fontSize! * 3 / 4); };
let resizeFrame = 0;
new ResizeObserver(() => { cancelAnimationFrame(resizeFrame); resizeFrame = requestAnimationFrame(sizeTerminal); }).observe($('terminal'));
function viewport() { document.documentElement.style.setProperty('--app-height', `${window.visualViewport?.height || window.innerHeight}px`); }
window.visualViewport?.addEventListener('resize', viewport); window.addEventListener('resize', viewport); viewport();
function rawInput(data: string) {
  if (ctrl && /^[a-zA-Z]$/.test(data)) { data = String.fromCharCode(data.toUpperCase().charCodeAt(0) - 64); setCtrl(false); }
  if (!inline.raw(data)) return;
  if (send({ type: 'input', data })) state.inputRevision++;
  else toast('Disconnected. Input was not sent.');
}
function replaceLine(text: string): Promise<boolean> {
  if (!state.ready || state.exited || ws?.readyState !== WebSocket.OPEN) return Promise.resolve(false);
  const id = crypto.randomUUID();
  return new Promise(resolve => {
    const timer = setTimeout(() => { edits.delete(id); resolve(false); }, 5000);
    edits.set(id, accepted => { clearTimeout(timer); resolve(accepted); });
    send({ type: 'replace', text, id, prompt: state.prompt, revision: state.inputRevision });
    state.inputRevision++;
  });
}
const suggestions = new SuggestionClient(baseURL.href, session, () => accessToken);
const inline = new InlineSuggestions(term, { state: () => state, replace: replaceLine,
  suggest: (text, signal) => suggestions.suggest(text, signal), raw: rawInput, execute });
term.onData(rawInput);
function setCtrl(value: boolean) { ctrl = value; for (const button of document.querySelectorAll('[data-modifier]')) button.setAttribute('aria-pressed', String(value)); }
function renderShortcuts() {
  $('shortcut-buttons').replaceChildren();
  for (const shortcut of shortcuts) {
    const button = document.createElement('button');
    button.textContent = shortcut.label; button.title = shortcut.value;
    button.classList.toggle('command-shortcut', shortcut.kind === 'command');
    if (shortcut.kind === 'keys' && shortcut.value === 'Ctrl') { button.dataset.modifier = ''; button.setAttribute('aria-pressed', String(ctrl)); }
    button.addEventListener('pointerdown', e => e.preventDefault());
    button.onclick = () => {
      if (shortcut.kind === 'command') { execute(shortcut.value); return; }
      if (shortcut.value === 'Ctrl') { setCtrl(!ctrl); term.focus(); return; }
      rawInput(keySequence(shortcut.value)); term.focus();
    };
    $('shortcut-buttons').append(button);
  }
  updateRun();
}
let draftShortcuts: Shortcut[] = [];
function editShortcuts() {
  draftShortcuts = structuredClone(shortcuts); renderEditor();
  $('shortcut-error').textContent = ''; $<HTMLDialogElement>('shortcuts-dialog').showModal();
}
function renderEditor() {
  $('shortcut-editor').replaceChildren();
  draftShortcuts.forEach((shortcut, index) => {
    const row = document.createElement('div'); row.className = 'shortcut-row';
    const field = (title: string, name: 'label' | 'value') => {
      const label = document.createElement('label'); label.textContent = title;
      if (name === 'value') label.className = 'binding-label';
      const input = document.createElement('input'); input.value = shortcut[name]; input.className = name === 'value' ? 'binding' : 'shortcut-label';
      input.maxLength = name === 'label' ? 24 : 4000; input.autocomplete = 'off'; input.spellcheck = false;
      input.oninput = () => shortcut[name] = input.value; label.append(input); return label;
    };
    row.append(field('Label', 'label'));
    const kindLabel = document.createElement('label'); kindLabel.textContent = 'Action';
    const kind = document.createElement('select');
    for (const [value, text] of [['keys', 'Keys'], ['command', 'Command']]) { const option = document.createElement('option'); option.value = value; option.textContent = text; kind.append(option); }
    kind.value = shortcut.kind; kind.onchange = () => { shortcut.kind = kind.value as Shortcut['kind']; renderEditor(); };
    kindLabel.append(kind); row.append(kindLabel, field(shortcut.kind === 'command' ? 'Command to run' : 'Keys to send', 'value'));
    const actions = document.createElement('div'); actions.className = 'shortcut-actions';
    for (const [label, delta] of [['Move up', -1], ['Move down', 1], ['Remove', 0]] as const) {
      const button = document.createElement('button'); button.type = 'button'; button.className = 'text-button'; button.textContent = label;
      button.disabled = delta !== 0 && (index + delta < 0 || index + delta >= draftShortcuts.length);
      button.onclick = () => { if (!delta) draftShortcuts.splice(index, 1); else [draftShortcuts[index], draftShortcuts[index + delta]] = [draftShortcuts[index + delta], draftShortcuts[index]]; renderEditor(); };
      actions.append(button);
    }
    row.append(actions); $('shortcut-editor').append(row);
  });
}
$('customize-shortcuts').onclick = () => { $<HTMLDialogElement>('options-dialog').close(); editShortcuts(); };
$('add-shortcut').onclick = () => { if (draftShortcuts.length >= 24) return; draftShortcuts.push({ label: '', kind: 'command', value: '' }); renderEditor(); $('shortcut-editor').lastElementChild?.scrollIntoView({ block: 'nearest' }); };
$('reset-shortcuts').onclick = () => { draftShortcuts = structuredClone(defaults); renderEditor(); };
$('shortcuts-form').onsubmit = e => {
  e.preventDefault();
  try { shortcuts = validateShortcuts(draftShortcuts); persist('shortcuts', shortcuts); setCtrl(false); renderShortcuts(); $<HTMLDialogElement>('shortcuts-dialog').close(); }
  catch (error: any) { $('shortcut-error').textContent = error.message; }
};
renderShortcuts();
let touchY = 0;
$('terminal').addEventListener('touchstart', e => { if (e.touches.length === 1) touchY = e.touches[0].clientY; }, { passive: true });
$('terminal').addEventListener('touchmove', e => {
  if (e.touches.length !== 1) return;
  const delta = e.touches[0].clientY - touchY;
  if (Math.abs(delta) >= 16) { e.preventDefault(); term.scrollLines(-Math.trunc(delta / 16)); touchY = e.touches[0].clientY; }
}, { passive: false });

async function openSocket() {
  const socketURL = endpoint('ws');
  if (baseURL.origin !== location.origin) socketURL.searchParams.set('ticket', (await api<{ ticket: string }>('/api/ticket', {})).ticket);
  socketURL.protocol = baseURL.protocol === 'https:' ? 'wss:' : 'ws:'; socketURL.searchParams.set('after', String(after));
  const socket = new WebSocket(socketURL);
  ws = socket;
  socket.onopen = () => { reconnectDelay = 1000; connection('Connected', true); sizeTerminal(); notify('terminal-ready'); };
  socket.onmessage = event => {
    if (socket !== ws) return;
    const message: ServerMessage = JSON.parse(event.data);
    if (message.type === 'hello') {
      suggestions.setMode(message.engine);
      if (message.reset) { queue.clear(); after = 0; term.reset(); }
      if (message.truncated) {
        term.write('\r\n\x1b[33mOlder output is unavailable. Ctrl-L redraws the current program.\x1b[0m\r\n');
        toast('Reconnected with limited scrollback. Use Ctrl-L to redraw if needed.');
      }
    } else if (message.type === 'output') {
      if (message.seq > after) queue.push(message);
      if (!frameQueued) scheduleDrain();
    } else if (message.type === 'state') {
      state = message.state; notify('terminal-state', { state }); $('cwd').textContent = state.cwd; $('cwd').title = state.cwd;
      updateRun();
      inline.onState(state); suggestions.onState(state.prompt);
    } else if (message.type === 'context') {
      if (message.context.prompt === state.prompt && state.ready) suggestions.updateContext(message);
    } else if (message.type === 'edit-result') {
      edits.get(message.id)?.(message.accepted); edits.delete(message.id);
      if (!message.accepted) state.inputRevision = message.revision;
    } else if (message.type === 'result' && pendingCommand?.id === message.id) {
      pendingCommand = undefined;
      if (!message.accepted) toast(message.message || 'Command was not sent.');
      updateRun();
    }

  };
  socket.onclose = event => {
    if (socket !== ws) return;
    ws = undefined; inline.disconnect(); suggestions.disconnect();
    for (const resolve of edits.values()) resolve(false); edits.clear();
    // Never resend uncertain input or an uncertain command automatically.
    if (pendingCommand) { pendingCommand = undefined; toast('Connection lost before acknowledgement. Check the terminal before running again.'); }
    if (event.code === 4001) { connection('Other tab'); toast(event.reason); return; }
    connection('Reconnecting');
    clearTimeout(reconnectTimer); if (!document.hidden) reconnectTimer = setTimeout(() => void connect(), reconnectDelay);
    reconnectDelay = Math.min(10000, reconnectDelay * 1.5);
  };
}
async function connect(token?: string) {
  clearTimeout(reconnectTimer);
  try {
    const result = await api<{ state: ShellState; accessToken: string }>('/api/connect', { session, ...(token ? { token } : {}) });
    state = result.state; accessToken = result.accessToken; notify('terminal-authorized', { accessToken });
    $<HTMLDialogElement>('login-dialog').close(); $('login-error').textContent = '';
    await openSocket();
  } catch (error: any) {
    if (error.status === 401) {
      if (embedded) { notify('terminal-locked'); return; }
      connection('Locked'); const dialog = $<HTMLDialogElement>('login-dialog');
      if (!dialog.open) dialog.showModal();
      if (token) $('login-error').textContent = 'That token did not match.';
    } else if (error.status === 404) { connection('Session ended'); notify('terminal-ended'); } else {
      connection('Offline'); reconnectTimer = setTimeout(() => void connect(), reconnectDelay);
      reconnectDelay = Math.min(10000, reconnectDelay * 1.5);
    }
  }
}
$('login-form').onsubmit = e => { e.preventDefault(); void connect($<HTMLInputElement>('token').value); };
document.addEventListener('visibilitychange', () => {
  if (document.hidden) { clearTimeout(reconnectTimer); ws?.close(1000, 'Backgrounded'); }
  else if (!ws || ws.readyState === WebSocket.CLOSED) void connect();
});
window.addEventListener('online', () => { if (!ws) void connect(); });

function execute(command: string) {
  if (!state.ready || state.exited || pendingCommand || ws?.readyState !== WebSocket.OPEN) { toast('Wait for the shell prompt before running a command.'); return; }
  if (!command.trim() || /[\x00-\x1f\x7f]/.test(command)) { toast('Use one command line at a time.'); return; }
  inline.disconnect();
  const id = crypto.randomUUID(); pendingCommand = { id };
  if (!send({ type: 'command', command, prompt: state.prompt, id })) { pendingCommand = undefined; toast('Disconnected. The command was not sent.'); }
  updateRun();
}
for (const button of document.querySelectorAll<HTMLButtonElement>('[data-close]')) button.onclick = () => $<HTMLDialogElement>(button.dataset.close!).close();
$('menu-button').onclick = () => $<HTMLDialogElement>('options-dialog').showModal();
$('copy-selection').onclick = async () => {
  const text = term.getSelection();
  if (!text) { toast('Select terminal text first.'); return; }
  try { await navigator.clipboard.writeText(text); toast('Selection copied.'); } catch { toast('Clipboard is unavailable in this browser context.'); }
};
$('new-shell').onclick = async () => {
  if (!state.exited && !confirm('End the current session and start a new shell? Running programs in this session will stop.')) return;
  try {
    inline.disconnect(); suggestions.disconnect();
    const old = ws; ws = undefined; old?.close(); clearTimeout(reconnectTimer);
    await api('/api/new', {}); after = 0; queue.clear(); pendingCommand = undefined;
    $<HTMLDialogElement>('options-dialog').close(); await connect();
  } catch (error: any) { toast(error.message); void connect(); }
};
if (!embedded && import.meta.env.PROD && 'serviceWorker' in navigator) navigator.serviceWorker.register(new URL('sw.js', document.baseURI), { scope: new URL('.', document.baseURI).pathname }).catch(() => {});
if (embedded) {
  window.addEventListener('message', event => {
    if (event.source !== parent || event.origin !== location.origin) return;
    if (event.data?.type === 'authorize') { accessToken = event.data.accessToken; void connect(); }
    if (event.data?.type === 'tab-visibility') { tabVisible = event.data.visible; cancelAnimationFrame(outputFrame); clearTimeout(outputTimer); frameQueued = false; if (queue.length) scheduleDrain(); if (tabVisible) sizeTerminal(); }
    if (event.data?.type === 'options') $<HTMLDialogElement>('options-dialog').showModal();
    if (event.data?.type === 'focus-terminal') { sizeTerminal(); term.focus(); }
  });
  notify('terminal-loaded');
} else void connect();
