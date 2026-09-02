# Deep research: the 3-token lease model (2026-09-01)

Question under test (user): *"maybe the 3 tokens is kinda useless — if we have 2 tokens on
the pool it would fetch the 2 tokens from the pool indefinitely, right?"* — and the
follow-ups from the same thread: can a 3rd-party client bypass the 3-token cap by changing
UA / IP, and should there be a separate per-key table in the database?

Everything below was verified against the **live production database**
(Neon project `archivepool-live`, default branch) and the deployed
`archivepool.vercel.app` on 2026-09-01, not against assumptions.

---

## 1. Verdict on "3 tokens is useless"

**Confirmed — with a precision the hypothesis deserves.**

The lease is `leaseAccounts()` in `lib/queries.ts`:

```ts
const picked = rows.filter((r) => r.service === service).slice(0, LEASE_PER_CATEGORY_ACCOUNT)
```

over rows filtered by `accountServableWhere` (`removed=false, disabled=false,
status in ('alive','preview')`), ordered premium-first then
`last_leased_at ASC NULLS FIRST`.

- If a service has **≤ 3 servable accounts, every request returns all of them,
  every time, forever.** The cap never bites. With 2 tokens: both go out
  indefinitely. Confirmed exactly as the user stated.
- The cap only does anything when a service has **> 3** accounts. It bounds the
  *per-response* blast radius — one response never carries more than 3
  credentials per service.
- **But there is no per-key state.** `last_leased_at` is a column on
  `account_entries` — it is **global**, shared by every key in existence.
  Rotation therefore hands the rest of the pool to *any single key* across
  successive requests: with the live data (10 servable Qobuz accounts), one key
  drains the whole Qobuz pool in **4 requests**. That is comfortably inside one
  rate-limit window (30 req / 5 min per key).

So the honest description of the current design:

| Property | True today? |
| --- | --- |
| Caps credentials per HTTP response | yes (3/service) |
| Caps credentials per key over time | **no — global rotation, no per-key memory** |
| Spreads load across accounts | yes (that is what it actually does) |
| Throttles a leaked key | only via the 30/5min key limit, which 4 requests don't even approach |

The word "lease" suggests per-client bookkeeping. There is none. What exists is
a *rotating sample*, not a lease.

## 2. Live ground truth (queried 2026-09-01)

- Servable accounts: **Qobuz 10 (all premium, alive)**, **Tidal 1 (premium,
  alive)**, Deezer 0, Apple Music 0.
- Qobuz accounts entered the pool **Aug 26–29**; the Tidal account has existed
  since Aug 20. Any fetch or client cache from before Aug 26 legitimately
  contained `qobuz=0`.
- The Tidal **API instance** is disabled/dead — that is the "Tidal API down"
  line on `/api/status`. The account feed never serves instances, so it is
  unaffected.
- `api_keys`: 8 rows, **only one sees traffic** — `atp_e2f45f`
  "ArchiveTune (CI-baked app key)" (id 9, created 2026-08-30 15:31): 318 uses,
  last used today 12:38. The rotated key `atp_022bd3` (id 11, created
  2026-08-30 18:02 — exactly matching the CI secret update timestamp
  2026-08-30T18:02:48Z) has 2 uses, both from 18:03 that day (the post-rotation
  smoke test). Meaning: installed APKs from before the 18:02 rotation present
  key 9 and authenticate fine; CI builds from 2026-09-01 bake key 11.
  Both keys are valid.
- Lease stamps today arrive in bursts of 3 at 11:52, 12:12, 12:27, 12:38 —
  real authenticated `/api/accounts` fetches succeeding roughly every 15 min.
  The server side is **healthy**.

## 3. Why the app user saw "errors" and "1 tidal, 0 qobuz"

- **"1 tidal and 0 qobuz"** is the `pool_refresh_done` toast with the counts the
  *lease* returned, not the pool's contents. Before Aug 26 the feed genuinely
  had 1 tidal / 0 qobuz, so any cache from then shows exactly this. If a current
  build still reports 0 Qobuz, the two candidate paths are (a) the fetch is
  failing and the app is serving the stale cache, or (b) the 200-but-empty
  cache-preservation branch keeping an old empty list. Logs answer this
  unambiguously (section 6).
- **"Sometimes gives errors"** — the toast `pool_refresh_failed` fires on any
  non-200 or network exception. Historical cause: the revoked pasted key
  `atp_9084aa` ("My phone", revoked **and** deleted 2026-08-29) 401-ing until
  the app's self-heal (clear pasted key → retry with baked key) shipped. Current
  plausible cause: cold-start latency — Neon compute here has
  `suspend_timeout_seconds: 0`, so every idle-period request pays a compute
  wake, on top of Vercel function cold starts.
- **One design interaction worth knowing**: the app's refresh throttle is 24 h
  *only when every service has accounts*. With Deezer/Apple empty in the pool
  (`hasEveryService()` = false), every installed app refetches **every 15
  minutes** instead of every 24 h. That is why the lease stamps churn every
  ~15 min and why `use_count` climbed to 318 in ~45 h (~7/h). Harmless at one
  user; at ~90+ active devices behind one serverless instance the 30/5min key
  limit starts returning 429 to real users. (Multiple concurrent Vercel
  instances each keep their own in-memory window, so the effective ceiling is
  30 × instances — the code's own "honest limitation" comment.)

## 4. Bypass analysis — "can't they just change UA or IP?"

**They don't even need to.**

- **UA**: the feed routes never read `User-Agent`. The only UA consumer is the
  key-*request* spam guard on `/api/keys`. Changing UA changes nothing for
  `/api/accounts`.
- **IP**: the per-IP 120/min limit applies *before* auth and exists to bound
  key-guessing against the constant-time compare. With a valid key it is
  irrelevant; and it is in-memory per instance anyway.
- **Per-key 30/5min**: in-memory, per serverless instance, and even if honored
  perfectly it permits 30 × 3 = 90 accounts/min. A pool of any realistic size
  drains in minutes.
- **Registration → own key**: this door is actually closed. Signup is open, but
  POST `/api/keys` only files an admin-approval *request* (subject + ≥10-char
  reason, 1 per IP+UA per 30 days). No key is issued without approval. One user
  exists today.
- **The real bypass**: the CI-baked app key is a `BuildConfig` string in a
  public APK. `strings`/apktool on any release recovers `atp_e2f45f`. A
  3rd-party app presenting it is indistinguishable from a real ArchiveTune
  install, because the server deliberately authenticates only the key. **No
  lease cleverness closes this while one shared key is baked into a public
  artifact.**

Conclusion: the lease cap is not, and was never going to be, an
anti-extraction control. Its genuine value is per-response exposure bounding
and load spreading. Extraction cost today is "4 HTTP requests with a key that
ships inside the APK."

## 5. The separate-table idea — evaluation

Proposal (user's): a per-key table so each key's lease window is its own.

### What it buys

- Each key sees ≤ 3 accounts per rotation cycle. Walking N accounts then needs
  ⌈N/3⌉ **distinct keys**, each of which costs an admin approval — extraction
  goes from N/3 HTTP requests to N/3 social-engineering events. That is a real
  raise of the bar.
- Revoking a key instantly freezes its window (a leaked key stops being a
  walking iterator; today revocation only stops *new* requests, and the
  attacker has already walked everything).
- The `use_count` / `last_used_at` bookkeeping already on `api_keys` becomes
  genuinely diagnostic: a key whose distinct-entry footprint grows fast is
  either the shared app key doing its job or a walker.

### Costs and trade-offs

- **The shared app key breaks load spreading**: all ArchiveTune users present
  the same key, so a strictly sticky 3-account window would concentrate the
  entire user base on 3 Qobuz accounts while 7 idle. Mitigations, pick one or
  combine:
  - **TTL rotation per key** — re-pick the window every, say, 6–24 h; each key
    still rotates, just slowly.
  - **A larger window for the designated shared app key** (it is public anyway;
    its exposure is already total — its job is load spreading).
  - **Per-user pasted keys as the norm** — the app already supports a pasted
    personal key preference; that is the long-term trust model.
- **DB cost is marginal**: `/api/accounts` already executes 3–4 statements per
  request (verify SELECT, lease SELECT, `stampLeases` UPDATE, useCount UPDATE),
  so the Neon compute wakes either way. The rate-limit.ts argument against
  DB-backed state was about per-request limiter buckets, not lease bookkeeping.
  One indexed SELECT + one upsert per request is noise at this traffic level
  (~7 requests/h).
- **Concurrency**: two simultaneous requests from one key can double-assign;
  a PK `(key_id, entry_id)` upsert makes that benign.
- **Dead entries**: reassignment must be allowed immediately when an assigned
  entry is no longer servable, or keys get stranded on dead accounts.

### Recommended concrete shape

Table:

```sql
CREATE TABLE api_key_leases (
  key_id    integer NOT NULL REFERENCES api_keys(id) ON DELETE CASCADE,
  entry_id  integer NOT NULL REFERENCES account_entries(id) ON DELETE CASCADE,
  leased_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (key_id, entry_id)
);
CREATE INDEX idx_api_key_leases_entry ON api_key_leases (entry_id);
```

Selection: keep today's global premium-first / least-recently-leased ordering,
but **filter to entries this key either has never leased or leased before
`now() - TTL`**; fall back to the unfiltered global ordering when a key's
eligible set is empty (thin pool must degrade, not error — same principle the
code already states). Optional and the actual brake: a distinct-accounts-per-key
budget over a rolling window (e.g. ≤ 9 distinct entries per 30 days), which
converts "walk the pool" into a months-long project even for a valid key.

## 6. What the logs show (app side, for the record)

Every build plants `Timber.DebugTree` + `GlobalLogTree`; the pool client logs
under tag **`PoolAccounts`** and the in-app log viewer is the Logcat screen in
settings. The relevant lines:

- `Pool accounts refreshed: tidal=%d qobuz=%d deezer=%d apple=%d` — the lease
  result (note: capped at 3 per service by design, so "qobuz=3" is normal even
  with 10 in the pool).
- `Pool account feed %s returned HTTP %d` — 429, 5xx, etc.
- `Pool account feed rejected the presented key (HTTP 401) — it is revoked,
  deleted, or predates the pool's current database.`
- `Dropped encrypted pool field %s because no available key could decrypt it`
  — the signature of a key-mismatch (worth grepping if "0 qobuz" persists on a
  current build; it would mean token/appId/appSecret failing v2 decryption).
- `Pool returned empty account lists — keeping existing cache to avoid
  mid-playback source disappearance` — the stale-cache preservation branch.

## 7. Ranked: what actually protects the credentials

1. **Treat the baked app key as public.** Alert on `use_count` velocity and
   rotate when the pattern exceeds the plausible install base. This is the only
   lever that addresses the real bypass.
2. **Per-key lease windows + distinct-entry budget** (section 5) — raises
   extraction cost from HTTP requests to admin approvals.
3. **Keep the v2 response encryption** — it protects intermediaries, logs, and
   TLS-terminated proxies, not the client itself.
4. **Keep the rate limits** as friction, not as a control.
5. **Per-user keys** (app support already exists) as the end-state trust model,
   with the shared key demoted to a public fallback tier with its own window.

## 8. Incidental findings

- `suspend_timeout_seconds: 0` on the Neon compute guarantees a cold wake on
  the first request of every idle period. Combined with the app's 15-min
  partial refresh, most fetches hit a warm instance — but a 24 h+ gap always
  pays the wake. If "errors" persist, this is the first place to look before
  blaming the app.
- The 15-min partial refresh (because Deezer/Apple are empty in the pool)
  also means lease stamps and `use_count` grow ~96/day per device — worth
  remembering when reading those numbers as a user-count proxy.
- Keys `atp_47c47e` (id 2) and `atp_f943b7` (id 5) are valid, owner-less, and
  unused — candidates for cleanup or revocation if their values are not
  recorded anywhere.
