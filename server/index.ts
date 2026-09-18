import http from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { Session } from './session.ts';
import { executableNames } from './catalog.ts';
import { suggest } from './suggestions.ts';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
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
const token = process.env.TERMAI_TOKEN || '';
if (!loopback && token.length < 24) throw new Error('Set TERMAI_TOKEN to at least 24 characters before binding outside loopback.');
const allowedHosts = new Set((process.env.TERMAI_ALLOWED_HOSTS || (loopback ? 'localhost,127.0.0.1,[::1]' : '')).split(',').filter(Boolean));
if (!loopback && !allowedHosts.size) throw new Error('Set TERMAI_ALLOWED_HOSTS to the hostname(s) used by your phone.');
const owners = new Set<string>();
const sessions = new Map<string, Session>();
const opening = new Map<string, Promise<Session>>();
const commands = await executableNames();
const production = process.env.NODE_ENV === 'production';
const server = http.createServer();
const vite = production ? undefined : await (await import('vite')).createServer({
  root, server: { middlewareMode: true, hmr: { server }, allowedHosts: [...allowedHosts] }, appType: 'spa',
});
function allowed(req: http.IncomingMessage): boolean {
  try { return allowedHosts.has(new URL(`http://${req.headers.host}`).hostname); } catch { return false; }
}
function sameOrigin(req: http.IncomingMessage): boolean {
  try { return !!req.headers.origin && new URL(req.headers.origin).host === req.headers.host; } catch { return false; }
}
function owner(req: http.IncomingMessage): string | undefined {
  const id = req.headers.cookie?.match(/(?:^|;\s*)termai=([a-f0-9]{64})(?:;|$)/)?.[1];
  return id && owners.has(id) ? id : undefined;
}
function json(res: http.ServerResponse, status: number, data: unknown) {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(data));
}
async function body(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  if (!req.headers['content-type']?.startsWith('application/json')) throw new Error('Expected JSON');
  let text = '';
  for await (const chunk of req) { text += chunk; if (text.length > 16384) throw new Error('Request too large'); }
  const parsed = JSON.parse(text || '{}');
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Expected an object');
  return parsed;
}
async function getSession(id: string) {
  if (sessions.has(id)) return sessions.get(id)!;
  if (opening.has(id)) return opening.get(id)!;
  if (sessions.size >= 16) throw new Error('The session limit has been reached.');
  const promise = (async () => {
    const session = new Session(process.env.TERMAI_CWD || process.cwd(), commands);
    try { await session.start(); sessions.set(id, session); return session; }
    catch (error) { await session.dispose(); throw error; }
    finally { opening.delete(id); }
  })();
  opening.set(id, promise); return promise;
}
const mime: Record<string, string> = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.svg': 'image/svg+xml', '.wasm': 'application/wasm' };
server.on('request', async (req, res) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Frame-Options', 'DENY');
  if (!allowed(req)) { json(res, 403, { error: 'Hostname is not allowed.' }); return; }
  try {
    const url = new URL(req.url || '/', `http://${req.headers.host}`);
    if (basePath !== '/' && url.pathname === basePath) { res.writeHead(308, { Location: publicBase }).end(); return; }
    url.pathname = localPath(url.pathname);
    if (url.pathname.startsWith('/api/')) {
      if (req.method !== 'GET' && !sameOrigin(req)) { json(res, 403, { error: 'Origin is not allowed.' }); return; }
      let id = owner(req);
      if (url.pathname === '/api/connect' && req.method === 'POST') {
        const input = await body(req);
        if (!id) {
          if (token) {
            const supplied = typeof input.token === 'string' ? input.token : '';
            const a = Buffer.from(supplied), b = Buffer.from(token);
            if (a.length !== b.length || !timingSafeEqual(a, b)) { json(res, 401, { error: 'Enter the connection token.' }); return; }
          }
          if (owners.size >= 64) { json(res, 429, { error: 'Too many connections. Restart the server to clear them.' }); return; }
          id = randomBytes(32).toString('hex'); owners.add(id);
          const secure = req.headers.origin?.startsWith('https:') ? '; Secure' : '';
          res.setHeader('Set-Cookie', `termai=${id}; Path=${publicBase}; HttpOnly; SameSite=Strict${secure}`);
        }
        const session = await getSession(id); json(res, 200, { state: session.state }); return;
      }
      if (!id) { json(res, 401, { error: 'Connect to your shell first.' }); return; }
      const session = await getSession(id);
      if (url.pathname === '/api/context' && req.method === 'GET') { json(res, 200, await session.catalog()); return; }
      if (url.pathname === '/api/suggest' && req.method === 'POST') {
        const input = await body(req);
        if (typeof input.text !== 'string' || input.text.length > 2000) { json(res, 400, { error: 'Keep a command under 2,000 characters.' }); return; }
        const catalog = await session.catalog();
        const environment = await session.environment();
        json(res, 200, { candidates: await suggest(input.text, catalog, environment, session.discovery), source: 'Commands, paths, history & syntax checks', cwd: catalog.cwd }); return;
      }
      if (url.pathname === '/api/new' && req.method === 'POST') {
        await session.dispose(); sessions.delete(id);
        json(res, 200, { state: (await getSession(id)).state }); return;
      }
      json(res, 404, { error: 'Not found' }); return;
    }
    if (vite) { vite.middlewares(req, res); return; }
    if (!['GET', 'HEAD'].includes(req.method || '')) { res.writeHead(405).end(); return; }
    const file = path.resolve(root, 'dist', '.' + decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname));
    if (!file.startsWith(path.join(root, 'dist') + path.sep)) { res.writeHead(403).end(); return; }
    try {
      if (!(await stat(file)).isFile()) throw new Error('Not a file');
      let data = await readFile(file);
      if (path.extname(file) === '.html') data = Buffer.from(data.toString().replace('<base href="/" data-termai-base>', `<base href="${publicBase}" data-termai-base>`));
      res.writeHead(200, { 'Content-Type': mime[path.extname(file)] || 'application/octet-stream', 'Cache-Control': url.pathname.startsWith('/assets/') ? 'public, max-age=31536000, immutable' : 'no-cache' });
      res.end(req.method === 'HEAD' ? undefined : data);
    } catch { res.writeHead(404).end('Not found'); }
  } catch (error) { json(res, 400, { error: error instanceof Error ? error.message : 'Request failed' }); }
});
const sockets = new WebSocketServer({ noServer: true, maxPayload: 128 * 1024 });
server.on('upgrade', (req, socket, head) => {
  const socketUrl = new URL(req.url || '/', 'http://localhost');
  if (localPath(socketUrl.pathname) !== '/ws') { if (production) socket.destroy(); return; } // Vite handles its own HMR upgrade.
  const id = owner(req);
  if (!allowed(req) || !sameOrigin(req) || !id || !sessions.has(id)) { socket.write('HTTP/1.1 403 Forbidden\r\n\r\n'); socket.destroy(); return; }
  const after = Number(socketUrl.searchParams.get('after') || 0);
  if (!Number.isSafeInteger(after) || after < 0) { socket.destroy(); return; }
  sockets.handleUpgrade(req, socket, head, ws => {
    ws.on('error', () => ws.close());
    sessions.get(id)!.attach(ws, after, () => { const s = sessions.get(id); sessions.delete(id); void s?.dispose(); });
  });
});
server.listen(port, host, () => console.log(`termai → http://${host}:${port}${publicBase} (${production ? 'production' : 'development'}, Ghostty)`));
let closing = false;
async function close() {
  if (closing) return; closing = true;
  await Promise.all([...sessions.values()].map(s => s.dispose()));
  sockets.close(); await vite?.close(); server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 2000).unref();
}
process.on('SIGINT', () => void close()); process.on('SIGTERM', () => void close());
