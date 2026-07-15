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
| `DATABASE_URL`        | yes      | Postgres connection string.                                                             |
| `ADMIN_TOKEN`         | yes      | Bearer token for `/admin` + admin APIs. Generate: `openssl rand -base64 32`.            |
| `CRON_SECRET`         | prod     | Secret the scheduled health check must present. On Vercel Cron it is sent automatically.|
| `READ_KEYS_ENFORCED`  | no       | `"true"` requires a per-app read key for `/api/sources` and `/api/discovery/*`.         |

See `.env.example` for a copy-paste template.

## Deploy to Vercel

1. Push this repo to your own GitHub, then "Import Project" on Vercel.
2. Add a Postgres database (the Neon integration sets `DATABASE_URL` for you) and set
   `ADMIN_TOKEN` + `CRON_SECRET` in Project Settings → Environment Variables.
3. Run the schema once against the production database: `psql "$DATABASE_URL" -f scripts/schema.sql`.
4. The cron in `vercel.json` (`*/30 * * * *`) runs the health sweep automatically.

## Deploy elsewhere (Railway, Fly, VPS, …)

The app runs anywhere Next.js does — `pnpm build` then `pnpm start` (the platform's `PORT` is
respected automatically). Set the same environment variables as above and run
`scripts/schema.sql` once against your database.

**Important:** `vercel.json` cron only runs on Vercel. On other hosts the health sweep will not
fire on its own, so nothing auto-disables dead sources. Trigger it externally instead — a ready-made
GitHub Action is included at `.github/workflows/health-cron.yml`:

1. In this repo's **Settings → Secrets and variables → Actions**, add:
   - `HEALTH_URL` = your deployment's base URL (e.g. `https://archivepool.up.railway.app`).
   - `CRON_SECRET` = the same value you set on the deployment.
2. The workflow pings `GET /api/cron/health` every 15 minutes (and can be run manually from the
   Actions tab). Any external scheduler that sends `Authorization: Bearer <CRON_SECRET>` works too.

## API

Public (no auth, CORS-open):

- `GET /api/status` — aggregate health per service/kind for the status page.

Pool JSON (open by default; requires a read key when `READ_KEYS_ENFORCED=true`):

- `GET /api/sources` — the full active pool.
- `GET /api/discovery/tidal` — Tidal instances in ArchiveTune's `{ streaming, api }` discovery shape.
- `GET /api/discovery/qobuz` — same for Qobuz.

When gating is on, apps send the key as `Authorization: Bearer <key>` (also accepted:
`x-api-key: <key>`).

Admin (require `Authorization: Bearer $ADMIN_TOKEN`):

- `GET /api/admin/keys` — list read keys.
- `POST /api/admin/keys` `{ "name": "..." }` — create a key (plaintext returned **once**).
- `DELETE /api/admin/keys?id=<id>` — revoke a key.
- `POST /api/admin/remove` — hard-remove a source entry.
- `GET /api/cron/health` — run a health sweep on demand.

## Read keys (optional gating)

By default the pool JSON is public. To restrict it to specific apps:

1. Set `READ_KEYS_ENFORCED=true`.
2. Open `/admin`, enter your `ADMIN_TOKEN`, and create a key per app. Copy it immediately —
   only its hash is stored, so it is shown once.
3. Give the key to the app. For ArchiveTune, set it as the `SOURCE_PROVIDER_KEY` build secret
   (GitHub Actions secret) and point `SOURCE_PROVIDER_URL` at your deployment.

## Connecting ArchiveTune

In the ArchiveTune repo, set:

- Actions **variable** `SOURCE_PROVIDER_URL` = your deployment URL (e.g. `https://archivepool.vercel.app`).
- Actions **secret** `SOURCE_PROVIDER_KEY` = a read key from `/admin` (only needed if you enabled gating).

The app fetches `/api/discovery/tidal` and `/api/discovery/qobuz`, merges them with any of the
user's own instances, and health-checks before use. A blank URL/key simply disables discovery.

## Notes

- Payloads (tokens, credentials, instance URLs) are only exposed through the pool JSON endpoints —
  never on the public status page, which reports counts and health only.
- The health log is trimmed to ~30 days automatically.
- This project ships no license file; add one if you intend others to reuse it.
