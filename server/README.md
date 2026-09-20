# ArchivePool Go backend

A drop-in Go implementation of the ArchivePool backend: the same 30 HTTP routes as
`app/api/**/route.ts`, the same JSON shapes, status codes and headers, and the same server-side
behaviour as the manual-submission server action (`app/actions/submit.ts`).

The React frontend is unchanged and keeps calling the same API. The Android client keeps hitting the
same feeds.

* **No third-party modules.** The deployment has no module proxy, so everything is built on the
  standard library — including a PostgreSQL wire-protocol client
  (`internal/pgwire`: startup, SSLRequest/TLS, MD5 + SCRAM-SHA-256 auth, simple and extended query
  protocols) and the KDFs the standard library lacks (`internal/kdf`: PBKDF2-HMAC-SHA256, scrypt).
* **SQL is written by hand** with `$$n$$` placeholders bound through the extended protocol, exactly
  as `drizzle-orm/node-postgres` binds them. No query text is built by concatenating values.

## Run

```bash
cd server
go build ./... && go vet ./... && go test ./...

# Go server on :8080 (PORT overrides), reading the same environment as the Next app
go run ./cmd/archivepool
```

During cutover, Next keeps serving the frontend and the Go server serves `/api/*`:

* Option A — point the app at the Go base URL (`SOURCE_PROVIDER_URL=http://host:8080`) and keep
  Next on :3000 for the pages.
* Option B — proxy `/api/*` from Next to the Go server (`next.config.mjs` `rewrites()`), so the
  browser keeps talking to one origin and the session cookie (`atp_session`, same name, same
  attributes) is shared.

Environment variables are identical to the TypeScript app (`.env.example`):

| Variable | Purpose |
| --- | --- |
| `DATABASE_URL` | Postgres connection string (required; Neon/Railway URLs with `sslmode=require` are fine) |
| `ADMIN_TOKEN_HASH` | SHA-256 hex of the admin token (preferred) |
| `ADMIN_TOKEN` | Plaintext admin token (legacy fallback) |
| `CRON_SECRET` | Bearer secret for `/api/cron/*` (the admin token also works) |
| `SESSION_SECRET` | HMAC key for `atp_session`; missing ⇒ signing fails closed |
| `READ_KEYS_ENFORCED` | `true` gates the discovery/instances/report routes as well as the credential feeds |
| `POOL_ENCRYPTION_KEY` | base64 32-byte AES-256-GCM key for credentials at rest |
| `POOL_CLIENT_KEY` | base64 32-byte key legacy clients' responses are encrypted with |
| `BLOB_READ_WRITE_TOKEN` | optional; absent ⇒ snapshot access is a no-op and feeds read the database |
| `PORT` | listen port (default 8080) |
| `NODE_ENV` | `production` marks the session cookie `Secure`, exactly as the TS checks |

On boot the process starts listening immediately and applies the idempotent migration in the
background (the TS equivalent, `lib/db/ensure.ts`, is memoised and triggered by the first request).
`server/migrations/001_schema.sql` is `scripts/schema.sql` verbatim; `internal/schema` also applies the
`ensure.ts` statement list so a database created from an older `schema.sql` self-heals.

## TypeScript → Go map

| TypeScript | Go |
| --- | --- |
| `app/api/**/route.ts` (30 routes) | `internal/httpapi/{feeds,report,keys,auth,admin,cron,credentials,submit}.go` |
| `app/actions/submit.ts` | `internal/httpapi/submit.go` (also exposed as `POST /api/submit`) |
| `lib/db/index.ts`, drizzle call sites | `internal/pgwire/*`, `internal/db/*` |
| `lib/db/ensure.ts`, `scripts/schema.sql` | `internal/schema/schema.go`, `migrations/001_schema.sql` |
| `lib/crypto.ts` | `internal/crypto/crypto.go` |
| `lib/sources.ts` | `internal/pool/sources.go` |
| `lib/queries.ts` | `internal/pool/{leases,status,discovery,history,dashboard}.go` |
| `lib/api-keys.ts` | `internal/auth/keys.go` |
| `lib/sessions.ts` | `internal/auth/sessions.go` |
| `lib/admin-auth.ts` | `internal/auth/admin.go` |
| `lib/users.ts` | `internal/auth/users.go` (+ `internal/kdf/scrypt.go`) |
| `lib/audit.ts` | `internal/auth/audit.go` |
| `lib/rate-limit.ts` | `internal/ratelimit/ratelimit.go` |
| `lib/ttl-cache.ts` | `internal/cache/ttl.go` |
| `lib/edge-snapshot.ts` | `internal/blob/snapshot.go` |
| `lib/health.ts` | `internal/health/health.go` |
| `lib/health-sweep.ts` | `internal/health/sweep.go` |
| `lib/ingest.ts` | `internal/health/ingest.go` |
| `lib/instance-sync.ts` | `internal/health/sync.go` |
| `lib/monochrome.ts`, `lib/spotiflac.ts` | `internal/health/monochrome.go`, `internal/health/spotiflac.go` |
| `lib/external-sources.ts` | `internal/health/external.go` |
| `lib/tidal-oauth.ts`, `lib/qobuz-oauth.ts` | `internal/oauth/tidal.go`, `internal/oauth/qobuz.go` |

## Route parity checklist

All 30 TypeScript route handlers, plus the server action. Every row was checked against the
`route.ts` source (method, status codes, body shape, headers) and, where a live database was
available, exercised against a real deployment.

| # | Route / method | Behaviour parity | Notes |
| --- | --- | --- | --- |
| 1 | `GET /api/sources` | ✅ | legacy combined feed, always key-gated, `{version:1, generatedAt, encrypted, encryption, accountsFeed, instancesFeed, tidal…amazon-music:{apis,accounts}}` |
| 2 | `GET /api/accounts` | ✅ | `{version:2, …, service:{accounts:[…]}}`, `X-Pool-Client: v2` ⇒ read-key-derived encryption, legacy ⇒ `POOL_CLIENT_KEY`, else 503 `security_not_configured` |
| 3 | `GET /api/instances/{service}` | ✅ | `{streaming,api}`; 404 `{"error":"unknown service"}`; Blob snapshot first, cached DB read second |
| 4 | `GET /api/discovery/tidal` | ✅ | alias of #3 for `tidal` |
| 5 | `GET /api/discovery/qobuz` | ✅ | alias of #3 for `qobuz` |
| 6 | `GET /api/status` | ✅ | public, TTL-cached, 503 `database_unavailable` + message when the DB is down, `history:{days,overall,categories}` |
| 7 | `POST /api/report` | ✅ | `dead`/`not_premium`, 3-report auto-disable, lease-proofed replacement (registered key + proven lease + 3/hour), `replacement` envelope identical to `/api/accounts` |
| 8 | `GET /api/cron/health` | ✅ | `CRON_SECRET` or admin token; external ingestion (isolated), sweep, snapshot rewrite, cache invalidation |
| 9 | `GET /api/cron/monochrome` | ✅ | monochrome + SpotiFLAC sync, snapshot rewrite, `ok` true if either feed succeeded, 500 when both failed |
| 10 | `POST /api/auth/signup` | ✅ | username/password rules, 5 accounts per IP+UA per 24h, session cookie |
| 11 | `POST /api/auth/login` | ✅ | 10 attempts per IP+username and 30 per IP per 10 min, uniform `invalid_credentials` |
| 12 | `POST /api/auth/logout` | ✅ | clears the cookie (`Max-Age=0`) |
| 13 | `GET /api/auth/me` | ✅ | `{username}` or 401 |
| 14 | `GET /api/keys` | ✅ | `{keys, requests}`, 500 with `internal_error` on DB failure |
| 15 | `POST /api/keys` | ✅ | subject/reason validation, 1 request per IP+UA (30d), active-key cap 10, `{id,status:"pending"}` |
| 16 | `DELETE /api/keys/{id}` | ✅ | revoke, `?undo=1` restore, `?delete=1` hard delete, 404 `not_found` |
| 17 | `POST /api/requests/{id}/claim` | ✅ | row-locked claim, 4 distinct error codes, 409 for `key_limit`, plaintext shown once |
| 18 | `GET /api/admin/keys` | ✅ | admin token or admin-role session, every key including soft-deleted |
| 19 | `POST /api/admin/keys` | ✅ | `{ok,id,key,prefix}`, audit `key.create` |
| 20 | `PATCH /api/admin/keys` | ✅ | revoke/restore, audit `key.revoke` / `key.restore` |
| 21 | `DELETE /api/admin/keys/{id}` | ✅ | hard delete, 404 when absent, audit `key.delete` |
| 22 | `POST /api/admin/keys/custom` | ✅ | `/^atp_[A-Za-z0-9]{24,}$/`, 409 `exists`, re-seeds a baked key |
| 23 | `GET /api/admin/requests` | ✅ | bare array, `cache-control: private, no-store` |
| 24 | `POST /api/admin/requests/{id}` | ✅ | approve (no minting) / reject (≥10-char note), audit rows |
| 25 | `GET /api/admin/users` | ✅ | never selects `password_hash` |
| 26 | `PATCH /api/admin/users` | ✅ | role change, `cannot_demote_self`, audit `user.role_change` |
| 27 | `GET /api/admin/audit` | ✅ | `limit` clamped to 1..500 |
| 28 | `GET /api/admin/remove` | ✅ | every entry, ids sorted ascending, `payload` never selected |
| 29 | `POST /api/admin/remove` | ✅ | hard remove/restore across both tables by id, audit `entry.remove` |
| 30 | `POST /api/admin/purge-dead` | ✅ | bulk-removes `status='dead'`, audit with ids |
| 31 | `POST /api/admin/check-entry` | ✅ | single entry re-check, error message surfaced (e.g. missing `POOL_ENCRYPTION_KEY`) |
| 32 | `POST /api/admin/force-check` | ✅ | forced sweep + monochrome sync in parallel, audit `entry.force_check` |
| 33 | `POST /api/tidal/device/start` | ✅ | 502 `start_failed` + detail on failure |
| 34 | `POST /api/tidal/device/poll` | ✅ | `pending`/`slow_down`/`expired`/`error`, then the same ingest path as a manual submission |
| 35 | `POST /api/qobuz/login` | ✅ | 401 `login_failed`, `needs_secret` passthrough, then ingest |
| 36 | server action `submitSource` | ✅ | `POST /api/submit` (additive, see deviations): same fields, validation, admission policy and state shapes |

Headers: `cache-control` (`private, no-store` for per-key feeds, `public, s-maxage=300,
stale-while-revalidate=3600` for `/api/status` and the public snapshot answer, `private, no-store`
when `READ_KEYS_ENFORCED=true`), `access-control-allow-origin: *` on the feed and status routes,
`retry-after` on 429s. Route-level auth rules (read keys with scopes, `atp_session` cookie, admin
token/hash or admin session, `CRON_SECRET`) are identical.

### Crypto parity

| Layer | Behaviour |
| --- | --- |
| At rest | AES-256-GCM, `enc:1:<b64 iv>:<b64 ciphertext‖tag>`, 12-byte IV, `POOL_ENCRYPTION_KEY`; sensitive-field allowlist identical to `lib/crypto.ts` |
| Client (v2) | `sha256("archivepool-client:" + readKey)` |
| Client (legacy) | `POOL_CLIENT_KEY` |
| Passwords | scrypt `N=16384, r=8, p=1, keylen=64`, stored `N:r:p:salt:hash` (hex) |
| Sessions | `atp_session` = `<userId>.<expiresAtMs>.<base64url HMAC-SHA256>`, httpOnly, `SameSite=Lax`, `Path=/`, 30 days, `Secure` when `NODE_ENV=production` |

## Intentional deviations

1. **Key order inside payload-derived objects.** Client-facing credential objects
   (`leaseAccounts`/`leaseInstances` output, the `replacement` envelope) are `map[string]any` in Go,
   which marshals keys alphabetically; the TS preserved the payload's insertion order. Keys, values
   and nesting are identical — only the order of keys within those objects differs. Every
   *documented* response body is built from structs, so its key order matches the TS exactly
   (`internal/httpapi/router_test.go` pins this).
2. **`lastCheckedAt` on `/api/status`.** The TS builds `items.map(r => r.lastCheckedAt).filter(Boolean).sort().pop()`
   — sorting `Date` objects with the default comparator sorts their `toString()` (weekday name first),
   so the value it reports is not necessarily the latest check. The port returns the true maximum.
   This is the only behavioural improvement in the port; nothing else consumes that field.
3. **`POST /api/submit` is additive.** The manual-submission form is a Next *server action*, not an
   HTTP route, so it has no path to be a drop-in for. The Go equivalent of its logic is implemented
   and exposed there for a cutover where the Go server also serves the form; while Next serves the
   frontend the React page keeps using the action, unchanged.
4. **Blob writes beyond the snapshot.** `internal/blob` implements the snapshot read/write the app
   needs (that is the whole of `lib/edge-snapshot.ts`); it does not implement Blob listing or
   deletion, which nothing in the app calls.
5. **Header name casing.** Go's `net/http` canonicalises header names (`Retry-After`,
   `Cache-Control`) where Next emits them lowercase. HTTP header names are case-insensitive; values
   are identical.
6. **Error/detail text from the network and database stack.** Go's driver and `net/http` produce
   their own wording — `/api/status` on a database failure returns e.g. `dial tcp … connection
   refused`, and a failing health probe reports `Get "https://…": dial tcp …` where Node said
   `fetch failed`. Codes, statuses and shapes are unchanged; only the human-readable detail differs.
   (Timeouts are still reported as `timeout`, matching `lib/health.ts`'s `reason()`.)

## Verification

```bash
cd server
go build ./... && go vet ./...     # clean
go test ./...                      # unit tests (+ live tests when DATABASE_URL is set)
```

Tests and what they pin:

* `internal/pgwire` — SCRAM-SHA-256 against the **RFC 7677 §3** exchange (client-final and
  server-final byte-for-byte); PBKDF2 vectors; text-format decoding; and a live test
  (`DATABASE_URL`) that dials the real server over TLS, binds parameters through the extended
  protocol, round-trips JSONB and NULL, decodes `timestamptz`, and maps `ErrorResponse` to the
  server's own message. **Read-only: every statement is a `SELECT`.**
* `internal/kdf` — scrypt against the **RFC 7914 §12** vectors (including the pool's own
  `N=16384, r=8, p=1`) and PBKDF2-HMAC-SHA256 known answers.
* `internal/crypto` — decrypts ciphertext produced by the TypeScript implementation, emits the same
  `enc:1:` format, `deriveClientKey` equal to `sha256("archivepool-client:"+key)`, the sensitive-field
  allowlist, and fail-closed behaviour without keys.
* `internal/auth` — a hash written by `lib/users.ts` verifies, the `N:r:p:salt:hash` format, a token
  written by `lib/sessions.ts` verifies, cookie attributes, and the admin/cron credential rules
  (hash preferred, malformed hash fails closed, plaintext fallback, cron secret).
* `internal/pool` — fingerprints and masked labels against vectors produced by `lib/sources.ts`, plus
  the category table; and live tests (`DATABASE_URL`) that execute the lease SQL — keyed/unkeyed,
  scoped/global, and the replacement query — **inside a rolled-back transaction**, so the credential
  path's SQL is verified without writing anything.
* `internal/health` — the Amazon shape-only rules (including that `premium` must be a real boolean)
  and every branch of `describeSaveError`'s configuration diagnosis.
* `internal/ratelimit`, `internal/cache` — sliding-window semantics (`retry-after`, expiry,
  independence, cap) and TTL/read-through/single-flight/invalidation semantics, both with an injected
  clock.
* `internal/httpapi` — routing fallbacks (404/405 empty bodies, trailing-slash redirect, HEAD→GET),
  path-parameter capture, JSON key order for every documented body (including the embedded one-time
  key response), no HTML escaping, the 429 shape, JavaScript `Number()` coercion, the credential
  feed's fail-closed 503, cron authorization, and a registry test asserting all 36 registered
  routes.
* `internal/schema` — a live test (`DATABASE_URL`) asserting the migration is idempotent and leaves
  every relation the app reads in place. It applies the same idempotent statements the server applies
  at boot.

Live verification performed against the deployment in `.env.local`:

* `go test ./internal/pgwire -run TestLiveConnection` and `go test ./internal/schema -run TestLiveEnsure`
  both pass (TLS + SCRAM-SHA-256 to Neon).
* A read-only HTTP sweep of a live instance: `/api/status` 200 with real category figures;
  `/api/instances/{tidal,qobuz}` serving the **Blob snapshot** with
  `cache-control: public, s-maxage=300, stale-while-revalidate=3600` and the database fallback with
  `private, no-store` when the snapshot is absent; `/api/instances/bogus` 404 with the documented
  body; credential feeds 401; admin reads 200 with real rows (`keys`, `remove`); admin and cron
  authorization tests; and the validation-only paths of `submit`, `report`, `qobuz/login`,
  `tidal/device/poll`.
* The Blob integration was verified end-to-end against the configured store: upload through the
  `blob.vercel-storage.com` endpoint, read through the store's public host, then deletion of the
  temporary probe object (the production snapshot pathname was never rewritten).
* The live health checks were exercised with synthetic payloads only (no stored credential was
  decrypted): instance reachability against a real host and a local server (200/404/500, `healthPath`
  and `probeUrl` joining, the hi-res premium regex), plus the Tidal/Deezer/Apple/Qobuz/Amazon account
  paths against the real services with deliberately invalid inputs. Every case landed on the
  documented verdict (`dead` with the expected `detail`, `preview` for a reachable non-premium
  instance, `alive` for a well-formed Amazon artifact).

**Note on the database in `.env.local`:** booting the port there applied the same idempotent migration
the TS app applies on its first request, which created the relations that deployment was missing
(`users`, `api_key_requests`, `audit_log`, `health_log`, `api_key_leases`). The legacy `source_entries`
→ `account_entries`/`instance_entries` copy ran too; it is `ON CONFLICT (fingerprint) DO NOTHING` and
the row counts were already 61 = 51 + 10, so nothing was duplicated. No credentials were read or
returned by any test.
