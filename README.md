# ArchivePool

A self-hostable **community source pool** for [ArchiveTune](https://github.com/vossgraves/ArchiveTune).
People anonymously contribute Tidal/Qobuz API instances and accounts; the site health-checks them
on a schedule, auto-drops the dead/non-premium ones, and serves the surviving pool as JSON that the
app auto-discovers at runtime.

- **Public status page** (`/`) — aggregate health only, no secrets ever shown.
- **Anonymous submit** (`/submit`) — contribute an instance URL or account, no login. Tidal accounts
  can be added with one click via **Sign in with Tidal** (OAuth device flow — no password touches
  this site), or by pasting a token manually.
- **Machine JSON** — `/api/sources` and `/api/discovery/*` feed the app.
- **Automatic health checks** — a cron sweep disables entries after repeated failures and
  re-enables them if they recover.
- **Admin** (`/admin`) — guarded by a secret token: manage per-app read keys and hard-remove entries.

Built with Next.js 16 (App Router), Postgres via Drizzle ORM, and Tailwind. No ORM migrations tool
is required — a plain SQL schema is included.

---

## Quick start (local)

```bash
pnpm install                       # or npm install
cp .env.example .env.local         # then fill in the values (see below)
psql "$DATABASE_URL" -f scripts/schema.sql   # create the tables (run once)
pnpm dev                           # http://localhost:3000
```

You need a Postgres database. [Neon](https://neon.tech) has a free tier and works out of the box —
create a project and paste its connection string into `DATABASE_URL`.

## Environment variables

| Variable              | Required | Purpose                                                                                 |
| --------------------- | -------- | --------------------------------------------------------------------------------------- |
| `DATABASE_URL`        | yes      | Postgres connection string. Use a **pooled** one on serverless (see Deploy).             |
| `ADMIN_TOKEN_HASH`    | yes\*    | SHA-256 hash of the admin token for `/admin` + admin APIs. `TOKEN=$(openssl rand -base64 32); printf %s "$TOKEN" \| sha256sum`. Store only the hash, keep the token yourself. |
| `ADMIN_TOKEN`         | fallback\* | Legacy plaintext token, used only when `ADMIN_TOKEN_HASH` is unset. Prefer the hash.  |
| `CRON_SECRET`         | prod     | Secret the scheduled health check must present as `Authorization: Bearer`.               |
| `READ_KEYS_ENFORCED`  | recommended | `"true"` also requires a per-app key for `/api/discovery/*`; `/api/sources` always requires one. |
| `POOL_ENCRYPTION_KEY` | yes for accounts | base64 32-byte AES key. Encrypts credentials at rest in the DB. `openssl rand -base64 32`. |
| `POOL_CLIENT_KEY`     | yes for accounts | separate base64 32-byte AES key. `/api/sources` returns ciphertext; the app decrypts. |

\* Set exactly one of `ADMIN_TOKEN_HASH` / `ADMIN_TOKEN`. If neither is set, every admin route
returns 401 — it fails closed rather than opening up.

See `.env.example` for a copy-paste template.

## Credential encryption

Sensitive fields (Tidal/Qobuz tokens, Qobuz `appId`, usernames, notes, etc.) are encrypted with
AES-256-GCM in two independent layers. Non-sensitive fields such as an instance `baseUrl` stay in
the clear so discovery keeps working.

- **At rest** — set `POOL_ENCRYPTION_KEY`. Credentials are stored encrypted in the database, so a DB
  dump or backup leak exposes only ciphertext. The key never leaves the server.
- **End-to-end** — set `POOL_CLIENT_KEY`. `/api/sources` re-encrypts sensitive fields with this key,
  so anyone hitting the URL in a browser sees ciphertext. The response includes `"encrypted": true`,
  and blobs use the format `enc:1:<iv-b64>:<ciphertext+tag-b64>`. The ArchiveTune app ships the same
  key (its `POOL_CLIENT_KEY` build field) and decrypts locally.

Account submissions are rejected without the at-rest key. The credential feed returns HTTP 503
without the client key and HTTP 401 without a read key; it never falls back to plaintext or public
delivery. **Note:** a key embedded in a distributed app can be extracted by decompiling it — true
secrecy from app users requires proxying playback through the server so tokens never reach clients.

## Deploy to Vercel

1. Push this repo to your own GitHub, then "Import Project" on Vercel.
2. Set the environment variables from the table above in Project Settings → Environment
   Variables. `DATABASE_URL` must be a **pooled** connection string — serverless functions open a
   connection per invocation, so a direct (non-pooled) URL exhausts the database's connection
   limit. On Neon that is the `-pooler` host; on Supabase, the port-6543 transaction pooler.
3. Run the schema once against the production database: `psql "$DATABASE_URL" -f scripts/schema.sql`.
4. Set up the health sweep — see below. It is **not** automatic.

### Scheduling the health sweep

Without a scheduler nothing auto-disables dead sources, so this step is required.

`vercel.json` deliberately contains **no `crons` block**. Vercel's Hobby plan caps cron jobs at
once per day, and a more frequent expression there does not merely get throttled — it makes the
deployment fail outright. Once a day is far too coarse for a pool health sweep.

Use the included GitHub Actions workflows instead (`.github/workflows/health-cron.yml`, every 15
minutes, and `monochrome-cron.yml`, every 12 hours). They only `curl` a URL, so they work on any
host:

1. In this repo's **Settings → Secrets and variables → Actions**, add:
   - `HEALTH_URL` = your deployment's base URL (e.g. `https://archivepool.vercel.app`).
   - `CRON_SECRET` = the same value you set on the deployment.
2. Both can also be run manually from the Actions tab. Any external scheduler that sends
   `Authorization: Bearer <CRON_SECRET>` works too.

On a **Pro** plan you may instead add a native `crons` block to `vercel.json` — if you do, delete
these workflows so the sweep does not run twice.

## Deploy elsewhere (Fly, VPS, …)

The app runs anywhere Next.js does — `pnpm build` then `pnpm start` (the platform's `PORT` is
respected automatically). Set the same environment variables, run `scripts/schema.sql` once
against your database, and configure the same GitHub Actions scheduler described above.

## API

Public (no auth, CORS-open):

- `GET /api/status` — aggregate health per service/kind for the status page.

Pool JSON:

- `GET /api/sources` — encrypted account pool; always requires a read key.
- `GET /api/discovery/tidal` — Tidal instances in ArchiveTune's `{ streaming, api }` discovery shape.
- `GET /api/discovery/qobuz` — same for Qobuz.

Apps send read keys as `Authorization: Bearer <key>` (also accepted: `x-api-key: <key>`). Keys in
query strings are intentionally rejected because URLs are commonly logged.

Admin (require `Authorization: Bearer $ADMIN_TOKEN`):

- `GET /api/admin/keys` — list read keys.
- `POST /api/admin/keys` `{ "name": "..." }` — create a key (plaintext returned **once**).
- `DELETE /api/admin/keys?id=<id>` — revoke a key.
- `POST /api/admin/remove` — hard-remove a source entry.
- `GET /api/cron/health` — run a health sweep on demand.

## Read keys

The credential feed is always restricted. To provision the app and optionally restrict discovery:

1. Set `READ_KEYS_ENFORCED=true`.
2. Open `/admin`, enter your `ADMIN_TOKEN`, and create a key per app. Copy it immediately —
   only its hash is stored, so it is shown once.
3. Give the key to the app. For ArchiveTune, set it as the `SOURCE_PROVIDER_KEY` build secret
   (GitHub Actions secret) and point `SOURCE_PROVIDER_URL` at your deployment.

## Connecting ArchiveTune

In the ArchiveTune repo, set:

- Actions **variable** `SOURCE_PROVIDER_URL` = your deployment URL (e.g. `https://archivepool.vercel.app`).
- Actions **secret** `SOURCE_PROVIDER_KEY` = a read key from `/admin`.
- Actions **secret** `POOL_CLIENT_KEY` = the same client-delivery key configured on ArchivePool.

The app fetches `/api/discovery/tidal` and `/api/discovery/qobuz`, merges them with any of the
user's own instances, and health-checks before use. A blank URL/key simply disables discovery.

## Notes

- Payloads (tokens, credentials, instance URLs) are only exposed through the pool JSON endpoints —
  never on the public status page, which reports counts and health only.
- The health log is trimmed to ~30 days automatically.
- This project ships no license file; add one if you intend others to reuse it.
