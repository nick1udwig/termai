/** Observe DEC bracketed-paste mode without changing the PTY output. */
export class PasteMode {
  enabled = false;
  private state: 'text' | 'escape' | 'csi' | 'string' | 'string-escape' = 'text';
  private parameters = '';
  feed(data: string) {
    for (const char of data) {
      if (this.state === 'string' || this.state === 'string-escape') {
        if (char === '\x07' || (this.state === 'string-escape' && char === '\\')) this.state = 'text';
        else this.state = char === '\x1b' ? 'string-escape' : 'string';
      } else if (char === '\x1b') this.state = 'escape';
      else if (this.state === 'escape') {
        if (char === '[') { this.state = 'csi'; this.parameters = ''; }
        else if (']PX^_'.includes(char)) this.state = 'string';
        else { if (char === 'c') this.enabled = false; this.state = 'text'; }
      } else if (this.state === 'csi') {
        if (char >= '@' && char <= '~') {
          if (/^\?\d+(;\d+)*$/.test(this.parameters) && this.parameters.slice(1).split(';').includes('2004') && (char === 'h' || char === 'l')) this.enabled = char === 'h';
          this.state = 'text';
        } else if (this.parameters.length < 256) this.parameters += char;
        else this.state = 'text';
      }
    }
  }
  paste(text: string) { return this.enabled ? `\x1b[200~${text}\x1b[201~` : text; }
}
