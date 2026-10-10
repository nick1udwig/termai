import { access, stat } from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import type { DirectoryHost } from '../src/directory-data.ts';
import { directoryFacts, directorySnapshot } from './directories.ts';

/** Recover stored case without realpath, which would replace symlink aliases. */
export async function pathSpelling(file: string, signal?: AbortSignal): Promise<string | undefined> {
  const parts = path.resolve(file).split('/').filter(Boolean);
  if (parts.length > 64) return undefined;
  let actual = '/';
  for (const part of parts) {
    const entries = await directoryFacts(actual, 10000, signal);
    const fold = (name: string) => name.normalize('NFC').toLowerCase();
    const entry = entries.find(entry => entry.name === part) || entries.find(entry => fold(entry.name) === fold(part));
    if (!entry) return undefined; // A bounded or inaccessible listing cannot prove spelling.
    actual = path.join(actual, entry.name);
  }
  return actual;
}

export const directoryHost: DirectoryHost = {
  async stat(file, signal, checkExecutable = true) {
    signal?.throwIfAborted();
    const info = await stat(file).catch(() => undefined);
    if (!info) { signal?.throwIfAborted(); return undefined; }
    const executable = checkExecutable && info.isFile() && await access(file, constants.X_OK).then(() => true, () => false);
    // Darwin commonly accepts differently cased filenames, so existence alone
    // cannot supply the spelling used by directory and file suggestions.
    const spelling = process.platform === 'darwin' ? await pathSpelling(file, signal) : undefined;
    signal?.throwIfAborted();
    return { file: info.isFile(), directory: info.isDirectory(), executable,
      ...(spelling && spelling !== path.resolve(file) ? { spelling } : {}) };
  },
  entries: directoryFacts,
  async lookup(file, signal) {
    const info = await directoryHost.stat(file, signal);
    // A data operation: no fuzzy matching or transcript interpretation on the host.
    return info ? { info } : { listing: await directorySnapshot(path.dirname(file), 10000, signal) };
  },
};
