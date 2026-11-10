<!-- SPDX-License-Identifier: GPL-3.0-or-later -->
# Cloudflare deployment and free-tier resource budgets

ArchivePool runs Next.js/OpenNext on Workers, Neon through Hyperdrive, and one
`POOL_SNAPSHOTS` KV namespace. One build key is shared by every installation of an
app. Dependency budgets must therefore be shared across keys, addresses, isolates
and colos. Process-local rate limits and caches alone cannot enforce a daily cap.

**A free deployment cannot promise availability under unlimited incoming traffic.**
Workers counts requests before application code can reject them; Error 1027 cannot
be converted into an application response. CPU is also enforced by the runtime.
The guards below cap dependency work and preserve public snapshots, with deliberate
refusals when capacity is spent. The owner must upgrade before refusals affect
normal traffic, and must account for other Workers and database consumers.

## Official limits, checked 2026-11-10

The official documentation was read through its public GitHub source. Cloudflare
revision: [`6b11374`](https://github.com/cloudflare/cloudflare-docs/tree/6b11374bc7f337df654ab8040c00e910b5081be5/src/content).
Neon revision: [`64774e5`](https://github.com/neondatabase/website/blob/64774e52457f35ef4ddbec8a839783e7832ba43f/content/docs/introduction/plans.md).

| Resource | Current Free limit | Enforcement and application guard |
|---|---|---|
| Workers requests | 100,000/day, account-wide; midnight UTC reset | Incoming requests, including rejected requests, count. Over quota returns 1027. Application code cannot prevent this. Static assets served by the assets binding are exempt. |
| Workers CPU/memory | 10 ms/request; 128 MB/isolate | I/O wait is excluded. Password/scrypt login stays disabled. Request bodies are capped at 64 KiB before parsing; upstream response consumption at 256 KiB/request. Health and sync calls are sliced. These are work bounds, not proof that OpenNext fits 10 ms. |
| Workers subrequests | 50 external subrequests/request; Cache API calls share this allowance; internal services have a separate 1,000 allowance | All upstream HTTP and redirect hops use `budgetedFetch`, capped at 40. Cache paths use at most six match/put calls in the healthy fixtures; outage fallbacks remain below ten. SQL statements and KV operations are counted separately below. |
| Workers Logs | 200,000 events/day; three-day retention | Head sampling is 10%; routine invocation/error pairs are about 13,000 events/day in the pessimistic model. Dashboard request/CPU metrics remain available. Watch account-wide log use. |
| Worker upload | 3 MiB compressed | Previous build was about 2 MiB; this change was not fully built on the shared machine. Check the release artifact before deployment. |
| Hyperdrive | 100,000 statements/day, cached queries included; approximately 20 origin connections/configuration | Every query, mutation, BEGIN/COMMIT/ROLLBACK and DDL statement counts. The shared ledger grants at most 80,000 statement units/day. Ordinary requests can reserve only 72,000, leaving 8,000 for authenticated crons. Client pools have at most three connections by default. |
| Workers KV | 100,000 reads/day; 1,000 writes, deletes and list operations/day; 1 GB storage; 25 MiB/value; one write/second/key | Ledger limits: 80,000 reads/day, of which 8,000 are reserved for crons, and 32 writes/day. No KV delete/list operations. Four stable keys; no per-client/key KV writes. Scheduled publication uses at most 16 writes/day, plus one operator schema-marker write on rollout. |
| SQLite Durable Objects | 100,000 RPC sessions/day; 13,000 GB-s/day; 5 million row reads/day; 100,000 row writes/day; 5 GB storage | One global object, one INTEGER-primary-key row. Public reads check its outage signal, including cache hits. An RPC session is opened only when a request needs a resource; calls on its returned RpcTarget are part of that session. At most 51,064 successful ticket reservations/day, including 32 anonymous admissions, plus at most 1,440 database-outage signal writes; denied reservations do not write. A continuously active 128 MB object is below 11,060 GB-s/day. |
| Neon compute | 100 CU-hours/project/month; Free can autoscale to 2 CU; scale-to-zero after five minutes | A conservative union of SQL wake windows is limited to 10 hours/day, with the last hour reserved for crons. **This fits only if the owner fixes the endpoint at 0.25 CU**: 31 × 10 × .25 = 77.5 CU-hours. At 0.5 or 2 CU it does not fit. External SQL consumers and Hyperdrive/origin behavior must be monitored. |
| Neon Postgres storage | **1 GB/project**, 20 GB across Free projects | Daily retention bounds historical tables. Source payloads are limited to 16 KiB after encryption and anonymous admissions to 32/day. Active users, keys, attributed pool entries and database bloat still require monitoring/admission policy. Do not rely on the older 0.5 GB figure. |
| Neon public network transfer | 5 GB/project/month | Metadata-only queries and bounded lease selections reduce transport. The measured workload below fits; the application does not enforce a provider-wide byte counter. Large payloads or other project consumers can still exhaust transfer. |

Official pages: [Workers limits](https://developers.cloudflare.com/workers/platform/limits/),
[Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/),
[Hyperdrive pricing](https://developers.cloudflare.com/hyperdrive/platform/pricing/),
[Hyperdrive limits](https://developers.cloudflare.com/hyperdrive/platform/limits/),
[KV limits](https://developers.cloudflare.com/kv/platform/limits/),
[KV pricing](https://developers.cloudflare.com/kv/platform/pricing/),
[Durable Objects pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/),
[Neon plans](https://neon.com/docs/introduction/plans). Workers Logs pricing changes
on 2026-12-01; recheck before a December rollout.

## Measured request costs

`tests/harness.cjs` wraps the real `pg` client, KV binding, Cache API and fixture
fetches. It counts statements actually sent, including transactions, failed queries
and schema checks. `docs/route-costs.json` contains every scenario, status, connection
count, returned PostgreSQL protocol bytes and local CPU sample. The baseline is
`529addd`, after PRs #15 and #18; main's subsequent premium-field fix changes no
resource costs. These are **local fixtures**, with no production database or provider
connections. Existing migrations are applied to a throwaway Postgres 16 first.

Reproduce with `tests/run-local.sh node tests/measure.cjs`. The script checks disk
space, uses a unique container and a non-default loopback port, sets TMPDIR, and
removes the container on success or failure. `pnpm test:limits` uses
`TEST_DATABASE_URL` in CI; the URL guard rejects any non-local database.

The main fixture has three accounts per service and ten instances per applicable
service. Variants include six expired Tidal credentials, a larger sweep pool,
new/repeat leases, missing/random keys, completed batches and transaction paths.
Health verdict fixtures isolate database batching; the separate renewal fixtures
exercise actual TypeScript refresh logic. Ranges include early rejections. KV columns
are reads/writes and Cache columns are matches/puts; DO sessions are shared across all RPC methods in a request. A schema marker costs at most
one KV read per cold isolate, zero SQL; that read is included wherever it occurs.

| Method/path | SQL before | SQL after | KV R/W | Cache M/P | HTTP fetches | DO sessions | Local CPU max ms |
|---|---:|---:|---:|---:|---:|---:|---:|
| GET /api/accounts | 0–29 | 0–28 | 0–1/0 | 0/0 | 0–6 | 0–1 | 23.11 |
| GET /api/sources | 0–31 | 0–30 | 0–1/0 | 0/0 | 0–6 | 0–1 | 17.49 |
| GET /api/discovery/tidal | 0–1 | 0–1 | 0–3/0 | 1–2/0–4 | 0 | 1 | 93.85 |
| GET /api/discovery/qobuz | 0–1 | 0–1 | 0–3/0 | 1–2/0–4 | 0 | 1 | 6.74 |
| GET /api/instances/[service] | 0–1 | 0–1 | 0–3/0 | 1–2/0–4 | 0 | 1 | 3.44 |
| GET /api/status | 0 | 0 | 0–1/0 | 1/0–2 | 0 | 1 | 0.82 |
| POST /api/report | 5–14 | 4–13 | 1/0 | 0/0 | 0–1 | 1 | 12.45 |
| GET /api/cron/health | 16–39 | 13–37 | 1/0–3 | 0/0 | 4–18 | 1 | 17.92 |
| GET /api/cron/monochrome | 1–32 | 1–25 | 1/0–1 | 0/0 | 0–22 | 1 | 30.75 |
| GET /api/cron/purge-dead | 3–4 | 13–16 | 1/0–2 | 0/0 | 0 | 1 | 7.59 |
| GET /api/admin/audit | 1 | 1 | 1/0 | 0/0 | 0 | 1 | 15.89 |
| GET /api/admin/claims | 1 | 1 | 1/0 | 0/0 | 0 | 1 | 2.95 |
| GET /api/admin/keys | 1 | 1 | 0/0 | 0/0 | 0 | 1 | 2.73 |
| GET /api/admin/remove | 2 | 2 | 1/0 | 0/0 | 0 | 1 | 3.44 |
| GET /api/admin/requests | 1 | 1 | 1/0 | 0/0 | 0 | 1 | 2.63 |
| GET /api/admin/users | 1 | 1 | 1/0 | 0/0 | 0 | 1 | 2.47 |
| POST /api/admin/check-entry | 5 | 5 | 1/0 | 0/0 | 1 | 1 | 3.58 |
| POST /api/admin/force-check | 23 | 27 | 1/0 | 0/0 | 17 | 1 | 14.85 |
| POST /api/admin/keys | 2 | 2 | 1/0 | 0/0 | 0 | 1 | 2.87 |
| PATCH /api/admin/keys | 2 | 2 | 1/0 | 0/0 | 0 | 1 | 5.9 |
| POST /api/admin/keys/custom | 2 | 2 | 1/0 | 0/0 | 0 | 1 | 4 |
| DELETE /api/admin/keys/[id] | 2 | 2 | 1/0 | 0/0 | 0 | 1 | 2.71 |
| POST /api/admin/remove | 3 | 3 | 1/0 | 0/0 | 0 | 1 | 3.36 |
| POST /api/admin/purge-dead | 5 | 5 | 1/0 | 0/0 | 0 | 1 | 8.87 |
| POST /api/admin/purge-entry | 3 | 3 | 1/0 | 0/0 | 0 | 1 | 3.08 |
| POST /api/admin/requests/[id] | 3 | 3 | 1/0 | 0/0 | 0 | 1 | 7.28 |
| POST /api/admin/claims/[id] | 2–13 | 2–13 | 1/0 | 0/0 | 0 | 1 | 4.59 |
| PATCH /api/admin/users | 2 | 2 | 1/0 | 0/0 | 0 | 1 | 2.7 |
| POST /api/auth/claim-legacy | 7–16 | 7–16 | 1/0 | 0/0 | 0 | 1 | 5.63 |
| GET /api/auth/github/start | 0 | 0 | 0/0 | 0/0 | 0 | 0 | 0.85 |
| GET /api/auth/github/callback | 1–4 | 1–4 | 1/0 | 0/0 | 2 | 1 | 7.72 |
| POST /api/auth/login | 0 | 0 | 0/0 | 0/0 | 0 | 0 | 0.42 |
| POST /api/auth/signup | 0 | 0 | 0/0 | 0/0 | 0 | 0 | 0.44 |
| POST /api/auth/logout | 0 | 0 | 0/0 | 0/0 | 0 | 0 | 0.31 |
| GET /api/auth/me | 0–2 | 0–2 | 0–1/0 | 0/0 | 0 | 0–1 | 4.12 |
| GET /api/keys | 3 | 3 | 1/0 | 0/0 | 0 | 1 | 5.18 |
| POST /api/keys | 4 | 4 | 1/0 | 0/0 | 0 | 1 | 9.73 |
| DELETE /api/keys/[id] | 2 | 2 | 1/0 | 0/0 | 0 | 1 | 5 |
| POST /api/requests/[id]/claim | 8 | 8 | 1/0 | 0/0 | 0 | 1 | 7.98 |
| POST /api/tidal/device/start | 0 | 0 | 0/0 | 0/0 | 1 | 1 | 0.76 |
| POST /api/tidal/device/poll | 1 | 1 | 1/0 | 0/0 | 2 | 1 | 3.85 |
| POST /api/qobuz/login | 1 | 1 | 1/0 | 0/0 | 5 | 1 | 4.09 |
| submit action | 1–3 | 1–3 | 1/0 | 0/0 | 0–1 | 1 | 25.44 |
| page / | 0 | 0 | 0/0 | 0/0 | 0 | 0 | 0.49 |
| page /docs | 0 | 0 | 0/0 | 0/0 | 0 | 0 | 0.32 |
| page /login | 0 | 0 | 0/0 | 0/0 | 0 | 0 | 0.18 |
| page /signup | 0 | 0 | 0/0 | 0/0 | 0 | 0 | 1.18 |
| page /admin | 0 | 0 | 0/0 | 0/0 | 0 | 0 | 0.21 |
| page /submit | 2 | 2 | 1/0 | 0/0 | 0 | 1 | 3.47 |
| page /dashboard | 12 | 10 | 1/0 | 0/0 | 0 | 1 | 17.73 |

Implicit HEAD executes the GET handler at the same resource cost; Next implements OPTIONS without application SQL/KV work.

Important hot-path details:

- `/api/accounts`: new lease 4 statements, repeat 2, six expired Tidal candidates 28.
  `/api/sources`: new 6, repeat 3, six expired candidates 30. Renewals add live SQL
  and fixture HTTP; credential responses never use a stale snapshot or cached auth.
- Public discovery/status data with a last-good snapshot use **zero SQL**, even after that copy
  ages. Discovery authorization can use one SQL statement when the key manifest is
  older than five minutes or lacks a key; normal revocation lag is not extended by
  the six-hourly publisher. During a recorded outage, known public-URL identities
  can use their last-good copy and the response is marked stale. URL query parameters, request cache-control headers and ETag variants cannot
  change their internal cache key. Missing keys and unsupported instance services
  reject before SQL/KV. A random presented key can still cost one SQL statement;
  brief negative caches help repeated guesses, while the global ledger bounds unique
  guesses across colos. A manifest read serves all discovery keys in an isolate.
- The eight-verdict sweep fixture uses 17 statements: one bounded queue read and two
  writes/check. A finishing four-entry batch uses 13, including four publication
  reads and three KV writes. The expired-Tidal fixture spends 37 statements for six
  checks before fetch admission stops the batch. A check requiring a second renewal
  can be more expensive; all such statements still pass through the daily guard.
- Instance sync queries only the current slice's fingerprints, not every row for
  that service. Eight new passing instances cost nine statements; a publish-only
  call costs one SQL statement and one KV write. No-batch/no-feed requests on Workers
  are bounded too. Force-check shares the same per-request fetch budget with sync.
- Public aggregate status is computed in SQL and transfers only category aggregates,
  not all pool rows. Legacy instance leases and moderation lists select only the
  columns they return/use, avoiding needless credential/history transfer.
- Migration bootstrap is **never run by a Free Worker read**, including KV outages.
  Missing/wrong markers fail closed before a connection is opened. Operator bootstrap
  off Workers is 73 statements, or 74 with legacy-copy verification on a fresh schema;
  the incremental rollout SQL has 18 statements. There is no BEGIN/COMMIT wrapper.
- Local CPU in the JSON artifact includes Node driver/crypto work and mocked-provider
  handling, but excludes Next rendering and production Worker startup. Some samples
  exceed 10 ms. They cannot establish Worker compliance. Measure deployed p95/p99 CPU
  before continuing on Free; large authenticated management lists/SSR, malformed or
  oversized JSON/form inputs, crypto on large payloads, bundle regex scans and TCP
  handshakes remain CPU hot spots. Server response consumption is bounded before
  parsing, not by slicing an already-read body. Password hashing is deliberately
  unavailable on Free.

## Daily budget model

Assumptions: one otherwise quiet Cloudflare account/Neon project; one 0.25 CU
endpoint with five-minute scale-to-zero; no SQL traffic from old Vercel/Railway,
Rust/Go, consoles or other branches. Three app keys, 1,000 daily installs/app:
2,000 modern account requests and 1,000 legacy source requests. Each install makes
two discovery requests/day (6,000 total), plus 1,000 public status requests/day.
Use the cold-colo fixture for every discovery request, ignoring cache hits. This
pessimistically permits independent misses across 100 active colos; changing keys,
headers or URLs does not create an unbounded application cache namespace.

Pool: 128 non-expired entries, including six Tidal accounts; a sweep every six hours.
Instance sync: 48 candidates across three feeds every twelve hours, eight per slice.
Purge: daily at 04:30. Assume three HTTP probes/check on average and healthy refresh
endpoints. Reserve 576 SQL statements for up to six Tidal renewals/hour, plus 500
statements and 100 KV reads for owner/auth/key actions. Normal leases are charged
as *new* leases despite stickiness, so actual normal usage should be lower.

Pessimistic addition: one broken legacy client sends 5,000 source requests/day,
and a hostile unauthenticated caller sends 50,000 requests with distinct invalid
keys. Ignore local IP/key limits and negative caching. The attacker cannot send an
authenticated cron or create an audit/key/session row. There is no assumption that
one shared build key rate-limits the whole fleet. Charge one authorization SQL
statement for every discovery request once the manifest ages past five minutes.

| Meter | Normal before | Normal after (demand) | Pessimistic before | Pessimistic after |
|---|---:|---:|---:|---:|
| Worker invocations/day | about 10,100 | about 10,100 | about 65,100 | about 65,100; rejected calls still count |
| Hyperdrive statements/day | 25,426 | 22,306 | 110,426: exceeds 100,000 | demand 102,306; **reservations ≤80,000** and ordinary ≤72,000; requests are refused before the provider quota |
| KV reads/day, cold misses | about 16,200 | about 22,200 | about 71,200 | demand about 77,200; reservations ≤80,000, ordinary ≤72,000 |
| KV writes/day | ≤11 + rollout marker | ≤16 + rollout marker | same; reads never write snapshots | ≤32 application writes, plus operator writes |
| SQL wake time/day | can approach 24 hours | reservation cap 10 hours | can approach 24 hours | ≤10 credited hours; ordinary stops at nine, crons retain an hour |
| Neon CU-hours/31 days at .25 CU | up to 186 | ≤77.5 credited | up to 186 | ≤77.5 credited, subject to the endpoint/external-consumer assumptions |
| Neon transfer/31 days | about 1.2 GB | about 1.1 GB | about 6 GB: exceeds 5 GB | **≤4.4 GB in these fixtures**, including a conservative handshake/miscellaneous allowance |
| SQLite DO successful row writes/day | absent | at most 52,504 | absent | at most 52,504; one row, no secondary index |

Cron SQL arithmetic: before `4 × (2×128 + 3×16 + 5) + 2×(48+6+1) + 4 = 1,350`;
after `4 × (2×128 + 16 + 4) + 2×(48+6+1) + 16 = 1,230`.
Normal totals add leases (17,000 before / 14,000 after), discovery (6,000 / 6,000 worst case after manifest expiry),
576 renewal statements and 500 owner statements. About 1,828 scheduled probe fetches
fit the 4,000 probe units reserved for crons; ordinary probes are limited to 4,000,
with a combined 8,000/day cap. Crons are bounded by their existing drivers too:
40 health calls/run, 25 calls/feed/sync, plus one sync publish and one daily purge.
If that many calls still cannot drain the pool, fail the job and upgrade/change the
schedule; do not silently declare the tail checked.

Reservations deliberately overcount: SQL tickets have eight units, KV read tickets
two, writes one and probe tickets eight. Unspent units are discarded, not refunded
across requests. Tickets expire after twenty seconds and cannot cross UTC midnight.
The pessimistic workload therefore hits application refusals *earlier* than the raw
statement/read demand suggests. These caps protect dependencies, not fairness or
availability for an app when an attacker competes for ordinary capacity.

The transfer bound uses measured transport plus generous protocol allowances:
72,000 ordinary SQL units allow at most 9,000 request admissions. A repeat legacy
fixture returns less than 13 KiB of Postgres protocol data and uses two connections;
allow 15 KiB/admission, plus 300 MiB/month for crons, renewal and management. This
is a **fixture-based bound, not a provider byte limiter**. Large Amazon session/auth
payloads, long URLs, management exports or another database consumer invalidate it.
Watch actual Neon transfer and upgrade before the projected monthly total reaches
4 GB. Reducing legacy transfer helps only while those payload assumptions hold.

Retention keeps at most 200,000 health/report rows after purge (30 days), and 50,000
audit rows (90 days). Persisted check detail is at most 1 KiB. With ordinary small
account/instance/key payloads, a 128-row pool, modest user/key counts, leases and
indexes, budget **under 600 MiB** for live data and headroom. This is not a hard
storage guarantee: incoming rows between purges, audit detail, active account/key
counts, TOAST, dead tuples and restore history must be measured. A purge cannot
repair a provider storage cap once even DELETE needs additional space.

### Conservative input caps: needs owner decision

The anonymous submit action accepts an Amazon session artifact by shape
(length ≥16, premium=true), without an upstream probe. Before the caps, its measured
64 KiB fixture cost one SQL statement, zero HTTP fetches and **saved the row**.
The same fixture now rejects before database or upstream work. The global probe
budget cannot contain shape-only admission: distributed callers could otherwise
spend 9,000 ordinary SQL reservations on distinct large artifacts; a 900 KiB
session grows after at-rest encoding, allowing more than 10 GiB/day of payloads.

| Input | Enforced default | Reason and owner review |
|---|---|---|
| Request body | `MAX_REQUEST_BODY_BYTES = 64 * 1024` | The Worker rejects declared, streamed and multipart oversize with 413 before OpenNext parses or accesses resources. Next server actions use the same limit. Review legitimate forms and account artifacts; rejected requests still count as invocations. |
| Stored source payload | `MAX_STORED_SOURCE_PAYLOAD_BYTES = 16 * 1024` | UTF-8 JSON is checked before and after at-rest encryption, before initial DB/upstream work and again after verification. A 13 KiB session exceeds the encrypted cap; a 10 KiB fixture fits. Review real Amazon artifact sizes without weakening the encrypted bound. Existing oversized rows are not truncated. |
| Anonymous admissions | `ANONYMOUS_ADMISSIONS_PER_DAY = 32` | One persisted UTC counter across Workers isolates; an atomic DB bucket off Workers. Accepted candidates reserve before upsert, including resubmissions; failed saves remain spent and unavailable budgets fail closed. At most 512 KiB/day or 15.5 MiB/31 days of serialized anonymous payloads, before row/index/bloat overhead. Attributed submissions are exempt. Review expected contribution volume and the 320-verdict cron driver. |

Anonymous admission is reserved **after the live health check**, before upsert.
Rejected anonymous floods therefore still spend probe budget for checks that run;
per-IP probe limits still apply. This keeps failed checks from spending the 32 daily
admission slots, at the cost of probes even when admission capacity is exhausted.
The timing is unchanged; the owner should review this trade-off.

Retention now hard-deletes removed `account_entries` and `instance_entries` once
30 days have elapsed since removal, and `audit_log` rows after 90 days. The owner
should confirm these recovery and audit windows. A verified re-submission still
revives a removed entry before it is purged; this existing behavior is unchanged.

The constants live in `cloudflare/input-limits.mjs`. These conservative defaults
change accepted inputs and are listed under **Needs owner decision** in the PR so
the owner can tune them. Attribution requires a signed-in contributor on the submit
action; this cap does not prevent abuse through registered accounts. Active valid
rows can accumulate indefinitely, and management/credential responses are not
provider-wide byte-limited. The fixture budget remains conditional on small ordinary
payloads, modest user/key counts and the owner's monitoring/admission policy.

## Defects addressed and behavior during outages

The 2026-11-06 outage was Hyperdrive statement exhaustion. PR #15 stopped 57
idempotent migrations per cold isolate and repeated discovery bookkeeping. Those
fixes remain; this change removes the remaining per-key/per-colo discovery lookup
for sufficiently fresh manifest keys, with last-good fallback during outages, needless usage-counter writes on credential reads, broad
credential/instance reads and repeated per-batch retention. Every database client
query and KV operation now reserves capacity through the one persistent ledger,
including transactions and schema paths, before opening a database connection. The wrapper scope also enforces the guard
if OpenNext binding context is missing.

Public instance/status snapshots retain their last-good KV values without an
expiration that deletes the outage fallback. A failed publish never overwrites a
good copy. Instance snapshots older than 24 hours and status snapshots older than
26 hours carry additive `stale:true`. A recorded database connection/query/budget failure sets a shared fifteen-minute
outage signal, refreshed at most once/minute. Public reads check it without SQL
or KV writes and mark even a fresh edge/KV copy stale. A missed signal is eventually
covered by the snapshot-age threshold; public reads do not probe SQL just to
discover an outage. Public status without
any usable copy returns the existing database-unavailable 503; discovery preserves
its existing empty feed with an additive stale marker. If KV itself fails or its
budget is spent, seven-day last-good Cache API backups preserve public bodies and
public-URL identities in previously visited colos; these responses are marked stale.
A new colo with neither KV access nor a backup cannot manufacture the missing copy.

Credential auth, leases and replacements stay live and fail closed on database
errors; they never consume stale credential/authorization snapshots. Existing
unhandled credential database failures remain 500 errors; changing those to a
structured 503 would change the existing status/envelope contract and needs owner
approval. Existing 429/503 responses retain Retry-After, with the Worker boundary
adding it if a handler omitted it. Shared-budget refusals cannot exhaust Hyperdrive
first. Probe-budget/oversized-response failures are inconclusive checks, and never
persist a false dead verdict or accept an unverified contribution.

Renewals return the complete Tidal credential, including the rotated refresh token,
in both normal and replacement leases. A locally expired token followed by a
session 401 advances the in-memory credential too, so R1 is followed by R2 rather
than being spent twice. Encryption migration skips already-encrypted rows and uses
`payload = <original snapshot>::jsonb` when converting plaintext. Sweep and single
check verdict updates do not contain payload. Qobuz secret repair targets one
fingerprint instead of reading/decrypting and rewriting all Qobuz accounts. A
re-login returns its new fingerprint so the following secret repair still targets
the current row, with compare-and-set guards on its appId and appSecret.

Daily purge removes old health/report markers, audit, expired 72-hour leases,
one-day rate-limit buckets, 90-day requests (including pending) and GitHub claims,
and payload-bearing removed entries after 30 days. Entries with lapsed declared
expiry are eligible after the grace period. Recent successful premium checks protect
flapping entries; synthetic report markers cannot manufacture recovery evidence.
A restore/revive clears removed_at, and a subsequent removal starts a new clock.
A verified manual resubmission also updates its declared expiry.
Sessions/OAuth/device state are signed cookies or upstream state, not database
session tables; no server session table grows per login.

Hot indexes cover key hashes, lease primary keys/entry lookups, service/active/LRU
queries, contributor queries, expiry, health entry/time and successful-check
anti-joins. Retention has checked_at/id, created_at/id, leased_at, window_start,
request/claim age and partial removed_at indexes. Request/user IP+UA+time indexes
avoid scanning their entire history. PostgreSQL aggregates and ranking still scan
eligible rows; statement counts alone do not bound database CPU or bloat.

## Regression guards and CI

`.github/workflows/typescript.yml` runs `tsc --noEmit`, ESLint, the local Postgres resource,
cron, retention, outage and route-coverage tests, and mutation checks on every PR
and push to main. Every API method, the submit action and data-reading pages has a
fixture ceiling; adding a new route without one fails CI. Separate guards cover
cold-schema/KV failures, key rejection, cache busting, last-good publication,
credential outage refusal, Unicode detail bounds and large upstream bodies.
Outage signals are persistent across actor restarts and propagate to other colos.
SQLite DO/RpcTarget behavior is exercised in local workerd via Miniflare.

The P1 tests use mocked databases/fetches only: encryption migration/CAS and
payload-free verdict writes; single-use R1→R2 refresh with sessions returning 401;
wrong-type premium evidence, boolean priority and optimistic unreadable bodies.
Lease response tests decrypt client ciphertext and require the rotated refresh
field in normal and replacement paths. `tests/check-mutations.cjs` temporarily
restores old behavior, asserts an AssertionError for each regression, and restores
the source in finally. These mutation checks also run in CI. No test can fetch a
provider/community host or connect to production.

## Owner rollout and operating checklist

1. Keep Neon fixed at **0.25 CU**, five-minute scale-to-zero, and disable/redirect
   old SQL-serving deployments. Account for all other consumers of the Cloudflare
   account and Neon project. The ledger covers this Worker only.
2. Apply [`scripts/migrations/2026-11-10-free-tier.sql`](../scripts/migrations/2026-11-10-free-tier.sql)
   outside Workers before rollout. Confirm indexes and `pool_state` exist. Keep
   the old marker until the owner rolls out; immediately afterward set the KV
   `schema:applied` text value to **2026-11-10.2**. Missing/wrong markers disable SQL
   before connecting. Never ask Free request handling to run the DDL pass.
3. The owner release build must include `cloudflare/worker.mjs`, the
   `FREE_TIER_BUDGET` binding and the SQLite migration in wrangler.jsonc. No paid
   platform/R2 activation is required for SQLite DOs. Trigger a complete health
   sweep to seed status, instance and discovery-key manifests. No deployment was
   performed as part of these tests.
4. Watch Workers metrics: daily requests **70,000 warning / 80,000 upgrade**;
   p95 CPU **6 ms warning**, p99 **8 ms upgrade**, any 1102/subrequest error is an
   immediate action. Check sampled logs and total log events against **150,000/day**. Check compressed release size **2.5 MiB warning / 3 MiB cap**.
5. Watch Hyperdrive statements **60,000 warning / 70,000 upgrade** and origin
   connections approaching 15. Watch application resource-refusal logs, which
   can appear before provider numbers reach these levels because tickets overcount.
   Crons must finish, retain progress cursors and publish; alert on a failed run,
   an undrained tail or snapshots older than **12 h warning / 24 h action**.
6. Watch KV reads **60,000 warning / 70,000 upgrade**, writes **500 warning /
   800 upgrade** account-wide (the app should stay near 16), and DO row writes
   **60,000 warning / 80,000 upgrade**. Monitor DO session and duration metrics,
   and avoid running a second independent budget namespace for the same traffic.
7. Watch Neon: projected compute **70 CU-hours warning / 80 upgrade**; projected
   transfer **3 GB warning / 4 upgrade**; Postgres storage including indexes
   **600 MiB warning / 750 MiB upgrade**. Check oldest retained timestamps, row
   counts, largest payload/audit rows, table/index sizes, autovacuum/dead tuples,
   endpoint connections, active compute size and other branches/restore usage.
   Fix a failed purge while there is still room for DELETE and vacuum.

Workers Paid ($5/month baseline) removes Hyperdrive's daily statement cap, increases
CPU and request headroom and provides monthly KV allowances. Neon is a separate
upgrade; Workers Paid does not buy Neon compute, storage or transfer. Raise/remove
ledger ceilings deliberately as part of that rollout, with dashboard evidence.
Password login can be enabled on Paid with CF_WEB_LOGIN_ENABLED=true.

Owner decisions: tune the enforced request/form, stored-payload and anonymous
admission caps; pagination or limits for full management/contribution/key lists;
active-user/key/attributed-pool admission ceilings; shorter retention of meaningful
audit/request history; and structured credential 503 envelopes. Remaining changes are listed instead
of silently truncating clients' lists or changing existing status/envelope formats.
Discovery manifests are refreshed by health sweeps, but normal cached authorization
expires after five minutes without extending through memo/edge reloads. During a
recorded outage last-good public-URL authorization can last longer.
Credential revocations remain immediate. Decide whether public-URL authorization
needs a shorter lag before relying on it as an access-control boundary. Do not drop
legacy `source_entries` or user/key rows until other deployments are verified retired.

## Setup, OAuth and owner deployment commands

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
workflows start driving the new deployment on their next run. The workflows already loop bounded `?batch=` calls until `done`.

## Local preview

```bash
# .dev.vars holds the same secret names for `wrangler dev` (gitignored):
#   SESSION_SECRET=…, POOL_ENCRYPTION_KEY=…, POOL_CLIENT_KEY=…, ADMIN_TOKEN_HASH=…, CRON_SECRET=…,
#   GITHUB_CLIENT_ID=…, GITHUB_CLIENT_SECRET=…
# Hyperdrive in dev: wrangler.jsonc's localConnectionString points at localhost:5432 —
# set it to a local Postgres (use a throwaway local database for tests).
pnpm preview:cf     # build + wrangler dev
curl http://localhost:8787/api/status
```
