import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, stat, rm } from 'node:fs/promises';
import ssh2 from 'ssh2';
import { Vault, inspectPrivateKey } from '../server/vault.ts';
import { backendURL, sshAddress } from '../src/connections.ts';

test('keychain requires passwords, encrypts private keys, exposes only public metadata and survives restart', async () => {
  const directory = await mkdtemp('/tmp/termai-vault-');
  try {
    const vault = new Vault(directory);
    await assert.rejects(vault.create('empty password', ''), /passphrase/);
    const short = await vault.create('short', 'x'); const unlocked = await vault.unlock(short.id, 'x'); assert.ok(unlocked.length); unlocked.fill(0); await vault.remove(short.id);
    const key = await vault.create('personal', 'correct-passphrase');
    assert.match(key.publicKey, /^ssh-ed25519 /);
    assert.deepEqual(Object.keys(key).sort(), ['createdAt', 'fingerprint', 'id', 'name', 'publicKey']);
    const raw = await readFile(directory + '/vault.json', 'utf8');
    assert.ok(!raw.includes('PRIVATE KEY') && !raw.includes('correct-passphrase'));
    assert.equal((await stat(directory + '/vault.json')).mode & 0o777, 0o600);
    const restarted = new Vault(directory);
    await assert.rejects(restarted.unlock(key.id, 'wrong-passphrase'), /Incorrect/);
    const privateKey = await restarted.unlock(key.id, 'correct-passphrase');
    const parsed = ssh2.utils.parseKey(privateKey); assert.ok(!(parsed instanceof Error)); privateKey.fill(0);
    await restarted.rename(key.id, 'renamed'); assert.equal((await restarted.list()).keys[0].name, 'renamed');
    await restarted.remove(key.id); assert.deepEqual((await restarted.list()).keys, []);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('encrypted imports require the existing passphrase and retain a usable SSH key', async () => {
  const directory = await mkdtemp('/tmp/termai-import-');
  try {
    const pair = ssh2.utils.generateKeyPairSync('ed25519', { passphrase: 'original-password', cipher: 'aes256-cbc', rounds: 16 });
    const vault = new Vault(directory);
    await assert.rejects(vault.create('bad', 'wrong-password', pair.private), /Cannot unlock/);
    const key = await vault.create('import', 'original-password', pair.private), raw = await vault.unlock(key.id, 'original-password');
    const parsed = ssh2.utils.parseKey(raw, 'original-password'); assert.ok(!(parsed instanceof Error)); raw.fill(0);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('known-host pins cannot be silently replaced and concurrent vault changes are retained', async () => {
  const directory = await mkdtemp('/tmp/termai-pins-');
  try {
    const vault = new Vault(directory);
    await Promise.all([vault.trust('one', 22, 'SHA256:first'), vault.trust('two', 2222, 'SHA256:second')]);
    assert.equal((await vault.list()).knownHosts.length, 2);
    await assert.rejects(vault.trust('one', 22, 'SHA256:changed'), /Host key changed/);
    await vault.forget('one', 22); await vault.trust('one', 22, 'SHA256:changed');
    assert.equal((await vault.list()).knownHosts.find(host => host.host === 'one')?.fingerprint, 'SHA256:changed');
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('connection addresses reject embedded credentials, unsupported schemes and invalid SSH destinations', () => {
  assert.equal(backendURL('https://host/t'), 'https://host/t/');
  for (const url of ['javascript:alert(1)', 'https://user:password@host/', 'https://host/?token=secret']) assert.throws(() => backendURL(url));
  assert.deepEqual(sshAddress({ host: '::1', username: 'nick' }), { host: '::1', username: 'nick', port: 22 });
  assert.throws(() => sshAddress({ host: 'host; touch /tmp/no', username: 'nick' }));
  assert.throws(() => sshAddress({ host: 'host', username: 'nick', port: 0 }));
});

test('explicit backups update only their own identity and inspection does not persist a key', async () => {
  const directory = await mkdtemp('/tmp/termai-backup-');
  try {
    const vault = new Vault(directory), pair = ssh2.utils.generateKeyPairSync('ed25519');
    const metadata = inspectPrivateKey(pair.private, 'x');
    assert.match(metadata.fingerprint, /^SHA256:/); assert.deepEqual((await vault.list()).keys, []);
    const backup = await vault.create('backup', 'x', pair.private);
    const refreshed = await vault.create('renamed backup', 'y', pair.private, backup.id);
    assert.equal(refreshed.id, backup.id); assert.equal((await vault.list()).keys.length, 1);
    await assert.rejects(vault.unlock(backup.id, 'x'), /Incorrect/);
    const raw = await vault.unlock(backup.id, 'y'); assert.equal(raw.toString(), pair.private); raw.fill(0);
    const other = ssh2.utils.generateKeyPairSync('ed25519');
    await assert.rejects(vault.create('wrong identity', 'x', other.private, backup.id), /different SSH key/);
    assert.equal((await vault.list()).keys[0].fingerprint, metadata.fingerprint);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
