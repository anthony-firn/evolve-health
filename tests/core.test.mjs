import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { argon2idInline } from '../web/src/lib/kdf.mjs';
import { hex, utf8 } from '../web/src/lib/bytes.mjs';
import { Vault } from '../web/src/core/vault.mjs';
import { parseKit, kitLink, passphraseStrength, suggestPassphrase } from '../web/src/core/account.mjs';
import { createServer } from '../node/server.mjs';

const FAST = { alg: 'argon2id', m: 256, t: 1, p: 1 };
let server, url, dir;

before(async () => {
  dir = await mkdtemp(join(tmpdir(), 'eh-node-'));
  server = createServer({ dataDir: dir });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  url = `http://127.0.0.1:${server.address().port}`;
});
after(async () => {
  server.closeAllConnections();
  server.close();
  await rm(dir, { recursive: true, force: true });
});

/** Sync and fail the test if any node reported a problem. */
async function sync(vault) {
  await vault.syncAll();
  for (const [node, st] of vault.nodeStatus) assert.ok(st.ok, `sync with ${node} failed: ${st.error}`);
}

async function account(name) {
  const vault = await Vault.open({ memory: true });
  await vault.create({ name, passphrase: `${name} correct horse battery staple`, kdf: FAST });
  return vault;
}

test('Argon2id WebAssembly matches the RFC 9106 test vector', async () => {
  const tag = await argon2idInline(new Uint8Array(32).fill(1), new Uint8Array(16).fill(2), { m: 32, t: 3, p: 4 }, 32,
    new Uint8Array(8).fill(3), new Uint8Array(12).fill(4));
  assert.equal(hex(tag), '0d640df58d78766c08c037a34a8b53c9d01ef0452d75b65eb52520e96b01e659');
});

test('passphrases: suggestions are strong, short ones are rejected', () => {
  assert.equal(passphraseStrength('hunter2').ok, false);
  assert.equal(passphraseStrength('password123').ok, false);
  const s = suggestPassphrase();
  assert.equal(s.split('-').length, 6);
  assert.equal(passphraseStrength(s).ok, true);
});

test('unlock needs the right passphrase; records survive lock and unlock', async () => {
  const vault = await account('Ada');
  const acct = vault.session.acct;
  const space = await vault.createProfile({ kind: 'person', name: 'Ada Example' });
  await space.put('allergy', { substance: 'Penicillin', reaction: 'Hives', severity: 'moderate' });
  vault.lock();
  await assert.rejects(vault.unlock(acct, 'wrong passphrase entirely'), /decrypt/i);
  await vault.unlock(acct, 'Ada correct horse battery staple');
  const [profile] = vault.profiles();
  assert.equal(profile.name, 'Ada Example');
  assert.equal(profile.space.list('allergy')[0].data.substance, 'Penicillin');
  vault.lock();
});

test('operations are opaque, padded and rejected when tampered with', async () => {
  const vault = await account('Bo');
  const space = await vault.createProfile({ kind: 'person', name: 'Bo' });
  await space.put('condition', { name: 'Asthma' });
  const ops = await vault.db.getOps(space.id);
  for (const op of ops) assert.ok(!JSON.stringify(op).includes('Asthma'));
  const sizes = new Set(ops.map((o) => Buffer.from(o.c, 'base64url').length - 28));
  for (const size of sizes) assert.ok([256, 512, 1024, 2048].includes(size), `bucketed size ${size}`);
  const forged = { ...ops[1], id: 'AAAAAAAAAAAAAAAAAAAAAA', c: ops[1].c.slice(0, -4) + 'AAAA' };
  const before = space.rejected;
  await space.ingest([forged]);
  assert.equal(space.rejected, before + 1);
  vault.lock();
});

test('files are chunked, encrypted and readable again', async () => {
  const vault = await account('Cy');
  const space = await vault.createProfile({ kind: 'person', name: 'Cy' });
  const bytes = new Uint8Array(600000).map((_, i) => i % 251);
  const ref = await space.saveFile(bytes, { name: 'scan.pdf', type: 'application/pdf' });
  assert.equal(ref.h.length, 3);
  assert.deepEqual(await vault.readFile(space, ref), bytes);
  vault.lock();
});

test('two devices of one account sync through a node; Emergency Kit signs in', async () => {
  const phone = await account('Dee');
  const space = await phone.createProfile({ kind: 'pet', name: 'Biscuit', species: 'Dog' });
  await phone.addNode(url); // added after the profile existed
  await space.put('immunization', { vaccine: 'Rabies', date: '2026-03-01' });
  const file = await space.saveFile(utf8('vaccine certificate'), { name: 'cert.txt', type: 'text/plain' });
  await space.put('document', { title: 'Rabies certificate', file });
  await sync(phone);

  const kit = parseKit(kitLink('https://example.test/app/', phone.session.record, [url]));
  const laptop = await Vault.open({ memory: true });
  await assert.rejects(laptop.signInWithKit(kit, 'not the passphrase at all'), /passphrase/);
  await laptop.signInWithKit(kit, 'Dee correct horse battery staple');
  await sync(laptop);
  const pet = laptop.profiles()[0];
  assert.equal(pet.name, 'Biscuit');
  assert.equal(pet.space.list('immunization')[0].data.vaccine, 'Rabies');
  const doc = pet.space.list('document')[0];
  assert.equal(new TextDecoder().decode(await laptop.readFile(pet.space, doc.data.file)), 'vaccine certificate');

  // Concurrent edits converge: the later write wins on both devices.
  const rid = pet.space.list('immunization')[0].rid;
  await pet.space.put('immunization', { vaccine: 'Rabies', date: '2026-03-01', lot: 'A1' }, rid);
  await new Promise((r) => setTimeout(r, 5));
  await space.put('immunization', { vaccine: 'Rabies', date: '2026-03-01', lot: 'B2' }, rid);
  await sync(laptop); await sync(phone); await sync(laptop);
  assert.equal(pet.space.get(rid).data.lot, 'B2');
  assert.equal(space.get(rid).data.lot, 'B2');
  phone.lock(); laptop.lock();
});

test('caregiver access: invite, approve, contribute, remove with key rotation', async () => {
  const rosa = await account('Rosa');
  await rosa.addNode(url);
  const profile = await rosa.createProfile({ kind: 'person', name: 'Rosa Rivera' });
  await profile.put('medication', { name: 'Apixaban', dose: '5 mg', frequency: 'twice a day' });
  await sync(rosa);

  const { code } = await rosa.createInvite(profile, { role: 'contributor', label: 'Jordan' });
  const jordan = await account('Jordan');
  const accepted = await jordan.acceptInvite(code, { name: 'Jordan (child)' });
  assert.match(accepted.code, /^\d{4} \d{4} \d{4}$/);

  await sync(rosa);
  const [request] = rosa.requests();
  assert.equal(request.name, 'Jordan (child)');
  assert.equal(request.code, accepted.code, 'both sides show the same safety code');
  await rosa.approveRequest(request.id);
  await sync(rosa);

  await sync(jordan);
  await sync(jordan);
  const shared = jordan.profiles().find((p) => p.id === profile.id);
  assert.ok(shared, 'Jordan sees Rosa’s profile');
  assert.equal(shared.role, 'contributor');
  assert.equal(shared.space.list('medication')[0].data.name, 'Apixaban');
  await shared.space.put('visit', { date: '2026-11-20', type: 'Primary care', summary: 'BP looks good' });
  await sync(jordan);
  await sync(rosa);
  assert.equal(profile.list('visit')[0].data.summary, 'BP looks good');
  const names = (await rosa.members(profile)).map((m) => m.name);
  assert.deepEqual(names.sort(), ['Jordan (child)', 'Rosa'].sort());

  // Viewer cannot write
  await rosa.changeRole(profile, jordan.session.acct, 'viewer');
  await sync(jordan);
  await assert.rejects(shared.space.put('note', { title: 'x' }), /view this profile/);

  // Removal rotates the key; new records are not readable by the removed person.
  await rosa.removeMember(profile, jordan.session.acct);
  assert.equal(profile.membership.epoch, 2);
  await profile.put('condition', { name: 'Osteoporosis' });
  await sync(rosa);
  await sync(jordan);
  assert.equal(jordan.profiles().find((p) => p.id === profile.id), undefined);
  rosa.lock(); jordan.lock();
});

test('a node rejects writes from people who are not members and forged membership', async () => {
  const owner = await account('Eve');
  await owner.addNode(url);
  const space = await owner.createProfile({ kind: 'person', name: 'Eve' });
  await sync(owner);
  const stranger = await account('Mallory');
  await stranger.addNode(url);
  const client = stranger.client(url);
  await assert.rejects(client.request('GET', `/v1/spaces/${space.id}/ops?after=0`, { session: stranger.session }), /member/);
  const forged = { ...space.membership, version: 99, members: [...space.membership.members, { acct: stranger.session.acct, role: 'manager', signPub: stranger.session.signPub, boxPub: stranger.session.boxPub }] };
  await assert.rejects(client.request('PUT', `/v1/spaces/${space.id}`, { session: stranger.session, body: forged }), /rejected|signed/);
  owner.lock(); stranger.lock();
});

test('hosted shares expire, count opens and can be withdrawn', async () => {
  const vault = await account('Fay');
  await vault.addNode(url);
  const id = await vault.publishShare(url, utf8('sealed bytes'), Date.now() + 60000);
  const anon = vault.client(url);
  const got = await anon.request('GET', `/v1/shares/${id}`, { raw: true });
  assert.equal(new TextDecoder().decode(got.bytes), 'sealed bytes');
  const log = await vault.shareLog(url, id);
  assert.equal(log.opens.length, 1);
  await vault.withdrawShare(url, id);
  await assert.rejects(anon.request('GET', `/v1/shares/${id}`), /expired or was withdrawn/);
  await assert.rejects(vault.publishShare(url, utf8('x'), Date.now() + 400 * 86400000), /expire within/);
  vault.lock();
});
