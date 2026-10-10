import { localBash } from '../server/shell.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { shellComplete } from '../server/completion.ts';
import { localHost } from '../server/host.ts';
import { suggest as localSuggest } from '../server/suggestions.ts';
import { suggest } from '../src/engine/suggestions.ts';
import { Discovery } from '../server/discovery.ts';
import { Facts } from '../server/facts.ts';
import { ContextCache, RemoteHost, type FactTransport } from '../src/remote-host.ts';
import { Session } from '../server/session.ts';
import { SSHHost } from '../server/ssh.ts';
import type { Catalog } from '../src/protocol.ts';
import type { CommandMetadata } from '../src/engine/command-policy.ts';

const exec = promisify(execFile);
const signal = () => AbortSignal.timeout(5000);
const metadata: CommandMetadata = { flags: {}, subcommands: { orchard: ['deploy'] }, requiredPositionals: {} };
const noDiscovery = { cached: () => metadata, discover: async () => ({ metadata }) };

async function customFixture() {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'termai-completion-'));
  const file = path.join(cwd, 'completions');
  await writeFile(file, `_orchard() {
    [[ "$1" == orchard && "$2" == "\${COMP_WORDS[COMP_CWORD]}" && "$COMP_LINE" == "orchard deploy $2" ]] || return
    COMPREPLY=('release/east-zone' 'release/west-zone')
    printf 'private completion chatter'
  }
  complete -F _orchard orchard
  complete -W 'release/east-zone release/west-zone' branches
  `);
  const env = { PATH: '/usr/bin:/bin', HOME: cwd, TERMAI_COMPLETIONS_FILE: file, PRIVATE_SECRET: 'not-on-the-wire' };
  const catalog: Catalog = { cwd, commands: ['orchard', 'branches'], paths: [], history: [] };
  return { cwd, env, catalog, file, dispose: () => rm(cwd, { recursive: true, force: true }) };
}

test('generic shell completions repair split names and spelled prefixes while preserving ambiguity and quotes', async () => {
  const f = await customFixture();
  try {
    const run = (input: string) => suggest(input, f.catalog, f.env, noDiscovery, localHost(f.cwd, f.env));
    for (const input of ['orchard deploy release slash east dash zone', 'orchard deploy R E L E A S E slash east dash zone']) {
      const result = await run(input);
      assert.equal(result[0].command, 'orchard deploy release/east-zone', JSON.stringify(result));
      assert.equal(result.at(-1)?.command, input);
      assert.equal(result.at(-1)?.literal, true);
    }
    const ambiguous = await run('orchard deploy release');
    assert.deepEqual(ambiguous.filter(candidate => candidate.changes.some(change => change.startsWith('Completion →'))).map(candidate => candidate.command), [
      'orchard deploy release/east-zone', 'orchard deploy release/west-zone',
    ]);
    assert.equal((await run("orchard deploy 'release'"))[0].command, "orchard deploy 'release'");
    const exact = await run('orchard deploy release/east-zone');
    assert.equal(exact[0].command, 'orchard deploy release/east-zone');
    assert.ok(exact.every(candidate => !candidate.command.includes('west-zone')));
    assert.deepEqual(await shellComplete(['branches', 'release/e'], f.cwd, f.env, signal()), ['release/east-zone']);
    assert.ok(!JSON.stringify(await run('orchard deploy release')).includes('private completion chatter'));
    const many = Array.from({ length: 1200 }, (_, index) => 'item' + index.toString().padStart(4, '0'));
    await writeFile(f.file, `complete -W '${many.join(' ')} zebra/queue-worker' branches\n`);
    assert.ok(!(await shellComplete(['branches', ''], f.cwd, f.env, signal())).includes('zebra/queue-worker'));
    assert.equal((await run('branches zebra slash queue dash worker'))[0].command, 'branches zebra/queue-worker', 'Prefix lookup finds a name beyond the full-list budget');
  } finally { await f.dispose(); }
});

test('real Git workflows repair the reported push, options, refs, remotes, aliases and alternate working directories', async t => {
  const completion = '/usr/share/bash-completion/completions/git';
  try { await access(completion); } catch { t.skip('Git completion is not installed'); return; }
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'termai-git-completion-'));
  const env = { PATH: '/usr/bin:/bin', HOME: cwd, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
  const git = (...args: string[]) => exec('/usr/bin/git', args, { cwd, env });
  const discovery = new Discovery();
  const catalog: Catalog = { cwd, commands: ['git'], paths: [], history: [] };
  try {
    await git('init', '-q');
    await git('symbolic-ref', 'HEAD', 'refs/heads/feat/elixir-worker');
    await git('-c', 'user.name=Test', '-c', 'user.email=test@example.test', 'commit', '--allow-empty', '-qm', 'initial');
    await git('branch', 'fix/queue-worker');
    await git('tag', 'release-v1.2');
    await git('remote', 'add', 'origin', 'https://example.invalid/repo.git');
    await git('config', 'alias.co', 'checkout');
    const cases = [
      ['git push dash u origin feet/elixir dash worker', 'git push -u origin feat/elixir-worker'],
      ['git push -u origin feat', 'git push -u origin feat/elixir-worker'],
      ['git push --set-upstream origen feat slash elixir dash worker', 'git push --set-upstream origin feat/elixir-worker'],
      ['git checkout F E A T', 'git checkout feat/elixir-worker'],
      ['git switch fix slash queue dash worker', 'git switch fix/queue-worker'],
      ['git merge feet/elixir dash worker', 'git merge feat/elixir-worker'],
      ['git rebase fix slash queue dash worker', 'git rebase fix/queue-worker'],
      ['git show release dash v1 dot 2', 'git show release-v1.2'],
      ['git co feat slash elixir dash worker', 'git co feat/elixir-worker'],
      [`git -C ${cwd} switch fix slash queue dash worker`, `git -C ${cwd} switch fix/queue-worker`],
    ];
    for (const [input, expected] of cases) {
      const result = await localSuggest(input, catalog, env, discovery);
      assert.equal(result[0].command, expected, JSON.stringify({ input, result }));
      assert.equal(result.at(-1)?.command, input);
    }
    assert.equal((await git('branch', '--show-current')).stdout.trim(), 'feat/elixir-worker', 'No proposed command was executed');
    assert.equal((await git('status', '--porcelain')).stdout, '');
    await git('switch', '-q', 'fix/queue-worker');
    await git('branch', '-D', 'feat/elixir-worker');
    const fresh = await localSuggest('git switch feat', catalog, env, discovery);
    assert.ok(!fresh.some(candidate => candidate.command === 'git switch feat/elixir-worker'));
  } finally { discovery.dispose(); await rm(cwd, { recursive: true, force: true }); }
});

test('client completion facts hide environment and reject invalid batches, unknown commands and stale contexts', async () => {
  const f = await customFixture();
  const state = { prompt: 1, cwd: f.cwd, ready: true, exited: false };
  const facts = new Facts({ state, catalog: async () => f.catalog, environment: async () => f.env,
    help: { read: async () => ({ flags: [], subcommands: [] }) } });
  const requests: any[] = [];
  const transport: FactTransport = async <T>(body: any, abort: AbortSignal) => {
    requests.push(body);
    return (body.kind === 'context' ? await facts.context() : await facts.read(body.key, body.operations, abort)) as T;
  };
  try {
    const cache = new ContextCache(), abort = signal();
    const snapshot = await cache.get(transport, abort);
    const host = new RemoteHost(transport, snapshot, abort);
    assert.equal((await suggest('orchard deploy release slash east dash zone', f.catalog, {}, noDiscovery, host, undefined, abort))[0].command,
      'orchard deploy release/east-zone');
    assert.ok(!JSON.stringify(snapshot).includes('not-on-the-wire'));
    assert.ok(requests.some(request => request.operations?.some((op: any) => op.kind === 'completion')));
    for (const words of [[], ['orchard'], ['missing', ''], ['orchard', 'bad\ninput']])
      await assert.rejects(facts.read(snapshot.key, [{ kind: 'completion', words }], abort));
    await assert.rejects(facts.read(snapshot.key, Array(9).fill({ kind: 'completion', words: ['orchard', ''] }), abort), /expensive/);
    const sentinel = path.join(f.cwd, 'executed');
    await host.complete(['branches', `$(touch ${sentinel})`]);
    await assert.rejects(access(sentinel));
    state.prompt++;
    await assert.rejects(facts.read(snapshot.key, [{ kind: 'completion', words: ['branches', ''] }], abort), /context changed/);
    await assert.rejects(shellComplete(['branches', ''], f.cwd, f.env, AbortSignal.abort()), { name: 'AbortError' });
  } finally { await f.dispose(); }
});

test('completion failures leave ordinary repairs and the original transcript available', async () => {
  const catalog: Catalog = { cwd: '/tmp', commands: ['orchard'], paths: [], history: [] };
  const host = { ...localHost('/tmp'), complete: async () => { throw new Error('Unavailable completion'); } };
  const result = await suggest('orchard deploy release', catalog, {}, noDiscovery, host);
  assert.equal(result[0].command, 'orchard deploy release');
  assert.equal(result.at(-1)?.literal, true);
});

test('SSH completion uses the same script and passes quoted operands without evaluating them', async () => {
  const f = await customFixture();
  try {
    const remote = new SSHHost() as any;
    remote.dir = f.cwd;
    remote.exec = async (command: string, abort: AbortSignal) => {
      const result = await exec(localBash(), ['--noprofile', '--norc', '-c', command], { signal: abort });
      return { ...result, code: 0 };
    };
    assert.deepEqual(await remote.host(f.cwd, f.env).complete(['orchard', 'deploy', ''], signal()), ['release/east-zone', 'release/west-zone']);
    const sentinel = path.join(f.cwd, 'ssh-executed');
    await remote.host(f.cwd, f.env).complete(['branches', `$(touch ${sentinel})`], signal());
    await assert.rejects(access(sentinel));
  } finally { await f.dispose(); }
});

test('prompt snapshots include newly registered completions without changing active terminal input', async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'termai-live-completion-'));
  const previous = process.env.TERMAI_NO_RC;
  process.env.TERMAI_NO_RC = '1';
  const session = new Session(cwd, [], 'client') as any;
  const waitPrompt = async (prompt: number) => {
    const deadline = Date.now() + 5000;
    while ((!session.state.ready || session.state.prompt < prompt) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
    assert.ok(session.state.ready && session.state.prompt >= prompt);
  };
  try {
    await session.start(); await waitPrompt(1);
    session.receive({ type: 'input', data: "orchard(){ :; }; _orchard(){ COMPREPLY=('release/east-zone'); }; complete -F _orchard orchard\r" });
    await waitPrompt(2);
    session.receive({ type: 'input', data: 'unfinished command' });
    const before = { ...session.state };
    let writes = 0;
    const original = session.process.write.bind(session.process);
    session.process.write = (data: string) => { writes++; original(data); };
    const context = await session.facts.context();
    const result = await session.facts.read(context.key, [{ kind: 'completion', words: ['orchard', 'deploy', ''] }], signal());
    assert.deepEqual(result, [['release/east-zone']]);
    assert.deepEqual(session.state, before);
    assert.equal(writes, 0);
    assert.ok((await readFile((await session.environment()).TERMAI_COMPLETIONS_FILE, 'utf8')).includes('_orchard'));
  } finally {
    if (previous === undefined) delete process.env.TERMAI_NO_RC; else process.env.TERMAI_NO_RC = previous;
    await session.dispose(); await rm(cwd, { recursive: true, force: true });
  }
});
