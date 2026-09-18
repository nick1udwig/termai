import { createReadStream } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';

const mime: Record<string, string> = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.svg': 'image/svg+xml', '.wasm': 'application/wasm', '.woff2': 'font/woff2' };
export function acceptedEncodings(header?: string): string[] {
  if (!header) return ['identity'];
  const values = new Map(header.toLowerCase().split(',').map(part => {
    const [name, ...parameters] = part.trim().split(';');
    const q = parameters.map(value => value.trim()).find(value => value.startsWith('q='));
    const quality = q ? Number(q.slice(2)) : 1;
    return [name.trim(), Number.isFinite(quality) && quality >= 0 && quality <= 1 ? quality : 0];
  }));
  return ['br', 'gzip', 'identity'].map(name => ({ name, q: values.get(name) ?? (name === 'identity' ? values.get('*') === 0 ? 0 : 1 : values.get('*') || 0) }))
    .filter(entry => entry.q > 0).sort((a, b) => b.q - a.q).map(entry => entry.name);
}
export function staticAssets(dist: string, publicBase: string) {
  let htmlCache: { stamp: string; data: Promise<Buffer> } | undefined;
  return async (req: IncomingMessage, res: ServerResponse, pathname: string) => {
    if (!['GET', 'HEAD'].includes(req.method || '')) { res.writeHead(405).end(); return; }
    const file = path.resolve(dist, '.' + decodeURIComponent(pathname === '/' ? '/index.html' : pathname));
    if (!file.startsWith(dist + path.sep)) { res.writeHead(403).end(); return; }
    try {
      const info = await stat(file);
      if (!info.isFile()) { res.writeHead(404).end('Not found'); return; }
      const html = path.extname(file) === '.html';
      let selected: { file: string; encoding: string; size: number } | undefined;
      for (const encoding of acceptedEncodings(req.headers['accept-encoding'])) {
        if (encoding === 'identity') { selected = { file, encoding, size: info.size }; break; }
        if (html) continue; // HTML is rewritten for the runtime mount path.
        const variant = file + (encoding === 'br' ? '.br' : '.gz');
        const compressed = await stat(variant).catch(() => undefined);
        if (compressed?.isFile()) { selected = { file: variant, encoding, size: compressed.size }; break; }
      }
      res.setHeader('Vary', 'Accept-Encoding');
      if (!selected) { res.writeHead(406).end(); return; }
      res.setHeader('Content-Type', mime[path.extname(file)] || 'application/octet-stream');
      res.setHeader('Cache-Control', pathname.startsWith('/assets/') ? 'public, max-age=31536000, immutable' : 'no-cache');
      if (selected.encoding !== 'identity') res.setHeader('Content-Encoding', selected.encoding);
      if (!html) res.setHeader('Content-Length', selected.size);
      if (req.method === 'HEAD') { res.writeHead(200).end(); return; }
      if (html) {
        const stamp = `${file}:${info.mtimeMs}:${info.size}`;
        if (htmlCache?.stamp !== stamp) htmlCache = { stamp, data: readFile(file, 'utf8').then(text => Buffer.from(text.replace('<base href="/" data-termai-base>', `<base href="${publicBase}" data-termai-base>`))) };
        res.end(await htmlCache.data);
      } else await pipeline(createReadStream(selected.file), res);
    } catch {
      if (res.headersSent) res.destroy(); else res.writeHead(404).end('Not found');
    }
  };
}
