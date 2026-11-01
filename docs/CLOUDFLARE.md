<!-- SPDX-License-Identifier: GPL-3.0-or-later -->
# Deploying to Cloudflare Workers (free tier)

This app runs on Cloudflare Workers via **OpenNext for Cloudflare**
(`@opennextjs/cloudflare@1.20.1` — the last adapter line whose peer range accepts
`next@16.2.6`; `>=1.20.2` wants a newer Next). It keeps every route and response
shape identical, and it coexists with the Vercel/Railway paths — nothing in this
file changes how the app runs anywhere else.

## Why it fits the free tier

| Limit | This app |
|---|---|
| 100k requests/day | ~2,000 reports/day + feeds/status ≈ tens of thousands — headroom. |
| 10 ms CPU/request | Reads are I/O-bound (Postgres, upstream fetches — wait time is unmetered). One hot spot: `scrypt` password verification (see *Known limits*). |
| 3 MiB compressed worker | Measured ~2.0 MiB (`pnpm build:cf`, then `gzip -c .open-next/server-functions/default/handler.mjs`). |
| 50 subrequests/request | Report path ≤ ~10; the sweep/instance sync are driven in `?batch=` slices (≤10 checks each) by GitHub Actions — see below. |
| Cron triggers | Not needed — the existing GitHub Actions crons keep driving `/api/cron/*` via `HEALTH_URL`. |
| Hyperdrive | Free. Pooled TCP to Neon; `pg` connects to the `HYPERDRIVE` binding's in-colo endpoint over a Workers socket. |
| R2 | Free (10 GB). The `POOL_SNAPSHOTS` bucket replaces `@vercel/blob` for `pool/instances.json`. |
| KV | Not needed — snapshot lives in R2, rate limits stay in-isolate (same semantics as Vercel warm instances). |

## One-time setup

```bash
# 1. Install deps (pnpm — the repo's package manager)
corepack pnpm install

# 2. R2 bucket for the instance snapshot
pnpm exec wrangler r2 bucket create archivepool-snapshots
#    (bucket name is already wired in wrangler.jsonc — POOL_SNAPSHOTS binding)

# 3. Hyperdrive over the existing Neon database
#    Use the same pooled DATABASE_URL Vercel has (Neon "-pooler" host).
pnpm exec wrangler hyperdrive create archivepool-db \
  --connection-string="<DATABASE_URL>"
# → prints an id like 0f1a2b3c… — paste it into wrangler.jsonc:
#   hyperdrive[0].id = "0f1a2b3c…"

# 4. Secrets (values come from the Vercel env — copy them over, never commit them)
pnpm exec wrangler secret put SESSION_SECRET
pnpm exec wrangler secret put POOL_ENCRYPTION_KEY
pnpm exec wrangler secret put POOL_CLIENT_KEY
pnpm exec wrangler secret put ADMIN_TOKEN_HASH      # preferred
# pnpm exec wrangler secret put ADMIN_TOKEN         # legacy fallback — only if no hash
pnpm exec wrangler secret put CRON_SECRET
# Optional fallbacks/tuning:
# pnpm exec wrangler secret put DATABASE_URL        # only needed WITHOUT Hyperdrive
# vars (already in wrangler.jsonc): READ_KEYS_ENFORCED="true"
# optional var: POOL_DB_MAX_CONNECTIONS (default 3; keep ≤3 on Workers)
```

`BLOB_READ_WRITE_TOKEN` is **not** needed on Workers — the snapshot goes to R2.
`VERCEL_OIDC_TOKEN` is Vercel-only — not needed.

## Deploy

```bash
# Build + deploy in one step — deploy:cf runs `pnpm build:cf` then
# `opennextjs-cloudflare deploy` (requires CLOUDFLARE_API_TOKEN or `wrangler login`).
# NEXT_PUBLIC_SITE_URL must be exported BEFORE the command: it is a build-time
# var — an env the deploy step alone sees would be too late.
NEXT_PUBLIC_SITE_URL=https://archivepool.<subdomain>.workers.dev pnpm deploy:cf
```

`NEXT_PUBLIC_SITE_URL` at **build** time keeps `metadataBase` correct for the
statically prerendered pages (it only affects OpenGraph/canonical URLs).

Then update the GitHub Actions secret `HEALTH_URL` to the worker URL
(`https://archivepool.<subdomain>.workers.dev`) — the health/monochrome/purge
workflows start driving the new deployment on their next run. No workflow changes
are needed; they already loop `?batch=` calls until `done`.

## Local preview

```bash
# .dev.vars holds the same secret names for `wrangler dev` (gitignored):
#   SESSION_SECRET=…, POOL_ENCRYPTION_KEY=…, POOL_CLIENT_KEY=…, ADMIN_TOKEN_HASH=…, CRON_SECRET=…
# Hyperdrive in dev: wrangler.jsonc's localConnectionString points at localhost:5432 —
# set it to a local Postgres (or the Neon string for a read-only check).
pnpm preview:cf     # build + wrangler dev
curl http://localhost:8787/api/status
```

## What changed vs Vercel (behavior notes)

- **DB** — `pg` + drizzle unchanged; the pool is created lazily per isolate and
  prefers the `HYPERDRIVE` binding's connection string over `DATABASE_URL`
  (`lib/db/index.ts`). Per-isolate pool stays ≤ `POOL_DB_MAX_CONNECTIONS`.
- **Snapshot** — `POOL_SNAPSHOTS` R2 bucket, same `pool/instances.json` key, same
  24 h TTL and `snapshotCacheControl()` rules (`lib/edge-snapshot.ts`). The
  `@vercel/blob` path remains for Vercel deploys.
- **Sweep / instance sync** — unchanged logic; only sliced so a single request
  stays inside free-tier CPU/subrequest budgets (`app/api/cron/health?batch=N`,
  `app/api/cron/monochrome?feed=…&after=…&limit=N`). The sweep drains its stale list
  until N real checks ran — rows skipped without a verdict (refresh cooling) are passed
  over inside the call, so `remaining`/`done` stay truthful; feed slices keyset-paginate
  on the sorted URL list via `batch.nextAfter`. Response bodies are additive:
  `attempted`, `remaining`, `done`, `batch{…}` — existing single-shot calls still work.
- **Purge cron** — unchanged (pure SQL, no subrequests).
- **Response shapes** — all public feeds identical; `s-maxage`/`swr` headers are
  still emitted. `workers.dev` subdomains don't CDN-cache worker responses, so
  `/api/status` relies on the in-isolate TTL cache until a custom domain + Cache
  Rules exist. Correctness unaffected.

## Known limits on the free tier

- **Web login/signup are disabled on Workers — by design.** `scrypt(N=16384)`
  intentionally burns ~30–80 ms of CPU per verify — that is the brute-force defense, and
  the stored hashes cannot be verified cheaper, so on Workers `/api/auth/login` and
  `/api/auth/signup` fail fast: `503 {"error":"web_login_unavailable"}`
  (`webLoginDisabled()` in `lib/cf-env.ts`; scrypt itself is untouched). Admin-token
  (`sha256`) and session-cookie (`hmac`) auth are unaffected, and the dashboard pages
  simply surface the 503. To restore web login, move to Workers Paid ($5/mo, 30 s CPU)
  and set the `CF_WEB_LOGIN_ENABLED` var to `"true"` — no code change.
- **First request on a cold isolate** pays one TCP+SCRAM handshake per new pool
  connection (a few ms CPU) — Hyperdrive keeps this rare by pooling upstream.
- **`use_count`/`last_login` best-effort writes** ride `ctx.waitUntil` on Workers —
  same best-effort semantics as the floating writes they replace.
- **`@vercel/analytics`** still renders on pages; its beacon endpoint does not
  exist off-Vercel so it silently no-ops.

## Rollback / cutover

The Vercel deployment can later 308-redirect to the worker URL (a redirect-only
deploy lives on branch `chore/vercel-redirect`). Caveat: Ktor/OkHttp clients may
not auto-follow a 308 on `POST` — cut the app's `POOL_BASE_URL` over at the client
rather than relying on redirects for `/api/report` and other POSTs.
