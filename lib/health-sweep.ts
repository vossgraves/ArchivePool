// SPDX-License-Identifier: GPL-3.0-or-later
import { and, eq, sql } from "drizzle-orm"
import { atRestEncryptionEnabled, decryptAtRest, encryptAtRest, hasPlaintextSecret } from "@/lib/crypto"
import { db } from "@/lib/db"
import { accountEntries, healthLog, instanceEntries } from "@/lib/db/schema"
import { ensureSchema } from "@/lib/db/ensure"
import {
  FetchBudgetExhausted,
  cfBindings,
  RowFetchBudgetExhausted,
  fetchBudgetExceeded,
  fetchHeadroom,
  rowFetchExhausted,
  runWithFetchCeiling,
} from "@/lib/cf-env"
import { runCheck } from "@/lib/health"
import type { Kind, Service } from "@/lib/sources"

const AUTO_DISABLE_AFTER = 5
const CONCURRENCY = 6
// Batched sweeps run leaner fan-out: the in-flight overshoot past `limit` (≤ workers−1
// checks) then stays well inside a host's per-request subrequest ceiling.
const BATCH_CONCURRENCY = 3
// Hard cap on rows CONSUMED per batched call (real checks + no-verdict skips). Skips are
// not free: a check that bails inside a refresh/cooldown path can already have spent
// upstream fetches (session exchange, claim poll) plus its encryption and SQL writes —
// up to ~4 subrequests a row, so 12 keeps a call under the 50-subrequest ceiling.
const ATTEMPT_MAX = 12
// A single row may not burn the whole request budget: pathological entries (Qobuz
// secret-heal loops, long redirect chains) get a per-entry fetch ceiling. A batch only
// STARTS a row when a full ceiling still fits the remaining request budget; a row that
// hits the ceiling is an explicit no-verdict skip (starved) — consumed, so the cursor
// still advances past it and it can never starve the queue.
//
// The full-ceiling admission is deliberate and is what scripts/sim-fetch-budget.mjs pins: with a
// smaller reserve, several rows are admitted whose ceilings together exceed the budget, so the
// request budget can cut every one of them mid-check and none reaches a verdict. Admitting only
// what a whole ceiling fits keeps each started row finishable; rows then serialize and the
// unspent share of a finished ceiling is what lets the next one start.
const PER_ENTRY_FETCH_MAX = 24
// A cursor before every real row in the stalest-first order: pending=1 is the leading
// rank and ts=0/id=0 precedes any row (ids start at 1). Returned when a batch is cut
// before its first row so the driver retries the same position instead of a null.
const SWEEP_START_CURSOR = "1:0:0"
// Deliberately shorter than the 6-hourly cron that drives the sweep: with a window equal to the
// cadence, a row checked just under 6 h ago is "fresh" at the next run and is skipped again,
// so every row was really verified only every other run (12 h) — which is also how long a Tidal
// account could sit on an hour-dead access token. 5 h guarantees each run sweeps every row.
const STALE_AFTER_MS = 5 * 60 * 60 * 1000

type PoolEntry = {
  id: number
  service: string
  label: string
  payload: Record<string, unknown>
  fingerprint: string
  status: string
  premium: boolean
  detail: string | null
  latencyMs: number | null
  consecutiveFailures: number
  checkCount: number
  okCount: number
  disabled: boolean
  removed: boolean
  lastCheckedAt: Date | null
  lastLeasedAt: Date | null
  createdAt: Date
} & { kind: "account" | "api" }

async function allPoolEntries(): Promise<PoolEntry[]> {
  const accounts = await db.select().from(accountEntries).where(eq(accountEntries.removed, false))
  const instances = await db.select().from(instanceEntries).where(eq(instanceEntries.removed, false))
  return [
    ...accounts.map((e) => ({ ...e, kind: "account" as const })),
    ...instances.map((e) => ({ ...e, kind: "api" as const })),
  ]
}

async function sweepBatch(force: boolean, cursor: SweepCursor | null) {
  const stale = force ? sql`true` : sql`status = 'pending' or last_checked_at is null or last_checked_at < now() - interval '5 hours'`
  const pending = sql`case when status = 'pending' then 1 else 0 end`
  // Millisecond precision matches the public cursor, including Postgres timestamps with µs.
  const ts = sql`floor(extract(epoch from coalesce(last_checked_at, 'epoch'::timestamptz)) * 1000)`
  const after = cursor ? sql`(${pending} < ${cursor.pending} or (${pending} = ${cursor.pending} and
    (${ts} > ${cursor.ts} or (${ts} = ${cursor.ts} and id > ${cursor.id}))))` : sql`true`
  const result = await db.execute(sql`
    with entries as materialized (
      select id, service, label, payload, fingerprint, status, premium, detail, latency_ms,
        consecutive_failures, check_count, ok_count, disabled, removed, last_checked_at, last_leased_at, created_at, 'account' as kind
      from account_entries where not removed and (expires_at is null or expires_at > now())
      union all
      select id, service, label, payload, fingerprint, status, premium, detail, latency_ms,
        consecutive_failures, check_count, ok_count, disabled, removed, last_checked_at, last_leased_at, created_at, 'api' as kind
      from instance_entries where not removed and (expires_at is null or expires_at > now())
    ), stale as materialized (select * from entries where ${stale}),
    queue as materialized (select * from stale where ${after}),
    batch as (select * from queue order by (status = 'pending') desc, last_checked_at asc nulls first, id limit 13)
    select (select count(*) from entries)::int as total,
      ((select count(*) from entries) - (select count(*) from stale))::int as fresh,
      (select count(*) from queue)::int as remaining, row_to_json(batch) as entry
    from (select 1) seed left join batch on true
  `)
  const rows = result.rows as { total: number; fresh: number; remaining: number; entry: Record<string, unknown> | null }[]
  const entries = rows.filter((r) => r.entry).map((r) => Object.fromEntries(
    Object.entries(r.entry!).map(([key, value]) => [key.replace(/_([a-z])/g, (_, letter: string) => letter.toUpperCase()), value]),
  ) as PoolEntry)
  return { entries, total: rows[0]?.total ?? 0, fresh: rows[0]?.fresh ?? 0, remaining: rows[0]?.remaining ?? 0 }
}

export interface HealthSweepOptions {
  /** Re-check every non-removed entry, ignoring the stale window. */
  force?: boolean
  /**
   * Cap on real checks this call. Hosts with per-request ceilings (the Workers
   * free tier: 50 subrequests, ~10 ms CPU) run the sweep as consecutive calls —
   * each drains the stalest-first list until `limit` verdicts are written or it
   * ends, passing over rows skipped without a verdict inside the call, so the
   * next call picks up where this one stopped and no cursor has to be carried
   * anywhere. Omit on hosts without those ceilings (Vercel, Railway, a one-off
   * admin run).
   */
  limit?: number
  /**
   * Keyset cursor ("pending:lastCheckedAtMs:id") a previous batched call returned —
   * continue the sweep strictly after that row in the stalest-first order. Unparseable
   * values are ignored: the call restarts at the head, which still converges.
   */
  cursor?: string
}

export interface HealthSweepSummary {
  checked: number
  /** Rows that got no verdict this call — fresh entries plus no-verdict skips. */
  skipped: number
  /** Of `skipped`: rows inside the stale window. Deliberate — they were verified recently and
   *  will be picked up again once they age out. Split out because "3 checked, 8 skipped" reads
   *  like starvation otherwise. */
  fresh: number
  /** Entries that burned through their per-entry fetch ceiling — consumed as a
   *  no-verdict skip (no dead verdict, no cooldown) so the cursor still advances. */
  starved: number
  disabled: number
  reenabled: number
  /** Stale rows consumed this call (checked + skipped-without-verdict). */
  attempted: number
  /** Stale entries still waiting after this call — always 0 for an unbatched sweep. */
  remaining: number
  /** False while a batch-driving caller must invoke the sweep again to finish it. */
  done: boolean
  /** Keyset of the last row this call consumed — pass back as `?cursor=`. Null unbatched. */
  cursor: string | null
  /** The call stopped early because the request's outbound-fetch budget was spent. */
  budgetExhausted: boolean
}

/** Position of a row in the stalest-first order — same key the sort applies. */
type SweepCursor = { pending: number; ts: number; id: number }

function cursorKey(e: PoolEntry): SweepCursor {
  return {
    pending: e.status === "pending" ? 1 : 0,
    ts: e.lastCheckedAt ? new Date(e.lastCheckedAt).getTime() : 0,
    id: e.id,
  }
}

function formatCursor(e: PoolEntry): string {
  const k = cursorKey(e)
  return `${k.pending}:${k.ts}:${k.id}`
}

function parseCursor(raw: string | undefined): SweepCursor | null {
  if (!raw) return null
  const m = /^([01]):(\d+):(\d+)$/.exec(raw)
  if (!m) return null
  return { pending: Number(m[1]), ts: Number(m[2]), id: Number(m[3]) }
}

function afterCursor(e: PoolEntry, c: SweepCursor): boolean {
  const k = cursorKey(e)
  // The order is pending DESC (parked rows first), then lastCheckedAt ASC, then id
  // ASC — so "after the cursor" means a LOWER pending rank, or equal rank with a
  // greater ts, or equal ts with a greater id. (No test harness exists in this
  // repo; keep this comparator structurally identical to the sort above.)
  return k.pending < c.pending || (k.pending === c.pending && (k.ts > c.ts || (k.ts === c.ts && k.id > c.id)))
}

/**
 * Encrypt a row an older deployment stored in plaintext, before the check runs so a rotation the
 * check persists is never overwritten afterwards. Already-encrypted rows are left alone and the
 * write is conditional on the payload this run read: the lease path refreshes Tidal credentials
 * while a sweep is in flight, and writing the sweep's snapshot back unconditionally would replace
 * a rotated refresh token with the spent one.
 */
async function migrateAtRest(entry: Pick<PoolEntry, "id" | "kind" | "payload">) {
  if (!hasPlaintextSecret(entry.payload)) return
  const table = entry.kind === "account" ? accountEntries : instanceEntries
  await db
    .update(table)
    .set({ payload: encryptAtRest(entry.payload) })
    .where(and(eq(table.id, entry.id), sql`${table.payload} = ${JSON.stringify(entry.payload)}::jsonb`))
}

export async function runHealthSweep(
  options: HealthSweepOptions | boolean = {},
): Promise<HealthSweepSummary> {
  const { force = false, limit: requestedLimit, cursor: rawCursor } =
    typeof options === "boolean" ? { force: options, cursor: undefined } : options
  const limit = cfBindings() ? Math.min(requestedLimit ?? 8, 10) : requestedLimit
  await ensureSchema()
  const batch = limit == null ? null : await sweepBatch(force, parseCursor(rawCursor))
  const allEntries = batch ? batch.entries : await allPoolEntries()
  if (allEntries.some((entry) => entry.kind === "account") && !atRestEncryptionEnabled()) {
    throw new Error("POOL_ENCRYPTION_KEY is required to process account credentials")
  }

  const now = Date.now()
  // Entries parked in `pending` by app `dead` reports are neither servable nor dead, so they are
  // re-verified promptly instead of waiting out the 6h stale window.
  const stale = force
    ? allEntries
    : allEntries.filter(
        (e) =>
          e.status === "pending" ||
          !e.lastCheckedAt ||
          now - new Date(e.lastCheckedAt).getTime() > STALE_AFTER_MS,
      )

  // Deterministic order, stalest first, so every batch makes progress the next call can rely on:
  // a checked row's lastCheckedAt turns fresh and drops it out of this set entirely. Parked
  // entries lead — a report-demoted row has no usable verdict until it is re-verified.
  stale.sort(
    (a, b) =>
      Number(b.status === "pending") - Number(a.status === "pending") ||
      (a.lastCheckedAt ? new Date(a.lastCheckedAt).getTime() : 0) -
        (b.lastCheckedAt ? new Date(b.lastCheckedAt).getTime() : 0) ||
      a.id - b.id,
  )

  // Keyset into the same ordering: rows a previous batch consumed sit before the cursor —
  // checked rows are fresh and gone anyway, but rows skipped without a verdict are still
  // stale; filtering them here stops a skipped prefix from heading every later batch.
  const cursor = parseCursor(rawCursor)
  const queue = cursor == null ? stale : stale.filter((e) => afterCursor(e, cursor))

  let i = 0
  let inFlight = 0
  let checked = 0
  let starved = 0
  let disabled = 0
  let reenabled = 0
  const fresh = batch ? batch.fresh : allEntries.length - stale.length

  // Drain the keyset-filtered list until `limit` verdicts are written, `maxAttempts`
  // rows are consumed, the per-request fetch budget trips, or it ends. A row whose check
  // is skipped without a verdict (refresh cooling, claim lost) persists nothing and stays
  // stale; consuming it counts toward the attempt cap so skips cannot spend unbounded
  // subrequests, and the returned cursor moves the next call past it — a skipped prefix
  // can neither starve the tail nor fake `done`. The hard floor under both caps is the
  // fetch budget itself (chargeFetch in lib/cf-env): ~40 real subrequests per request,
  // enforced at the socket, not estimated.
  const attempt = async (entry: (typeof stale)[number]) =>
    runWithFetchCeiling(PER_ENTRY_FETCH_MAX, async () => {
    const table = entry.kind === "account" ? accountEntries : instanceEntries
    const plaintextPayload = decryptAtRest(entry.payload)
    await migrateAtRest(entry)
    const result = await runCheck(entry.service as Service, entry.kind as Kind, plaintextPayload, entry.fingerprint)
    // A verdict computed after the request's fetch budget tripped is unreliable: the
    // declining chargeFetch may have been flattened into a "dead" by a check's own
    // error handling. Discard it — this row counts as NOT consumed and the batch
    // stops, so the cursor ends before it and it is retried with a fresh budget.
    if (fetchBudgetExceeded()) throw new FetchBudgetExhausted()
    // Same guard for the per-entry ceiling: a result computed past it is unreliable —
    // report the row starved and advance the cursor instead of trusting a verdict.
    if (rowFetchExhausted()) throw new RowFetchBudgetExhausted()
    // A skipped result means the check never reached a verdict (refresh cooling, claim lost):
    // nothing persisted — no counter advance, no verdict overwrite, no health_log row.
    if (result.skipped) return
    checked++

    // The entry snapshot predates the probe by up to the whole mapLimit window; the write must
    // fold in whatever reports landed meanwhile, so the counter increments in place and a failed
    // check can only add to the disabled state, never undo one. The summary counters below stay
    // snapshot-based — they are observability, not state.
    if (!result.ok && entry.consecutiveFailures + 1 >= AUTO_DISABLE_AFTER) {
      if (!entry.disabled) disabled++
    } else if (result.ok && !result.premium) {
      // Working but no premium entitlement (free tier / lossy-only instance): disable
      // immediately — the pool only serves premium sources. Applies to every kind; the
      // entry self-heals on a later sweep if the entitlement returns (ok && premium).
      if (!entry.disabled) disabled++
    } else if (result.ok && entry.disabled) {
      reenabled++
    }

    await db
      .update(table)
      .set({
        status: result.status,
        premium: result.premium,
        detail: result.detail,
        latencyMs: result.latencyMs,
        consecutiveFailures: result.ok ? 0 : sql`${table.consecutiveFailures} + 1`,
        disabled: result.ok
          ? !result.premium
          : sql`${table.disabled} or (${table.consecutiveFailures} + 1) >= ${AUTO_DISABLE_AFTER}`,
        ...(result.ok ? { lastOkAt: sql`now()` } : {}),
        checkCount: sql`${table.checkCount} + 1`,
        okCount: sql`${table.okCount} + ${result.ok ? 1 : 0}`,
        lastCheckedAt: new Date(),
      })
      .where(eq(table.id, entry.id))

    await db.insert(healthLog).values({
      entryId: entry.id,
      ok: result.ok,
      premium: result.premium,
      latencyMs: result.latencyMs,
      detail: result.detail,
    })
    })

  let budgetHit = false
  let headroomBlocked = false
  // Rows whose attempt RETURNED (verdict persisted or clean no-verdict skip) are the
  // consumed prefix; a row that hit the fetch budget throws and stays unconsumed, so
  // the emitted cursor ends before it — done:false and it leads the next batch.
  const finished = new Array<boolean>(queue.length).fill(false)
  const concurrency = limit == null ? CONCURRENCY : Math.min(CONCURRENCY, BATCH_CONCURRENCY)
  // Total consumption is capped too — a skipped row is still an attempt, and attempts are
  // what spend subrequests (fetches inside a check before it can return skipped).
  const maxAttempts = limit == null ? Number.POSITIVE_INFINITY : Math.min(limit * 2, ATTEMPT_MAX)
  const workers = Array.from({ length: Math.min(concurrency, queue.length) }, async () => {
    while (
      !budgetHit &&
      i < queue.length &&
      (limit == null || (checked + inFlight < limit && i < maxAttempts))
    ) {
      // Start a row only when the request still has a full ceiling of head-room —
      // real spend PLUS other rows' outstanding reservations. Checking head-room and
      // reserving inside attempt() happen in one synchronous stretch, so concurrent
      // workers cannot oversubscribe and split the budget into starved slices. A row
      // that does not fit is a SOFT stop for THIS worker only: it exits, but
      // in-flight workers keep pulling — a finished row releases its unspent ceiling
      // and the head-room it returns can admit the next row (unlike a true budget
      // trip, which is terminal for every worker).
      if (fetchHeadroom() < PER_ENTRY_FETCH_MAX) {
        // This worker stops; it does NOT follow that the batch ran out of budget. The worker above
        // may still drain the queue — a sweep whose last row is taken by another worker used to log
        // `budgetExhausted: true` and read like starvation (observed: checked=3, remaining=0,
        // done=true, budgetExhausted=true). The flag is decided after the workers join, from what is
        // actually left unconsumed.
        headroomBlocked = true
        break
      }
      const idx = i++
      const entry = queue[idx]
      inFlight++
      try {
        await attempt(entry)
        finished[idx] = true
      } catch (e) {
        if (e instanceof FetchBudgetExhausted) {
          budgetHit = true
        } else if (e instanceof RowFetchBudgetExhausted) {
          starved++ // no verdict, no cooldown — but consumed, so the cursor moves on
          finished[idx] = true
        } else {
          throw e
        }
      } finally {
        inFlight--
      }
    }
  })
  await Promise.all(workers)

  // `attempted` = stale rows this call consumed (checked + no-verdict skips); `remaining` =
  // stale rows it never reached. `skipped` reports every row that got no verdict this call —
  // fresh rows plus no-verdict skips — matching what the callers read it as.
  // The consumed prefix ends before the first row whose attempt never returned —
  // a fetch-budget cut-off guarantees at least one such row exists when it tripped.
  let consumed = 0
  while (consumed < queue.length && finished[consumed]) consumed++
  const attempted = consumed
  const remaining = (batch?.remaining ?? queue.length) - consumed
  const skipped = (batch?.total ?? allEntries.length) - checked - remaining
  // Zero rows consumed (a budget cut on the first row): echo the incoming cursor —
  // or the start sentinel on the first call — so a non-null position always comes back
  // and the driver retries it rather than aborting on a missing cursor.
  const nextCursor =
    limit == null
      ? null
      : consumed > 0
        ? formatCursor(queue[consumed - 1])
        : rawCursor || SWEEP_START_CURSOR
  return {
    checked,
    skipped,
    fresh,
    starved,
    disabled,
    reenabled,
    attempted,
    remaining,
    done: remaining === 0,
    cursor: nextCursor,
    // Budget exhaustion means "work was left over because the request ran out of fetches": a
    // head-room block alone does not say that (another worker may have taken the last row), and the
    // driver reads this flag to decide whether an unchanged cursor is a retry or a bug. Reporting it
    // on a drained sweep made the log read like starvation when the queue was actually finished.
    budgetExhausted: budgetHit || (headroomBlocked && remaining > 0),
  }
}

/**
 * Check exactly one entry and persist the result, using the same rules as the full sweep
 * (auto-disable threshold, health_log append, at-rest payload migration). Used by the admin
 * panel so a single suspect account can be re-verified without sweeping the whole pool.
 *
 * Ids are globally unique across account_entries/instance_entries (shared sequence), so the
 * table is resolved by trying both.
 */
export async function checkEntryById(id: number, deadline?: AbortSignal) {
  await ensureSchema()
  const [account] = await db.select().from(accountEntries).where(eq(accountEntries.id, id)).limit(1)
  let entry: PoolEntry | undefined = account ? { ...account, kind: "account" } : undefined
  if (!entry) {
    const [instance] = await db.select().from(instanceEntries).where(eq(instanceEntries.id, id)).limit(1)
    if (instance) entry = { ...instance, kind: "api" }
  }
  if (!entry) return null
  if (entry.kind === "account" && !atRestEncryptionEnabled()) {
    throw new Error("POOL_ENCRYPTION_KEY is required to process account credentials")
  }

  const table = entry.kind === "account" ? accountEntries : instanceEntries
  const plaintextPayload = decryptAtRest(entry.payload)
  await migrateAtRest(entry)

  const result = await runCheck(
    entry.service as Service,
    entry.kind as Kind,
    plaintextPayload,
    entry.fingerprint,
    deadline,
  )

  // Failure accounting must fold in whatever landed between the entry snapshot above and this
  // write — report-path increments share the same counter — so a failed check bumps
  // consecutive_failures in place and can only ADD to the disabled state, never undo one a
  // racing report set. A successful check still overwrites both outright: it is the freshest
  // truth, and it also stamps last_ok_at, which is what tells reports its verdict outranks
  // theirs.
  // A skipped result means the check never reached a verdict (refresh cooling, claim lost):
  // no counter advance, no verdict overwrite, no health_log row — it must not count for the
  // report path's failure accounting either.
  if (result.skipped || fetchBudgetExceeded() || rowFetchExhausted()) {
    return {
      id: entry.id,
      ok: false,
      status: result.status,
      premium: result.premium,
      detail: result.detail,
      latencyMs: result.latencyMs,
      consecutiveFailures: entry.consecutiveFailures ?? 0,
      disabled: entry.disabled ?? false,
      skipped: true,
    }
  }

  // The health_log row rides in the same transaction: callers that treat a thrown check as
  // "nothing persisted" (the report path) cannot be double-charged by a half-written result.
  const [updated] = await db.transaction(async (tx) => {
    const rows = await tx
      .update(table)
      .set({
        status: result.status,
        premium: result.premium,
        detail: result.detail,
        latencyMs: result.latencyMs,
        consecutiveFailures: result.ok ? 0 : sql`${table.consecutiveFailures} + 1`,
        disabled: result.ok
          ? !result.premium // alive serves; preview is disabled by premium-only pool policy
          : sql`${table.disabled} or (${table.consecutiveFailures} + 1) >= ${AUTO_DISABLE_AFTER}`,
        ...(result.ok ? { lastOkAt: sql`now()` } : {}),
        checkCount: sql`${table.checkCount} + 1`,
        okCount: sql`${table.okCount} + ${result.ok ? 1 : 0}`,
        lastCheckedAt: new Date(),
      })
      .where(eq(table.id, entry.id))
      .returning({ consecutiveFailures: table.consecutiveFailures, disabled: table.disabled })

    await tx.insert(healthLog).values({
      entryId: entry.id,
      ok: result.ok,
      premium: result.premium,
      latencyMs: result.latencyMs,
      detail: result.detail,
    })
    return rows
  })

  return {
    id: entry.id,
    ok: result.ok,
    status: result.status,
    premium: result.premium,
    detail: result.detail,
    latencyMs: result.latencyMs,
    consecutiveFailures: updated?.consecutiveFailures ?? 0,
    disabled: updated?.disabled ?? false,
    skipped: false,
  }
}
