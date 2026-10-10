import { test } from 'node:test';
import assert from 'node:assert/strict';
import { localBash } from '../server/shell.ts';
import { release } from '../server/release.ts';

test('local Bash supports explicit modern shells without altering system Bash', () => {
  assert.equal(localBash({}, 'linux'), '/bin/bash');
  assert.equal(localBash({ TERMAI_BASH: '/opt/homebrew/bin/bash' }, 'darwin'), '/opt/homebrew/bin/bash');
  assert.throws(() => localBash({ TERMAI_BASH: 'bash' }), /absolute path/);
});
test('source checkouts expose a version without claiming a packaged commit', () => {
  assert.match(release.version, /^\d+\.\d+\.\d+/);
  assert.equal(release.platform, process.platform);
  assert.equal(release.node, process.version);
});
