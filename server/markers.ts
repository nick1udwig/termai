import { parseTransfer, type TransferEvent } from './transfers.ts';
export interface PromptEvent { cwd: string; code: number; history: string }
export type ReadingEvent = { type: 'file'; path: string } | { type: 'capture'; file: string; name: string; exitCode: number };
/** Strip only our shell's private OSC records, including records split across PTY chunks. */
export class Markers {
  onInputLine?: (text: string, cursor: number) => void;
  onTransfer?: (event: TransferEvent) => void;
  private pending = '';
  private prefix: string;
  private onPrompt: (event: PromptEvent) => void;
  private onBusy: () => void;
  private onSSH?: (command: string) => void;
  private onReading?: (event: ReadingEvent) => void;
  constructor(nonce: string, onPrompt: (event: PromptEvent) => void, onBusy: () => void, onSSH?: (command: string) => void, onReading?: (event: ReadingEvent) => void) {
    this.prefix = `\x1b]777;termai;${nonce};`; this.onPrompt = onPrompt; this.onBusy = onBusy; this.onSSH = onSSH;
    this.onReading = onReading;
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
      const transfer = parseTransfer(record);
      if (transfer) this.onTransfer?.(transfer);
      else if (record[0] === 'reading-file' && record.length === 2) {
        const file = Buffer.from(record[1], 'base64').toString('utf8');
        if (file.startsWith('/') && file.length <= 4096 && !/[\x00-\x1f\x7f]/.test(file)) this.onReading?.({ type: 'file', path: file });
      } else if (record[0] === 'reading-capture' && record.length === 4 && /^read\.[a-zA-Z0-9]{8}$/.test(record[1]) && /^(?:0|[1-9][0-9]{0,2})$/.test(record[3]) && Number(record[3]) <= 255) {
        const name = Buffer.from(record[2], 'base64').toString('utf8');
        if (name.length <= 4000) this.onReading?.({ type: 'capture', file: record[1], name, exitCode: Number(record[3]) });
      } else if (record[0] === 'ssh' && record.length === 2) {
        const command = Buffer.from(record[1], 'base64').toString('utf8');
        if (command.length <= 4000 && !/[\x00-\x1f\x7f]/.test(command)) this.onSSH?.(command);
      } else if (record[0] === 'input-line' && record.length === 3) {
        const text = Buffer.from(record[2], 'base64').toString('utf8');
        // Bash slices using its locale; sending the prefix avoids confusing
        // Readline character offsets with JavaScript's UTF-16 offsets.
        const prefix = Buffer.from(record[1], 'base64').toString('utf8');
        if (text.length <= 16000 && text.startsWith(prefix) && !/[\x00-\x1f\x7f]/.test(text))
          this.onInputLine?.(text, prefix.length);
      } else if (record[0] === 'busy') this.onBusy();
      else if (record[0] === 'prompt' && (record.length === 3 || record.length === 4)) {
        const payload = Buffer.from(record[2], 'base64').toString('utf8');
        const split = payload.indexOf('\0');
        const cwd = record.length === 4 ? payload : payload.slice(0, split);
        const history = record.length === 4 ? Buffer.from(record[3], 'base64').toString('utf8') : payload.slice(split + 1);
        if (record.length === 4 || split >= 0) this.onPrompt({ code: Number(record[1]) || 0, cwd, history });
      }
    }
    return output;
  }
}
