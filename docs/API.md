# ArchivePool API

Base URL for the public deployment: `https://archivepool.vercel.app`

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
Deezer Account):

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
requests. `apis` is always an empty list for Deezer (Deezer has no self-hosted instance tier).

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

---

## Scheduled jobs (cron secret)

### `GET /api/cron/health`

Runs one health sweep (and the monochrome instance sync). Used by the GitHub Actions
workflow in this repo hourly.

```json
{ "ok": true, "checked": 0, "skipped": 0, "disabled": 0, "reenabled": 0, "ranAt": "..." }
```

### `GET /api/cron/monochrome`

Runs the monochrome (Tidal/Qobuz proxy) instance sync without the full sweep.

Both accept the admin token as an alternative credential so they stay manually triggerable.
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

### `POST /api/admin/force-check` — full sweep + monochrome sync now

```json
{ "ok": true, "sweep": { ... }, "monochrome": { ... }, "ranAt": "..." }
```

### `POST /api/admin/purge-dead` — soft-remove every `dead` entry

```json
{ "ok": true, "removed": 3 }
```

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

- `report: "dead"` — the credential refused playback (expired ARL, revoked token). The entry is
  demoted to `pending`; after 3 reports it is disabled and no longer served. The hourly sweep
  re-verifies and can re-enable it if the server-side check disagrees.
- `report: "not_premium"` — the credential works but lacks the premium tier the pool believed it
  had. Clears the `premium` flag so premium-first lease ordering stops preferring it.

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
- **Qobuz accounts** — username/password login proxied through `/api/qobuz/login`
  (credentials never stored server-side beyond the encrypted pool record), or pasting
  an appId/token pair.
- **Deezer accounts** — pasting an `arl` cookie.
- **API instances** — a `baseUrl` for Tidal/Qobuz restream instances.

Manual submissions are verified immediately; automatic sweeps re-check them on the
schedule. `POST /api/qobuz/login` exists as a JSON route used by the submit form
(`{ "username", "password" }` → `{ "appId", "token", ... }`); it validates against Qobuz
and returns `400`/`401` on missing or bad credentials.

---

## Encryption

Sensitive fields (`token`, `appId`, `appSecret`, `arl`, `masterSecret`, `refreshToken`,
passwords, usernames, cookies, email, etc.) are encrypted in two independent
AES-256-GCM layers. Keys are base64-encoded 32-byte values (`openssl rand -base64 32`).

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
  `.github/workflows/health-cron.yml` (hourly) + `monochrome-cron.yml` (every 12 h),
  which just `curl` the cron routes with `CRON_SECRET`.
- **Secrets to keep in sync** — `POOL_CLIENT_KEY` must be byte-identical between this site
  and the app builds; `POOL_ENCRYPTION_KEY` must survive database migrations or stored
  accounts become undecryptable.
- **Database** — Postgres via Drizzle. Schema in `scripts/schema.sql`
  (`CREATE TABLE IF NOT EXISTS` — safe to re-run). Use a **pooled** connection string on
  serverless; a direct URL exhausts connection limits under concurrent functions.
