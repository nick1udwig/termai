import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dictationLayout, dictationLevel } from '../src/dictation-layout.ts';

test('native panel expands left or right without moving the microphone', () => {
  assert.deepEqual(dictationLayout(330, 200, 390, 800), { bx: 330, by: 200, px: 178, py: 200, panelOnLeft: true });
  assert.deepEqual(dictationLayout(12, 200, 390, 800), { bx: 12, by: 200, px: 66, py: 200, panelOnLeft: false });
});
test('narrow displays stack controls, and the keyboard clamps the button to visible space', () => {
  const stacked = dictationLayout(126, 200, 300, 800);
  assert.equal(stacked.bx, 126); assert.equal(stacked.by, 200); assert.equal(stacked.py, 146);
  const keyboard = dictationLayout(330, 700, 390, 400);
  assert.equal(keyboard.by, 340);
  assert.ok(keyboard.px >= 12 && keyboard.px + 146 <= 378);
});
test('microphone levels match native silence, gain range and signed little-endian PCM', () => {
  assert.equal(dictationLevel(new ArrayBuffer(3200)), 0);
  assert.equal(dictationLevel(new ArrayBuffer(0)), 0);
  const pcm = (sample: number) => { const bytes = new ArrayBuffer(2); new DataView(bytes).setInt16(0, sample, true); return bytes; };
  assert.equal(dictationLevel(pcm(32767)), 1);
  assert.equal(dictationLevel(pcm(4096)), dictationLevel(pcm(-4096)));
  assert.ok(dictationLevel(pcm(4096)) > dictationLevel(pcm(256)));
});
