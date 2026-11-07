# ArchivePool API

Base URL for the public deployment: `https://archivepool.natune.workers.dev`

The old `https://archivepool.vercel.app` origin answers `402 DEPLOYMENT_DISABLED` and is kept
only as a last-resort client fallback; do not treat it as a second live deployment.

ArchivePool is a community source pool for ArchiveTune. People anonymously contribute
Tidal/Qobuz/Deezer credentials and instances; the site health-checks them on a schedule and
serves the survivors as JSON that the ArchiveTune app consumes at runtime.

All responses are JSON. Public endpoints send `access-control-allow-origin: *` so the app can
call them directly from Android.

---

## Authentication model

Three distinct credentials exist. They never overlap:

| Credential | Env var on the server | Purpose |
|---|---|---|
| Read key | `api_keys` table (only the SHA-256 hash is stored) | Reading the credential feed `/api/sources`, optionally `/api/discovery/*` |
| Admin token | `ADMIN_TOKEN_HASH` (SHA-256 of the token) | `/admin` page + admin APIs |
| Cron secret | `CRON_SECRET` | Scheduled health sweeps (`/api/cron/*`) |

Keys/tokens are sent as `Authorization: Bearer <secret>`. `x-api-key: <secret>` is also
accepted for read keys. Query-string keys are **intentionally rejected** — URLs get logged.

### Web sign-in (GitHub OAuth)

Browser sign-in uses GitHub OAuth (password sign-in returns `503 web_login_unavailable`
on Workers — scrypt cannot fit the free-tier CPU budget — and its error text points here):

- `GET /api/auth/github/start` — state + PKCE verifier in a short-lived signed HttpOnly
  cookie, then a redirect to `github.com/login/oauth/authorize` (`scope=read:user`).
- `GET /api/auth/github/callback` — verifies the state cookie, exchanges the code
  (PKCE), reads the numeric id + login from `/user`, signs in a known `github_id`, or
  issues a 10-minute signed "pending" cookie and sends the browser to choose a username.
- `POST /api/auth/github/complete` — `{ "username" }` creates a new account for the
  pending GitHub identity (username must be free; same rules as sign-up usernames).
- `POST /api/auth/github/claim` — claims an EXISTING username. With
  `{ "username", "apiKey" }`, the key's SHA-256 hash must match an `api_keys` row owned
  by that account — possessing the account's own key is the ownership proof — then
  `github_id` links to it and the old keys keep working unchanged for apps. With just
  `{ "username" }` a pending row lands in `github_claims` for admin review
  (`GET /api/admin/claims`, `POST /api/admin/claims/{id}` with `approve`/`reject`).

Sessions are the same HMAC-signed `atp_session` cookie as before (signed via
`crypto.subtle` on this path). `GITHUB_CLIENT_ID`/`GITHUB_CLIENT_SECRET` must be set —
the routes answer `503 github_auth_unconfigured` otherwise.

Read-key enforcement is controlled by the `READ_KEYS_ENFORCED` env var:

- unset or `"false"` — `/api/sources` and `/api/discovery/*` are open (no key required);
  any presented key still works if it is valid.
- `"true"` — every credential/discovery request must present a valid, non-revoked read key,
  otherwise the route answers `401`.
- `SET` and `DELETE` on the feed and admin routes always require the relevant credential
  regardless of the flag. An unset admin credential fails closed (`401` on every admin route).

---

## Public status (no auth)

### `GET /api/status`

Aggregate, credential-free health for the public status page. Never contains secrets.

Response — one object per category (Tidal API, Tidal Account, Qobuz API, Qobuz Account,
Deezer API, Deezer Account, Apple Music Account, Amazon Music API, Amazon Music Account):

```json
{
  "generatedAt": "2026-08-20T16:48:55.110Z",
  "categories": [
    {
      "service": "tidal",
      "kind": "api",
      "label": "Tidal API",
      "total": 0,
      "alive": 0,
      "premium": 0,
      "dead": 0,
      "pending": 0,
      "uptimePct": null,
      "lastCheckedAt": null,
      "health": "unknown"
    }
  ]
}
```

- `health`: `operational` (alive + premium), `degraded` (alive, no premium), `down`
  (entries exist but none alive), `unknown` (no entries).
- `uptimePct`: rolling pass rate of scheduled checks, or `null` before the first check.
- Caching: `public, s-maxage=60, stale-while-revalidate=300`.

A `history` object accompanies `categories`, holding one point per day for the window
`health_log` retains (14 days — the sweep prunes at 30):

```json
{
  "history": {
    "days": 14,
    "overall": [
      { "day": "2026-09-13", "label": "13 Sep", "checks": 48, "ok": 47, "pct": 97.9, "partial": true }
    ],
    "categories": [
      { "service": "tidal", "kind": "account", "points": [] }
    ]
  }
}
```

`pct` is `null` for a day nothing was checked, which is not the same as a day everything failed,
and `partial` marks today's still-accumulating bucket. The field is additive: it is computed
separately from `categories` and degrades to empty arrays if the aggregate fails, so a client that
predates it is unaffected.

```bash
curl https://archivepool.vercel.app/api/status
```

---

## Credential feed (read key, or open when `READ_KEYS_ENFORCED=false`)

### `GET /api/sources`

The full pool as the app consumes it. Leases **up to 3 entries per category**
(`LEASE_PER_CATEGORY`) rather than the whole pool: selection is premium-first, then
least-recently-leased, and the server stamps `last_leased_at` so rotation advances across
requests. `apis` carries instance URLs for every service that has an instance tier: Tidal, Qobuz,
Deezer and Amazon Music (its instances answer `GET {baseUrl}/health`; Deezer ones answer
`GET {baseUrl}/health` too, with either an `{ok,user}` or an `{ok,accounts}` document). Apple Music
is the only `apis` list that is always empty — it has no self-hosted instance tier.

For **account** entries, this is also a sticky per-key lease: a resolved read key (its `api_keys`
row id) keeps the same entries across repeated fetches for 72h (`LEASE_TTL_HOURS`) rather than
rotating on every request, so a leaked key only ever sees its own small window instead of walking
the whole pool over enough fetches. `POST /api/report` releases a key's lease on an entry it
reports dead/not_premium and can hand back a replacement — see below.

```json
{
  "version": 1,
  "generatedAt": "2026-08-20T16:49:01.493Z",
  "encrypted": true,
  "tidal":   { "apis": [], "accounts": [] },
  "qobuz":   { "apis": [], "accounts": [] },
  "deezer":  { "apis": [], "accounts": [] }
}
```

Account entries carry the fields the app needs per service:

- Tidal: `token`, `refreshToken?`, `countryCode?`, `premium`
- Qobuz: `token`, `appId`, `appSecret`, `premium`
- Deezer: `arl`, `masterSecret?`, `premium`
- Amazon Music: `session`, `premium`, plus `bypassToken?` and `turnstileJwt?` / `turnstileJwtExpiresAt?`
  when the contributor pooled the instance auth material alongside the account

plus `id`, `status`, `latencyMs`, `lastCheckedAt`. When `encrypted` is `true`, every
sensitive field is ciphertext (see [Encryption](#encryption)).

```bash
curl -H 'Authorization: Bearer atp_...' https://archivepool.vercel.app/api/sources
```

Errors:

| Status | Meaning |
|---|---|
| `401` | Read key missing/invalid while enforcement is on |
| `503` | `POOL_CLIENT_KEY` not configured — credential delivery is disabled by design (`security_not_configured`) |

Caching: `private, no-store` (responses are per-key and per-lease).

---

## Discovery feeds (read key when enforced, else open)

### `GET /api/discovery/tidal`
### `GET /api/discovery/qobuz`

Verified instance base URLs in the `{ streaming, api }` shape the ArchiveTune app's
`discoverInstances()` parser consumes. `streaming` is the preferred audio-serving list;
`api` mirrors it. Only `alive`/`preview` instances appear, deduplicated, premium first.

```json
{
  "streaming": ["https://instance.example"],
  "api": ["https://instance.example"]
}
```

On a database failure the route degrades to an empty feed (`{ "streaming": [], "api": [] }`)
so the app treats it as "no contributed instances" rather than crashing.

### `GET /api/instances/amazon-music`

Same route and shape (`GET /api/instances/{service}`, key-gated when `READ_KEYS_ENFORCED=true`),
for Amazon Music instances. The URLs are verified differently from a Tidal/Qobuz restream: an
Amazon instance publishes its own liveness document at `GET {baseUrl}{healthPath || "/health"}`,
which must answer HTTP 2xx with a JSON object whose `status` is not an error value. Premium is read
from the same hi-res markers as everywhere else — from `probeUrl` when the contributor gave one,
otherwise from the health body.

Auth material for those instances (`bypassToken`, or a pre-minted `turnstileJwt` with
`turnstileJwtExpiresAt`) never appears in this feed: it travels on the entry and is delivered only
through the credential feed, encrypted like every other credential.

### `GET /api/instances/deezer`

Same route and shape, for Deezer instances (`GET {baseUrl}/health` unless the contributor set a
`healthPath`). A Deezer instance also publishes its own liveness document, but in one of two
community shapes: Ultra MAX (`github.com/PaRaN01a-hash/ultramax-music`) answers
`{"ok":true,"user":{…}}` and fails with `{"ok":false,"error":…}`; the Monochrome Deezer fallback
host answers `{"ok":bool,"accounts":{"total","available","dead","cooling",…},…}`. The pool reads
the verdict from the document: an explicit `ok:false` is dead, and so is an `accounts` block with
nothing available or cooling. Premium is read from the same hi-res markers as everywhere else —
from `probeUrl` when the contributor gave one, otherwise from the health body.

Deezer instances are per-user in the wild (Ultra MAX authenticates with the caller's own ARL), so
the pool ships no seed list for this tier beyond the host shape it verifies: instances arrive as
contributed submissions, and are served only after that liveness check.

---

## Scheduled jobs (cron secret)

### `GET /api/cron/health`

Runs one health sweep and republishes the instance snapshot. Used by the GitHub Actions
workflow in this repo every 6 hours.

```json
{ "ok": true, "checked": 0, "skipped": 0, "starved": 0, "disabled": 0, "reenabled": 0, "remaining": 0, "done": true, "ranAt": "..." }
```

Optional `?batch=N&cursor=C` (N: 1–10, default 8) runs at most N real checks — and
at most min(2N, 12) consumed rows — per call for hosts with a per-request budget
(Cloudflare Workers free tier). Consumed counts rows whose check is skipped without a
verdict (refresh cooling, a lost claim), because a bail-out can still spend upstream
fetches. `cursor` in the response is the keyset of the last consumed row; pass it back as
`cursor=` so a skipped prefix cannot head every batch and starve the tail. A per-request
outbound-fetch budget (40 on Workers, unlimited elsewhere) can stop a call earlier —
`budgetedFetch` charges every probe including each redirect hop — when `budgetExhausted`
is true the cursor already ends before the cut-off row, so the same loop just resumes it
with a fresh budget; a verdict computed after the budget tripped is never persisted.
Each row additionally has a 24-fetch ceiling: a batch only starts a row when the
request still holds a full ceiling, and a row that burns through it is reported as a
consumed no-verdict skip under `starved` (no dead verdict, no cooldown) — the cursor
moves past it, so one pathological entry can never starve the queue.
`attempted`
counts the stale rows consumed, `remaining` the ones still waiting after the cursor;
`done` is true when `remaining` is 0, and only the finishing call republishes the
snapshot. The scheduled workflow loops until `done:true`. Called without `batch`, the
whole sweep still runs in one request.

### `GET /api/cron/monochrome`

Runs the monochrome (Tidal/Qobuz proxy) instance sync without the full sweep.

Batched mode for request-budgeted hosts:

- `?feed=NAME` — `monochrome`, `spotiflac-tidal` or `spotiflac-qobuz`; one feed per call.
- `&after=URL&limit=N` — keyset slice of that feed's sorted candidate list (limit
  1–10, default 8). The response's `batch` object carries
  `{ total, after, nextAfter, done, budgetExhausted }`; repeat with
  `after=<batch.nextAfter>` until `done` — `budgetExhausted:true` slices resume at the
  first unfinished candidate (a fetch-budget cut-off is never written as a verdict).
  Keyset (not offset) is deliberate: the live feed is refetched per call, and a >-cursor over
  the sorted set converges even when its membership shifts mid-sweep.
- `?publish=1` — republish the instance snapshot once every feed has drained (the workflows
  call it after their feed loops). No parameters: the whole sync still runs in one request.

### `GET /api/cron/purge-dead`

Soft-removes entries that have been unservable for at least 7 days: `dead` or `disabled`,
older than the grace window, and with no `ok && premium` row in `health_log` inside it. This
is the scheduled form of `POST /api/admin/purge-dead` — same `removed = true` semantics, same
`entry.purge_dead` audit action (actor `cron`), just bounded so a transient outage cannot
empty the pool. Idempotent: the eligibility predicate is the UPDATE's WHERE clause, so a second
run in the same window removes nothing. The response reports the real counts:

```json
{ "ok": true, "removed": 0, "removedAccounts": 0, "removedInstances": 0, "graceDays": 7, "ranAt": "..." }
```

All accept the admin token as an alternative credential so they stay manually triggerable.
`maxDuration` is 60s.

```bash
curl -H 'Authorization: Bearer <CRON_SECRET>' \
  https://archivepool.vercel.app/api/cron/health
```

---

## Admin (admin token)

All admin routes require `Authorization: Bearer <admin token>` and fail closed
(`401`) when the credential is unset, malformed, or wrong. Verification is constant-time
(SHA-256 + `timingSafeEqual`).

### `GET /api/admin/keys` — list read keys

```json
{ "keys": [ { "id": 1, "name": "ArchiveTune", "prefix": "atp_ab12cd", "revoked": false, "useCount": 7, "lastUsedAt": "..." } ] }
```

Hashes are never returned.

### `POST /api/admin/keys` — create a read key

Request: `{ "name": "ArchiveTune" }` — key prefix `atp_` + 48 hex chars.

Response (plaintext shown exactly once):

```json
{ "ok": true, "id": 1, "key": "atp_...", "prefix": "atp_ab12cd" }
```

### `PATCH /api/admin/keys` — revoke / restore

Request: `{ "id": 1, "revoked": false }` (defaults to revoking).

### `GET /api/admin/remove` — raw source table (no payloads)

Admin-only diagnostic listing. `payload` (the credential) is deliberately never returned;
only masked labels and health metrics.

### `POST /api/admin/remove` — hard-remove an entry

Request: `{ "id": 42 }` → `{ "ok": true, "id": 42, "removed": true }`. Also accepts the
entry's `fingerprint`.

### `POST /api/admin/check-entry` — re-check one entry

Request: `{ "id": 42 }` → `{ "ok": true, "result": { ... } }`. `404` when unknown.

### `GET /api/admin/claims` — pending GitHub username claims

### `POST /api/admin/claims/{id}` — review a claim: `{ action: "approve" }` links the
claimed `github_id` to the existing account; `{ action: "reject", note }` needs a
≥10-char note. Audited like key-request reviews.

### `POST /api/admin/force-check` — full sweep + monochrome sync now

```json
{ "ok": true, "sweep": { ... }, "monochrome": { ... }, "ranAt": "..." }
```

### `POST /api/admin/purge-dead` — soft-remove every `dead` entry

```json
{ "ok": true, "removed": 3 }
```

### `POST /api/admin/purge-entry` — destroy the credentials of a removed entry

Request: `{ "id": 42, "mode": "payload" }`. `mode` is `payload` (default: blank the stored payload,
keep the row for the Removed tab) or `row` (delete the row). `409` unless the entry is already
removed, `404` when unknown. Irreversible; audited as `entry.purge`.

---

## App feedback (open when `READ_KEYS_ENFORCED=false`)

### `POST /api/report`

Apps report what they observed at playback time, so dead or wrongly-flagged entries stop being
leased without waiting for the next sweep — and without apps hammering the pool's database
re-checking every credential.

Request (`Authorization: Bearer <read key>` when enforcement is on; open otherwise):

```json
{ "service": "deezer", "kind": "account", "id": 42, "report": "dead" }
```

- `report: "dead"` — the credential refused playback (expired ARL, revoked token). The pool
  re-checks it live first: a healthy entry keeps serving (the app's cached copy was stale), a
  failing one is demoted to `pending`, and after 3 failures it is disabled and no longer served.
  The sweep re-verifies and can re-enable it.
- `report: "not_premium"` — the credential works but lacks the premium tier the pool believed it
  had. The pool re-checks it live and disables the entry only when the provider confirms it; a
  report the check cannot confirm is ignored (`ignored: "not_premium"`).

Target by `id` (from `/api/sources`/`/api/accounts`) or `fingerprint`. On a `dead`/`not_premium`
report against an **account** entry, if the reporting key actually held a per-key lease on that
entry (see the sticky-lease note under
[Credential feed](#credential-feed-read-key-or-open-when-read_keys_enforcedfalse) above — i.e.
the key really received this credential from `/api/accounts`), that lease is released and one
replacement credential is drawn and returned in the same shape `/api/accounts` uses, capped at 3
replacements/hour/service/key. Reporting an id the key never leased still updates the entry's
status as described above — reports remain a side channel anyone with a valid (or, when
enforcement is off, no) key can contribute to — it just never earns a replacement, which is what
stops a report loop over arbitrary ids from harvesting the pool.

```json
{
  "ok": true,
  "id": 42,
  "encrypted": true,
  "encryption": "read-key",
  "replacement": {
    "deezer": { "accounts": [ { "id": 57, "premium": true, "status": "alive", "arl": "enc:1:…" } ] }
  }
}
```

`replacement` is `null` (report still `ok: true`) when: the report targeted an instance rather
than an account, the caller has no read key resolved (open deployments with `READ_KEYS_ENFORCED`
off and no key presented), the hourly cap was hit, or nothing else in the pool qualified.

Responses: `200 { ok, id, encrypted, encryption, replacement }`, `400` invalid body/service/kind/
report, `404` unknown entry, `401` key required and invalid.

```bash
curl -X POST -H 'Content-Type: application/json' \
  -d '{"service":"deezer","kind":"account","id":42,"report":"dead"}' \
  https://archivepool.vercel.app/api/report
```

## Submissions

Submissions are handled by the web UI (`/submit`) through a Next.js server action
(`app/actions/submit.ts`), not a public REST route — this keeps rate limiting and
validation server-side. The `/submit` page supports:

- **Tidal accounts** — one-click **Sign in with Tidal** (OAuth device flow via
  `/api/tidal/device/start` + `/api/tidal/device/poll`), or pasting a token manually.
- **Qobuz accounts** — username/password login proxied through `/api/qobuz/login`, or
  pasting an appId/token pair. Password sign-in **retains the credential** (encrypted at rest
  inside the pool record, and never returned by any endpoint) so the pool can re-login and
  renew the account itself: a Qobuz `user_auth_token` has no refresh endpoint, so a
  token-only contribution is a one-shot that dies the first time Qobuz invalidates it.
  Token-only submissions have nothing to renew with and are checked as before.
- **Deezer accounts** — pasting an `arl` cookie.
- **API instances** — a `baseUrl` for Tidal/Qobuz restream instances, and for Deezer instances,
  which are verified against their own `/health` document (see `/api/instances/deezer`).
- **Amazon Music instances** — a `baseUrl` verified against that instance's own `/health`
  document, with optional instance auth material: the operator's `bypassToken`, or a pre-minted
  `turnstileJwt` plus its `turnstileJwtExpiresAt`.

Manual submissions are verified immediately; automatic sweeps re-check them on the
schedule. `POST /api/qobuz/login` exists as a JSON route used by the submit form
(`{ "username", "password" }` → `{ "appId", "token", ... }`); it validates against Qobuz
and returns `400`/`401` on missing or bad credentials.

---

## Encryption

Sensitive fields (`token`, `appId`, `appSecret`, `arl`, `masterSecret`, `refreshToken`,
passwords, usernames, cookies, email, `session`, `bypassToken`, `turnstileJwt`, etc.) are
encrypted in two independent AES-256-GCM layers. Keys are base64-encoded 32-byte values
(`openssl rand -base64 32`).

- **At rest** — `POOL_ENCRYPTION_KEY`, server-side only. Rows in `source_entries.payload`
  are ciphertext, so a database dump leaks nothing. Losing this key makes stored
  credentials unrecoverable.
- **End-to-end** — `POOL_CLIENT_KEY`. `/api/sources` re-encrypts sensitive fields with it
  before responding (`"encrypted": true`), so even a browser hitting the URL sees
  ciphertext. The ArchiveTune app ships the same key (build field `POOL_CLIENT_KEY`) and
  decrypts locally. The feed fails closed (`503`) without it; it never falls back to
  plaintext delivery.

Wire format (colon-delimited, all base64):

```
enc:1:<12-byte IV>:<ciphertext + 16-byte GCM tag>
```

Decrypting one field (Java/Kotlin — what the app does):

```kotlin
val key = Base64.decode(BuildConfig.POOL_CLIENT_KEY, Base64.DEFAULT) // 32 bytes
val parts = blob.removePrefix("enc:1:").split(":")
val iv = Base64.decode(parts[0], Base64.DEFAULT)
val data = Base64.decode(parts[1], Base64.DEFAULT)
val cipher = Cipher.getInstance("AES/GCM/NoPadding")
cipher.init(Cipher.DECRYPT_MODE, SecretKeySpec(key, "AES"), GCMParameterSpec(128, iv))
val plaintext = String(cipher.doFinal(data), Charsets.UTF_8)
```

Non-sensitive fields such as instance `baseUrl` stay in the clear so discovery keeps
working.

---

## ArchiveTune integration

The app is wired via four build-time fields (see `app/build.gradle.kts`):

| Field | Source | Purpose |
|---|---|---|
| `SOURCE_PROVIDER_URL` | CI variable, else baked default `https://archivepool.vercel.app` | Base URL for `/api/sources` + `/api/discovery/*` |
| `SOURCE_PROVIDER_KEY` | CI secret, optional | Read key presented as `Bearer` (unused while the pool runs unenforced) |
| `POOL_CLIENT_KEY` | CI secret, optional | Decrypts `enc:1:` payloads from `/api/sources` |

In this repo's GitHub Actions (secrets/variables):

- `SOURCE_PROVIDER_URL` variable = `https://archivepool.vercel.app`
- `POOL_CLIENT_KEY` secret = the same base64 key configured as the site's `POOL_CLIENT_KEY`
- `SOURCE_PROVIDER_KEY` secret = a read key from the admin page (only needed if
  `READ_KEYS_ENFORCED=true`)

App consumption:

- `PoolAccountManager.refresh()` GETs `/api/sources`, decrypts with `PoolCrypto`
  (`BuildConfig.POOL_CLIENT_KEY`), caches per-service lists, and persists them to DataStore
  so accounts survive cold starts. HTTP `401` is logged explicitly as a read-key problem;
  any non-2xx keeps the previous cache.
- `QobuzAudioProvider`/`TidalAudioProvider` GET `/api/discovery/{service}` for instances.
- Deezer playback resolves pools of `arl` cookies through `DeezerAudioProvider` (gateway
  sessions + `deezer://` Blowfish-decrypted streams); it is inert without either a pooled
  or a manually signed-in account.

---

## Operational notes

- **Vercel cron cap** — `vercel.json` deliberately has no `crons` block (Hobby caps at one
  per day, and a more frequent expression fails the deployment). The real scheduler is
  `.github/workflows/health-cron.yml` (every 6 h) + `monochrome-cron.yml` (every 12 h) +
  `purge-cron.yml` (daily), which just `curl` the cron routes with `CRON_SECRET`.
- **Secrets to keep in sync** — `POOL_CLIENT_KEY` must be byte-identical between this site
  and the app builds; `POOL_ENCRYPTION_KEY` must survive database migrations or stored
  accounts become undecryptable.
- **Database** — Postgres via Drizzle. Schema in `scripts/schema.sql`
  (`CREATE TABLE IF NOT EXISTS` — safe to re-run). Use a **pooled** connection string on
  serverless; a direct URL exhausts connection limits under concurrent functions.
