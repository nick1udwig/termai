import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PasteMode } from '../server/paste-mode.ts';
import { dictationTarget } from '../src/protocol.ts';

test('paste mode follows split and combined DEC sequences, resets, and ignores control strings', () => {
  const sequence = '\x1b[?1004;2004h';
  for (let split = 0; split <= sequence.length; split++) {
    const mode = new PasteMode();
    assert.equal(mode.paste('hello'), 'hello');
    mode.feed(sequence.slice(0, split)); mode.feed(sequence.slice(split));
    assert.equal(mode.paste('hello'), '\x1b[200~hello\x1b[201~');
    mode.feed('\x1b[?2004l'); assert.equal(mode.enabled, false);
    for (const start of [']', 'P', '_']) {
      mode.feed('\x1b' + start + 'title\x1b[?2004h\x1b\\');
      assert.equal(mode.enabled, false);
    }
    mode.feed('\x1b[?2004h\x1bc'); assert.equal(mode.enabled, false);
    mode.feed('\x1b[2004h'); assert.equal(mode.enabled, false);
  }
});

test('only a Bash prompt or a marked foreground program accepts dictation', () => {
  const state = { cwd: '/tmp', prompt: 1, inputRevision: 0, promptRevision: 0, ready: false, exited: false };
  assert.equal(dictationTarget(state), undefined);
  assert.equal(dictationTarget({ ...state, ready: true }), 'shell');
  assert.equal(dictationTarget({ ...state, inputTarget: 'program' }), 'program');
  assert.equal(dictationTarget({ ...state, inputTarget: 'program', exited: true }), undefined);
});
