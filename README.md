# Evolve Health

Free, open-source health records for you, your family and your pets. Keep visits, medicines, allergies,
test results, vaccines and documents in one place; give each doctor, dentist, eye doctor, pharmacy, vet
or groomer exactly what they need; let caregivers help; and record appointments so you don't have to
remember everything that was said.

Everything is encrypted in the browser before it is stored or synced. There is no company server that
holds your records: they live on your devices and, if you choose, on storage nodes that you or someone
you trust runs. A node only ever holds ciphertext.

**Try it:** [evolvetech.dev/play/evolve-health](https://www.evolvetech.dev/play/evolve-health/) (choose
*Explore with sample data* to look around without entering anything) ·
[Project page](https://www.evolvetech.dev/projects/evolve-health/)

**Status: working prototype.** The crypto, sync, sharing, caregiver access, imports and recording are
implemented and tested (see [Checks](#checks)), but it has not had an independent security audit. It is
not a medical device and gives no medical advice.

## What it does

- **Profiles for people and pets.** Conditions, medicines (and pet preventatives), allergies, vaccines,
  test results, measurements, procedures, vision prescriptions, documents and photos, care team,
  insurance, family history, emergency contacts and a journal. An emergency card sits on top of each profile.
- **Share with a professional.** Pick *Dentist*, *Eye doctor*, *Pharmacy*, *Urgent care*, *Vet*,
  *Boarding*, *Groomer* and others; Evolve Health preselects what they usually need and you review every
  item. Send a revocable hosted link with an open count, a self-contained link, an encrypted file with a
  share code, or a printout. An optional 6-digit PIN means a forwarded link alone is not enough. The
  recipient needs no account and can download the records as a FHIR R4 bundle for their own system.
- **Caregivers and family.** Invite someone with their own vault as a *Viewer*, *Helper* (can add records
  and record visits) or *Manager* (can also share and invite helpers). Both sides compare a 12-digit safety
  code before approval. Removing someone rotates the profile key.
- **Record appointments.** With everyone's consent, record a visit, tap to mark medicine changes,
  instructions, follow-ups and questions, and keep the audio encrypted with the visit. Live transcription
  runs only when the browser can do it on the device (Chrome's on-device Web Speech); otherwise import a
  transcript from your phone's recorder (.txt, .vtt, .srt, Whisper .json). Sentences about medicines,
  follow-ups, tests and warning signs are highlighted by word matching, each linked to its moment in the recording.
- **Import what you already have.** Patient-portal downloads (C-CDA XML and MyChart-style ZIPs), SMART
  Health Cards (vaccine QR cards, with optional issuer-signature checking), FHIR R4 JSON/NDJSON, PDFs and photos.
- **Export everything** as FHIR R4, or as an encrypted backup file.

## Privacy, and insurers

People reasonably worry that health data can be used to price or judge them, for example by life,
disability or long-term-care insurers, who are not covered by GINA's genetic-information protections.
Evolve Health is designed so the system itself adds nothing anyone can buy, subpoena or mine:

- No company copy of your records, no analytics, no ads, no third-party scripts, no data sales.
- No account tied to your identity: no email, phone or real name is required.
- Storage nodes see only ciphertext padded to size buckets, plus the public keys they need to enforce access.
- Records you mark private (mental health, reproductive and sexual health, substance use, genetic testing,
  HIV and STIs) are never preselected by any share preset. Records that clearly mention these topics are
  marked private automatically, and you can untick that.
- Sharing with an *Insurer, employer or lawyer* preselects nothing and explains the stakes first. Evolve
  Health does not help anyone leave things off an application: answering truthfully matters, because
  misstatements can void a policy.
- Every share carries a purpose-of-use notice (treatment; not for underwriting, employment or marketing),
  is labeled with who it was for, and the FHIR bundle is tagged with HL7 `TREAT` and `NORDSCLCD`.

What it cannot do: stop an insurer from asking your doctors for their records when you apply, or stop a
recipient from keeping what you gave them. See [SECURITY.md](SECURITY.md) for the full threat model.

## How it works

```
 your browser (each device)                     storage nodes (optional, any number)
 ┌──────────────────────────────┐               ┌──────────────────────────────────┐
 │ passphrase ─Argon2id─┐       │  signed HTTPS │ accounts: public keys + sealed   │
 │ Secret Key ──────────┴► AMK  │ ◄───────────► │   keyring                        │
 │ keyring: Ed25519 + X25519    │               │ profiles: membership (signed),   │
 │   keys, profile keys         │               │   padded encrypted operations,   │
 │ profile = signed, encrypted  │               │   encrypted file chunks          │
 │   operation log (CRDT)       │               │ shares: one sealed package each  │
 └──────────────────────────────┘               └──────────────────────────────────┘
```

- Signing up creates an Ed25519 signing key and an X25519 key on the device. The keyring is sealed with
  AES-256-GCM under a key derived from **both** the passphrase (Argon2id, 64 MiB, 3 passes, in WebAssembly)
  and a random 128-bit **Secret Key** printed on the Emergency Kit, so a node cannot guess passphrases offline.
- Each profile has its own key. Every change is an operation encrypted with it, padded, and signed by its
  author. The newest operation per record wins (hybrid logical clock), so devices and nodes can exchange
  operations in any order and converge.
- A signed membership document says who can read or write a profile and carries each member's copy of the
  profile keys, wrapped to their X25519 key. Nodes enforce it and clients verify it.
- Files are split into 256 KiB chunks, each encrypted with a per-file key and stored by its hash.
- Shares are compressed, padded and encrypted with a fresh key that travels only in the link's `#fragment`.

Details: [docs/protocol.md](docs/protocol.md).

## Run your own

The app is static files; the node is one dependency-free Node.js program. Either:

```sh
docker compose up -d                                         # http://localhost:8787 on this computer
DOMAIN=health.example.org docker compose --profile https up -d   # public, with automatic HTTPS
```

or, with Node.js 22:

```sh
node node/server.mjs --app web            # app + node on http://localhost:8787
node node/server.mjs --host 0.0.0.0       # node only, for the hosted app to sync with
```

Browsers only allow the app's encryption on `https://` or `localhost`, so put anything reachable from
other devices behind HTTPS. [node/README.md](node/README.md) covers Caddy, Tailscale and Cloudflare
Tunnel, registration codes, quotas and backups.

## Development

No build step: `web/` is served as is. Node.js 22+ for tests.

```sh
npm install            # dev dependency only: the qrcode package, used as a test oracle
npm test               # unit and integration tests (Node)
python3 tests/browser_test.py --shots /tmp/shots   # end-to-end in Chrome (Playwright)
tools/build_wasm.sh    # rebuild web/src/lib/argon2.wasm (Rust, wasm32-unknown-unknown)
```

| Path | |
|---|---|
| `web/src/lib/` | bytes, WebCrypto wrappers, Argon2id loader, QR encoder |
| `web/src/core/` | accounts, local storage, profiles (spaces), membership, sync |
| `web/src/node/core.mjs` | storage-node logic shared by the server and the in-browser relay |
| `web/src/health/` | record model, presets, FHIR, C-CDA, SMART Health Cards, ZIP, transcripts |
| `web/src/share/` | share packages |
| `web/src/ui/` | the interface (DOM APIs only; Trusted Types enforced) and the recipient viewer |
| `node/` | HTTP server, file-system store, Caddyfile |
| `crates/argon2-wasm/` | Argon2id compiled to WebAssembly with raw exports |

## Checks

- `tests/core.test.mjs`: Argon2id against the RFC 9106 vector; unlock, tampering, padding, files; two
  devices converging through a real node; Emergency Kit sign-in; caregiver invite → approve → contribute →
  role change → removal with key rotation; forged membership rejected; hosted shares.
- `tests/node.test.mjs`: registration codes, quotas, manager limits, erasure, request freshness, CORS.
- `tests/health.test.mjs`: SMART Health Card signing/verification and tampering, numeric QR text, C-CDA
  (negation, narrative references, no DTD expansion), ZIP, share packages and PINs, transcripts, presets.
- `tests/fhir.test.mjs`: R4 required elements, references, time zones and an export→import round trip.
- `tests/qr.test.mjs`: the QR encoder matches the `qrcode` package module for module.
- `tests/browser_test.py`: the whole flow in Chrome against a node, including recording with a fake microphone.

During development the importers were also run against the official SMART Health Cards spec examples
(signatures verified with the spec issuer's keys) and HL7's C-CDA example documents. The HL7 FHIR
validator has not been run as part of these checks; to run it yourself:
`java -jar validator_cli.jar bundle.json -version 4.0.1`.

## Limits

- No direct connection to providers' systems yet (SMART on FHIR patient access would be next).
- Live transcription depends on the browser offering on-device speech recognition; there is no bundled
  speech model yet.
- Expiry of self-contained links and files is enforced by the viewer; only hosted shares can be withdrawn.
- People removed from a profile keep whatever they already synced.
- There is no time-delayed emergency access yet.

## License

Apache License 2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE).
