import { probe, SharedTask } from './probes.ts';
import { localBash } from './shell.ts';
const syntaxCache = new Map<string, SharedTask<boolean>>();
export function syntaxValid(command: string, cwd: string, signal = AbortSignal.timeout(4000)): Promise<boolean> {
  signal.throwIfAborted();
  const key = JSON.stringify([cwd, command]);
  const cached = syntaxCache.get(key);
  if (cached && !cached.aborted) return cached.wait(signal);
  if (syntaxCache.size >= 1000) syntaxCache.delete(syntaxCache.keys().next().value!);
  const result = new SharedTask(probeSignal => checkSyntax(command, cwd, probeSignal));
  syntaxCache.set(key, result);
  return result.wait(signal);
}
async function checkSyntax(command: string, cwd: string, signal: AbortSignal): Promise<boolean> {
  try {
    // No startup files, inherited shell functions, or execution. Even substitutions
    // and redirections in this string are only parsed by Bash's noexec mode.
    await probe(localBash(), ['--noprofile', '--norc', '-n', '-c', command], {
      cwd, timeout: 1000, maxBuffer: 16384,
      env: { PATH: '/usr/bin:/bin', LC_ALL: 'C', BASH_ENV: '/dev/null', ENV: '/dev/null' },
    }, signal);
    return true;
  } catch { signal.throwIfAborted(); return false; }
}
