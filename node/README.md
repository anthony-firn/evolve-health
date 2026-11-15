# Running an Evolve Health node

A node stores encrypted copies of people's profiles so their devices and caregivers stay in sync, relays
invite replies, and hosts shares until they expire. It never receives anything readable. One small
program, no npm dependencies, Node.js 22 or Docker.

## Quick start

```sh
git clone https://github.com/anthony-firn/evolve-health && cd evolve-health
docker compose up -d                        # http://localhost:8787 on this computer
```

or without Docker:

```sh
node node/server.mjs --app web --data ./evolve-health-data
```

`--app web` also serves the web app, so the same address is a complete, self-hosted Evolve Health.
Leave it off to run only the node and use the app from evolvetech.dev or elsewhere.

## Reaching it from your phone and other people

Browsers only allow the app's encryption on `https://` or `localhost`, and an `https://` page cannot
talk to a plain `http://` node on your network. Pick one:

- **A domain you control (automatic HTTPS with Caddy).** Point a DNS name at the machine, open ports 80
  and 443, then: `DOMAIN=health.example.org docker compose --profile https up -d`.
- **Tailscale** (no open ports; works for your own devices and people you share your tailnet with):
  `tailscale serve --bg 8787` gives `https://<machine>.<tailnet>.ts.net`.
- **Cloudflare Tunnel**: `cloudflared tunnel --url http://localhost:8787` (or a named tunnel for a stable address).

Then add the `https://` address in Evolve Health under **Settings → Sync and devices**.

## Options

| Flag | Environment | Default | |
|---|---|---|---|
| `--port` | `EH_PORT` | 8787 | |
| `--host` | `EH_HOST` | 127.0.0.1 | use 0.0.0.0 behind a reverse proxy or in Docker |
| `--data` | `EH_DATA` | ./evolve-health-data | ciphertext only; back it up like any directory |
| `--app` | `EH_APP` | (off) | folder of the web app to serve |
| `--name` | `EH_NAME` | Evolve Health node | shown to people who add the node |
| `--registration open\|code` | `EH_REGISTRATION` | open | `code` requires a code for new accounts |
| `--code SECRET` (repeatable) | `EH_CODES` (comma-separated) | | registration codes |
| `--quota-mb` | `EH_QUOTA_MB` | 2048 | storage per account (profiles they own plus their shares) |
| `--allow-origin` | `EH_ALLOW_ORIGIN` | * | CORS origin; requests are signed, so `*` is safe |
| `--log` | `EH_LOG=1` | off | log method, route and status (never bodies or addresses) |

A node for your family can stay `open` on a private Tailscale address. For a node on the public
internet, use `--registration code` and give the code to the people you host.

## What is stored

```
evolve-health-data/
  account/<id>.json        public keys, sealed keyring, storage used
  space/<id>.json          signed membership document (public keys, roles, wrapped keys)
  ops/<id>/<n>.json        encrypted, padded, signed operations
  blob/<id>/<hash>.bin     encrypted file chunks
  inbox/<account>/…        sealed invite replies (deleted once read)
  share/, sharedata/       sealed shares (deleted at expiry or when withdrawn)
```

Backing up the folder backs up ciphertext; restoring it on another machine works with the same address.
Expired shares are swept automatically. Owners can erase their profiles from the app, which deletes
them here.

## API

See [../docs/protocol.md](../docs/protocol.md). Everything is under `/v1/`; `GET /v1/info` identifies a node.
