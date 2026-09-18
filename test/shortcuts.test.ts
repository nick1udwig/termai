import { test } from 'node:test';
import assert from 'node:assert/strict';
import { defaults, keySequence, validateShortcuts } from '../src/shortcuts.ts';
test('key bindings produce terminal control sequences', () => {
  assert.equal(keySequence('Ctrl+R Tab Escape Up'), '\x12\t\x1b\x1b[A');
  assert.equal(keySequence('Alt+B Ctrl+Left Shift+Tab'), '\x1bB\x1b[1;5D\x1b[Z');
  assert.equal(keySequence('Ctrl+Alt+C'), '\x1b\x03');
  assert.throws(() => keySequence('NotAKey'));
});
test('saved shortcuts validate commands without rewriting shell syntax', () => {
  assert.deepEqual(validateShortcuts(defaults), defaults);
  const command = { label: 'Tests', kind: 'command', value: 'cd project && npm test | tail -20' };
  assert.deepEqual(validateShortcuts([command]), [command]);
  assert.throws(() => validateShortcuts([{ ...command, value: 'echo first\necho second' }]));
  assert.throws(() => validateShortcuts([{ ...command, kind: 'keys' }]));
});
