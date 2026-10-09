export const nativeColumns = 152;
const cells = (text: string) => [...text].reduce((sum, ch) => sum + (/\p{Mark}/u.test(ch) ? 0 : /[\u2e80-\ua4cf\uac00-\ud7af]|\p{Extended_Pictographic}/u.test(ch) ? 2 : 1), 0);
const paint = (text = '') => '\x1b[48;2;53;54;64m' + text + ' '.repeat(Math.max(0, nativeColumns - cells(text))) + '\x1b[0m';
const recap = (text: string) => '\x1b[2;3m' + text.padEnd(nativeColumns) + '\x1b[0m';
export function codexScreen(draft = 'Ask Codex to do anything', historyLines = 45) {
  const rows = [
    ...Array.from({ length: historyLines }, (_, i) => `History ${i}: Ordinary terminal output remains available for scrolling and copying.`),
    '', '• The new renderer keeps normal terminal input, scrolling, copying and shortcuts.',
    "    const example = { keep: 'spacing' };", '',
    recap('  ↳ Recap: Updated rendering with compact controls and readable paragraphs. Tests'),
    recap('           and browser validation passed. The original terminal remains available in Full width,'),
    recap('           and each viewer keeps an independent screen size.'), '', '',
    paint(), paint('› ' + draft), paint(),
    '  \x1b[38;2;246;226;183mGPT-6.1-Sol xhigh\x1b[0m · ~/Work/git/mobile-demo/mobile-demo · Review rendering',
    '  \x1b[2m← for agents · ? for shortcuts' + ' '.repeat(90) + '⚠ 1 warning · f2 to view\x1b[0m',
  ];
  return { text: rows.join('\n') + '\n', composer: rows.length - 4 };
}
