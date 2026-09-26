import { createReadStream, createWriteStream } from 'node:fs';
import { opendir, stat, lstat, unlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { SFTPWrapper, Stats } from 'ssh2';
import type { FileEntry, FileListing } from '../src/file-protocol.ts';

export interface FileHost { state: { cwd: string }; remote?: { home: string; files: SFTPWrapper } }
export const MAX_UPLOAD = 1024 * 1024 * 1024;
const fail = (message: string, status = 400) => Object.assign(new Error(message), { status });
export function filePath(host: FileHost, input: string) {
  if (typeof input !== 'string' || !input || input.length > 4096 || input.includes('\0')) throw fail('Enter a file path.');
  const home = host.remote?.home || os.homedir();
  return path.posix.resolve(host.state.cwd, input === '~' ? home : input.startsWith('~/') ? path.posix.join(home, input.slice(2)) : input);
}
function remoteCall<T>(work: (done: (error: Error | undefined | null, result: T) => void) => void): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(fail('The remote filesystem did not respond.', 504)), 15000);
    work((error, result) => { clearTimeout(timer); error ? reject(error) : resolve(result); });
  });
}
async function info(host: FileHost, file: string) { return host.remote ? remoteCall<Stats>(done => host.remote!.files.stat(file, done)) : stat(file); }
function entry(name: string, attrs: { size: number; mode: number; isDirectory(): boolean; isSymbolicLink(): boolean }, modified: number): FileEntry {
  return { name, directory: attrs.isDirectory(), symlink: attrs.isSymbolicLink(), size: attrs.size, modified, mode: attrs.mode };
}
export async function listFiles(host: FileHost, input: string): Promise<FileListing> {
  const directory = filePath(host, input), entries: FileEntry[] = []; let truncated = false;
  if (host.remote) {
    const sftp = host.remote.files;
    // Read directory handles in batches instead of accumulating unbounded listings.
    const handle = await remoteCall<Buffer>(done => sftp.opendir(directory, done));
    try {
      while (true) {
        const batch = await remoteCall<import('ssh2').FileEntryWithStats[] | false>(done => sftp.readdir(handle, (error, result) => (error as Error & { code?: number })?.code === 1 ? done(null, false) : done(error, result)));
        if (!batch || !batch.length) break;
        for (const item of batch) if (item.filename !== '.' && item.filename !== '..') {
          if (entries.length >= 10000) { truncated = true; break; }
          const value = entry(item.filename, item.attrs, item.attrs.mtime * 1000);
          if (value.symlink) value.directory = await info(host, path.posix.join(directory, value.name)).then(s => s.isDirectory(), () => false);
          entries.push(value);
        }
        if (truncated) break;
      }
    } finally { await remoteCall<void>(done => sftp.close(handle, error => done(error, undefined))).catch(() => {}); }
  } else {
    for await (const item of await opendir(directory)) {
      if (entries.length >= 10000) { truncated = true; break; }
      const file = path.join(directory, item.name);
      const attrs = await lstat(file).catch(() => undefined); if (!attrs) continue;
      const value = entry(item.name, attrs, attrs.mtimeMs);
      if (value.symlink) value.directory = await stat(file).then(s => s.isDirectory(), () => false);
      entries.push(value);
    }
  }
  entries.sort((a, b) => Number(b.directory) - Number(a.directory) || a.name.localeCompare(b.name, undefined, { numeric: true }));
  return { path: directory, parent: path.posix.dirname(directory), entries, truncated };
}
export async function uploadFile(host: FileHost, directory: string, name: string, req: IncomingMessage) {
  if (!name || name === '.' || name === '..' || /[/\\\x00-\x1f\x7f]/.test(name) || Buffer.byteLength(name) > 255) throw fail('Choose a valid file name.');
  const file = path.posix.join(filePath(host, directory), name);
  if (!(await info(host, path.posix.dirname(file))).isDirectory()) throw fail('Upload destination is not a directory.');
  if (Number(req.headers['content-length']) > MAX_UPLOAD) throw fail('Uploads are limited to 1 GB per file.', 413);
  // Exclusive creation prevents overwriting files or following a destination symlink.
  const output = host.remote ? host.remote.files.createWriteStream(file, { flags: 'wx', mode: 0o600 }) : createWriteStream(file, { flags: 'wx', mode: 0o600 });
  let opened = false, bytes = 0;
  output.once('open', () => { opened = true; });
  const limit = new Transform({ transform(chunk, _encoding, done) { bytes += chunk.length; done(bytes > MAX_UPLOAD ? fail('Uploads are limited to 1 GB per file.', 413) : null, chunk); } });
  const abort = new AbortController(), timeout = setTimeout(() => abort.abort(), 30 * 60 * 1000);
  const interrupted = () => abort.abort(); req.once('aborted', interrupted);
  req.pipe(limit);
  try { await pipeline(limit, output, { signal: abort.signal }); return { name, bytes }; }
  catch (error) {
    if (opened) await (host.remote ? remoteCall<void>(done => host.remote!.files.unlink(file, error => done(error, undefined))) : unlink(file)).catch(() => {});
    throw error;
  } finally { clearTimeout(timeout); req.off('aborted', interrupted); req.unpipe(limit); req.resume(); }
}
interface Download { host: FileHost; file: string; name: string; until: number; valid: () => boolean }
const downloads = new Map<string, Download>();
export async function downloadTicket(host: FileHost, input: string, valid: () => boolean, name?: string) {
  const file = filePath(host, input);
  if (!(await info(host, file)).isFile()) throw fail('Choose a regular file to download.');
  for (const [id, item] of downloads) if (item.until < Date.now() || !item.valid()) downloads.delete(id);
  if (downloads.size >= 256) throw fail('Too many pending downloads. Try again shortly.', 429);
  const ticket = randomBytes(32).toString('hex');
  downloads.set(ticket, { host, file, name: name || path.posix.basename(file), until: Date.now() + 60000, valid });
  return { ticket };
}
export async function sendDownload(ticket: string, req: IncomingMessage, res: ServerResponse) {
  const item = downloads.get(ticket); downloads.delete(ticket);
  if (!item || item.until < Date.now() || !item.valid()) throw fail('This download link has expired. Download the file again.', 404);
  if (!(await info(item.host, item.file)).isFile()) throw fail('Choose a regular file to download.');
  const input = item.host.remote ? item.host.remote.files.createReadStream(item.file) : createReadStream(item.file);
  res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Disposition': `attachment; filename="download"; filename*=UTF-8''${encodeURIComponent(item.name).replace(/['()*]/g, c => '%' + c.charCodeAt(0).toString(16))}`, 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' });
  try { await pipeline(input, res, { signal: AbortSignal.timeout(30 * 60 * 1000) }); }
  catch { res.destroy(); }
}
export function fileError(error: unknown) {
  const e = error as Error & { code?: string | number; status?: number };
  if (e.code === 'EEXIST' || e.code === 11) return fail('A file with that name already exists. Rename your file before uploading.', 409);
  if (e.code === 'ENOENT' || e.code === 2) return fail('File or directory not found.', 404);
  if (e.code === 'EACCES' || e.code === 'EPERM' || e.code === 3) return fail('Permission denied for this file or directory.', 403);
  return e;
}
