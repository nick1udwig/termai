/** Symbol names are interpretations of speech, never edits to the original input. */
export const symbolNames: Record<string, string> = Object.assign(Object.create(null), {
  tilde: '~', slash: '/', 'forward slash': '/', backslash: '\\', 'back slash': '\\', 'backward slash': '\\',
  dot: '.', period: '.', 'full stop': '.', 'decimal point': '.', comma: ',', colon: ':', semicolon: ';', 'semi colon': ';',
  dash: '-', hyphen: '-', minus: '-', 'double dash': '--', 'double hyphen': '--',
  underscore: '_', 'under score': '_', plus: '+', 'plus sign': '+', 'double plus': '++',
  equals: '=', 'equal sign': '=', 'equals sign': '=', 'double equals': '==',
  'not equals': '!=', 'less than': '<', 'greater than': '>', 'less than or equal': '<=', 'greater than or equal': '>=',
  'double greater than': '>>', 'double less than': '<<',
  ampersand: '&', 'and sign': '&', 'double ampersand': '&&', 'logical and': '&&',
  pipe: '|', 'vertical bar': '|', 'double pipe': '||', 'logical or': '||',
  dollar: '$', 'dollar sign': '$', at: '@', 'at sign': '@', hash: '#', hashtag: '#', 'hash sign': '#', pound: '#', 'pound sign': '#', 'number sign': '#', octothorpe: '#',
  percent: '%', 'percent sign': '%', caret: '^', 'caret sign': '^',
  asterisk: '*', star: '*', 'double asterisk': '**', 'question mark': '?', 'exclamation mark': '!', 'exclamation point': '!', bang: '!',
  quote: '"', 'double quote': '"', 'single quote': "'", apostrophe: "'", backtick: '`', 'back tick': '`',
  'quotation mark': '"', 'double quotation mark': '"', 'single quotation mark': "'",
  'open quote': '"', 'close quote': '"', 'open single quote': "'", 'close single quote': "'",
  'open double quote': '"', 'close double quote': '"',
  'open parenthesis': '(', 'close parenthesis': ')', 'left parenthesis': '(', 'right parenthesis': ')',
  'open paren': '(', 'close paren': ')', 'left paren': '(', 'right paren': ')',
  'open bracket': '[', 'close bracket': ']', 'left bracket': '[', 'right bracket': ']',
  'open square bracket': '[', 'close square bracket': ']', 'left square bracket': '[', 'right square bracket': ']',
  'open brace': '{', 'close brace': '}', 'left brace': '{', 'right brace': '}',
  'open curly brace': '{', 'close curly brace': '}', 'left curly brace': '{', 'right curly brace': '}',
  'open angle bracket': '<', 'close angle bracket': '>', 'left angle bracket': '<', 'right angle bracket': '>',
  'right arrow': '->', 'left arrow': '<-',
  buc: '$', mic: ';', fas: '/', bas: '\\', pam: '&', pat: '@', soq: "'", doq: '"', tic: '`',
  tis: '=', wut: '?', zap: '!', hax: '#', hep: '-', ket: '^', lac: '[', rac: ']', lit: '(', rit: ')',
  lob: '{', rob: '}', led: '<', ban: '>', lus: '+', stet: '==', slus: '++', shed: '--',
  dart: '->', dusk: '-<', lark: '+>', lush: '+<',
});
const names = Object.keys(symbolNames).map(name => ({ name, words: name.split(' '), key: name.replaceAll(' ', '') }));
// Retain the established explicit vocabulary in the low-level command parser.
// General English names also participate as separate suggestion alternatives.
const directNames = new Set('tilde slash buc mic fas bas pam pat soq doq tic tis wut zap hax hep ket lac rac lit rit lob rob led ban lus stet slus shed dart dusk lark lush'.split(' '));
const maxWords = Math.max(...names.map(name => name.words.length));
const phonetic = (word: string) => word.replace(/ph/g, 'f').replace(/ck|qu/g, 'k').replace(/c/g, 'k').replace(/[aeiouy]/g, '').replace(/(.)\1+/g, '$1');
const tokenize = (input: string) => input.match(/"[^"\n]*"|'[^'\n]*'|\S+/g) || [];
interface Unit { word: string; name?: string; at: number }
interface Match { name: string; count: number; distance: number; alias?: boolean }

/** Bounded Damerau distance also handles transposed letters from dictation. */
function distance(a: string, b: string): number {
  if (Math.abs(a.length - b.length) > 2) return 3;
  const rows = Array.from({ length: a.length + 1 }, (_, i) => [i]);
  rows[0] = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) {
    rows[i][j] = Math.min(rows[i - 1][j] + 1, rows[i][j - 1] + 1, rows[i - 1][j - 1] + Number(a[i - 1] !== b[j - 1]));
    if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) rows[i][j] = Math.min(rows[i][j], rows[i - 2][j - 2] + 1);
  }
  return rows[a.length][b.length];
}
function matches(words: string[], at: number, nearby: boolean, general = true): Match[] {
  const found: Match[] = [];
  for (let count = Math.min(maxWords, words.length - at); count > 0; count--) {
    const span = words.slice(at, at + count);
    if (span.some(word => !/^[a-z]+$/i.test(word))) continue;
    const phrase = span.join(' ').toLowerCase();
    // Preserve the executable name; a standalone symbol name can still be expanded.
    if (at === 0 && count < words.length) continue;
    // Speech recognition can split "tilde" into "told a". Treat the whole phrase
    // as one symbol before a spoken slash, leaving ordinary prose untouched.
    const next = words[at + count]?.toLowerCase();
    if (nearby && phrase === 'told a' && (['slash', 'slach', 'fas'].includes(next) || (next === 'forward' && words[at + count + 1]?.toLowerCase() === 'slash')))
      return [{ name: 'tilde', count, distance: 0, alias: true }];
    if (nearby && phrase === 'told' && next === 'a') continue;
    if (symbolNames[phrase] && (general || directNames.has(phrase))) return [{ name: phrase, count, distance: 0 }];
    if (!nearby || at === 0) continue;
    const key = span.join('').toLowerCase();
    if (key.length < 4) continue; // Short Urbit names only match exactly.
    for (const name of names) {
      if (name.words.length !== count || name.key.length < 4 || Math.abs(name.key.length - key.length) > 2) continue;
      const edits = distance(key, name.key), budget = Math.min(key.length, name.key.length) >= 7 ? 2 : 1;
      const sound = phonetic(key), sameSound = sound.length >= 3 && sound === phonetic(name.key);
      if (edits > 0 && (edits <= budget || sameSound)) found.push({ name: name.name, count, distance: Math.min(edits, 2) });
    }
  }
  return found.sort((a, b) => a.distance - b.distance || b.count - a.count || a.name.localeCompare(b.name)).slice(0, 3);
}
function render(units: Unit[]): string {
  let output = '', joinNext = false, quote = '';
  for (const { word, name, at } of units) {
    const symbol = name && symbolNames[name];
    if (!symbol) { output += (output && !joinNext ? ' ' : '') + word; joinNext = false; continue; }
    let left = false, right = false;
    if (["'", '"', '`'].includes(symbol)) {
      left = name!.startsWith('close ') || (!name!.startsWith('open ') && quote === symbol);
      right = !left; quote = left ? '' : symbol;
    } else if (['/', '\\', '.', '_', ':', ',', '@', '=', '==', '^', '->', '<-', '-<', '+>', '+<', '+', '++', '*', '**', '%'].includes(symbol) || name === 'hyphen') left = right = true;
    else if (['~', '$', '!', '#', '-', '--', '[', '(', '{'].includes(symbol)) right = true;
    else if (['?', ']', ')', '}'].includes(symbol)) left = true;
    if (at === 1 && !units[0]?.name) left = false;
    output += (output && !joinNext && !left ? ' ' : '') + symbol;
    joinNext = right;
  }
  return output;
}
export function expandSymbols(input: string, general = true): string {
  const words = tokenize(input), units: Unit[] = [];
  for (let at = 0; at < words.length;) {
    const match = matches(words, at, false, general)[0];
    units.push({ word: words[at], name: match?.name, at }); at += match?.count || 1;
  }
  return units.some(unit => unit.name) ? render(units) : input;
}
/** Nearby spellings are separate alternatives, with bounded branching and work. */
export function symbolAlternatives(input: string): string[] {
  const words = tokenize(input);
  if (words.length > 64 || input.length > 2000 || /[\n\r]/.test(input)) return [];
  type State = { units: Unit[]; score: number; changed: boolean };
  const states: State[][] = Array.from({ length: words.length + 1 }, () => []);
  states[0].push({ units: [], score: 0, changed: false });
  for (let at = 0; at < words.length; at++) {
    const options = matches(words, at, true), exact = options[0]?.distance === 0;
    for (const state of states[at].sort((a, b) => b.score - a.score).slice(0, 4)) {
      const add = (name: string | undefined, count: number, gain: number, changed: boolean) => {
        const bucket = states[at + count];
        bucket.push({ units: [...state.units, { word: words[at], name, at }], score: state.score + gain, changed: state.changed || changed });
        bucket.sort((a, b) => b.score - a.score); bucket.splice(4);
      };
      if (!exact) add(undefined, 1, 0, false);
      for (const match of options) add(match.name, match.count, match.distance ? 3 - match.distance : 0, !!match.alias || match.distance > 0 || !directNames.has(match.name));
    }
  }
  const exact = expandSymbols(input, false);
  return [...new Set(states[words.length].filter(state => state.changed).sort((a, b) => b.score - a.score).map(state => render(state.units)))].filter(text => text !== input && text !== exact).slice(0, 3);
}
