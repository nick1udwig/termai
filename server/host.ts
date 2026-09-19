import { access, stat } from 'node:fs/promises';
import { constants } from 'node:fs';
import type { EngineHost } from '../src/engine/host.ts';
import { directoryEntries } from './directories.ts';
import { syntaxValid } from './syntax.ts';

/** Native implementation of the engine's host facts. */
export function localHost(cwd: string): EngineHost {
  return {
    async stat(file, signal) {
      signal?.throwIfAborted();
      const info = await stat(file).catch(() => undefined);
      if (!info) return undefined;
      const executable = info.isFile() && await access(file, constants.X_OK).then(() => true, () => false);
      signal?.throwIfAborted();
      return { file: info.isFile(), directory: info.isDirectory(), executable };
    },
    async entries(dir, limit, signal) {
      return (await directoryEntries(dir, limit, signal)).map(entry => ({ name: entry.name, directory: entry.isDirectory(), symlink: entry.isSymbolicLink() }));
    },
    syntax: (command, signal) => syntaxValid(command, cwd, signal),
  };
}
