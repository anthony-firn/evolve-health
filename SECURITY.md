# Security model

Evolve Health keeps health records encrypted on people's own devices and lets them sync through storage
nodes that never see readable data. This document says what that protects against, how, and where it
stops. It has not had an independent audit.

## Reporting a problem

Please use GitHub's private vulnerability reporting on this repository rather than a public issue.

## What is protected, and from whom

| Who | What they get | Why |
|---|---|---|
| A storage-node operator, or anyone who copies a node's disk | Account public keys, sealed keyrings, profile ids, membership (public keys and roles), padded ciphertext, share sizes and open times | Content is AES-256-GCM encrypted on the device; keyrings need the passphrase **and** the 128-bit Secret Key, which the node never receives |
| A node trying to read or join a profile | Nothing | Membership documents are signed by the owner or an owner-certified manager; clients verify signatures and pin the inviter's keys from the invite link |
| A node altering or replaying data | Rejected | Every operation is signed (Ed25519) and authenticated (GCM with the profile, operation id, epoch and author as associated data) |
| Someone on the network | Nothing beyond what the node sees | HTTPS; requests are signed with a timestamp and expire after 5 minutes |
| Someone who gets a share link | The share, until it expires or is withdrawn | That is what a link is. Add a PIN so the link alone is not enough |
| Someone who gets a share link but not the PIN | Nothing | The PIN is stretched with Argon2id and mixed into the key |
| A person removed from a profile | What they already had | The profile key is rotated, so new records use a key they never receive |
| Someone with a stolen, locked device | Ciphertext, until they guess the passphrase | Argon2id (64 MiB, 3 passes) per guess; the Secret Key is on the device, so the passphrase is the only barrier there |
| A malicious imported file | Rendered as text | The interface never uses `innerHTML`; Trusted Types and a strict Content Security Policy are enforced; the XML reader ignores DTDs |
| EvolveTech | Nothing | There is no EvolveTech server with your data; the public site serves static files |

## What is not protected

- **A compromised device or browser.** Malware, a malicious extension or someone using your unlocked
  device can read what you can read. Evolve Health locks after inactivity (10 minutes by default).
- **The code you run.** Like every web app, the code comes from the site that serves it. If that site were
  compromised it could serve code that leaks keys. To remove that trust, run your own copy (`node
  node/server.mjs --app web`) or install it from a reviewed checkout.
- **Metadata.** Nodes learn which account owns which profile, who is a member, how many operations and
  chunks exist and when they change, and the network address of whoever connects. Sizes are padded to
  buckets but not hidden. The bundled server does not log requests unless started with `--log`.
- **Recipients.** Anything you share can be kept, copied or printed by the recipient. Self-contained links
  and files enforce expiry in the viewer only.
- **Lost credentials.** No one can reset a passphrase. Losing the passphrase, or losing both the device and
  the Emergency Kit, means losing the records.
- **Live transcription.** It is used only when the browser reports on-device recognition. Evolve Health
  never falls back to cloud recognition, but it cannot verify what a browser does internally.
- **Legal process against providers.** Your doctors' own records are outside this system.

## Cryptography

| Purpose | Construction |
|---|---|
| Passphrase stretching | Argon2id, m = 64 MiB, t = 3, p = 1, 16-byte salt (Rust `argon2` crate compiled to WebAssembly, run in a worker) |
| Account key | HKDF-SHA-256(Argon2id(passphrase) ‖ Secret Key, info = account id) → AES-256-GCM |
| Node sign-in proof | HKDF-SHA-256(Secret Key); the node stores only its SHA-256 |
| Identity | Ed25519 signing key and X25519 key per account (Web Crypto); account id = first 128 bits of SHA-256(Ed25519 public key) |
| Profile data | Random 256-bit key per profile epoch; operations padded to 256 B…64 KiB buckets, AES-256-GCM, Ed25519-signed |
| Files | Random 256-bit key per file, 256 KiB chunks, AES-256-GCM, addressed by SHA-256 of ciphertext |
| Key sharing | Ephemeral X25519 + HKDF-SHA-256 + AES-256-GCM to each member's X25519 key |
| Invites | 128-bit invite secret; acceptance is HMAC'd and sealed to the inviter; 12-digit safety code from both parties' keys |
| Shares | Random 128-bit secret (plus Argon2id(PIN), m = 19 MiB, t = 2) → HKDF → AES-256-GCM over deflated, padded JSON |
| Requests to nodes | Ed25519 over method, path, timestamp and SHA-256 of the body |

Signing and X25519 operations use non-extractable Web Crypto key handles. While a vault is unlocked, the
decrypted keyring (which includes those private keys and the profile keys) is also held in page memory,
because it must be re-sealed when it changes and profile keys must be re-wrapped for new members. Locking
drops it.

## Known gaps

- Manager certificates are not individually revocable; a client that has never seen a newer membership
  version relies on the node to refuse documents from removed managers.
- No time-delayed emergency access yet.
- No independent audit or fuzzing beyond the tests in `tests/`.
