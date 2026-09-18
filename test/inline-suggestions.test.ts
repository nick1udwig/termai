import { test } from 'node:test';
import assert from 'node:assert/strict';
import { InlineSuggestions } from '../src/inline-suggestions.ts';
import { InputLine } from '../src/input-line.ts';

function fixture(command: string) {
  let acknowledge!: (accepted: boolean) => void;
  const acknowledgement = new Promise<boolean>(resolve => acknowledge = resolve);
  const replacements: string[] = [];
  let requested = false;
  const inline = Object.assign(Object.create(InlineSuggestions.prototype), {
    generation: 0, literal: '', speech: '', choices: [], autoOpen: true, line: new InputLine(), status: {}, render() {},
    host: {
      state: () => ({ prompt: 1, ready: true }),
      replace: (text: string) => { replacements.push(text); return replacements.length === 1 ? acknowledgement : Promise.resolve(true); },
      suggest: async () => { requested = true; return { candidates: [{ command, score: 100, changes: [] }] }; },
    },
  });
  return { inline, acknowledge, replacements, requested: () => requested };
}

test('suggestion lookup overlaps acknowledgement but cannot apply before it', async () => {
  const f = fixture('git init');
  const pending = f.inline.dictate('Get in it.', false);
  assert.equal(f.requested(), true);
  await Promise.resolve();
  assert.deepEqual(f.replacements, ['Get in it.']);
  f.acknowledge(true); await pending;
  assert.deepEqual(f.replacements, ['Get in it.', 'git init']);
});

test('layout refreshes coalesce per frame and clearing an empty menu does not render', () => {
  const previousRequest = globalThis.requestAnimationFrame, previousCancel = globalThis.cancelAnimationFrame;
  const callbacks = new Map<number, FrameRequestCallback>();
  let next = 0, positioned = 0, rendered = 0;
  globalThis.requestAnimationFrame = callback => { callbacks.set(++next, callback); return next; };
  globalThis.cancelAnimationFrame = id => { callbacks.delete(id); };
  try {
    const { inline } = fixture('git init');
    inline.position = () => positioned++;
    inline.render = () => rendered++;
    inline.clear(); assert.equal(rendered, 0);
    inline.literal = 'git init';
    inline.refresh(); inline.refresh(); inline.refresh();
    assert.equal(callbacks.size, 1);
    const callback = callbacks.get(next)!; callbacks.delete(next); callback(0);
    assert.equal(positioned, 1);
    inline.refresh(); inline.clear();
    assert.equal(callbacks.size, 0);
    assert.equal(rendered, 1);
  } finally {
    if (previousRequest) globalThis.requestAnimationFrame = previousRequest; else Reflect.deleteProperty(globalThis, 'requestAnimationFrame');
    if (previousCancel) globalThis.cancelAnimationFrame = previousCancel; else Reflect.deleteProperty(globalThis, 'cancelAnimationFrame');
  }
});

test('unchanged suggestions avoid a second replacement; rejected and superseded edits stay untouched', async () => {
  const unchanged = fixture('echo hello');
  const pending = unchanged.inline.dictate('echo hello', false);
  unchanged.acknowledge(true); await pending;
  assert.deepEqual(unchanged.replacements, ['echo hello']);
  for (const accepted of [false, true]) {
    const f = fixture('git init');
    const pending = f.inline.dictate('Get in it.', false);
    if (accepted) f.inline.clear();
    f.acknowledge(accepted); await pending;
    assert.deepEqual(f.replacements, ['Get in it.']);
    assert.equal(f.inline.controller.signal.aborted, true);
  }
});
