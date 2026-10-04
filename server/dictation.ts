import { readFile, stat, access } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { WebSocket } from 'ws';
import { randomBytes } from 'node:crypto';
import { MAX_OPUS_BYTES, parseOpusFrame } from '../src/voxtype-audio.ts';

export interface DictationStatus { installed: boolean; available: boolean; reason?: string }
interface Configuration { url: URL; token: string }
const directory = () => path.join(process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local/share'), 'voxtype-mobile');
async function configuration(): Promise<Configuration> {
  const file = process.env.TERMAI_VOXTYPE_TOKEN_FILE || path.join(directory(), 'token');
  if ((await stat(file)).mode & 0o077) throw new Error('Voxtype token must be private (chmod 600).');
  const token = (await readFile(file, 'utf8')).trim();
  if (token.length < 32 || /[\r\n]/.test(token)) throw new Error('Invalid Voxtype token.');
  const url = new URL(process.env.TERMAI_VOXTYPE_URL || 'ws://127.0.0.1:8765/v1/dictate');
  if (url.protocol !== 'ws:' || !['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname) || url.username || url.password || url.search || url.hash) throw new Error('Voxtype must use a local WebSocket endpoint.');
  return { url, token };
}
export function compatible(value: any): boolean {
  return value?.type === 'capabilities' && value.protocol === 2 && value.dictation === true && value.sample_rate === 16000 && value.channels === 1 && value.format === 'opus' && value.framing === 'sequence_opus_v1' && Array.isArray(value.audio_encodings) && value.audio_encodings.includes('opus_v1') && Array.isArray(value.results) && value.results.includes('final');
}
export async function detectDictation(): Promise<DictationStatus> {
  const paths = [process.env.TERMAI_VOXTYPE_TOKEN_FILE || path.join(directory(), 'token'), path.join(directory(), 'voxtype')];
  const installed = (await Promise.all(paths.map(file => access(file).then(() => true, () => false)))).some(Boolean);
  try {
    const config = await configuration();
    const url = new URL(config.url); url.pathname = url.pathname.replace(/\/dictate$/, '/capabilities');
    const available = await new Promise<boolean>((resolve) => {
      const socket = new WebSocket(url, { headers: { Authorization: 'Bearer ' + config.token }, handshakeTimeout: 1500, maxPayload: 16384 });
      const timer = setTimeout(() => finish(false), 2000);
      const finish = (value: boolean) => { clearTimeout(timer); resolve(value); socket.terminate(); };
      socket.on('error', () => finish(false)); socket.on('close', () => finish(false));
      socket.once('message', bytes => { try { finish(compatible(JSON.parse(bytes.toString()))); } catch { finish(false); } });
    });
    return { installed: true, available, ...(!available ? { reason: 'Voxtype is installed but its dictation API is unavailable or needs updating.' } : {}) };
  } catch { return { installed, available: false }; }
}

export async function installCommand(): Promise<string> {
  const local = process.env.TERMAI_VOXTYPE_SOURCE || path.join(os.homedir(), 'git/voxtype-mobile');
  try { await access(path.join(local, 'scripts/install')); return `bash '${path.join(local, 'scripts/install').replaceAll("'", "'\\''")}'`; } catch {}
  const address = process.env.TERMAI_VOXTYPE_INSTALL_URL;
  if (!address) throw new Error('Set TERMAI_VOXTYPE_INSTALL_URL to the published voxtype-mobile install script, or TERMAI_VOXTYPE_SOURCE to its checkout.');
  const url = new URL(address);
  if (url.protocol !== 'https:') throw new Error('The installer URL must use HTTPS.');
  const parts = url.pathname.split('/').filter(Boolean);
  const repository = process.env.TERMAI_VOXTYPE_REPO || (url.hostname === 'raw.githubusercontent.com' && parts.length >= 4 ? `https://github.com/${parts[0]}/${parts[1]}.git` : undefined);
  if (!repository) throw new Error('Set TERMAI_VOXTYPE_REPO to the repository used by the downloaded installer.');
  const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
  return `(termai_voxtype_installer=$(mktemp) && trap 'rm -f "$termai_voxtype_installer"' EXIT && curl -fsSL ${quote(url.href)} -o "$termai_voxtype_installer" && VOXTYPE_MOBILE_REPO=${quote(repository)} bash "$termai_voxtype_installer")`;
}

/** One browser recording, one daemon connection. No model or desktop output path. */
export class Dictation {
  private socket?: WebSocket;
  private done = false;
  private ready = false;
  private finishing = false;
  private bytes = 0;
  private maxBytes = MAX_OPUS_BYTES;
  private maxSamples = 16000 * 300;
  private frames = 0;
  private audioFinal = false;
  private timer: ReturnType<typeof setTimeout>;
  private result: (text: string) => void;
  private status: (state: 'ready' | 'done' | 'error', message?: string) => void;
  constructor(result: (text: string) => void, status: (state: 'ready' | 'done' | 'error', message?: string) => void) {
    this.result = result; this.status = status;
    this.timer = setTimeout(() => this.fail('Dictation timed out.'), 10000);
    void this.connect();
  }
  private async connect() {
    try {
      const config = await configuration();
      if (this.done) return;
      const socket = this.socket = new WebSocket(config.url, { headers: { Authorization: 'Bearer ' + config.token, 'X-Voxtype-Protocol': '2', 'X-Voxtype-Audio': 'opus_v1', 'X-Voxtype-Session': randomBytes(16).toString('hex') }, handshakeTimeout: 3000, maxPayload: 65536 });
      socket.on('error', () => this.fail('Could not connect to Voxtype.'));
      socket.on('close', () => { if (!this.done) this.fail('Voxtype disconnected. Please try again.'); });
      socket.on('message', bytes => {
        if (this.done) return;
        try {
          const event = JSON.parse(bytes.toString());
          if (event.type === 'ready' && !this.ready) {
            if (event.protocol !== 2 || event.sample_rate !== 16000 || event.channels !== 1 || event.format !== 'opus' || event.audio_encoding !== 'opus_v1' || event.framing !== 'sequence_opus_v1' || event.accepted_frames !== 0 || event.finished !== false || event.resume !== true) throw new Error('Unsupported Voxtype audio format. Update Termai and Voxtype together.');
            this.maxSamples = Math.min(300, Math.max(1, Number(event.max_seconds) || 300)) * 16000;
            this.maxBytes = Math.min(MAX_OPUS_BYTES, Math.max(17, Number(event.max_encoded_bytes) || MAX_OPUS_BYTES));
            this.ready = true; clearTimeout(this.timer);
            this.timer = setTimeout(() => this.fail('Dictation timed out.'), 480000);
            this.status('ready');
          } else if (event.type === 'final') {
            if (!this.finishing || typeof event.text !== 'string' || event.text.length > 16000) throw new Error('Invalid Voxtype result.');
            // Collapse spoken paragraph breaks; never pass terminal controls to the PTY.
            const text = event.text.replace(/[\r\n\t]+/g, ' ');
            if (/[\x00-\x1f\x7f-\x9f]/.test(text)) throw new Error('Voxtype returned terminal control characters.');
            this.result(text); this.close('ack'); this.status('done');
          } else if (event.type === 'error') throw new Error(event.code === 'busy' ? 'Voxtype is busy. Try again after the current dictation.' : 'Voxtype could not transcribe this recording.');
          // Revisable partials stay on the backend. Only final text is inserted.
        } catch (error) { this.fail(error instanceof Error ? error.message : 'Invalid Voxtype response.'); }
      });
    } catch { this.fail('Voxtype is unavailable.'); }
  }
  audio(bytes: Buffer) {
    if (this.done) return;
    try {
      const frame = parseOpusFrame(bytes);
      if (!this.ready || this.finishing || this.audioFinal || frame.sequence !== this.frames || frame.totalSamples > this.maxSamples || this.bytes + bytes.length > this.maxBytes || !this.socket || this.socket.bufferedAmount > 256 * 1024) throw new Error('Recording exceeded the audio limit or connection capacity. Please try again.');
      this.bytes += bytes.length; this.frames++; this.audioFinal = frame.final; this.socket.send(bytes);
    } catch (error) { this.fail(error instanceof Error ? error.message : 'Invalid Opus audio.'); }
  }
  finish() {
    if (!this.ready || this.done || this.finishing) return;
    if (!this.audioFinal) { this.fail('Recording ended without complete Opus audio.'); return; }
    this.finishing = true; this.socket!.send(JSON.stringify({ type: 'finish' }));
  }
  cancel() { this.close('cancel'); }
  private close(type: 'ack' | 'cancel') {
    if (this.done) return;
    this.done = true; clearTimeout(this.timer);
    if (this.socket?.readyState === WebSocket.OPEN) {
      this.socket.send(JSON.stringify({ type })); this.socket.close();
      const socket = this.socket; const timer = setTimeout(() => socket.terminate(), 2000); timer.unref();
      socket.once('close', () => clearTimeout(timer));
    } else this.socket?.terminate();
  }
  private fail(message: string) { if (this.done) return; this.cancel(); this.status('error', message); }
}
