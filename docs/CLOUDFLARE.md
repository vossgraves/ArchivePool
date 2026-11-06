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
| 100k requests/day | Exceeding it returns Cloudflare **Error 1027** (a Cloudflare error page, not the app's JSON `429`). The app's own feeds are tens of thousands/day; see *Rate limits* below. |
| 10 ms CPU/request | Reads are I/O-bound (Postgres, upstream fetches — wait time is unmetered). One hot spot: `scrypt` password verification (see *Known limits*). |
| 3 MiB compressed worker | Measured ~2.0 MiB (`pnpm build:cf`, then `gzip -c .open-next/server-functions/default/handler.mjs`). |
| 50 subrequests/request | Report path ≤ ~10; the sweep/instance sync are driven in `?batch=` slices (≤10 checks each) by GitHub Actions — see below. |
| Cron triggers | Not needed — the existing GitHub Actions crons keep driving `/api/cron/*` via `HEALTH_URL`. |
| Hyperdrive | **100,000 database statements/day on Free** — every `SELECT`, `INSERT`, `UPDATE`, `CREATE` and no-op `IF NOT EXISTS` counts; over the cap, statements fail (they are not throttled). Pooled TCP to Neon; `pg` connects to the `HYPERDRIVE` binding's in-colo endpoint over a Workers socket. This is the ceiling the pool reached first — see *Rate limits* below. |
| Workers KV | Free (1k writes / 100k reads / day, 25 MiB values). The `POOL_SNAPSHOTS` namespace replaces `@vercel/blob` for `pool/instances.json` — a few KB rewritten ~6×/day — and also holds `schema:applied` (one write per deploy) and `pool/status.json` (one write per sweep). Read-key identities stay out of KV: their cache lives in the per-colo Cache API so a shared build key cannot spend the 1k/day write budget. Chosen over R2: R2 activation needs a payment method on the account; KV does not. |
| R2 | Not needed — the snapshot lives in KV. |

## Rate limits: what was hit, and what this branch changes

Two independent limits both present as "rate limited", and they need different fixes.

### 1. Hyperdrive's 100,000 statements/day (the one that took the database down)

On 2026-11-06 the deployed Worker answered `GET /api/status` with
`503 {"error":"database_unavailable","detail":"Failed query: select … from account_entries …"}`
while `/api/accounts` (which rejects a missing key *before* any SQL) still answered `401`.
That isolates the failure to database statements, not requests, CPU or subrequests:

- Workers Free request quota returns Cloudflare **Error 1027** once exhausted, not a JSON 503.
- CPU exhaustion returns **1102**. Exceeding 50 subrequests fails the invocation.
- KV quota failures are caught by the snapshot read and fall back to SQL; they do not surface
  as a SQL error.
- `wrangler.jsonc` configures no D1, R2, Durable Object or rate-limit binding, and WAF rate
  limiting rules are not part of the Free plan.
- Hyperdrive Free's 100,000/day cap is the only configured Cloudflare limit where further
  **statements fail** rather than being throttled.

Before this branch, one day of ordinary traffic spent that budget on statements that did no
useful work:

| Path | Statements before | After |
|---|---|---|
| First request in every cold isolate | `ensureSchema()` ran **57** idempotent migrations (`globalThis` memo is per isolate, not global) | 1 KV read; 0 SQL after the version marker exists |
| Every discovery poll (`/api/instances/*`, `/api/discovery/*`) | key SELECT + `use_count` UPDATE = 2, plus a discovery SELECT on a snapshot miss | per-colo Cache API identity (1 SQL per key per colo per 5 min); 0 `use_count` writes; snapshot from KV |
| Legacy `/api/sources` lease | `stampLeases` ran one UPDATE per id (3 accounts + 10 instances) inside a transaction = 13 UPDATEs + BEGIN/COMMIT | one `UPDATE … FROM (VALUES …)` |
| `/api/status` miss | 4 statements (entry scans, uptime aggregate, 14-day history) | edge/KV snapshot; database only when the sweep's copy is absent/stale |
| Tidal lease refresh | up to 6 candidates refreshed concurrently (6 Tidal round trips) | bounded at 3 in flight |

The schema gate is the big one: 57 statements per cold isolate, across however many isolates
a global Worker gets in a day, is easily six figures on its own. The marker is written once
per schema version, and the route caches stop repeat polls from reaching SQL at all.

**Operator note:** after restoring or recreating the database, delete the `schema:applied` KV
key (or bump `SCHEMA_VERSION` in `lib/db/ensure.ts`) — otherwise the Worker will assume the
schema is already present. Any change to the statements array must bump `SCHEMA_VERSION`.

### 2. The app's own 429s were fleet-wide, not per client

`lib/rate-limit.ts` read only `x-forwarded-for` / `x-real-ip`. Cloudflare puts the peer in
`cf-connecting-ip` and does **not** add XFF to a Worker request, so every caller resolved to
the literal `"unknown"` and all clients shared one `feed-ip:` bucket per isolate. On top of
that, a build bakes one read key into every install, so `feed-key:<id>` at 30 leases / 5 min
capped the *whole fleet*, not one client — and 401 discovery polls still spent the IP bucket
before auth.

Changes:

- `clientIp()` reads `cf-connecting-ip` on Workers (XFF stays primary on Vercel/Railway,
  where the platform sets it; `cf-connecting-ip` is not trusted there, to avoid a spoofed
  bucket per request).
- Account/report key buckets are `key + client address` (60 leases / 5 min per client), with
  an **opt-in** per-key total (`POOL_KEY_FLEET_LIMIT`, default off). Leases are sticky per
  key for 72h, so a leaked key cannot walk the pool by rotating addresses anyway.
- Discovery limits are 120/min per real address, and the read-key check is cached per colo
  (including brief negative caching), so a broken build's 401 storm costs one SQL lookup per
  key per colo per 5 minutes, not one per launch.
- Every 429 carries `retry-after`; the database-unavailable 503 now carries
  `retry-after: 60` so a client can tell a temporary database problem from a host failover.
- Discovery responses when keys are enforced are `private, max-age=300` instead of
  `no-store` (the body is identical public instance URLs), and carry a weak `ETag` honouring
  `If-None-Match` → 304. That lets a client reuse a five-minute-old copy without a request.

Upstream provider 429s (Tidal's `abuse_detected`, a Qobuz/Deezer instance answering 429) are
already contained inside the health/refresh paths: they set a cooldown and are never returned
to a client as a `429`. They are not the limit the apps see.

### What to check in the Cloudflare dashboard

The maintainer needs the Cloudflare connector for these; the code cannot observe them:

- **Workers & Pages → archivepool → Metrics**: requests/day vs 100,000; Errors → Invocation
  Statuses (`exceededCpu` = 1102, subrequest failures).
- **Hyperdrive → archivepool-db**: queries/day vs 100,000. This should now be a small
  fraction of the old figure; if it is still exhausted, the deployed version is old or the
  schema marker was deleted against a schema that then re-ran.
- **Workers KV → POOL_SNAPSHOTS**: reads/writes per day vs 100k/1k.
- **Workers Logs** (or `wrangler tail`): the underlying SQL error text. Cloudflare's
  Hyperdrive-limit error is explicit there; the route only surfaces "Failed query".



```bash
# 1. Install deps (pnpm — the repo's package manager)
corepack pnpm install

# 2. KV namespace for the instance snapshot
pnpm exec wrangler kv namespace create archivepool-snapshots
#    (namespace id is already wired in wrangler.jsonc — POOL_SNAPSHOTS binding)

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
pnpm exec wrangler secret put GITHUB_CLIENT_ID       # Sign in with GitHub — see below
pnpm exec wrangler secret put GITHUB_CLIENT_SECRET
# Optional fallbacks/tuning:
# pnpm exec wrangler secret put DATABASE_URL        # only needed WITHOUT Hyperdrive
# vars (already in wrangler.jsonc): READ_KEYS_ENFORCED="true"
# optional var: POOL_DB_MAX_CONNECTIONS (default 3; keep ≤3 on Workers)
```

`BLOB_READ_WRITE_TOKEN` is **not** needed on Workers — the snapshot goes to KV.
`VERCEL_OIDC_TOKEN` is Vercel-only — not needed.

### GitHub OAuth App (web sign-in)

Web accounts sign in with GitHub instead of a password (scrypt cannot run inside the
free 10 ms CPU budget). Create one OAuth App under
https://github.com/settings/developers → "New OAuth App":

- **Homepage URL:** `https://<worker host>` (e.g. `https://archivepool.natune.workers.dev`
  or your custom domain).
- **Authorization callback URL:** `https://<worker host>/api/auth/github/callback`.
- Scope is the built-in `read:user` — nothing else to grant.

Then set the app's Client ID and generated Client Secret as the two
`wrangler secret put` values above. The flow costs two outbound fetches and a few
`crypto.subtle` HMAC/SHA-256 ops per callback — well inside the free request budget.
A first GitHub sign-in creates the account immediately — the username is derived
from the GitHub login (collisions get a suffixed variant; an existing legacy name is
never taken over) and there is no username prompt. Legacy (pre-GitHub) accounts are
recovered from the dashboard: the user proves ownership with one of the old account's
API keys (`POST /api/auth/claim-legacy`) and every per-user row — api_keys, same
hashes so apps keep working, and api_key_requests — moves to their GitHub account while
the legacy row is marked claimed+disabled. Without a key, GitHub-linked accounts file a
`github_claims` row for admin review (same transfer on approval). Deployments that
keep password login (non-Workers) get the same GitHub button alongside the password form.

## Deploy

```bash
# Build + deploy in one step — deploy:cf runs `pnpm build:cf` then
# `opennextjs-cloudflare deploy` (requires CLOUDFLARE_API_TOKEN or `wrangler login`).
# NEXT_PUBLIC_SITE_URL must be exported BEFORE the command: it is a build-time
# var — an env the deploy step alone sees would be too late.
NEXT_PUBLIC_SITE_URL=https://archivepool.natune.workers.dev pnpm deploy:cf
```

`NEXT_PUBLIC_SITE_URL` at **build** time keeps `metadataBase` correct for the
statically prerendered pages (it only affects OpenGraph/canonical URLs).

Then update the GitHub Actions secret `HEALTH_URL` to the worker URL
(`https://archivepool.natune.workers.dev`) — the health/monochrome/purge
workflows start driving the new deployment on their next run. No workflow changes
are needed; they already loop `?batch=` calls until `done`.

## Local preview

```bash
# .dev.vars holds the same secret names for `wrangler dev` (gitignored):
#   SESSION_SECRET=…, POOL_ENCRYPTION_KEY=…, POOL_CLIENT_KEY=…, ADMIN_TOKEN_HASH=…, CRON_SECRET=…,
#   GITHUB_CLIENT_ID=…, GITHUB_CLIENT_SECRET=…
# Hyperdrive in dev: wrangler.jsonc's localConnectionString points at localhost:5432 —
# set it to a local Postgres (or the Neon string for a read-only check).
pnpm preview:cf     # build + wrangler dev
curl http://localhost:8787/api/status
```

## What changed vs Vercel (behavior notes)

- **DB** — `pg` + drizzle unchanged; the pool is created lazily per isolate and
  prefers the `HYPERDRIVE` binding's connection string over `DATABASE_URL`
  (`lib/db/index.ts`). Per-isolate pool stays ≤ `POOL_DB_MAX_CONNECTIONS`.
- **Snapshot** — `POOL_SNAPSHOTS` KV namespace, same `pool/instances.json` key
  (value wraps `{savedAt, data}` — KV keeps no object metadata, so the 24 h TTL is
  checked from the payload plus a hard `expirationTtl`), same
  `snapshotCacheControl()` rules (`lib/edge-snapshot.ts`). The `@vercel/blob`
  path remains for Vercel deploys.
- **Sweep / instance sync** — unchanged logic; only sliced so a single request
  stays inside free-tier CPU/subrequest budgets (`app/api/cron/health?batch=N&cursor=…`,
  `app/api/cron/monochrome?feed=…&after=…&limit=N`). The sweep drains its stale list
  until N verdicts or 12 consumed rows (no-verdict skips still spend subrequests) and
  returns a `cursor` keyset so skipped prefixes cannot starve the tail — `remaining`/
  `done` stay truthful; feed slices keyset-paginate on the sorted URL list via
  `batch.nextAfter`. Under both caps sits a hard per-request fetch budget
  (`budgetedFetch`, 40 subrequests on Workers — redirect hops counted one by one) that
  trips inside the probe helpers; a
  verdict computed after it is discarded, the cursor ends before that row, and
  `budgetExhausted:true` marks the stop. Response bodies are additive: `attempted`,
  `cursor`, `remaining`, `done`, `budgetExhausted`, `batch{…}` — existing
  single-shot calls still work.
- **Purge cron** — unchanged (pure SQL, no subrequests).
- **Response shapes** — all public feeds identical; `s-maxage`/`swr` headers are
  still emitted. `workers.dev` subdomains don't CDN-cache worker responses, so
  `/api/status` relies on the in-isolate TTL cache until a custom domain + Cache
  Rules exist. Correctness unaffected.

## Known limits on the free tier

- **Web password login/signup are disabled on Workers — by design.** `scrypt(N=16384)`
  intentionally burns ~30–80 ms of CPU per verify — that is the brute-force defense, and
  the stored hashes cannot be verified cheaper, so on Workers `/api/auth/login` and
  `/api/auth/signup` fail fast: `503 {"error":"web_login_unavailable"}` pointing at
  GitHub sign-in (`webLoginDisabled()` in `lib/cf-env.ts`; scrypt itself is untouched
  and lives in `lib/passwords.ts`, lazy-imported so the Workers path never loads it).
  Browser sign-in uses GitHub OAuth (see above); admin-token (`sha256`) and
  session-cookie (`hmac`) auth are unaffected. To restore password login, move to
  Workers Paid ($5/mo, 30 s CPU) and set the `CF_WEB_LOGIN_ENABLED` var to `"true"` —
  no code change.
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
