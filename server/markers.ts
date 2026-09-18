export interface PromptEvent { cwd: string; code: number; history: string }
/** Strip only our shell's private OSC records, including records split across PTY chunks. */
export class Markers {
  private pending = '';
  private prefix: string;
  private onPrompt: (event: PromptEvent) => void;
  private onBusy: () => void;
  constructor(nonce: string, onPrompt: (event: PromptEvent) => void, onBusy: () => void) {
    this.prefix = `\x1b]777;termai;${nonce};`; this.onPrompt = onPrompt; this.onBusy = onBusy;
  }
  feed(data: string): string {
    this.pending += data;
    let output = '';
    while (this.pending) {
      const index = this.pending.indexOf(this.prefix);
      if (index === -1) {
        let tail = 0;
        for (let n = 1; n < this.prefix.length && n <= this.pending.length; n++)
          if (this.pending.endsWith(this.prefix.slice(0, n))) tail = n;
        output += this.pending.slice(0, this.pending.length - tail);
        this.pending = tail ? this.pending.slice(-tail) : '';
        break;
      }
      output += this.pending.slice(0, index);
      this.pending = this.pending.slice(index);
      const end = this.pending.indexOf('\x07');
      if (end === -1) {
        if (this.pending.length > 32768) { output += this.pending; this.pending = ''; }
        break;
      }
      const record = this.pending.slice(this.prefix.length, end).split(';');
      this.pending = this.pending.slice(end + 1);
      if (record[0] === 'busy') this.onBusy();
      else if (record[0] === 'prompt' && record.length === 4) {
        this.onPrompt({ code: Number(record[1]) || 0, cwd: Buffer.from(record[2], 'base64').toString('utf8'), history: Buffer.from(record[3], 'base64').toString('utf8') });
      }
    }
    return output;
  }
}
