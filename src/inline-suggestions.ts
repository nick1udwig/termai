import type { Terminal } from 'ghostty-web';
import type { Candidate, ShellState } from './protocol.ts';
import { InputLine } from './input-line.ts';
interface Host {
  state(): ShellState;
  replace(text: string): Promise<boolean>;
  suggest(text: string, signal: AbortSignal): Promise<{ candidates: Candidate[] }>;
  raw(data: string): void;
  execute(text: string): void;
}
export class InlineSuggestions {
  private line = new InputLine();
  private generation = 0;
  private prompt = -1;
  private controller?: AbortController;
  private literal = '';
  private choices: string[] = [];
  private selected = '';
  private prefix = '';
  private suffix = '';
  private speech = '';
  private loading = false;
  private open = false;
  private autoOpen = true;
  private tapToSend = true;
  private composing = false;
  private compositionText = '';
  private compositionSent = '';
  private compositionTyped = false;
  private lastCommit = { text: '', at: 0 };
  private positionFrame = 0;
  private canvas?: HTMLCanvasElement;
  private pane?: HTMLElement;
  private toggle = document.getElementById('alternatives-toggle')!;
  private menu = document.getElementById('alternatives-menu')!;
  private items = document.getElementById('alternative-items')!;
  private status = document.getElementById('suggestion-status')!;
  private term: Terminal;
  private host: Host;
  constructor(term: Terminal, host: Host) {
    this.term = term; this.host = host;
    const setting = document.getElementById('auto-alternatives') as HTMLInputElement;
    try { this.autoOpen = localStorage.getItem('termai.autoAlternatives') !== 'false' && localStorage.getItem('termai.justRun') !== 'true'; } catch {}
    setting.checked = this.autoOpen;
    setting.onchange = () => {
      this.autoOpen = setting.checked;
      try { localStorage.setItem('termai.autoAlternatives', String(this.autoOpen)); localStorage.removeItem('termai.justRun'); } catch {}
      this.open = this.autoOpen; this.render();
    };
    const tapSetting = document.getElementById('tap-alternate-send') as HTMLInputElement;
    try { this.tapToSend = localStorage.getItem('termai.tapAlternateSend') !== 'false'; } catch {}
    tapSetting.checked = this.tapToSend;
    tapSetting.onchange = () => {
      this.tapToSend = tapSetting.checked;
      try { localStorage.setItem('termai.tapAlternateSend', String(this.tapToSend)); } catch {}
    };
    document.addEventListener('pointerdown', event => {
      if (!this.menu.contains(event.target as Node) && !this.toggle.contains(event.target as Node)) this.collapse();
    });
    this.toggle.addEventListener('pointerdown', e => e.preventDefault());
    this.toggle.onclick = () => { this.open = !this.open; this.render(); };
    term.onCursorMove(() => this.refresh()); term.onScroll(() => this.refresh());
    const container = document.getElementById('terminal')!;
    const resize = new ResizeObserver(() => this.refresh());
    resize.observe(container); resize.observe(this.menu);
    window.visualViewport?.addEventListener('resize', () => this.refresh());
    const stop = (event: Event) => { if (event.cancelable) event.preventDefault(); event.stopImmediatePropagation(); };
    const eligible = () => host.state().ready && this.line.known && !host.state().exited;
    // Browsers expose dictation as replacement text, multi-character insertText, or
    // committed composition. Clipboard paste is deliberately left to the terminal.
    container.addEventListener('beforeinput', event => {
      const e = event as InputEvent;
      if (this.composing && /^deleteContent(?:Backward|Forward)$/.test(e.inputType)) {
        stop(e); this.composing = false; this.compositionText = ''; this.compositionSent = '';
        host.raw(e.inputType === 'deleteContentBackward' ? '\x7f' : '\x1b[3~');
        this.armInput(); return;
      }
      if (this.composing) {
        if (e.inputType === 'insertCompositionText' && e.data !== null) this.updateComposition(e.data);
        stop(e); return;
      }
      if (e.data && this.lastCommit.text === e.data && performance.now() - this.lastCommit.at < 120) {
        this.lastCommit.text = ''; stop(e); return;
      }
      if (!eligible() || !e.data || /[\x00-\x1f\x7f]/.test(e.data)) return;
      if (['insertFromDictation', 'insertReplacementText'].includes(e.inputType) || (e.inputType === 'insertText' && e.data.length > 1)) {
        stop(e); void this.dictate(e.data, e.inputType === 'insertReplacementText');
      }
    }, true);
    container.addEventListener('compositionstart', e => {
      this.composing = true; this.compositionText = ''; this.compositionSent = ''; this.compositionTyped = false; stop(e);
    }, true);
    container.addEventListener('compositionupdate', event => {
      if (this.composing) { this.updateComposition((event as CompositionEvent).data); stop(event); }
    }, true);
    container.addEventListener('compositionend', event => {
      if (!this.composing) return;
      const e = event as CompositionEvent; stop(e); this.composing = false;
      this.armInput();
      if (this.compositionTyped) {
        this.updateComposition(e.data); this.lastCommit = { text: e.data, at: performance.now() };
        return;
      }
      if (!e.data) return;
      this.lastCommit = { text: e.data, at: performance.now() };
      if (eligible() && !/[\x00-\x1f\x7f]/.test(e.data)) void this.dictate(e.data, false);
      else host.raw(e.data);
    }, true);
    container.addEventListener('keydown', e => {
      if (this.composing && (e.isComposing || e.keyCode === 229)) e.stopImmediatePropagation();
      else this.lastCommit.text = '';
    }, true);
    container.addEventListener('input', () => this.armInput());
    this.armInput();
  }
  private armInput() {
    if (this.composing || !this.term.textarea) return;
    // Android may suppress Backspace at the beginning of an empty textarea.
    // Bash owns the real text; this invisible buffer only gives the IME room to delete.
    this.term.textarea.value = '\u200b';
    this.term.textarea.setSelectionRange(1, 1);
  }
  private updateComposition(text: string) {
    // Mobile keyboards often compose a word one letter at a time. Stream those
    // edits immediately; only a bulk commit is a possible dictation transcript.
    if (!this.compositionText && Array.from(text).length <= 1) this.compositionTyped = true;
    if (!this.compositionTyped && this.compositionText && text !== this.compositionText) this.compositionTyped = true;
    if (this.compositionTyped) {
      const before = Array.from(this.compositionSent), after = Array.from(text);
      let shared = 0;
      while (shared < before.length && before[shared] === after[shared]) shared++;
      for (let i = shared; i < before.length; i++) this.host.raw('\x7f');
      const inserted = after.slice(shared).join('');
      if (inserted) this.host.raw(inserted);
      this.compositionSent = text;
    }
    this.compositionText = text;
  }
  private collapse() { if (this.open) { this.open = false; this.render(); } }
  onState(state: ShellState) {
    if (state.prompt !== this.prompt) {
      this.clear(); this.prompt = state.prompt; this.line.reset();
      this.line.known = state.ready && state.inputRevision === state.promptRevision;
    } else if (!state.ready || state.exited) { this.clear(); this.line.known = false; }
  }
  disconnect() { this.clear(); this.line.known = false; this.prompt = -1; }
  refresh() {
    if (!this.literal || this.positionFrame) return;
    this.positionFrame = requestAnimationFrame(() => { this.positionFrame = 0; this.position(); });
  }
  raw(data: string): boolean {
    queueMicrotask(() => this.armInput());
    if (data === '\x1b[I' || data === '\x1b[O') return true;
    // Escape dismisses this UI, without leaving Readline waiting for a Meta key.
    if (data === '\x1b' && this.literal) { this.collapse(); return false; }
    // Moving the cursor or dismissing the menu does not discard the alternatives.
    if (/^(\x1b\[[CDHF]|[\x01\x02\x05\x06])$/.test(data)) {
      this.line.feed(data); this.collapse(); return true;
    }
    this.clear(); this.line.feed(data); return true;
  }
  private clear() {
    const visible = !!this.literal || this.loading || this.open || !!this.choices.length;
    ++this.generation; this.controller?.abort(); this.literal = ''; this.speech = ''; this.choices = [];
    this.loading = false; this.open = false;
    if (this.positionFrame) cancelAnimationFrame(this.positionFrame);
    this.positionFrame = 0;
    if (visible) this.render();
  }
  private async dictate(text: string, replacement: boolean) {
    if (!this.literal) {
      this.prefix = this.line.text.slice(0, this.line.cursor); this.suffix = this.line.text.slice(this.line.cursor); this.speech = text;
    } else this.speech = replacement ? text : this.speech + text;
    this.literal = this.prefix + this.speech + this.suffix;
    if (this.literal.length > 2000) { this.clear(); this.host.raw(text); return; }
    this.controller?.abort(); this.controller = new AbortController();
    const request = ++this.generation, prompt = this.host.state().prompt;
    this.loading = true; this.open = this.autoOpen; this.choices = []; this.selected = this.literal;
    this.line.reset(this.literal); this.status.textContent = 'Finding command alternatives'; this.render();
    try {
      const replacement = this.host.replace(this.literal);
      // Observe failures immediately, even while the replacement acknowledgement is pending.
      const suggestion = this.host.suggest(this.literal, this.controller.signal).then(result => ({ result }), error => ({ error }));
      if (!await replacement) { if (request === this.generation) this.disconnect(); return; }
      if (request !== this.generation) return;
      const outcome = await suggestion;
      if ('error' in outcome) throw outcome.error;
      const result = outcome.result;
      if (request !== this.generation || prompt !== this.host.state().prompt || !this.host.state().ready) return;
      const parsed = result.candidates.filter(candidate => !candidate.literal);
      this.choices = [...new Set(parsed.filter(candidate => candidate.command !== this.literal).map(candidate => candidate.command))].slice(0, 3);
      const top = parsed[0]?.command || this.literal;
      this.line.reset(top);
      if (top !== this.literal && !await this.host.replace(top)) { if (request === this.generation) this.disconnect(); return; }
      if (request !== this.generation) return;
      this.selected = top; this.line.reset(top); this.loading = false;
      this.status.textContent = 'Command alternatives ready'; this.render();
    } catch (error: any) {
      if (request !== this.generation || error.name === 'AbortError') return;
      this.loading = false; this.open = true;
      this.status.textContent = 'Alternatives unavailable. Original text kept.'; this.render();
    }
  }
  private async choose(text: string) {
    if (this.tapToSend) { this.host.execute(text); this.term.focus(); return; }
    const request = ++this.generation; this.controller?.abort(); this.loading = false;
    this.collapse();
    this.line.reset(text);
    if (await this.host.replace(text) && request === this.generation) {
      this.selected = text; this.line.reset(text); this.open = false; this.render();
    }
    this.term.focus();
  }
  private render() {
    this.armInput();
    const visible = !!this.literal && this.host.state().ready;
    this.toggle.hidden = !visible; this.menu.hidden = !visible || !this.open;
    this.toggle.classList.toggle('loading', this.loading);
    this.toggle.setAttribute('aria-expanded', String(this.open));
    this.toggle.setAttribute('aria-label', this.open ? 'Hide alternatives' : 'Show alternatives');
    this.menu.setAttribute('aria-busy', String(this.loading));
    this.items.replaceChildren();
    if (this.loading) {
      for (let i = 0; i < 3; i++) { const row = document.createElement('div'); row.className = 'alternative-skeleton'; row.setAttribute('aria-hidden', 'true'); row.innerHTML = '<i></i><span></span><b>···</b>'; this.items.append(row); }
    } else {
      this.choices.forEach((text, index) => this.addChoice(text, index, false));
    }
    if (this.literal) this.addChoice(this.literal, this.loading ? 3 : this.choices.length, true);
    this.refresh();
  }
  private addChoice(text: string, index: number, literal: boolean) {
    const button = document.createElement('button'); button.className = 'alternative-choice';
    button.classList.toggle('literal-choice', literal); button.classList.toggle('selected', text === this.selected && (!literal || !this.choices.includes(text)));
    button.setAttribute('aria-pressed', String(button.classList.contains('selected'))); button.title = text;
    const icon = document.createElement('span'); icon.className = 'choice-icon'; icon.setAttribute('aria-hidden', 'true');
    if (literal) icon.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"><path d="M20 3H4a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h3v3l5-3h8a2 2 0 0 0 2-2V5a2 2 0 0 0-2-2Z"/></svg>';
    else icon.textContent = '›_';
    const label = document.createElement('span'); label.className = 'choice-command'; label.textContent = text;
    const number = document.createElement('span'); number.className = 'choice-number'; number.textContent = String(index + 1); number.setAttribute('aria-hidden', 'true');
    button.append(icon, label, number); button.addEventListener('pointerdown', e => e.preventDefault());
    button.onclick = () => void this.choose(text); this.items.append(button);
  }
  private position() {
    if (!this.literal) return;
    if (!this.canvas?.isConnected) {
      this.canvas = document.querySelector<HTMLCanvasElement>('#terminal canvas') || undefined;
      this.pane = this.canvas?.closest<HTMLElement>('.terminal-pane') || undefined;
    }
    if (!this.canvas || !this.pane) return;
    const bounds = this.canvas.getBoundingClientRect(), pane = this.pane.getBoundingClientRect();
    const buffer = this.term.buffer.active;
    const row = buffer.baseY + buffer.cursorY - buffer.viewportY;
    if (row < 0 || row >= this.term.rows || buffer.type !== 'normal' || this.term.getViewportY() > 0) { this.toggle.hidden = true; this.menu.hidden = true; return; }
    // Read geometry before writes. The menu observer schedules a follow-up if its
    // width or height changes, without forcing another layout in this frame.
    const menuHeight = this.menu.offsetHeight;
    const cellWidth = bounds.width / this.term.cols, cellHeight = bounds.height / this.term.rows;
    const x = bounds.left - pane.left + (buffer.cursorX + 1) * cellWidth;
    const y = bounds.top - pane.top + row * cellHeight;
    const left = Math.max(4, Math.min(pane.width - 36, x));
    const menuWidth = Math.min(330, pane.width - 16);
    const menuLeft = Math.max(8, Math.min(pane.width - menuWidth - 8, left - 12));
    const below = pane.height - y - cellHeight - 12;
    const above = y - 12;
    const upward = below < 210 && above > below;
    const available = Math.max(44, upward ? above : below);
    this.toggle.hidden = !this.host.state().ready; this.menu.hidden = !this.host.state().ready || !this.open;
    this.toggle.style.left = `${left}px`; this.toggle.style.top = `${Math.max(0, y - 8)}px`;
    this.menu.style.width = `${menuWidth}px`; this.menu.style.left = `${menuLeft}px`;
    this.menu.style.maxHeight = `${available}px`;
    this.items.style.maxHeight = `${Math.max(30, available - 14)}px`;
    this.menu.style.top = `${upward ? Math.max(4, y - Math.min(menuHeight, available) - 10) : y + cellHeight + 10}px`;
    this.menu.classList.toggle('above', upward);
    this.menu.style.setProperty('--pointer-x', `${Math.min(menuWidth - 18, Math.max(18, left - menuLeft + 12))}px`);
  }
}
