import { access, stat } from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import type { DirectoryHost } from '../src/directory-data.ts';
import { directoryFacts, directorySnapshot } from './directories.ts';

export const directoryHost: DirectoryHost = {
  async stat(file, signal) {
    signal?.throwIfAborted();
    const info = await stat(file).catch(() => undefined);
    if (!info) { signal?.throwIfAborted(); return undefined; }
    const executable = info.isFile() && await access(file, constants.X_OK).then(() => true, () => false);
    signal?.throwIfAborted();
    return { file: info.isFile(), directory: info.isDirectory(), executable };
  },
  entries: directoryFacts,
  async lookup(file, signal) {
    const info = await directoryHost.stat(file, signal);
    // A data operation: no fuzzy matching or transcript interpretation on the host.
    return info ? { info } : { listing: await directorySnapshot(path.dirname(file), 10000, signal) };
  },
};
