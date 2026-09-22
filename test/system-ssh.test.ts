import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import ssh2 from 'ssh2';
import { sshArguments, resolveSystemSSH, NativeSSH, readIdentity } from '../server/system-ssh.ts';
import { Vault } from '../server/vault.ts';

test('SSH capture accepts literal interactive invocations and preserves native shell semantics otherwise', () => {
  assert.deepEqual(sshArguments("ssh -i '/tmp/key with spaces' -p2222 user@host"), ['-i', '/tmp/key with spaces', '-p2222', 'user@host']);
  assert.deepEqual(sshArguments('ssh -o IdentityFile=~/.ssh/work host'), ['-o', 'IdentityFile=~/.ssh/work', 'host']);
  assert.deepEqual(sshArguments('ssh -i "key\\name" host'), ['-i', 'key\\name', 'host']);
  for (const command of ['echo ssh host', 'ssh host uptime', 'ssh -L 8080:localhost:80 host', 'ssh -N host', 'ssh $HOST', 'ssh host; echo second', 'ssh host && true', 'ssh $(hostname)', 'ssh "${HOST}"', 'ssh -oProxyCommand=foo host', 'ssh -i', 'ssh "broken', 'ssh host # comment']) assert.equal(sshArguments(command), undefined, command);
});

test('system SSH prefers configured agent keys without reversing agent order', async () => {
  const dir = await mkdtemp('/tmp/termai-agent-order-'), socket = dir + '/agent.sock';
  const agent = spawn('/usr/bin/ssh-agent', ['-D', '-a', socket], { stdio: ['ignore', 'pipe', 'pipe'] });
  const stopped = new Promise(resolve => agent.once('exit', resolve));
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Agent startup timed out')), 3000);
      agent.once('error', error => { clearTimeout(timer); reject(error); });
      agent.stdout.once('data', () => { clearTimeout(timer); resolve(); });
    });
    const env = { ...process.env, SSH_AUTH_SOCK: socket };
    const other = ssh2.utils.generateKeyPairSync('ed25519'), configured = ssh2.utils.generateKeyPairSync('ed25519');
    await writeFile(dir + '/other', other.private, { mode: 0o600 });
    await writeFile(dir + '/configured', configured.private, { mode: 0o600 });
    await promisify(execFile)('/usr/bin/ssh-add', [dir + '/other', dir + '/configured'], { env, timeout: 3000 });
    await writeFile(dir + '/config', `Host *\n IdentityFile ${dir}/configured\n IdentityAgent ${socket}\n IdentitiesOnly no\n UserKnownHostsFile /dev/null\n GlobalKnownHostsFile /dev/null\n`);
    const result = await resolveSystemSSH(`ssh -F ${dir}/config example.invalid`, env, dir);
    assert.deepEqual(result.identities.map(identity => identity.reference.type), ['agent', 'agent', 'file']);
    assert.equal(result.identities[0].publicKey, configured.public);
    assert.equal(result.identities[1].publicKey, other.public);
  } finally { agent.kill(); await stopped; await rm(dir, { recursive: true, force: true }); }
});

test('system identity resolution honors config and keeps private keys out of vault references', async () => {
  const dir = await mkdtemp('/tmp/termai-system-key-');
  try {
    const pair = ssh2.utils.generateKeyPairSync('ed25519'); await writeFile(dir + '/identity', pair.private, { mode: 0o600 });
    await writeFile(dir + '/config', `Host fixture\n HostName 127.0.0.1\n User example\n Port 2222\n IdentityFile ${dir}/identity\n IdentitiesOnly yes\n IdentityAgent none\n UserKnownHostsFile ${dir}/known\n GlobalKnownHostsFile /dev/null\n`);
    const info = await resolveSystemSSH(`ssh -F ${dir}/config fixture`, process.env, dir);
    assert.equal(info.host, '127.0.0.1'); assert.equal(info.port, 2222); assert.equal(info.username, 'example'); assert.equal(info.identities.length, 1);
    const vault = new Vault(dir + '/vault'), identity = info.identities[0];
    const first = await vault.reference('Fixture key', identity, identity.reference);
    assert.equal((await vault.reference('Same key', identity, identity.reference)).id, first.id);
    const disk = await readFile(dir + '/vault/vault.json', 'utf8');
    assert.ok(disk.includes(dir + '/identity')); assert.ok(!disk.includes('PRIVATE KEY')); assert.ok(!disk.includes('ciphertext'));
    assert.deepEqual(Object.keys(JSON.parse(disk).keys[0]).sort(), ['createdAt', 'fingerprint', 'id', 'name', 'publicKey', 'reference']);
    await assert.rejects(vault.unlock(first.id, 'irrelevant'), /external reference/);
    await vault.remove(first.id); assert.equal(await readFile(dir + '/identity', 'utf8'), pair.private);
    for (const setting of ['ProxyJump jump.example', 'LocalForward 8080 localhost:80', 'ForwardAgent yes', 'RemoteCommand uptime', 'CertificateFile /tmp/certificate', 'ControlPath /tmp/control', 'UserKnownHostsFile "/tmp/known hosts"']) {
      await writeFile(dir + '/native-config', `Host *\n ${setting}\n`);
      await assert.rejects(resolveSystemSSH(`ssh -F ${dir}/native-config target`, process.env, dir), NativeSSH, setting);
    }
    const encrypted = ssh2.utils.generateKeyPairSync('ed25519', { passphrase: 'fixture-pass', cipher: 'aes256-cbc', rounds: 4 });
    await writeFile(dir + '/identity', encrypted.private); await writeFile(dir + '/identity.pub', encrypted.public);
    const locked = await resolveSystemSSH(`ssh -F ${dir}/config fixture`, process.env, dir);
    assert.equal(locked.locked, true); assert.equal(locked.identities.length, 0);
    assert.ok(await readIdentity(dir + '/identity', 'fixture-pass'));
  } finally { await rm(dir, { recursive: true, force: true }); }
});
