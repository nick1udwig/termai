import { createReadStream } from 'node:fs';
import { isUtf8 } from 'node:buffer';
import { stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { Session } from './session.ts';

export const MAX_READING_BYTES = 20 * 1024 * 1024;
const types: Record<string, string> = {
  '.txt': 'text/plain', '.md': 'text/markdown', '.markdown': 'text/markdown', '.log': 'text/plain',
  '.json': 'application/json', '.jsonl': 'text/plain', '.csv': 'text/csv', '.tsv': 'text/tab-separated-values',
  '.xml': 'application/xml', '.yaml': 'text/plain', '.yml': 'text/plain', '.toml': 'text/plain',
  '.html': 'text/plain', '.htm': 'text/plain', '.css': 'text/plain', '.js': 'text/plain', '.ts': 'text/plain',
  '.tsx': 'text/plain', '.jsx': 'text/plain', '.py': 'text/plain', '.sh': 'text/plain', '.bash': 'text/plain',
  '.go': 'text/plain', '.rs': 'text/plain', '.c': 'text/plain', '.h': 'text/plain', '.cpp': 'text/plain',
  '.java': 'text/plain', '.sql': 'text/plain', '.svg': 'text/plain',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
  '.webp': 'image/webp', '.avif': 'image/avif', '.bmp': 'image/bmp', '.ico': 'image/x-icon',
  '.pdf': 'application/pdf', '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.ogg': 'audio/ogg',
  '.m4a': 'audio/mp4', '.flac': 'audio/flac', '.mp4': 'video/mp4', '.webm': 'video/webm',
};

export function readingMime(file: string, data: Buffer): string {
  const type = types[path.extname(file).toLowerCase()];
  if (type) return type;
  if (data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return 'image/png';
  if (data[0] === 255 && data[1] === 216 && data[2] === 255) return 'image/jpeg';
  if (/^GIF8[79]a/.test(data.subarray(0, 6).toString('ascii'))) return 'image/gif';
  if (data.subarray(0, 4).toString() === 'RIFF' && data.subarray(8, 12).toString() === 'WEBP') return 'image/webp';
  if (data.subarray(0, 5).toString() === '%PDF-') return 'application/pdf';
  return data.subarray(0, 4096).includes(0) || !isUtf8(data) ? 'application/octet-stream' : 'text/plain';
}

export function resolveReadingPath(session: Session, input: string): string {
  if (!input || input.length > 4096 || /[\x00-\x1f\x7f]/.test(input)) throw Object.assign(new Error('Enter a file path.'), { status: 400 });
  const posix = !!session.remote;
  const paths = posix ? path.posix : path;
  const home = posix ? session.remote!.home : os.homedir();
  const expanded = input === '~' ? home : input.startsWith('~/') ? paths.join(home, input.slice(2)) : input;
  return paths.resolve(session.state.cwd, expanded);
}

export async function readForViewing(session: Session, input: string): Promise<{ file: string; data: Buffer; mime: string }> {
  const file = resolveReadingPath(session, input);
  let data: Buffer;
  if (session.remote) data = await session.remote.readForViewing(file, MAX_READING_BYTES);
  else {
    const info = await stat(file).catch(error => { if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw Object.assign(new Error('File not found.'), { status: 404 }); throw error; });
    if (!info.isFile()) throw Object.assign(new Error('This path is not a regular file.'), { status: 400 });
    if (info.size > MAX_READING_BYTES) throw Object.assign(new Error('This file is too large for Reading Mode (20 MB limit).'), { status: 413 });
    const chunks: Buffer[] = []; let size = 0;
    for await (const chunk of createReadStream(file)) {
      size += chunk.length;
      if (size > MAX_READING_BYTES) throw Object.assign(new Error('This file is too large for Reading Mode (20 MB limit).'), { status: 413 });
      chunks.push(chunk);
    }
    data = Buffer.concat(chunks);
  }
  return { file, data, mime: readingMime(file, data) };
}
