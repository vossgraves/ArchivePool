// SPDX-License-Identifier: GPL-3.0-or-later
import { eq, sql } from "drizzle-orm"
import { atRestEncryptionEnabled, decryptAtRest, encryptAtRest } from "@/lib/crypto"
import { db } from "@/lib/db"
import { accountEntries, healthLog, instanceEntries } from "@/lib/db/schema"
import { ensureSchema } from "@/lib/db/ensure"
import { runCheck } from "@/lib/health"
import type { Kind, Service } from "@/lib/sources"

const AUTO_DISABLE_AFTER = 5
const CONCURRENCY = 6
// Batched sweeps run leaner fan-out: the in-flight overshoot past `limit` (≤ workers−1
// checks) then stays well inside a host's per-request subrequest ceiling.
const BATCH_CONCURRENCY = 3
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
}

export interface HealthSweepSummary {
  checked: number
  /** Rows that got no verdict this call — fresh entries plus no-verdict skips. */
  skipped: number
  disabled: number
  reenabled: number
  /** Stale rows consumed this call (checked + skipped-without-verdict). */
  attempted: number
  /** Stale entries still waiting after this call — always 0 for an unbatched sweep. */
  remaining: number
  /** False while a batch-driving caller must invoke the sweep again to finish it. */
  done: boolean
}

export async function runHealthSweep(
  options: HealthSweepOptions | boolean = {},
): Promise<HealthSweepSummary> {
  const { force = false, limit } = typeof options === "boolean" ? { force: options } : options
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

  let i = 0
  let inFlight = 0
  let checked = 0
  let disabled = 0
  let reenabled = 0

  // Drain the sorted list until `limit` checks have actually run — or it ends. A row whose
  // check is skipped without a verdict (refresh cooling, claim lost) persists nothing and
  // stays stale; consuming it inside THIS call both passes it over for now and guarantees
  // convergence: each call either clears `limit` stale rows or exhausts the list, and an
  // all-skipped pass still ends with remaining = 0. No cursor is carried between calls —
  // the attempted prefix is derivable from the stale order itself.
  const attempt = async (entry: (typeof stale)[number]) => {
    const table = entry.kind === "account" ? accountEntries : instanceEntries
    const plaintextPayload = decryptAtRest(entry.payload)
    // Migrate rows written by older deployments before checking. A Tidal check may rotate its
    // refresh token, so migrating afterwards could overwrite the newly issued credential.
    await db
      .update(table)
      .set({ payload: encryptAtRest(plaintextPayload) })
      .where(eq(table.id, entry.id))
    const result = await runCheck(entry.service as Service, entry.kind as Kind, plaintextPayload, entry.fingerprint)
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
  }

  const concurrency = limit == null ? CONCURRENCY : Math.min(CONCURRENCY, BATCH_CONCURRENCY)
  const workers = Array.from({ length: Math.min(concurrency, stale.length) }, async () => {
    while (i < stale.length && (limit == null || checked + inFlight < limit)) {
      const entry = stale[i++]
      inFlight++
      try {
        await attempt(entry)
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
  const attempted = i
  const remaining = stale.length - attempted
  const skipped = allEntries.length - checked - remaining
  return { checked, skipped, disabled, reenabled, attempted, remaining, done: remaining === 0 }
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
