import { localBash } from '../server/shell.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { SSH_WRAPPER_CHECK } from '../server/ssh-capture.ts';

test('SSH handoff recognizes unchanged argument wrappers without running their bodies', async () => {
  const cases: [string, boolean][] = [
    ['command ssh "$@"', true],
    ['/usr/bin/ssh "$@"', true],
    ['local rc started; started=$SECONDS; command ssh "$@"; rc=$?; terminal_cleanup; return "$rc"', true],
    ['local status; command ssh "$@"; status=$?; while ((status == 255)); do command ssh "$@"; status=$?; done', true],
    ['printf native', false],
    ['command ssh -J jump "$@"', false],
    ['shift; command ssh "$@"', false],
    ['cd /tmp; command ssh "$@"', false],
    ['export HOME=/tmp; command ssh "$@"', false],
    ['local PATH; command ssh "$@"', false],
    ['local options="-A"; command ssh "$@"', false],
    ['before_connect; command ssh "$@"', false],
    ['if true; then command ssh "$@"; fi', false],
    ['local rc; rc=$(printf unexpected); command ssh "$@"', false],
    ['other() { command ssh "$@"; }; other "$@"', false],
  ];
  for (const [body, expected] of cases) {
    // Any accidental invocation prints a sentinel and cannot start real SSH.
    const script = `ssh() { ${body}; }\n${SSH_WRAPPER_CHECK}\ncommand() { printf EXECUTED; }\nif __termai_ssh_passthrough; then printf yes; else printf no; fi`;
    const result = await promisify(execFile)(localBash(), ['--noprofile', '--norc', '-c', script], { env: { PATH: '/usr/bin:/bin', BASH_ENV: '/dev/null' }, timeout: 2000 });
    assert.equal(result.stdout, expected ? 'yes' : 'no', body);
    assert.equal(result.stderr, '', body);
  }
});
