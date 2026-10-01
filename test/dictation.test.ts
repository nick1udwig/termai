import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { WebSocketServer } from 'ws';
import { compatible, detectDictation, Dictation } from '../server/dictation.ts';
import { Session } from '../server/session.ts';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';

test('capability negotiation rejects older/incompatible daemons', () => {
  assert.equal(compatible({ type: 'ready', protocol: 1 }), false);
  const caps = { type: 'capabilities', protocol: 1, dictation: true, sample_rate: 16000, channels: 1, format: 'pcm_s16le', results: ['partial', 'final'] };
  assert.equal(compatible(caps), true);
  for (const patch of [{ protocol: 2 }, { sample_rate: 48000 }, { results: ['partial'] }, { dictation: false }]) assert.equal(compatible({ ...caps, ...patch }), false);
});

test('backend authenticates discovery, consumes transcripts directly, and rejects injected controls', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'termai-voice-'));
  const token = 'test-secret-'.repeat(4);
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 }); await once(server, 'listening');
  const saved = { url: process.env.TERMAI_VOXTYPE_URL, file: process.env.TERMAI_VOXTYPE_TOKEN_FILE };
  process.env.TERMAI_VOXTYPE_URL = `ws://127.0.0.1:${(server.address() as any).port}/v1/dictate`;
  process.env.TERMAI_VOXTYPE_TOKEN_FILE = path.join(dir, 'token');
  let transcript = 'hello\nworld', received = 0, admissions = 0;
  server.on('connection', (socket, request) => {
    assert.equal(request.headers.authorization, 'Bearer ' + token);
    assert.equal(request.headers.origin, undefined);
    if (request.url === '/v1/capabilities') { socket.send(JSON.stringify({ type: 'capabilities', protocol: 1, dictation: true, sample_rate: 16000, channels: 1, format: 'pcm_s16le', results: ['partial', 'final'] })); return; }
    admissions++;
    socket.send(JSON.stringify({ type: 'ready', protocol: 1, sample_rate: 16000, channels: 1, format: 'pcm_s16le', max_seconds: 300 }));
    socket.on('message', (bytes, binary) => {
      if (binary) received += (bytes as Buffer).length;
      else if (JSON.parse(bytes.toString()).type === 'finish') {
        socket.send(JSON.stringify({ type: 'partial', text: 'never insert this' }));
        socket.send(JSON.stringify({ type: 'final', text: transcript }));
      }
    });
  });
  try {
    assert.equal((await detectDictation()).available, false);
    await writeFile(process.env.TERMAI_VOXTYPE_TOKEN_FILE, token, { mode: 0o600 });
    assert.deepEqual(await detectDictation(), { installed: true, available: true }); assert.equal(admissions, 0);
    const results: string[] = [];
    async function dictate() {
      return new Promise<string>((resolve) => {
        const bridge = new Dictation(text => results.push(text), (status, message) => {
          if (status === 'ready') { bridge.audio(Buffer.alloc(3200)); bridge.finish(); }
          else resolve(status + ':' + (message || ''));
        });
      });
    }
    assert.equal(await dictate(), 'done:'); assert.deepEqual(results, ['hello world']); assert.equal(received, 3200);
    transcript = '\x1b[201~\recho injected';
    assert.match(await dictate(), /^error:/); assert.equal(results.length, 1);
  } finally {
    for (const socket of server.clients) socket.terminate(); await new Promise<void>(resolve => server.close(() => resolve()));
    if (saved.url === undefined) delete process.env.TERMAI_VOXTYPE_URL; else process.env.TERMAI_VOXTYPE_URL = saved.url;
    if (saved.file === undefined) delete process.env.TERMAI_VOXTYPE_TOKEN_FILE; else process.env.TERMAI_VOXTYPE_TOKEN_FILE = saved.file;
    await rm(dir, { recursive: true, force: true });
  }
});

test('paste is prompt/revision guarded, bracketed, and never executes or accepts controls', () => {
  const session = new Session('/tmp', []) as any, writes: string[] = [];
  session.process = { write: (text: string) => writes.push(text) };
  session.state.ready = true; session.state.prompt = 1;
  assert.equal(session.paste('echo dictated', 1, 0), true);
  assert.deepEqual(writes, ['\x1b[200~echo dictated\x1b[201~']);
  assert.equal(session.paste('stale', 1, 0), false);
  assert.equal(session.paste('different prompt', 2, 1), false);
  assert.equal(session.paste('echo evil\r', 1, 1), false);
  assert.equal(writes.length, 1);
});

test('program dictation respects paste mode and cannot cross edits, captures, or a return to Bash', () => {
  const session = new Session('/tmp', []) as any, writes: string[] = [], messages: any[] = [];
  session.process = { write: (text: string) => writes.push(text) };
  session.send = (message: any) => messages.push(message);
  session.state.prompt = 1; session.state.inputTarget = 'program';
  assert.equal(session.pasteDictation('Get in it.', 1, 0, 'program'), true);
  assert.deepEqual(writes, ['Get in it.']);
  assert.equal(messages[0].source, 'dictation');
  session.pasteMode.feed('\x1b[?2004h');
  assert.equal(session.pasteDictation('More words.', 1, 1, 'program'), true);
  assert.equal(writes[1], '\x1b[200~More words.\x1b[201~');
  assert.equal(session.pasteDictation('stale', 1, 1, 'program'), false);
  assert.equal(session.pasteDictation('new prompt', 2, 2, 'program'), false);
  assert.equal(session.pasteDictation('shell recording', 1, 2, 'shell'), false);
  assert.equal(session.pasteDictation('evil\r', 1, 2, 'program'), false);
  session.captured = { id: 'capture' };
  assert.equal(session.pasteDictation('captured', 1, 2, 'program'), false);
  session.captured = undefined; session.state.ready = true;
  assert.equal(session.pasteDictation('returned to Bash', 1, 2, 'program'), false);
  session.state.ready = false; session.state.exited = true;
  assert.equal(session.pasteDictation('exited', 1, 2, 'program'), false);
  assert.equal(writes.length, 2);
});

test('terminal control responses and program Enter preserve the program input target', () => {
  const session = new Session('/tmp', []) as any;
  session.process = { write() {} };
  session.state.inputTarget = 'program';
  for (const data of ['\x1b[1;1R', '\r', '\x03']) {
    session.receive({ type: 'input', data });
    assert.equal(session.state.inputTarget, 'program');
  }
  session.state.ready = true; session.state.inputTarget = 'shell';
  session.receive({ type: 'input', data: '\r' });
  assert.equal(session.state.ready, false); assert.equal(session.state.inputTarget, undefined);
});

test('worklet produces bounded little-endian 16k PCM across 44.1k and 48k block boundaries', () => {
  for (const rate of [44100, 48000, 16000]) {
    let Processor: any;
    const frames: any[] = [];
    vm.runInNewContext(readFileSync(new URL('../public/dictation-worklet.js', import.meta.url), 'utf8'), {
      AudioWorkletProcessor: class { port = { onmessage: null, postMessage: (message: unknown) => frames.push(message) }; },
      sampleRate: rate, registerProcessor: (_name: string, type: any) => { Processor = type; },
    });
    const processor = new Processor();
    for (let i = 0; i < rate; i += 128) processor.process([[new Float32Array(Math.min(128, rate - i)).fill(0.5)]]);
    processor.port.onmessage();
    const pcm = frames.filter(value => value !== 'flushed');
    assert.equal(pcm.reduce((sum, value) => sum + value.byteLength, 0), 32000);
    assert.ok(pcm.every(value => value.byteLength <= 3200));
    assert.equal(new DataView(pcm[0]).getInt16(0, true), 16384);
    assert.equal(frames.at(-1), 'flushed');
  }
});


test('stale recording controls cannot cancel or finish a newer dictation', () => {
  const session = new Session('/tmp', []) as any;
  let cancelled = 0, finished = 0;
  session.dictationId = '11111111-1111-1111-1111-111111111111';
  session.dictation = { cancel: () => cancelled++, finish: () => finished++ };
  for (const action of ['cancel', 'finish']) session.receive({ type: 'dictation', id: '22222222-2222-2222-2222-222222222222', action });
  assert.equal(cancelled, 0); assert.equal(finished, 0);
  session.receive({ type: 'dictation', id: session.dictationId, action: 'finish' });
  assert.equal(finished, 1);
  session.receive({ type: 'dictation', id: session.dictationId, action: 'cancel' });
  assert.equal(cancelled, 1); assert.equal(session.dictation, undefined);
});


test('capture boosts quiet audio without boosting silence or clipping louder speech', () => {
  function capture(amplitudes: number[]) {
    let Processor: any; const frames: ArrayBuffer[] = [];
    vm.runInNewContext(readFileSync(new URL('../public/dictation-worklet.js', import.meta.url), 'utf8'), {
      AudioWorkletProcessor: class { port = { onmessage: null, postMessage: (message: unknown) => { if (typeof message !== 'string') frames.push(message as ArrayBuffer); } }; },
      sampleRate: 48000, registerProcessor: (_name: string, type: any) => { Processor = type; },
    });
    const processor = new Processor(); let i = 0;
    for (const amplitude of amplitudes) for (let block = 0; block < 375; block++) {
      const audio = Float32Array.from({ length: 128 }, () => Math.sin(2 * Math.PI * 440 * i++ / 48000) * amplitude);
      processor.process([[audio]]);
    }
    processor.port.onmessage();
    return frames.flatMap(frame => Array.from({ length: frame.byteLength / 2 }, (_, i) => new DataView(frame).getInt16(i * 2, true) / 32768));
  }
  const rms = (values: number[]) => Math.sqrt(values.reduce((sum, v) => sum + v * v, 0) / values.length);
  assert.equal(rms(capture([0])), 0);
  assert.ok(rms(capture([0.0001]).slice(-4000)) < 0.00009, 'noise floor stays unamplified');
  const quiet = rms(capture([0.01]).slice(-4000));
  assert.ok(quiet > 0.025 && quiet < 0.029, 'quiet speech receives close to 4× gain');
  const loud = capture([0.01, 0.9]);
  assert.ok(Math.max(...loud.map(Math.abs)) <= 0.951, 'sudden loud speech keeps peak headroom');
  assert.ok(rms(loud.slice(-4000)) > 0.60 && rms(loud.slice(-4000)) < 0.66, 'loud speech retains its original level');
});
