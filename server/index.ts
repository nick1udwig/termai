import http from 'node:http';
import { fileAction } from './file-actions.ts';
import { makeDirectory, listFiles, uploadFile, downloadTicket, sendDownload, fileError } from './files.ts';
import { detectDictation, installCommand } from './dictation.ts';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import path from 'node:path';
import os from 'node:os';
import { Vault, inspectPrivateKey } from './vault.ts';
import { SSHHost, routeProbe } from './ssh.ts';
import { sshAddress, type SSHConnection } from '../src/connections.ts';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { resolveSystemSSH, NativeSSH, type SystemSSH } from './system-ssh.ts';
import { Session } from './session.ts';
import { suggest } from './suggestions.ts';
import { directoryInput } from '../src/engine/path-repair.ts';
import { executableNames } from './catalog.ts';
import { staticAssets } from './assets.ts';
import { pairingToken, Pairings } from './pairing.ts';
import { pairingPage } from './pairing-page.ts';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const engineSetting = process.env.TERMAI_ENGINE || 'server';
if (engineSetting !== 'server' && engineSetting !== 'client') throw new Error('TERMAI_ENGINE must be server or client.');
const engineMode: 'server' | 'client' = engineSetting;
const host = process.env.HOST || '127.0.0.1';
const port = Number(process.env.PORT || 3000);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT must be between 1 and 65535.');
const basePath = '/' + (process.env.TERMAI_BASE_PATH || '').split('/').filter(Boolean).join('/');
if (!/^\/(?:[a-zA-Z0-9_-]+(?:\/[a-zA-Z0-9_-]+)*)?$/.test(basePath)) throw new Error('Invalid TERMAI_BASE_PATH.');
const publicBase = basePath === '/' ? '/' : basePath + '/';
function localPath(urlPath: string): string {
  return basePath !== '/' && urlPath.startsWith(publicBase) ? urlPath.slice(basePath.length) : urlPath;
}
const loopback = ['127.0.0.1', 'localhost', '::1'].includes(host);
const dataDirectory = process.env.TERMAI_DATA_DIR || path.join(os.homedir(), '.local/share/termai');
const token = pairingToken(dataDirectory, process.env.TERMAI_TOKEN);
const allowedHosts = new Set((process.env.TERMAI_ALLOWED_HOSTS || (loopback ? 'localhost,127.0.0.1,[::1]' : '')).split(',').filter(Boolean));
if (!loopback && !allowedHosts.size) throw new Error('Set TERMAI_ALLOWED_HOSTS to the hostname(s) used by your phone.');
const allowedOrigins = new Set((process.env.TERMAI_ALLOWED_ORIGINS || '').split(',').filter(Boolean));
const vault = new Vault(dataDirectory);
const metadata = new Map<string, { id: string; name: string; kind: 'http' | 'ssh' }>();
const tickets = new Map<string, { owner: string; session: string; until: number }>();
let probes = 0;
const owners = new Pairings(dataDirectory, token);
const sessions = new Map<string, Session>();
const opening = new Map<string, Promise<Session>>();
const commands = await executableNames();
const production = process.env.NODE_ENV === 'production';
const server = http.createServer();
// Forward only authenticated upgrades to Vite; it must not listen independently.
const viteTransport = http.createServer();
const vite = production ? undefined : await (await import('vite')).createServer({
  root, base: publicBase, server: { middlewareMode: true, hmr: { server: viteTransport }, allowedHosts: [...allowedHosts] }, appType: 'spa',
  plugins: [{ name: 'termai-runtime-base', transformIndexHtml: html => html.replace('<base href="/" data-termai-base>', `<base href="${publicBase}" data-termai-base>`) }],
});
function allowed(req: http.IncomingMessage): boolean {
  try { return allowedHosts.has(new URL(`http://${req.headers.host}`).hostname); } catch { return false; }
}
function sameOrigin(req: http.IncomingMessage): boolean {
  try { return !!req.headers.origin && (new URL(req.headers.origin).host === req.headers.host || allowedOrigins.has(req.headers.origin)); } catch { return false; }
}
function owner(req: http.IncomingMessage): string | undefined {
  const bearer = req.headers.authorization?.match(/^Bearer ([a-f0-9]{64})$/)?.[1];
  const id = bearer || req.headers.cookie?.match(/(?:^|;\s*)termai=([a-f0-9]{64})(?:;|$)/)?.[1];
  return id && owners.has(id) ? id : undefined;
}
function json(res: http.ServerResponse, status: number, data: unknown) {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(data));
}
async function body(req: http.IncomingMessage, limit = 16384): Promise<Record<string, unknown>> {
  if (!req.headers['content-type']?.startsWith('application/json')) throw new Error('Expected JSON');
  let text = '';
  for await (const chunk of req) { text += chunk; if (text.length > limit) throw new Error('Request too large'); }
  const parsed = JSON.parse(text || '{}');
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Expected an object');
  return parsed;
}
function sessionId(value: unknown) {
  if (value === undefined || value === null || value === 'default') return 'default';
  if (typeof value !== 'string' || !/^[a-f0-9-]{36}$/.test(value)) throw new Error('Invalid terminal session.');
  return value;
}
async function getSession(id: string, name = 'Terminal', ssh?: SSHConnection, system?: SystemSSH, filesOnly = false) {
  if (sessions.has(id)) return sessions.get(id)!;
  if (opening.has(id)) return opening.get(id)!;
  if (sessions.size + opening.size >= 32) throw new Error('The session limit has been reached.');
  const promise = (async () => {
    let session: Session | undefined;
    try {
      const remote = ssh ? await SSHHost.connect(ssh, vault, system, filesOnly) : undefined;
      session = new Session(remote?.cwd || process.env.TERMAI_CWD || process.cwd(), commands, engineMode, remote, filesOnly);
      await session.start(); sessions.set(id, session); metadata.set(id, { id: id.split('/')[1], name, kind: ssh ? 'ssh' : 'http' }); return session; }
    catch (error) { await session?.dispose(); throw error; }
    finally { opening.delete(id); }
  })();
  opening.set(id, promise); return promise;
}
const serveAsset = staticAssets(path.join(root, 'dist'), publicBase);
server.on('request', async (req, res) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  if (!allowed(req)) { json(res, 403, { error: 'Hostname is not allowed.' }); return; }
  if (req.headers.origin && sameOrigin(req)) {
    res.setHeader('Access-Control-Allow-Origin', req.headers.origin); res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Credentials', 'true');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Private-Network', 'true');
  }
  if (req.method === 'OPTIONS') { res.writeHead(sameOrigin(req) ? 204 : 403).end(); return; }
  try {
    const url = new URL(req.url || '/', `http://${req.headers.host}`);
    if (basePath !== '/' && url.pathname === basePath) { res.writeHead(308, { Location: publicBase }).end(); return; }
    url.pathname = localPath(url.pathname);
    if (url.pathname.startsWith('/api/')) {
      if (req.method !== 'GET' && !sameOrigin(req)) { json(res, 403, { error: 'Origin is not allowed.' }); return; }
      if (url.pathname === '/api/files/download' && req.method === 'GET') {
        try { await sendDownload(url.searchParams.get('ticket') || '', req, res); } catch (error) { throw fileError(error); }
        return;
      }
      let id = owner(req);
      if (url.pathname === '/api/connect' && req.method === 'POST') {
        const input = await body(req);
        if (!id) {
          const supplied = typeof input.token === 'string' ? input.token : '';
          const a = Buffer.from(supplied), b = Buffer.from(token);
          if (a.length !== b.length || !timingSafeEqual(a, b)) { json(res, 401, { error: 'Enter the pairing token shown by your termai server.' }); return; }
          if (owners.size >= 256) { json(res, 429, { error: 'The saved pairing limit has been reached. Revoke old pairings before adding more.' }); return; }
          id = owners.issue();
        }
        const secure = req.headers.origin?.startsWith('https:') ? '; Secure' : '';
        res.setHeader('Set-Cookie', `termai=${id}; Path=${publicBase}; HttpOnly; SameSite=Strict; Max-Age=31536000${secure}`);
        const sid = sessionId(input.session);
        if (input.noSession === true) { json(res, 200, { accessToken: id }); return; }
        if (sid !== 'default' && !sessions.has(id + '/' + sid)) { json(res, 404, { error: 'This terminal has ended. Open its saved host to reconnect.' }); return; }
        const session = await getSession(id + '/' + sid); json(res, 200, { state: session.state, accessToken: id }); return;
      }
      if (!id) { json(res, 401, { error: 'Connect to your shell first.' }); return; }
      if (url.pathname === '/api/dictation' && req.method === 'GET') { json(res, 200, await detectDictation()); return; }
      const sid = sessionId(url.searchParams.get('session')), key = id + '/' + sid;
      if (url.pathname === '/api/ping' && req.method === 'GET') { json(res, 200, { ok: true }); return; }
      if (url.pathname === '/api/keychain' && req.method === 'GET') { json(res, 200, await vault.list()); return; }
      if (url.pathname === '/api/keychain' && req.method === 'POST') {
        const input = await body(req);
        if (input.action === 'delete' && typeof input.id === 'string') await vault.remove(input.id);
        else if (input.action === 'rename' && typeof input.id === 'string' && typeof input.name === 'string') await vault.rename(input.id, input.name);
        else if (input.action === 'forget') { const address = sshAddress({ host: input.host as string, port: input.port as number, username: 'unused' }); await vault.forget(address.host, address.port); }
        else if (input.action === 'inspect') { json(res, 200, inspectPrivateKey(input.privateKey, input.passphrase)); return; }
        else if (input.action === 'export' && typeof input.id === 'string') {
          const raw = await vault.unlock(input.id, input.passphrase);
          try { const key = (await vault.list()).keys.find(key => key.id === input.id); if (!key) throw new Error('SSH key not found.'); json(res, 200, { ...key, privateKey: raw.toString() }); } finally { raw.fill(0); }
          return;
        }
        else if (input.action === 'backup') { json(res, 200, await vault.create(input.name, input.passphrase, input.privateKey, typeof input.replaceId === 'string' ? input.replaceId : undefined)); return; }
        else if (input.action === 'create') { json(res, 200, await vault.create(input.name, input.passphrase, input.privateKey)); return; }
        else throw new Error('Unknown keychain action.');
        json(res, 200, await vault.list()); return;
      }
      if (url.pathname === '/api/ssh/probe' && req.method === 'POST') {
        if (probes >= 4) { json(res, 429, { error: 'Route probes are busy. Try again.' }); return; }
        const input = await body(req); probes++;
        try { json(res, 200, { milliseconds: await routeProbe(input as unknown as SSHConnection) }); } finally { probes--; }
        return;
      }
      if (url.pathname === '/api/sessions' && req.method === 'GET') {
        json(res, 200, [...metadata].filter(([key]) => key.startsWith(id + '/')).map(([key, info]) => ({ ...info, state: sessions.get(key)!.state }))); return;
      }
      if (url.pathname === '/api/sessions' && req.method === 'POST') {
        const input = await body(req), session = randomBytes(16).toString('hex').replace(/(.{8})(.{4})(.{4})(.{4})(.{12})/, '$1-$2-$3-$4-$5');
        const name = typeof input.name === 'string' && input.name.trim() ? input.name.trim().slice(0, 100) : 'Terminal';
        const shell = await getSession(id + '/' + session, name, input.ssh as SSHConnection | undefined, undefined, input.files === true);
        if (res.destroyed) { await shell.dispose(); sessions.delete(id + '/' + session); metadata.delete(id + '/' + session); return; }
        json(res, 200, { id: session, name, state: shell.state }); return;
      }
      if (url.pathname === '/api/sessions/close' && req.method === 'POST') {
        await sessions.get(key)?.dispose(); sessions.delete(key); metadata.delete(key); json(res, 200, { ok: true }); return;
      }
      if (url.pathname === '/api/ticket' && req.method === 'POST') {
        if (!sessions.has(key) || sessions.get(key)!.filesOnly) { json(res, 404, { error: 'Terminal not found.' }); return; }
        for (const [ticket, value] of tickets) if (value.until < Date.now()) tickets.delete(ticket);
        if (tickets.size >= 256) throw new Error('Too many pending connections.');
        const ticket = randomBytes(32).toString('hex'); tickets.set(ticket, { owner: id, session: sid, until: Date.now() + 15000 }); json(res, 200, { ticket }); return;
      }
      if (sid !== 'default' && !sessions.has(key)) { json(res, 404, { error: 'Terminal not found.' }); return; }
      const session = await getSession(key);
      if (url.pathname.startsWith('/api/files/')) {
        try {
          if (url.pathname === '/api/files/transfer' && req.method === 'POST') {
            const input = await body(req), transfer = typeof input.id === 'string' ? session.transfers.get(input.id) : undefined;
            if (!transfer) throw Object.assign(new Error('This transfer request expired. Run the command again.'), { status: 404 });
            if (input.action === 'ack') { session.transfers.acknowledge(transfer.id); json(res, 200, { ok: true }); return; }
            if (input.action !== 'download' || transfer.action !== 'download') throw new Error('Invalid transfer action.');
            const ticket = await downloadTicket(session, transfer.path, () => sessions.get(key) === session && owners.has(id!) && !!session.transfers.get(transfer.id), transfer.name, () => session.transfers.remove(transfer.id));
            session.transfers.acknowledge(transfer.id); json(res, 200, ticket); return;
          }
          if (url.pathname === '/api/files/action' && req.method === 'POST') { json(res, 200, await fileAction(session, await body(req, 256 * 1024))); return; }
          if (url.pathname === '/api/files/mkdir' && req.method === 'POST') { const input = await body(req); if (typeof input.name !== 'string' || typeof input.path !== 'string') throw new Error('Enter a folder name.'); json(res, 200, await makeDirectory(session, input.path, input.name)); return; }
          if (url.pathname === '/api/files/list' && req.method === 'GET') { json(res, 200, await listFiles(session, url.searchParams.get('path') || '.')); return; }
          if (url.pathname === '/api/files/upload' && req.method === 'POST') { json(res, 200, await uploadFile(session, url.searchParams.get('path') || '.', url.searchParams.get('name') || '', req)); return; }
          if (url.pathname === '/api/files/download' && req.method === 'POST') {
            const input = await body(req);
            json(res, 200, await downloadTicket(session, input.path as string, () => sessions.get(key) === session && owners.has(id!))); return;
          }
        } catch (error) { throw fileError(error); }
      }
      if (session.filesOnly) throw new Error('Open a terminal tab for shell actions.');
      if (url.pathname === '/api/dictation/install' && req.method === 'POST') {
        const input = await body(req);
        if (session.remote) throw new Error('Open a local terminal on this backend to install Voxtype.');
        const command = await installCommand();
        if (!session.paste(command, input.prompt as number, input.revision as number, true)) throw new Error('The terminal changed. Return to the shell prompt and try again.');
        json(res, 200, { ok: true }); return;
      }
      if (url.pathname === '/api/ssh/captured' && req.method === 'POST') {
        const input = await body(req), captureId = typeof input.id === 'string' ? input.id : '';
        if (input.action === 'ack') { session.acknowledgeCapture(captureId); json(res, 200, { ok: true }); return; }
        const previous = session.captureResult(captureId); if (previous) { json(res, 200, previous); return; }
        if (!session.captured || session.captured.id !== captureId || session.remote) throw new Error('This SSH request is no longer active.');
        if (input.action === 'cancel' || input.action === 'native') {
          if (session.captureFlight) throw new Error('SSH is still connecting.');
          session.releaseCapture(captureId, input.action === 'native'); json(res, 200, { native: input.action === 'native' }); return;
        }
        if (!session.captureFlight) {
          const command = session.captured.command;
          session.captureFlight = (async () => {
            try {
              const system = await resolveSystemSSH(command, await session.environment(), session.state.cwd, typeof input.passphrase === 'string' ? input.passphrase : undefined);
              if (!system.identities.length && !system.locked) throw new NativeSSH('No reusable key was found; using native SSH.');
              const childId = captureId.replace(/(.{8})(.{4})(.{4})(.{4})(.{12})/, '$1-$2-$3-$4-$5');
              const name = system.username + '@' + system.host;
              const child = await getSession(id + '/' + childId, name, { host: system.host, port: system.port, username: system.username, trust: typeof input.trust === 'string' ? input.trust : undefined }, system);
              const result = { id: childId, name, host: system.host, port: system.port, username: system.username, key: child.remote?.key };
              session.releaseCapture(captureId, false, result); return result;
            } catch (error) {
              if (!(error instanceof NativeSSH)) throw error;
              const result = { native: true, message: error.message }; session.releaseCapture(captureId, true, result); return result;
            }
          })().finally(() => { session.captureFlight = undefined; });
        }
        json(res, 200, await session.captureFlight); return;
      }
      if (url.pathname === '/api/context' && req.method === 'GET') { json(res, 200, await session.catalog()); return; }
      if (url.pathname === '/api/suggest' && req.method === 'POST') {
        if (!session.discovery) { json(res, 409, { error: 'This connection computes suggestions in the client.' }); return; }
        const input = await body(req);
        if (typeof input.text !== 'string' || input.text.length > 2000) { json(res, 400, { error: 'Keep a command under 2,000 characters.' }); return; }
        const disconnected = new AbortController();
        const cancel = () => { if (!res.writableEnded) disconnected.abort(); };
        res.once('close', cancel);
        const signal = AbortSignal.any([disconnected.signal, AbortSignal.timeout(5000)]);
        try {
          const catalog = await session.catalog(!directoryInput(input.text));
          signal.throwIfAborted();
          const environment = await session.environment();
          const candidates = await suggest(input.text, catalog, environment, session.discovery, undefined, signal);
          if (!res.destroyed) json(res, 200, { candidates, source: 'Commands, paths, history & syntax checks', cwd: catalog.cwd });
        } finally { res.off('close', cancel); }
        return;
      }
      if (url.pathname === '/api/facts' && req.method === 'POST') {
        const input = await body(req);
        const disconnected = new AbortController();
        const cancel = () => { if (!res.writableEnded) disconnected.abort(); };
        res.once('close', cancel);
        const signal = AbortSignal.any([disconnected.signal, AbortSignal.timeout(5000)]);
        try {
          const result = input.kind === 'context'
            ? await session.facts.context(typeof input.known === 'string' ? input.known : undefined, input.paths !== false)
            : typeof input.key === 'string' ? await session.facts.read(input.key, input.operations, signal)
            : (() => { throw new Error('Expected a context key.'); })();
          signal.throwIfAborted();
          if (!res.destroyed) json(res, 200, result);
        } finally { res.off('close', cancel); }
        return;
      }
      if (url.pathname === '/api/new' && req.method === 'POST') {
        if (session.remote) throw new Error('Open the saved SSH host again to start another shell.');
        await session.dispose(); sessions.delete(key); metadata.delete(key);
        json(res, 200, { state: (await getSession(key)).state }); return;
      }
      json(res, 404, { error: 'Not found' }); return;
    }
    if (vite) {
      if (!owner(req)) {
        if (req.method === 'GET' && ['/', '/index.html', '/terminal.html'].includes(url.pathname)) {
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
          res.end(pairingPage(publicBase));
        } else json(res, 401, { error: 'Pair with this backend first.' });
        return;
      }
      vite.middlewares(req, res); return;
    }
    await serveAsset(req, res, url.pathname);
  } catch (error) { if (!res.destroyed) json(res, (error as any)?.status || 400, { error: error instanceof Error ? error.message : 'Request failed', ...((error as any)?.needsSecret ? { needsSecret: true } : {}), ...((error as any)?.fingerprint ? { fingerprint: (error as any).fingerprint, changed: (error as any).changed } : {}) }); }
});
const sockets = new WebSocketServer({ noServer: true, maxPayload: 128 * 1024 });
server.on('upgrade', (req, socket, head) => {
  let socketUrl: URL;
  try { socketUrl = new URL(req.url || '/', 'http://localhost'); } catch { socket.destroy(); return; }
  if (localPath(socketUrl.pathname) !== '/ws') {
    if (vite && allowed(req) && sameOrigin(req) && owner(req)) viteTransport.emit('upgrade', req, socket, head);
    else { socket.write('HTTP/1.1 403 Forbidden\r\n\r\n'); socket.destroy(); }
    return;
  }
  const ticket = socketUrl.searchParams.get('ticket'), credential = ticket && tickets.get(ticket);
  let sid: string; try { sid = sessionId(socketUrl.searchParams.get('session')); } catch { socket.destroy(); return; }
  const id = credential && credential.until > Date.now() && credential.session === sid ? credential.owner : owner(req);
  const key = id + '/' + sid;
  if (!allowed(req) || !sameOrigin(req) || !id || !sessions.has(key) || sessions.get(key)!.filesOnly) { socket.write('HTTP/1.1 403 Forbidden\r\n\r\n'); socket.destroy(); return; }
  const after = Number(socketUrl.searchParams.get('after') || 0);
  if (!Number.isSafeInteger(after) || after < 0) { socket.destroy(); return; }
  if (ticket) tickets.delete(ticket);
  sockets.handleUpgrade(req, socket, head, ws => {
    ws.on('error', () => ws.close());
    sessions.get(key)!.attach(ws, after, () => { const s = sessions.get(key); sessions.delete(key); metadata.delete(key); void s?.dispose(); });
  });
});
server.listen(port, host, () => {
  console.log(`termai → http://${host}:${port}${publicBase} (${production ? 'production' : 'development'}, Ghostty)`);
  console.log(`Pairing token: ${token}`);
});
let closing = false;
async function close() {
  if (closing) return; closing = true;
  await Promise.all([...sessions.values()].map(s => s.dispose()));
  sockets.close(); await vite?.close(); server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 2000).unref();
}
process.on('SIGINT', () => void close()); process.on('SIGTERM', () => void close());
