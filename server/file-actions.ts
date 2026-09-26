import * as fs from 'node:fs/promises';
import { createReadStream, createWriteStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { createHash, randomBytes } from 'node:crypto';
import path from 'node:path';
import type { Stats } from 'ssh2';
import { filePath, listFiles, type FileHost } from './files.ts';
const fail = (message: string, status = 400) => Object.assign(new Error(message), { status });
function call<T>(run: (done: (error: Error | null | undefined, value: T) => void) => void) { return new Promise<T>((resolve, reject) => { const timer = setTimeout(() => reject(fail('Remote filesystem timed out.', 504)), 15000); run((error, value) => { clearTimeout(timer); error ? reject(error) : resolve(value); }); }); }
const attrs = (host: FileHost, file: string) => host.remote ? call<Stats>(done => host.remote!.files.lstat(file, done)) : fs.lstat(file);
const digest = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
function name(value: unknown) { if (typeof value !== 'string' || !value || value === '.' || value === '..' || /[/\\\x00-\x1f\x7f]/.test(value) || Buffer.byteLength(value) > 255) throw fail('Enter a valid file name.'); return value; }
async function absent(host: FileHost, file: string) { try { await attrs(host, file); } catch (e) { if (['ENOENT', 2].includes((e as { code: string | number }).code)) return; throw e; } throw fail('A file with that name already exists.', 409); }
async function rename(host: FileHost, from: string, to: string) { if (host.remote) await call<void>(done => host.remote!.files.rename(from, to, error => done(error, undefined))); else await fs.rename(from, to); }
async function remove(host: FileHost, file: string, directory = false) { if (host.remote) await call<void>(done => host.remote!.files[directory ? 'rmdir' : 'unlink'](file, error => done(error, undefined))); else await (directory ? fs.rmdir(file) : fs.unlink(file)); }
async function textFile(host: FileHost, file: string) {
  const stat = await attrs(host, file);
  if (!stat.isFile() || stat.size > 32768) throw fail('Edit supports text files up to 32 KB.');
  const input = host.remote ? host.remote.files.createReadStream(file) : createReadStream(file), chunks: Buffer[] = []; let size = 0;
  try { for await (const chunk of input) { size += chunk.length; if (size > 32768) throw fail('Edit supports text files up to 32 KB.'); chunks.push(Buffer.from(chunk)); } } finally { input.destroy(); }
  const bytes = Buffer.concat(chunks); let text: string;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { throw fail('This is not a UTF-8 text file.'); }
  if (text.includes('\0')) throw fail('Binary files cannot be edited as text.');
  return { text, version: digest(bytes), mode: stat.mode };
}
/** Same bounded filesystem operations for local sessions and SFTP sessions. */
export async function fileAction(host: FileHost, input: Record<string, unknown>) {
  const action = input.action;
  if (action === 'read' || action === 'write' || action === 'rename') {
    const file = filePath(host, input.path as string);
    if (action === 'rename') { const destination = path.posix.join(path.posix.dirname(file), name(input.name)); if (destination === file) return { ok: true }; await absent(host, destination); await rename(host, file, destination); return { ok: true }; }
    const original = await textFile(host, file); if (action === 'read') return original;
    if (typeof input.text !== 'string' || Buffer.byteLength(input.text) > 32768 || input.text.includes('\0')) throw fail('Edit supports text files up to 32 KB.');
    if (input.version !== original.version) throw fail('The file changed since you opened it. Reopen it before saving.', 409);
    const temporary = path.posix.join(path.posix.dirname(file), '.termai-edit-' + randomBytes(12).toString('hex'));
    const output = host.remote ? host.remote.files.createWriteStream(temporary, { flags: 'wx', mode: original.mode & 0o777 }) : createWriteStream(temporary, { flags: 'wx', mode: original.mode & 0o777 });
    try {
      await pipeline([Buffer.from(input.text)], output, { signal: AbortSignal.timeout(30000) });
      if ((await textFile(host, file)).version !== original.version) throw fail('The file changed while saving. Reopen it before saving.', 409);
      if (host.remote) await call<void>(done => host.remote!.files.ext_openssh_rename(temporary, file, error => done(error, undefined))); else await fs.rename(temporary, file);
    } finally { await remove(host, temporary).catch(() => {}); }
    return { ok: true };
  }
  if (!['copy', 'delete'].includes(action as string) || !Array.isArray(input.paths) || !input.paths.length || input.paths.length > 100) throw fail('Select between 1 and 100 items.');
  const files = [...new Set(input.paths.map(value => filePath(host, value as string)))];
  if (files.some(file => file === '/')) throw fail('The filesystem root cannot be changed.');
  // Never recurse through links, nor copy a directory into itself.
  const destination = action === 'copy' ? filePath(host, input.destination as string) : '';
  if (destination && !(await attrs(host, destination)).isDirectory()) throw fail('Choose a destination folder.');
  let count = 0, bytes = 0; const deadline = Date.now() + 120000;
  async function visit(file: string, to?: string, depth = 0): Promise<void> {
    if (++count > 10000 || depth > 32 || Date.now() > deadline) throw fail('Operation limit reached. Select fewer items.');
    const stat = await attrs(host, file);
    if (to) await absent(host, to);
    if (stat.isSymbolicLink()) {
      if (to) { const target = host.remote ? await call<string>(done => host.remote!.files.readlink(file, done)) : await fs.readlink(file); if (host.remote) await call<void>(done => host.remote!.files.symlink(target, to, error => done(error, undefined))); else await fs.symlink(target, to); }
      else await remove(host, file);
    } else if (stat.isDirectory()) {
      const listing = await listFiles(host, file); if (listing.truncated) throw fail('Folder has too many entries. Select a smaller folder.');
      if (to) { if (host.remote) await call<void>(done => host.remote!.files.mkdir(to, { mode: stat.mode & 0o777 }, error => done(error, undefined))); else await fs.mkdir(to, { mode: stat.mode & 0o777 }); }
      for (const child of listing.entries) await visit(path.posix.join(file, child.name), to ? path.posix.join(to, child.name) : undefined, depth + 1);
      if (!to) await remove(host, file, true);
    } else if (stat.isFile()) {
      if (to) {
        bytes += stat.size; if (bytes > 1024 ** 3) throw fail('Copy is limited to 1 GB per operation.');
        const source = host.remote ? host.remote.files.createReadStream(file) : createReadStream(file), target = host.remote ? host.remote.files.createWriteStream(to, { flags: 'wx', mode: stat.mode & 0o777 }) : createWriteStream(to, { flags: 'wx', mode: stat.mode & 0o777 });
        let opened = false; target.once('open', () => { opened = true; });
        try { await pipeline(source, target, { signal: AbortSignal.timeout(120000) }); } catch (error) { if (opened) await remove(host, to).catch(() => {}); throw error; }
      } else await remove(host, file);
    } else throw fail('Only regular files, folders and links are supported.');
  }
  const targets = files.map(file => destination ? path.posix.join(destination, path.posix.basename(file)) : undefined);
  for (const [i, target] of targets.entries()) if (target) { if (target === files[i] || target.startsWith(files[i] + '/')) throw fail('Choose a destination outside the selected folder.'); await absent(host, target); }
  for (const [i, file] of files.entries()) await visit(file, targets[i]);
  return { ok: true };
}
