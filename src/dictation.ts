import type { ClientMessage, ShellState } from './protocol.ts';
import './dictation.css';

interface Host {
  api<T>(path: string, data?: unknown): Promise<T>;
  send(message: ClientMessage): boolean;
  audio(data: ArrayBuffer): boolean;
  state(): ShellState;
  prepare(): void;
  notice(message: string): void;
  focus(): void;
  key: string;
}
export class DictationControl {
  private button = document.createElement('button');
  private cancelButton = document.createElement('button');
  private dialog = document.createElement('dialog');
  private available = false;
  private online = false;
  private visible = true;
  private phase: 'idle' | 'starting' | 'recording' | 'finishing' = 'idle';
  private stream?: MediaStream;
  private context?: AudioContext;
  private source?: MediaStreamAudioSourceNode;
  private processor?: AudioWorkletNode;
  private generation = 0;
  private id = '';
  private finishPending = false;
  private offered = false;
  private installed?: boolean;
  private daemonAvailable?: boolean;
  private unavailableReason?: string;
  private polling = false;
  private audioTimer?: ReturnType<typeof setTimeout>;
  private host: Host;
  constructor(host: Host) {
    this.host = host;
    this.button.className = 'dictation-mic'; this.button.hidden = true;
    this.button.id = 'termai-dictation'; this.button.type = 'button';
    this.cancelButton.className = 'dictation-cancel'; this.cancelButton.textContent = '×'; this.cancelButton.hidden = true;
    this.cancelButton.setAttribute('aria-label', 'Cancel dictation'); this.cancelButton.onclick = () => this.cancel();
    this.dialog.id = 'dictation-install';
    this.dialog.innerHTML = '<h2>Dictate with Voxtype Mobile</h2><p data-explanation>Install the daemon on your backend to dictate directly into this terminal.</p><p>Install pastes the command into your session. Review it and press Enter to run it.</p><label class="setting-toggle"><input type="checkbox"><span>Do not show again</span></label><div class="run-row"><button type="button" class="secondary-button" data-later>Not now</button><button type="button" class="run-button" data-install>Install</button></div>';
    const dismiss = () => { if (this.dialog.querySelector('input')!.checked) this.save('dismissed'); this.dialog.close(); };
    this.dialog.querySelector<HTMLButtonElement>('[data-later]')!.onclick = dismiss;
    this.dialog.addEventListener('cancel', dismiss);
    this.dialog.querySelector<HTMLButtonElement>('[data-install]')!.onclick = async () => {
      const button = this.dialog.querySelector<HTMLButtonElement>('[data-install]')!; button.disabled = true;
      try {
        this.host.prepare();
        const state = this.host.state();
        await this.host.api('/api/dictation/install', { prompt: state.prompt, revision: state.inputRevision });
        dismiss(); this.host.focus(); this.host.notice('Install command pasted. Review it, then press Enter to run it.');
      } catch (error) { this.host.notice((error as Error).message); } finally { button.disabled = false; }
    };
    document.body.append(this.button, this.cancelButton, this.dialog);
    this.render();
    let press: { x: number; y: number; left: number; top: number; at: number; active: boolean; dragged: boolean } | undefined;
    this.button.addEventListener('pointerdown', event => {
      if (event.button !== 0) return;
      event.preventDefault(); this.button.setPointerCapture(event.pointerId);
      const bounds = this.button.getBoundingClientRect();
      press = { x: event.clientX, y: event.clientY, left: bounds.left, top: bounds.top, at: performance.now(), active: this.phase !== 'idle', dragged: false };
      if (this.phase === 'idle') void this.start();
    });
    this.button.addEventListener('pointermove', event => {
      if (!press) return;
      const dx = event.clientX - press.x, dy = event.clientY - press.y;
      if (!press.dragged && Math.hypot(dx, dy) < 8) return;
      if (!press.dragged && !press.active) this.cancel();
      press.dragged = true;
      this.position(press.left + dx, press.top + dy);
    });
    this.button.addEventListener('pointerup', () => {
      if (!press) return;
      if (!press.dragged && (press.active || performance.now() - press.at >= 300)) this.finish();
      if (press.dragged) { try { localStorage.setItem('termai.micPosition', JSON.stringify([this.button.offsetLeft, this.button.offsetTop])); } catch {} }
      press = undefined;
    });
    this.button.addEventListener('pointercancel', () => { press = undefined; this.cancel(); });
    this.button.addEventListener('click', event => { if (event.detail === 0) { if (this.phase === 'idle') void this.start(); else this.finish(); } });
    const reposition = () => {
      try { const value = JSON.parse(localStorage.getItem('termai.micPosition') || 'null'); if (Array.isArray(value) && value.length === 2 && value.every(Number.isFinite)) this.position(value[0], value[1]); } catch {}
    };
    reposition(); window.visualViewport?.addEventListener('resize', reposition);
    window.addEventListener('resize', reposition);
    document.addEventListener('visibilitychange', () => { if (document.hidden) this.cancel(); else void this.poll(); });
    setInterval(() => void this.poll(), 15000);
  }
  private position(x: number, y: number) {
    const width = window.visualViewport?.width || innerWidth, height = window.visualViewport?.height || innerHeight;
    this.button.style.left = Math.max(8, Math.min(width - 56, x)) + 'px';
    this.button.style.top = Math.max(8, Math.min(height - 100, y)) + 'px';
    this.button.style.right = this.button.style.bottom = 'auto';
    this.cancelButton.style.left = Math.max(8, Math.min(width - 56, x - 56)) + 'px';
    this.cancelButton.style.top = this.button.style.top;
    this.cancelButton.style.right = this.cancelButton.style.bottom = 'auto';
  }
  private save(value: string) { try { localStorage.setItem('termai.voxtype:' + this.host.key, value); } catch {} }
  connected(online: boolean) { this.online = online; if (!online) { this.available = false; this.cancel(); this.dialog.close(); } else void this.poll(); this.render(); }
  prompt() { this.offer(); }
  visibility(visible: boolean) { this.visible = visible; if (!visible) { this.cancel(); this.dialog.close(); } else void this.poll(); this.render(); }
  private async poll() {
    if (!this.online || !this.visible || document.hidden || this.polling || this.phase !== 'idle') return;
    this.polling = true;
    try {
      const status = await this.host.api<{ installed: boolean; available: boolean; reason?: string }>('/api/dictation');
      if (!this.online || !this.visible) return;
      this.installed = status.installed;
      this.daemonAvailable = status.available;
      this.unavailableReason = status.reason;
      this.available = status.available && !!navigator.mediaDevices?.getUserMedia && typeof AudioWorkletNode !== 'undefined';
      if (status.available) this.dialog.close();
      this.offer();
    } catch { this.available = false; }
    finally { this.polling = false; this.render(); }
  }
  private offer() {
    // Old versions saved "installed" merely on finding a token or binary. Only
    // an explicit dismissal should hide help when the API cannot actually be used.
    let suppressed = false; try { suppressed = localStorage.getItem('termai.voxtype:' + this.host.key) === 'dismissed'; } catch {}
    if (this.daemonAvailable !== false || !this.online || !this.visible || document.hidden || suppressed || this.offered || !this.host.state().ready || document.querySelector('dialog[open]')) return;
    this.dialog.querySelector('h2')!.textContent = this.installed ? 'Enable Voxtype dictation' : 'Dictate with Voxtype Mobile';
    this.dialog.querySelector('[data-explanation]')!.textContent = this.installed
      ? this.unavailableReason || 'Voxtype is installed, but its dictation API is unavailable. It may need an update or restart.'
      : 'Install the daemon on your backend to dictate directly into this terminal.';
    this.offered = true; this.dialog.showModal();
  }
  private render() {
    this.button.hidden = !this.available || !this.online || !this.visible;
    this.button.textContent = this.phase === 'idle' ? '🎙' : this.phase === 'recording' ? '✓' : '…';
    // Stable accessibility marker used by Voxtype Mobile to suppress its overlay.
    this.button.setAttribute('aria-label', 'Termai dictation microphone');
    this.button.setAttribute('aria-description', this.phase === 'idle' ? 'Hold to dictate, or tap to start and stop. Drag to move.' : this.phase === 'finishing' ? 'Transcribing' : 'Finish dictation');
    this.button.setAttribute('aria-pressed', String(this.phase !== 'idle'));
    this.button.classList.toggle('recording', this.phase !== 'idle');
    this.cancelButton.hidden = this.button.hidden || this.phase === 'idle';
  }
  private async start() {
    if (!this.online || !this.available || !this.host.state().ready) { this.host.notice('Wait for the shell prompt before dictating.'); return; }
    const generation = ++this.generation; this.id = crypto.randomUUID(); this.phase = 'starting'; this.finishPending = false; this.render();
    try {
      // Resume within the user gesture, before the permission dialog settles.
      const context = this.context = new AudioContext(); await context.resume();
      const stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true } });
      if (generation !== this.generation) { stream.getTracks().forEach(track => track.stop()); return; }
      this.stream = stream;
      await context.audioWorklet.addModule(new URL('dictation-worklet.js', document.baseURI).href);
      if (generation !== this.generation) return;
      this.source = context.createMediaStreamSource(stream);
      this.processor = new AudioWorkletNode(context, 'dictation-pcm');
      this.processor.port.onmessage = event => {
        if (generation !== this.generation) return;
        if (event.data === 'flushed') { this.releaseAudio(); if (!this.host.send({ type: 'dictation', id: this.id, action: 'finish' })) this.cancel(); }
        else if (!this.host.audio(event.data)) { this.host.notice('Connection is too slow for dictation. Please try again.'); this.cancel(); }
      };
      this.host.prepare();
      const state = this.host.state();
      if (!this.host.send({ type: 'dictation', id: this.id, action: 'start', prompt: state.prompt, revision: state.inputRevision })) throw new Error('The terminal is disconnected.');
      this.audioTimer = setTimeout(() => { this.host.notice('Voxtype did not become ready.'); this.cancel(); }, 10000);
    } catch (error) { if (generation === this.generation) { this.host.notice((error as Error).message); this.cancel(); } }
  }
  event(id: string, state: 'ready' | 'done' | 'error', message?: string) {
    if (id !== this.id || this.phase === 'idle') return;
    clearTimeout(this.audioTimer);
    if (state === 'ready') {
      this.phase = 'recording'; this.source!.connect(this.processor!); this.processor!.connect(this.context!.destination);
      this.audioTimer = setTimeout(() => this.finish(), 299000);
      if (this.finishPending) this.finish();
    } else { if (message) this.host.notice(message); this.cancel(false); }
    this.render();
  }
  private finish() {
    if (this.phase === 'starting') { this.finishPending = true; return; }
    if (this.phase !== 'recording') return;
    this.phase = 'finishing'; clearTimeout(this.audioTimer); this.processor!.port.postMessage('flush');
    this.audioTimer = setTimeout(() => { this.host.notice('Dictation timed out.'); this.cancel(); }, 180000);
    this.render();
  }
  private releaseAudio() { this.stream?.getTracks().forEach(track => track.stop()); this.stream = undefined; this.source?.disconnect(); this.processor?.disconnect(); void this.context?.close().catch(() => {}); this.context = undefined; }
  cancel(notify = true) { ++this.generation; if (notify && this.phase !== 'idle') this.host.send({ type: 'dictation', id: this.id, action: 'cancel' }); this.releaseAudio(); clearTimeout(this.audioTimer); this.phase = 'idle'; this.render(); }
}
