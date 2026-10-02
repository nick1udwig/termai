import { test } from 'node:test';
import assert from 'node:assert/strict';
import { terminalLinkAt } from '../src/terminal-links.ts';

function terminal(rows: { text: string; wrapped?: boolean; uri?: string }[]) {
  const lines = rows.map(row => ({
    isWrapped: !!row.wrapped, length: Array.from(row.text).length,
    getCell: (col: number) => col < Array.from(row.text).length ? {
      getCodepoint: () => Array.from(row.text)[col].codePointAt(0)!,
      getHyperlinkId: () => row.uri ? 1 : 0,
    } : undefined,
  }));
  return {
    buffer: { active: { getLine: (row: number) => lines[row] } },
    wasmTerm: {
      getScrollbackLength: () => 1,
      getHyperlinkUri: (row: number) => rows[row + 1]?.uri || null,
      getScrollbackHyperlinkUri: (row: number) => rows[row]?.uri || null,
    },
  } as unknown as Parameters<typeof terminalLinkAt>[0];
}

test('web URLs open without sentence punctuation or adjacent ordinary text', () => {
  const text = 'See https://example.com/path?q=1#part. Done';
  const term = terminal([{ text }]);
  assert.equal(terminalLinkAt(term, 4, 0), 'https://example.com/path?q=1#part');
  assert.equal(terminalLinkAt(term, 30, 0), 'https://example.com/path?q=1#part');
  for (const col of [0, text.indexOf('. Done'), text.indexOf('Done'), -1, 100]) assert.equal(terminalLinkAt(term, col, 0), undefined);
  assert.equal(terminalLinkAt(term, 0, 100), undefined);
});

test('every wrapped URL segment resolves to the complete link without joining hard line breaks', () => {
  const term = terminal([
    { text: 'https://example.com/' },
    { text: 'a/long/path?q=1', wrapped: true },
    { text: '#fragment', wrapped: true },
    { text: 'separate-output' },
  ]);
  for (const [col, row] of [[0, 0], [10, 0], [3, 1], [4, 2]])
    assert.equal(terminalLinkAt(term, col, row), 'https://example.com/a/long/path?q=1#fragment');
  assert.equal(terminalLinkAt(term, 0, 3), undefined);
});

test('wide-cell padding and emoji before a link preserve cell coordinates', () => {
  const term = terminal([{ text: '界\0😀\0 https://example.com' }]);
  assert.equal(terminalLinkAt(term, 5, 0), 'https://example.com/');
  assert.equal(terminalLinkAt(term, 23, 0), 'https://example.com/');
  assert.equal(terminalLinkAt(term, 4, 0), undefined);
});

test('labeled hyperlinks resolve their destination in live output and scrollback', () => {
  const term = terminal([{ text: 'Older link', uri: 'https://example.com/older' }, { text: 'New link', uri: 'http://example.com/new' }]);
  assert.equal(terminalLinkAt(term, 2, 0), 'https://example.com/older');
  assert.equal(terminalLinkAt(term, 2, 1), 'http://example.com/new');
});

test('terminal text cannot activate non-web schemes or override an explicit unsafe hyperlink', () => {
  for (const uri of ['javascript:alert(1)', 'data:text/html,test', 'file:///tmp/readme', 'mailto:me@example.com', 'relative', 'https://']) {
    const term = terminal([{ text: 'https://example.com', uri }]);
    assert.equal(terminalLinkAt(term, 1, 0), undefined);
  }
  assert.equal(terminalLinkAt(terminal([{ text: 'ssh://example.com' }]), 1, 0), undefined);
});
