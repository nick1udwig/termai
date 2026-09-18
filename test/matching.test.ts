import { test } from 'node:test';
import assert from 'node:assert/strict';
import { matches, similarity, tokens } from '../server/repair.ts';

test('one-edit matching agrees with edit distance for insertions, deletions and substitutions', () => {
  const words = (length: number): string[] => length ? words(length - 1).flatMap(prefix => ['1', '2', '3'].map(char => prefix + char)) : [''];
  const candidates = [...words(3), ...words(4)];
  for (const a of candidates) for (const b of candidates) {
    let row = Array.from({ length: b.length + 1 }, (_, i) => i);
    for (let i = 1; i <= a.length; i++) {
      const next = [i];
      for (let j = 1; j <= b.length; j++) next[j] = Math.min(next[j - 1] + 1, row[j] + 1, row[j - 1] + Number(a[i - 1] !== b[j - 1]));
      row = next;
    }
    const phoneticMatch = a.length >= 4 && b.length >= 4 && a.replace(/(.)\1+/g, '$1') === b.replace(/(.)\1+/g, '$1');
    assert.equal(similarity(a, b) > 0, phoneticMatch || row[b.length] <= 1, `${a} / ${b}`);
  }
});

test('indexed matching retains exhaustive ranking, collisions and multiword alternatives', () => {
  const candidates = ['git', 'Git', '_git', 'git_init', 'getent', 'python3', 'hello_world.py', 'hello-world.py', 'HelloWorld.py', 'phone', 'fone', 'three', '3', 'ls', 'LS', '!!!'];
  for (const input of ['get in it', 'Python three', 'hello world dot py', 'PHONE', 'fone', 'three', 'LS', '!!!', 'git "init"']) {
    const words = tokens(input), expected = [];
    for (let length = 1; length <= 6 && length <= words.length; length++) {
      const span = words.slice(0, length);
      if (span.some(word => word.quoted || /^-/.test(word.value))) break;
      if (/^(dash|hyphen|underscore|dot|hep)$/i.test(span.at(-1)!.value)) continue;
      for (const candidate of candidates) {
        const score = similarity(span.map(word => word.value).join(' '), candidate);
        if (score) expected.push({ value: candidate, consumed: length, score: score + (length - 1) * 8 });
      }
    }
    expected.sort((a, b) => b.score - a.score || a.value.localeCompare(b.value));
    assert.deepEqual(matches(words, 0, candidates, 6), expected.slice(0, 4), input);
  }
});
