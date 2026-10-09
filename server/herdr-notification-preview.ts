import { stripVTControlCharacters } from 'node:util';
import { herdrRequest, type HerdrTarget } from './herdr.ts';
import type { HerdrAgent } from '../src/herdr-protocol.ts';

/** Plain terminal output before the input area, bounded for a notification. */
export function responsePreview(screen: string): string {
  const lines = stripVTControlCharacters(screen).replace(/\r/g, '').split('\n');
  const composer = lines.findLastIndex(line => /^\s*[│┃║]?\s*[›❯]\s/.test(line));
  const output = (composer < 0 ? lines : lines.slice(0, composer))
    .map(line => line.replace(/^\s*[│┃║]\s?/, '').replace(/[│┃║]\s*$/, '').trim())
    .filter(line => !/^[\s─━═┌┐└┘├┤┬┴┼╭╮╰╯│┃║]+$/.test(line) && !/^(?:[✻*]\s*)?(?:Worked|Working|Thinking)\s+for\s+\d/.test(line));
  const paragraphs = output.join('\n').trim().split(/\n\s*\n/);
  const text = (paragraphs.at(-1) || '').replace(/\s+/g, ' ').replace(/^[•●✦]\s*/, '');
  const characters = Array.from(text);
  return characters.length > 280 ? characters.slice(0, 279).join('') + '…' : text;
}

export async function agentResponsePreview(target: HerdrTarget, agent: HerdrAgent): Promise<string> {
  try {
    const current = await herdrRequest(target, 'pane.get', { pane_id: agent.paneId });
    if (current.pane?.terminal_id !== agent.terminalId) return '';
    // ANSI reads are passive. Text reads can make Herdr harvest an app's
    // transcript by scrolling it, which a background notification must avoid.
    const response = await herdrRequest(target, 'pane.read', { pane_id: agent.paneId, source: 'recent_unwrapped', format: 'ansi', lines: 40, strip_ansi: false });
    return typeof response.read?.text === 'string' ? responsePreview(response.read.text) : '';
  } catch { return ''; }
}

export function notificationBody(kind: 'done' | 'request', cwd: string, preview: string): string {
  const status = kind === 'done' ? 'Agent finished' : 'Agent needs your attention';
  const directory = Array.from(cwd.replace(/[\x00-\x1f\x7f]/g, '')).slice(0, 240).join('');
  return status + (directory ? ' · ' + directory : '') + (preview ? '\n' + preview : '');
}
