// Storage-node policies: registration, quotas, who may change membership, erasure, request freshness.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from '../node/server.mjs';
import { Vault } from '../web/src/core/vault.mjs';
import { signedString } from '../web/src/node/core.mjs';
import { sign } from '../web/src/lib/crypto.mjs';
import { b64url } from '../web/src/lib/bytes.mjs';

const FAST = { alg: 'argon2id', m: 256, t: 1, p: 1 };
const cleanup = [];
after(async () => { for (const fn of cleanup) await fn(); });

async function node(config = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'eh-node-'));
  const server = createServer({ dataDir: dir, ...config });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  cleanup.push(async () => { server.closeAllConnections(); server.close(); await rm(dir, { recursive: true, force: true }); });
  return { url: `http://127.0.0.1:${server.address().port}`, dir };
}

async function person(name) {
  const v = await Vault.open({ memory: true });
  await v.create({ name, passphrase: `${name} long enough passphrase here`, kdf: FAST });
  cleanup.push(() => v.lock());
  return v;
}

test('registration codes gate new accounts', async () => {
  const { url } = await node({ registration: 'code', registrationCodes: ['let-me-in'] });
  const v = await person('Gil');
  await assert.rejects(v.addNode(url).then(() => v.syncAccount(url)), /registration code/);
  const res = await v.client(url).request('PUT', `/v1/accounts/${v.session.acct}`, {
    session: v.session, headers: { 'eh-node-code': 'let-me-in' },
    body: { signPub: v.session.signPub, boxPub: v.session.boxPub, kdf: v.session.record.kdf, header: v.session.record.header, authHash: 'x'.repeat(43) },
  });
  assert.equal(res.ok, true);
});

test('quota is enforced per owner', async () => {
  const { url } = await node({ quotaBytes: 64 * 1024 });
  const v = await person('Hal');
  await v.addNode(url);
  const space = await v.createProfile({ kind: 'person', name: 'Hal' });
  await space.saveFile(new Uint8Array(200000), { name: 'big.bin' });
  await v.syncAll();
  assert.match(v.nodeStatus.get(url).error, /quota/i);
});

test('managers can add helpers but not other managers; owners can', async () => {
  const { url } = await node();
  const owner = await person('Ida');
  await owner.addNode(url);
  const profile = await owner.createProfile({ kind: 'person', name: 'Ida' });
  await owner.syncAll();
  const join = async (who, role) => {
    const { code } = await owner.createInvite(profile, { role, label: who.keyring.name });
    await who.acceptInvite(code);
    await owner.syncAll();
    const req = owner.requests().find((r) => r.acct === who.session.acct);
    await owner.approveRequest(req.id);
    await owner.syncAll(); await who.syncAll(); await who.syncAll();
    return who.space(profile.id);
  };
  const mgr = await person('Jo');
  const asManager = await join(mgr, 'manager');
  assert.equal(asManager.role, 'manager');
  await assert.rejects(mgr.createInvite(asManager, { role: 'manager', label: 'x' }), /Only the owner can add managers/);
  const helper = await person('Kai');
  const { code } = await mgr.createInvite(asManager, { role: 'contributor', label: 'Kai' });
  await helper.acceptInvite(code);
  await mgr.syncAll();
  const req = mgr.requests().find((r) => r.acct === helper.session.acct);
  await mgr.approveRequest(req.id);
  await mgr.syncAll(); await helper.syncAll(); await helper.syncAll(); await owner.syncAll();
  assert.equal(helper.space(profile.id)?.role, 'contributor');
  assert.equal(owner.space(profile.id).membership.members.length, 3);
  // A manager forging a manager promotion is rejected by the node.
  const doc = structuredClone(asManager.membership);
  doc.members.find((m) => m.acct === helper.session.acct).role = 'manager';
  await assert.rejects(mgr.updateMembership(asManager, () => doc), /not allowed/);
});

test('owners can erase a profile from the node', async () => {
  const { url, dir } = await node();
  const v = await person('Lu');
  await v.addNode(url);
  const space = await v.createProfile({ kind: 'pet', name: 'Mochi', species: 'Cat' });
  await space.put('note', { title: 'x' });
  await space.saveFile(new Uint8Array([1, 2, 3]));
  await v.syncAll();
  assert.ok((await readdir(join(dir, 'ops'))).includes(space.id));
  await v.removeProfile(space.id);
  for (const area of ['ops', 'opid', 'blob']) assert.deepEqual(await readdir(join(dir, area, space.id)).catch(() => []), []);
  await assert.rejects(v.client(url).request('GET', `/v1/spaces/${space.id}`, { session: v.session }), /Unknown profile/);
});

test('signed requests expire and cannot be moved to another path', async () => {
  const { url } = await node();
  const v = await person('Mo');
  await v.addNode(url);
  const signedAt = async (method, path, t) => `EH1 acct=${v.session.acct},t=${t},sig=${b64url(await sign(v.session.signer, await signedString(method, path, t)))}`;
  const old = Date.now() - 10 * 60000;
  let res = await fetch(`${url}/v1/accounts/${v.session.acct}/inbox`, { headers: { authorization: await signedAt('GET', `/v1/accounts/${v.session.acct}/inbox`, old) } });
  assert.equal(res.status, 401);
  const t = Date.now();
  res = await fetch(`${url}/v1/accounts/${v.session.acct}/header`, { headers: { authorization: await signedAt('GET', `/v1/accounts/${v.session.acct}/inbox`, t) } });
  assert.equal(res.status, 401);
  res = await fetch(`${url}/v1/accounts/${v.session.acct}/inbox`, { headers: { authorization: await signedAt('GET', `/v1/accounts/${v.session.acct}/inbox`, t) } });
  assert.equal(res.status, 200);
  const pre = await fetch(`${url}/v1/info`, { method: 'OPTIONS', headers: { 'access-control-request-private-network': 'true', origin: 'https://www.evolvetech.dev' } });
  assert.equal(pre.headers.get('access-control-allow-private-network'), 'true');
});
