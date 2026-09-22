import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import ssh2, { type ParsedKey, type AnyAuthMethod, type BaseAgent, type SigningRequestOptions, type SignCallback } from 'ssh2';
import { fingerprint } from './vault.ts';
import { sshAddress, type KeyReference } from '../src/connections.ts';
const exec = promisify(execFile);
export class NativeSSH extends Error {}
/** Only literal interactive SSH commands. Shell expansions/operators stay with Bash. */
export function sshArguments(command: string): string[] | undefined {
  const words: string[] = []; let word = '', quote = '', started = false;
  for (let i = 0; i < command.length; i++) {
    const c = command[i];
    if (c === '\\' && quote !== "'") {
      if (++i === command.length) return;
      if (quote === '"' && !/[\\"$`]/.test(command[i])) word += '\\';
      word += command[i]; started = true;
    }
    else if (quote) { if (c === quote) quote = ''; else { if (quote === '"' && /[$`]/.test(c)) return; word += c; } }
    else if (c === '"' || c === "'") { quote = c; started = true; }
    else if (/\s/.test(c)) { if (started) { words.push(word); word = ''; started = false; } }
    else { if (/[;&|<>$`(){}*?\[\]#]/.test(c)) return; word += c; started = true; }
  }
  if (quote) return; if (started) words.push(word);
  if (!['ssh', '/usr/bin/ssh'].includes(words.shift() || '')) return;
  let destination = false;
  const options = new Set(['identityfile', 'identitiesonly', 'identityagent', 'hostname', 'user', 'port', 'userknownhostsfile', 'globalknownhostsfile', 'stricthostkeychecking', 'hostkeyalias']);
  for (let i = 0; i < words.length; i++) {
    const value = words[i]; if (destination) return;
    if (value === '-t' || value === '-tt') continue;
    const match = value.match(/^-(i|p|l|F|o)(.*)$/);
    if (match) {
      const argument = match[2] || words[++i]; if (!argument) return;
      if (match[1] === 'o' && !options.has(argument.split(/[=\s]/)[0].toLowerCase())) return;
    } else if (value.startsWith('-')) return;
    else destination = true;
  }
  return destination ? words : undefined;
}
function parsed(raw: Buffer | string | ParsedKey, passphrase?: string): ParsedKey | undefined {
  const value = ssh2.utils.parseKey(raw, passphrase); return value instanceof Error ? undefined : value;
}
export function keyInfo(key: ParsedKey) { return { publicKey: key.type + ' ' + key.getPublicSSH().toString('base64'), fingerprint: fingerprint(key.getPublicSSH()) }; }
function expand(file: string, env: NodeJS.ProcessEnv, cwd: string) {
  const home = os.homedir(); // OpenSSH resolves ~ using the service account, not shell HOME.
  if (/^~[^/]/.test(file) || /%[A-Za-z]/.test(file)) throw new NativeSSH('This SSH path uses an unsupported expansion.');
  const expanded = file.replace(/^~(?=\/|$)/, home).replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_, name) => {
    if (!env[name]) throw new NativeSSH('This SSH path needs an environment variable.');
    return env[name]!;
  });
  return path.resolve(cwd, expanded);
}
export async function readIdentity(file: string, passphrase?: string) {
  const info = await stat(file); if (!info.isFile() || info.size > 20000) throw new Error('Invalid SSH identity file.');
  const raw = await readFile(file);
  try { const key = parsed(raw, passphrase); return key?.isPrivateKey() ? key : undefined; } finally { raw.fill(0); }
}
class OneKeyAgent extends ssh2.BaseAgent {
  private agent: BaseAgent; private key: ParsedKey;
  constructor(agent: BaseAgent, key: ParsedKey) { super(); this.agent = agent; this.key = key; }
  getIdentities(callback: (err: Error | null, keys?: ParsedKey[]) => void) { callback(null, [this.key]); }
  sign(key: ParsedKey | string | Buffer, data: Buffer, options: SigningRequestOptions | SignCallback, callback?: SignCallback) {
    if (typeof options === 'function') this.agent.sign(key, data, options); else this.agent.sign(key, data, options, callback);
  }
}
export interface SystemIdentity { reference: KeyReference; publicKey: string; fingerprint: string; method: AnyAuthMethod }
export interface SystemSSH {
  host: string; port: number; username: string; identities: SystemIdentity[]; known: Set<string>; hostKeyAlgorithms?: string[]; locked: boolean;
}
export async function agentIdentities(socket: string) {
  const agent = ssh2.createAgent(socket);
  const keys = await new Promise<ParsedKey[]>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('SSH agent did not respond.')), 2000);
    agent.getIdentities((error, keys) => { clearTimeout(timer); error ? reject(error) : resolve((keys || []).map(item => { let raw: unknown = item; while (raw && typeof raw === 'object' && 'pubKey' in raw) raw = raw.pubKey; return parsed(raw as ParsedKey); }).filter((key): key is ParsedKey => !!key)); });
  });
  return keys.map(key => ({ key, agent: new OneKeyAgent(agent, key) }));
}
export async function resolveSystemSSH(command: string, env: NodeJS.ProcessEnv, cwd: string, passphrase?: string): Promise<SystemSSH> {
  const args = sshArguments(command); if (!args) throw new NativeSSH('This SSH invocation uses the native client.');
  const { stdout } = await exec('/usr/bin/ssh', ['-G', ...args], { env, cwd, timeout: 4000, maxBuffer: 256 * 1024 });
  const config = new Map<string, string[]>();
  for (const line of stdout.split('\n')) { const at = line.indexOf(' '); if (at > 0) { const name = line.slice(0, at), values = config.get(name) || []; values.push(line.slice(at + 1)); config.set(name, values); } }
  const value = (name: string) => config.get(name)?.[0];
  const configured = (name: string) => !!value(name) && value(name) !== 'none';
  if (['localforward', 'remoteforward', 'dynamicforward', 'localcommand', 'proxycommand', 'proxyjump', 'remotecommand', 'certificatefile', 'controlpath'].some(configured)
    || value('forwardx11') === 'yes' || value('permitlocalcommand') === 'yes'
    || value('tunnel') && !['false', 'no'].includes(value('tunnel')!)
    || value('sessiontype') !== 'default' || value('requesttty') === 'no' || value('forwardagent') !== 'no') throw new NativeSSH('This SSH configuration uses the native client.');
  const address = sshAddress({ host: value('hostname'), username: value('user'), port: Number(value('port')) });
  const identities: SystemIdentity[] = [], allowed = new Set<string>(); let locked = false;
  for (const name of (config.get('identityfile') || []).slice(0, 16)) {
    if (name === 'none') continue;
    const file = expand(name.replace(/%d/g, os.homedir()).replace(/%h/g, address.host).replace(/%r/g, address.username).replace(/%%/g, '%'), env, cwd);
    if (/%[A-Za-z]/.test(file)) throw new NativeSSH('This SSH identity path uses an unsupported token.');
    try { const info = await stat(file + '.pub'); if (info.isFile() && info.size <= 20000) { const pub = parsed(await readFile(file + '.pub')); if (pub) allowed.add(keyInfo(pub).fingerprint); } } catch {}
    try {
      const key = await readIdentity(file, passphrase);
      if (key) { const info = keyInfo(key); allowed.add(info.fingerprint); identities.push({ ...info, reference: { type: 'file', path: file }, method: { type: 'publickey', username: address.username, key } }); }
      else locked = true;
    } catch (error: any) { if (error.code !== 'ENOENT' && error.code !== 'EACCES') throw error; }
  }
  let socket = value('identityagent') || env.SSH_AUTH_SOCK;
  if (socket === 'SSH_AUTH_SOCK') socket = env.SSH_AUTH_SOCK;
  if (socket?.startsWith('$')) socket = env[socket.slice(1)];
  if (socket && socket !== 'none') {
    socket = expand(socket, env, cwd);
    const agentKeys: SystemIdentity[] = [];
    for (const { key, agent } of await agentIdentities(socket).catch(() => [])) {
      const info = keyInfo(key); if (value('identitiesonly') === 'yes' && !allowed.has(info.fingerprint)) continue;
      agentKeys.push({ ...info, reference: { type: 'agent', path: socket }, method: { type: 'agent', username: address.username, agent } });
    }
    // Prefer configured keys already unlocked in the agent, retaining agent order
    // within each group so unrelated keys do not exhaust the server's auth limit.
    agentKeys.sort((a, b) => Number(allowed.has(b.fingerprint)) - Number(allowed.has(a.fingerprint)));
    identities.unshift(...agentKeys);
  }
  const known = new Set<string>(), hostKeyAlgorithms = new Set<string>();
  const hostKeyName = value('hostkeyalias') || (address.port === 22 ? address.host : `[${address.host}]:${address.port}`);
  const knownFiles = [...(config.get('userknownhostsfile') || []), ...(config.get('globalknownhostsfile') || [])].flatMap(line => {
    const files = line.split(' ');
    // ssh -G drops quoting here; do not guess at filenames containing spaces.
    if (files.length > 1 && files.some(file => !/^(\/|~\/|\$\{)/.test(file))) throw new NativeSSH('This SSH known-hosts path uses the native client.');
    return files;
  });
  for (const name of knownFiles) {
    if (!name || name === 'none') continue;
    try {
      const result = await exec('/usr/bin/ssh-keygen', ['-F', hostKeyName, '-f', expand(name, env, cwd)], { timeout: 2000, maxBuffer: 256 * 1024 });
      for (const line of result.stdout.split('\n')) {
        if (!line || line.startsWith('#')) continue;
        if (line.startsWith('@')) throw new NativeSSH('Certificate or revoked host entries use the native SSH client.');
        const columns = line.split(/\s+/), key = parsed(columns.slice(1, 3).join(' ')); if (key) { known.add(fingerprint(key.getPublicSSH())); for (const algorithm of key.type === 'ssh-rsa' ? ['rsa-sha2-512', 'rsa-sha2-256', 'ssh-rsa'] : [key.type]) hostKeyAlgorithms.add(algorithm); }
      }
    } catch (error) { if (error instanceof NativeSSH) throw error; }
  }
  return { ...address, identities: identities.slice(0, 16), known, hostKeyAlgorithms: [...hostKeyAlgorithms], locked };
}
