import { spawn } from 'node:child_process';
import { herdrSession } from '../src/herdr-protocol.ts';
import { herdrRequest, herdrSocket, type HerdrTarget } from './herdr.ts';
import { shellQuote } from '../src/engine/repair.ts';
import type { Session } from './session.ts';

// Divert plain interactive launches; other commands retain normal shell behavior.
export const HERDR_SHELL = String.raw`
__termai_capture_herdr() {
  local termai_pattern='^[[:space:]]*((/[^[:space:]]*/)?herdr)([[:space:]]+--session[[:space:]]+[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}|[[:space:]]+session[[:space:]]+attach[[:space:]]+[a-zA-Z0-9][a-zA-Z0-9_-]{0,63})?[[:space:]]*$'
  [[ "$READLINE_LINE" =~ $termai_pattern ]] || return 1
  local termai_binary; read -r termai_binary _ <<< "$READLINE_LINE"
  [[ "$(builtin type -t "$termai_binary")" == file ]] || return 1
  [[ "$READLINE_LINE" == [[:space:]]* ]] || builtin history -s "$READLINE_LINE"
  printf '\r\n\033]777;termai;%s;herdr;%s\007' "$TERMAI_NONCE" "$(printf '%s' "$READLINE_LINE" | command base64)"
  READLINE_LINE= READLINE_POINT=0
}
`;
export function parseHerdrCommand(command: string, env: NodeJS.ProcessEnv) {
  const match = /^\s*((?:\/[^\s]*\/)?herdr)(?:\s+(?:--session|session\s+attach)\s+([a-zA-Z0-9][a-zA-Z0-9_-]{0,63}))?\s*$/.exec(command);
  if (!match) throw new Error('Use herdr or herdr --session <name>.');
  return { binary: match[1], session: herdrSession(match[2] || env.HERDR_SESSION) };
}
export async function captureHerdr(source: Session, command: string): Promise<HerdrTarget> {
  const env = await source.environment(), parsed = parseHerdrCommand(command, env);
  const target: HerdrTarget = { session: parsed.session, remote: source.remote, socketPath: herdrSocket(parsed.session, env), binary: parsed.binary, env };
  try { await herdrRequest(target, 'session.snapshot'); return target; } catch { /* A normal launch also starts an absent server. */ }
  const args = [...(parsed.session ? ['--session', parsed.session] : []), 'server'];
  if (source.remote) {
    const assignments = Object.entries(env).filter(([key, value]) => value !== undefined && /^[A-Za-z_][A-Za-z0-9_]*$/.test(key) && !key.startsWith('TERMAI_')).map(([key, value]) => key + '=' + shellQuote(value!));
    await source.remote.exec('cd ' + shellQuote(source.state.cwd) + ' && nohup env ' + assignments.join(' ') + ' ' + [parsed.binary, ...args].map(shellQuote).join(' ') + ' </dev/null >/dev/null 2>&1 &');
  } else {
    const child = spawn(parsed.binary, args, { cwd: source.state.cwd, env, detached: true, stdio: 'ignore' });
    await new Promise<void>((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); }); child.unref();
  }
  for (let attempt = 0; attempt < 20; attempt++) {
    await new Promise(resolve => setTimeout(resolve, 100));
    try { await herdrRequest(target, 'session.snapshot'); return target; } catch { /* Wait for the new socket. */ }
  }
  throw new Error('Herdr did not start. Run herdr server on this machine and try again.');
}
