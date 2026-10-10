import { existsSync } from 'node:fs';
import path from 'node:path';

/** macOS's system Bash predates the Readline and PS0 hooks used by Termai. */
export function localBash(env = process.env, platform = process.platform): string {
  if (env.TERMAI_BASH) {
    if (!path.isAbsolute(env.TERMAI_BASH)) throw new Error('TERMAI_BASH must be an absolute path to Bash 4.4 or newer.');
    return env.TERMAI_BASH;
  }
  if (platform === 'darwin') {
    for (const candidate of ['/opt/homebrew/bin/bash', '/usr/local/bin/bash']) if (existsSync(candidate)) return candidate;
    throw new Error('Install modern Bash with brew install bash, or set TERMAI_BASH to Bash 4.4 or newer.');
  }
  return '/bin/bash';
}
