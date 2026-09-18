import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';

/** A shell prompt changes the generation; unchanged files keep their parsed identity. */
export class ShellContext {
  private dir: string;
  private files = new Map<string, { stamp: string; raw: string; value: unknown }>();
  private flight?: { prompt: number; promise: ReturnType<ShellContext['read']> };
  constructor(dir: string) { this.dir = dir; }
  private async file<T>(name: string, parse: (raw: string) => T): Promise<T> {
    const file = path.join(this.dir, name), previous = this.files.get(name);
    const info = await stat(file).catch(() => undefined);
    const stamp = info ? `${info.ino}:${info.mtimeMs}:${info.size}` : '';
    if (previous?.stamp === stamp) return previous.value as T;
    const raw = info ? await readFile(file, 'utf8').catch(() => '') : '';
    const value = previous?.raw === raw ? previous.value as T : parse(raw);
    this.files.set(name, { stamp, raw, value });
    return value;
  }
  private async read() {
    const [commands, functions, environment] = await Promise.all([
      this.file('commands', raw => [...new Set(raw.split('\n').filter(Boolean))].sort()),
      this.file('functions', raw => raw.split('\n').filter(Boolean)),
      this.file('environment', raw => raw ? Object.fromEntries(raw.split('\0').filter(line => line.includes('=')).map(line => {
        const split = line.indexOf('='); return [line.slice(0, split), line.slice(split + 1)];
      })) : { ...process.env }),
    ]);
    return { commands, functions, environment };
  }
  get(prompt: number) {
    if (this.flight?.prompt !== prompt) this.flight = { prompt, promise: this.read() };
    return this.flight.promise;
  }
}
