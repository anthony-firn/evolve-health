# Evolve Health protocol (v1)

Encodings: base64url without padding for binary fields; JSON bodies; Ed25519 signatures (64 bytes);
AES-256-GCM output is `iv (12 bytes) ‖ ciphertext ‖ tag (16 bytes)`.

## Accounts

```
signPub, boxPub   Ed25519 / X25519 public keys (raw, 32 bytes each)
acct              base64url(SHA-256(signPub)[0..16])
kdf               { alg: "argon2id", m: 65536, t: 3, p: 1, salt }
secretKey         16 random bytes, shown as EH1-XXXXX-… (Crockford base32); never sent to a node
AMK               HKDF-SHA-256(ikm = Argon2id(NFKC(passphrase), salt) ‖ secretKey, salt, info = "evolve-health/v1/account|" + acct)
header            { version, c: AES-GCM(AMK, keyring JSON, aad = "evolve-health/v1/keyring|" + acct + "|" + version) }
nodeAuth          HKDF-SHA-256(secretKey, info = "evolve-health/v1/node-auth|" + acct); nodes store SHA-256(nodeAuth)
```

The keyring holds the private keys (PKCS#8), the profile keys by epoch, node addresses, open invites,
pending acceptances and preferences. Concurrent keyring edits from two devices are merged as a union.

## Profiles (spaces)

A profile has a random 128-bit id and one AES key per epoch.

**Operation** (plaintext, padded to a 256 B…64 KiB bucket with a 4-byte length prefix):
`{ rid, kind, data, del, hlc }` where `hlc` = `base36(ms).base36(counter).device`.

**Envelope**: `{ v: 1, space, id, epoch, author, c, sig }`
- `c = AES-GCM(key[epoch], padded op, aad = "EHop1|space|id|epoch|author")`
- `sig = Ed25519(author, "EHop1|space|id|epoch|author|" + c)`

State is, per `rid`, the operation with the greatest `hlc`.

**Files**: per-file random key; chunk *i* of *n* (262,140 bytes before padding) sealed with
`aad = "EHblob1|i|n"`; stored at SHA-256(ciphertext). The record holds `{ k, h: [hashes], size, type, name }`.

**Membership** (signed JSON; signature over the canonical JSON without `sig`, prefixed `"EHmem1|"`):

```
{ v: 1, space, kind, owner, version, epoch, nodes,
  members: [{ acct, role: owner|manager|contributor|viewer, signPub, boxPub, since }],
  former:  [{ acct, signPub, removed }],
  grants:  { acct: box(member.boxPub, { space, keys: { epoch: key } }, "grant|space|acct") },
  certs:   { managerAcct: Ed25519(owner, "EHmgr1|space|acct|signPub") },
  meta:    AES-GCM(key[epoch], { names }, "meta|space"),
  signer, updatedAt, sig }
```

Accepted after a previous version when: same space and owner, higher version, epoch not lower, signer is
the owner or a certified manager of the previous version, managers did not change managers or
certificates, and every member's id matches its key. A first-seen document must be signed by the owner
or by a manager holding an owner certificate (version 1 always by the owner).

`box(pub, m, ctx)`: ephemeral X25519 → shared secret → HKDF-SHA-256(salt = epk ‖ pub,
info = "evolve-health/v1/box|" + ctx) → AES-GCM(m, aad = ctx); sent as `{ e: epk, c }`.

## Invites

The invite link carries `{ n: nodes, o: inviter, os, ob: inviter keys, w: owner, s: space, i: id,
k: 16-byte secret, r: role, l: profile name, f: inviter name, x: expiry }` in the URL fragment.
The invited person posts `box(ob, { type: "invite-accept", invite, space, acct, signPub, boxPub, name,
mac: HMAC-SHA-256(k, canonical{ invite, space, acct, signPub, boxPub, name }) }, "inbox|" + inviter)`
to the inviter's inbox. Both sides show a safety code: the first 64 bits of SHA-256 over both parties'
`acct:signPub:boxPub` (sorted) as 12 decimal digits. The inviter approves by adding the member and a
grant to the membership; the invited person verifies the inviter's keys against the link before using it.

## Shares

```
secret  16 random bytes; optional PIN → Argon2id(PIN, salt, m = 19456, t = 2, p = 1)
key     HKDF-SHA-256(secret ‖ pinKey, salt, "evolve-health/v1/share")
bytes   [1, hasPin, salt(16)] ‖ AES-GCM(key, pad(deflate-raw(JSON package)), aad = first 18 bytes)
links   viewer#1.<secret>.<bytes>             self-contained
        viewer#n.<secret>.<id>.<node>         hosted (node is URL-encoded; everything after the 3rd dot)
files   { format: "evolve-health-share", v: 1, data } + share code (secret in base32)
```

The package holds `{ id, createdAt, expiresAt, recipient, purpose, notice, from, subject, profile,
records, files }`. Viewers refuse expired packages; nodes delete hosted ones at expiry.

## Node API

Authenticated requests send
`Authorization: EH1 acct=<acct>,t=<ms>,sig=<Ed25519("EH1\nMETHOD\npath?query\nt\nbase64url(SHA-256(body)))>`;
the node accepts timestamps within 5 minutes.

| Method and path | Who | |
|---|---|---|
| `GET /v1/info` | anyone | `{ software: "evolve-health-node", version, name, registration, limits }` |
| `PUT /v1/accounts/:acct` | the account | register or update `{ signPub, boxPub, authHash, kdf, header }`; header version must increase |
| `GET /v1/accounts/:acct/public` | anyone | public keys |
| `GET /v1/accounts/:acct/header` | `Bearer nodeAuth` or the account | sealed keyring, for signing in on a new device |
| `DELETE /v1/accounts/:acct` | the account | erase keyring, inbox and the account's shares |
| `POST /v1/accounts/:acct/inbox` | anyone | sealed message `{ e, c }`, at most 16 KiB, 200 waiting |
| `GET /v1/accounts/:acct/inbox` · `DELETE …/inbox/:id` | the account | |
| `PUT /v1/spaces/:space` | owner or manager | create (owner) or update membership |
| `GET /v1/spaces/:space` | members | membership and sequence number |
| `DELETE /v1/spaces/:space` | owner | erase the profile from the node |
| `POST /v1/spaces/:space/ops` | helpers and above | up to 500 envelopes, each verified against membership |
| `GET /v1/spaces/:space/ops?after=n` | members | `{ ops, next, more }` in node order |
| `POST /v1/spaces/:space/blobs` | members | `{ hashes }` → `{ missing }` |
| `PUT` · `GET /v1/spaces/:space/blobs/:hash` | helpers and above · members | chunk must hash to its name |
| `PUT /v1/shares/:id` | any registered account | raw bytes, header `EH-Expires: <ms>` |
| `GET /v1/shares/:id` | anyone | raw bytes; records the time (only) of each open |
| `GET /v1/shares/:id/log` · `DELETE /v1/shares/:id` | creator | opens, or withdraw |

Storage written to a profile counts against its owner's quota; shares count against their creator.
