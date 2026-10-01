import type { EngineHost, Environment } from '../src/engine/host.ts';
import { directoryHost } from './directory-host.ts';
import { syntaxValid } from './syntax.ts';
import { shellComplete } from './completion.ts';
export function localHost(cwd: string, env: Environment = {}): EngineHost {
  return { ...directoryHost, syntax: (command, signal) => syntaxValid(command, cwd, signal),
    complete: (words, signal) => shellComplete(words, cwd, env, signal) };
}
