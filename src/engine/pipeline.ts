import { expandSymbols } from './speech.ts';
/** Split only top-level plain pipes. Quoting, substitutions and boolean lists
 * must keep their shell meaning; this parser never executes or expands them. */
export function pipelineParts(input: string): string[] | undefined {
  const text = expandSymbols(input).trim();
  if (text.length > 2000 || /[\r\n]/.test(text)) return;
  const parts: string[] = []; let start = 0, quote = '', depth = 0;
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (char === '\\' && quote !== "'") { i++; continue; }
    if (quote) { if (char === quote) quote = ''; continue; }
    if (["'", '"', '`'].includes(char)) { quote = char; continue; }
    if ('({'.includes(char)) { depth++; continue; }
    if (')}'.includes(char)) { if (--depth < 0) return; continue; }
    if (depth) continue;
    if (char === ';' || char === '&' || (char === '#' && (i === 0 || /\s/.test(text[i - 1])))) return;
    if (char !== '|') continue;
    if (['|', '&'].includes(text[i + 1])) return;
    parts.push(text.slice(start, i).trim()); start = i + 1;
  }
  if (quote || depth || !parts.length) return;
  parts.push(text.slice(start).trim());
  if (parts.length > 6 || parts.some(part => !part)) return;
  return parts;
}
