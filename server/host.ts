import type { EngineHost } from '../src/engine/host.ts';
import { directoryHost } from './directory-host.ts';
import { syntaxValid } from './syntax.ts';
export function localHost(cwd: string): EngineHost {
  return { ...directoryHost, syntax: (command, signal) => syntaxValid(command, cwd, signal) };
}
