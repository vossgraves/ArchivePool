// SPDX-License-Identifier: GPL-3.0-or-later
import { eq, sql } from "drizzle-orm"
import { atRestEncryptionEnabled, decryptAtRest, encryptAtRest } from "@/lib/crypto"
import { db } from "@/lib/db"
import { accountEntries, healthLog, instanceEntries } from "@/lib/db/schema"
import { ensureSchema } from "@/lib/db/ensure"
import {
  FetchBudgetExhausted,
  RowFetchBudgetExhausted,
  fetchBudgetExceeded,
  fetchBudgetRemaining,
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
const PER_ENTRY_FETCH_MAX = 24
// A cursor before every real row in the stalest-first order: pending=1 is the leading
// rank and ts=0/id=0 precedes any row (ids start at 1). Returned when a batch is cut
// before its first row so the driver retries the same position instead of a null.
const SWEEP_START_CURSOR = "1:0:0"
const STALE_AFTER_MS = 6 * 60 * 60 * 1000

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

export async function runHealthSweep(
  options: HealthSweepOptions | boolean = {},
): Promise<HealthSweepSummary> {
  const { force = false, limit, cursor: rawCursor } =
    typeof options === "boolean" ? { force: options, cursor: undefined } : options
  await ensureSchema()
  const allEntries = await allPoolEntries()
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
    // Migrate rows written by older deployments before checking. A Tidal check may rotate its
    // refresh token, so migrating afterwards could overwrite the newly issued credential.
    await db
      .update(table)
      .set({ payload: encryptAtRest(plaintextPayload) })
      .where(eq(table.id, entry.id))
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
      // Start a row only when the request still holds a full per-entry ceiling —
      // otherwise end the batch before it; it stays unconsumed and leads the next
      // call's queue (reported via budgetExhausted so the driver keeps retrying).
      if (fetchBudgetRemaining() < PER_ENTRY_FETCH_MAX) {
        budgetHit = true
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

  await db.execute(sql`delete from health_log where checked_at < now() - interval '30 days'`)
  // `attempted` = stale rows this call consumed (checked + no-verdict skips); `remaining` =
  // stale rows it never reached. `skipped` reports every row that got no verdict this call —
  // fresh rows plus no-verdict skips — matching what the callers read it as.
  // The consumed prefix ends before the first row whose attempt never returned —
  // a fetch-budget cut-off guarantees at least one such row exists when it tripped.
  let consumed = 0
  while (consumed < queue.length && finished[consumed]) consumed++
  const attempted = consumed
  const remaining = queue.length - consumed
  const skipped = allEntries.length - checked - remaining
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
    starved,
    disabled,
    reenabled,
    attempted,
    remaining,
    done: remaining === 0,
    cursor: nextCursor,
    budgetExhausted: budgetHit,
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
  // Migrate before checking: a Tidal check can rotate its refresh token, so writing the
  // migrated payload afterwards could clobber the newly issued credential.
  await db
    .update(table)
    .set({ payload: encryptAtRest(plaintextPayload) })
    .where(eq(table.id, entry.id))

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
  if (result.skipped) {
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
