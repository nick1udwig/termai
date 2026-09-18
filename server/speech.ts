/** Explicit symbol names supplied by the user. Literal quoted text is left alone. */
export const symbolNames: Record<string, string> = Object.assign(Object.create(null), {
  buc: '$', mic: ';', fas: '/', bas: '\\', pam: '&', pat: '@', soq: "'", doq: '"', tic: '`',
  tis: '=', wut: '?', zap: '!', hax: '#', hep: '-', ket: '^', lac: '[', rac: ']', lit: '(', rit: ')',
  lob: '{', rob: '}', led: '<', ban: '>', lus: '+', stet: '==', slus: '++', shed: '--',
  dart: '->', dusk: '-<', lark: '+>', lush: '+<',
});
export function expandSymbols(input: string): string {
  const words = input.match(/"[^"\n]*"|'[^'\n]*'|\S+/g) || [];
  let output = '', joinNext = false, quote = '';
  for (const [index, word] of words.entries()) {
    const symbol = symbolNames[word.toLowerCase()];
    if (!symbol) { output += (output && !joinNext ? ' ' : '') + word; joinNext = false; continue; }
    let left = false, right = false;
    if (['soq', 'doq', 'tic'].includes(word.toLowerCase())) {
      left = quote === symbol; right = !left; quote = left ? '' : symbol;
    } else if (['/', '\\', '@', '=', '==', '^', '->', '-<', '+>', '+<', '+', '++'].includes(symbol)) left = right = true;
    else if (['$', '!', '#', '-', '--', '[', '(', '{'].includes(symbol)) right = true;
    else if (['?', ']', ')', '}'].includes(symbol)) left = true;
    if (index === 1 && !symbolNames[words[0]!.toLowerCase()]) left = false;
    output += (output && !joinNext && !left ? ' ' : '') + symbol;
    joinNext = right;
  }
  // Avoid reformatting ordinary speech when there were no explicit symbol words.
  return words.some(word => symbolNames[word.toLowerCase()]) ? output : input;
}
