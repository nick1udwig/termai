import { test } from 'node:test';
import assert from 'node:assert/strict';
import { defaultReadingPhrases, readingPath, readingPhrases } from '../src/reading-request.ts';
import { readingRequest, readingPipeline, readingSuggestionChoice, readingSuggestionInput } from '../src/reading-request.ts';
import { ReadingCaptures } from '../server/reading-captures.ts';
import { readingMime } from '../server/reading.ts';
import { suggest } from './local-engine.ts';
import { Discovery } from './local-discovery.ts';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

test('reading phrases match whole phrases and keep paths with spaces', () => {
  assert.deepEqual(defaultReadingPhrases, ['look at']);
  assert.equal(readingPath('Look at "notes with spaces.md"', defaultReadingPhrases), 'notes with spaces.md');
  assert.equal(readingPath('look at /tmp/picture.png.', defaultReadingPhrases, true), '/tmp/picture.png');
  assert.equal(readingPath('look at notes.', defaultReadingPhrases), 'notes.');
  assert.equal(readingPath("look at 'note with spaces.md'", defaultReadingPhrases), 'note with spaces.md');
  assert.equal(readingPath('look at', defaultReadingPhrases), undefined);
  assert.equal(readingPath('look atlass', defaultReadingPhrases), undefined);
  assert.equal(readingPath('inspect notes.txt', readingPhrases(['Inspect', 'look at'])), 'notes.txt');
  assert.deepEqual(readingPhrases(['LOOK   AT', 'look at']), ['look at']);
  assert.deepEqual(readingPhrases(['']), defaultReadingPhrases);
});

test('reading alternatives use the command engine’s verified file and directory repairs', async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'termai-read-alternates-'));
  const discovery = new Discovery();
  try {
    await mkdir(path.join(cwd, 'docs'));
    await writeFile(path.join(cwd, 'README.md'), '# Read me');
    await writeFile(path.join(cwd, 'docs', 'Guide.md'), '# Guide');
    const catalog = { cwd, commands: ['cat', 'ls'], paths: ['README.md', 'docs/', 'docs/Guide.md'], history: [] };
    for (const [spoken, expected] of [
      ['look at readme dot md', 'look at README.md'],
      ['look at docs slash guide dot md', 'look at docs/Guide.md'],
      ['inspect readme dot md', 'inspect README.md'],
    ]) {
      const request = readingRequest(spoken, ['look at', 'inspect'], true)!;
      const candidates = await suggest(readingSuggestionInput(request), catalog, { ...process.env, HOME: cwd }, discovery);
      const choices = candidates.filter(candidate => !candidate.literal)
        .map(candidate => readingSuggestionChoice(candidate.command, request.phrase)).filter(Boolean);
      assert.equal(choices[0], expected, JSON.stringify(candidates));
    }
    assert.equal(readingSuggestionChoice("cat 'note with spaces.md'", 'look at'), "look at 'note with spaces.md'");
    assert.equal(readingSuggestionChoice('ls README.md', 'look at'), undefined);
  } finally { discovery.dispose(); await rm(cwd, { recursive: true, force: true }); }
});

test('reading MIME treats markup as display content', () => {
  assert.equal(readingMime('page.html', Buffer.from('<script>')), 'text/plain');
  assert.equal(readingMime('photo.PNG', Buffer.from('image')), 'image/png');
  assert.equal(readingMime('unknown', Buffer.from([0, 1])), 'application/octet-stream');
});

test('reader pipelines preserve Bash input and ignore quoted pipe text', () => {
  assert.deepEqual(readingPipeline('git diff | look at', ['look at']), { command: 'git diff', phrase: 'look at' });
  assert.deepEqual(readingPipeline('git diff pipe inspect', ['inspect'], true), { command: 'git diff', phrase: 'inspect' });
  assert.equal(readingPipeline("printf '%s' 'git diff | look at'", ['look at']), undefined);
  assert.equal(readingPipeline('git diff || look at', ['look at']), undefined);
  assert.equal(readingPipeline('git diff | look at other', ['look at']), undefined);
  assert.equal(readingPipeline('echo "$(git diff | look at)"', ['look at']), undefined);
  assert.deepEqual(readingPipeline("git diff | head -20 | look at", ['look at']), { command: 'git diff | head -20', phrase: 'look at' });
  assert.equal(readingRequest("look at printf '%s' 'a b'", ['look at'])?.operand, "printf '%s' 'a b'");
});

test('output snapshots preserve binary data, strip terminal codes, and bound retention', () => {
  const captures = new ReadingCaptures();
  const first = captures.add('git diff', Buffer.from('\x1b[31m+hello\x1b[0m\n'));
  assert.deepEqual(captures.pending(), [first]);
  assert.equal(captures.get(first.id)?.data.toString(), '+hello\n');
  assert.deepEqual(captures.pending(), []);
  const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 255]);
  const picture = captures.add('Command output', png);
  assert.equal(captures.get(picture.id)?.mime, 'image/png');
  assert.deepEqual(captures.get(picture.id)?.data, png);
  captures.remove(picture.id); assert.equal(captures.get(picture.id), undefined);
  for (let i = 0; i < 16; i++) captures.add('output', Buffer.from('text'));
  assert.equal(captures.get(first.id), undefined);
  assert.equal(captures.pending().length, 16);
  assert.throws(() => captures.add('too big', Buffer.alloc(20 * 1024 * 1024 + 1)), /20 MB/);
  captures.clear(); assert.deepEqual(captures.pending(), []);
});
