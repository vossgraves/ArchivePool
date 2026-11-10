// SPDX-License-Identifier: GPL-3.0-or-later
import "server-only"
import { and, eq, inArray, sql } from "drizzle-orm"
import { encryptAtRest } from "@/lib/crypto"
import { db } from "@/lib/db"
import { instanceEntries } from "@/lib/db/schema"
import { ensureSchema } from "@/lib/db/ensure"
import { runCheck } from "@/lib/health"
import { cfBindings, FetchBudgetExhausted, fetchBudgetExceeded } from "@/lib/cf-env"
import { fingerprint, isBlockedInstanceUrl, maskLabel, normalizeUrl, type Service } from "@/lib/sources"

export interface InstanceSyncResult {
  fetched: number // unique URLs handed in (the whole candidate list, before any slicing)
  skipped: number // already in pool and recently checked (by fingerprint)
  checked: number // actually health-checked this run
  added: number // passed check, newly inserted
  updated: number // already existed, status updated
  failed: number // health check did not pass
  rejected: number // reachable but not premium/hi-res — not added (new) per pool policy
  /** Probes that reached no verdict (the host's own rate limiter answered 429): nothing is
   *  persisted, and the next sweep re-probes them. */
  deferred: number
  /** Per-candidate verdicts for this slice, bounded to `opts.detailLimit`. The cron log is the
   *  only place a failed candidate's reason is visible, and "12 checked, 12 failed" with no
   *  reason is exactly what made the all-fail runs undiagnosable. */
  results?: { url: string; status: string; ok: boolean; premium: boolean; detail: string }[]
  /** Present only when the call was bounded (opts.limit): keyset cursor for the next
   *  slice — repeat with after=batch.nextAfter until done. */
  batch?: {
    total: number
    after: string | null
    nextAfter: string | null
    done: boolean
    /** The slice stopped early because the request's outbound-fetch budget was spent. */
    budgetExhausted?: boolean
  }
}

/** Instances checked more recently than this are skipped, so a sweep never hammers live hosts. */
const DEFAULT_RECHECK_WINDOW_MS = 6 * 60 * 60 * 1000

/**
 * Each health check allows up to 12s. A serial loop over a ten-entry feed can hit 2 minutes and
 * blow a cron route's maxDuration=60 (Vercel then kills it with FUNCTION_INVOCATION_TIMEOUT → 504).
 * Five workers cap the worst case at ~3 batches × 12s ≈ 36s while keeping per-entry DB writes
 * sequential within a worker, so the added/updated/failed accounting stays exact.
 */
const DEFAULT_CONCURRENCY = 5

/**
 * Health-checks a list of instance base URLs for one service and upserts the passing (premium)
 * ones as `kind=api` entries, updating rather than recreating any that already exist. This is the
 * shared core behind every instance feed (monochrome, the SpotiFLAC HiFi list, …): a feed
 * module only has to produce the URLs and hand them here.
 *
 * Pool policy, identical for every feed: an instance must be reachable AND advertise hi-res to be
 * pooled. A reachable-but-not-premium instance is never added; an existing one is disabled so the
 * discovery and lease feeds stop serving it, and re-enables automatically if a later sweep finds it
 * premium again. Public HiFi instances are frequently unsubscribed and therefore preview-only, so
 * expect most of a community list to land in `rejected` rather than `added` — that is the gate
 * doing its job, not a bug.
 *
 * @param service the pool service these URLs belong to (e.g. "tidal")
 * @param urls    candidate base URLs; normalized and de-duplicated internally
 * @param opts.note        optional origin marker stored on new payloads (encrypted at rest)
 * @param opts.recheckWindowMs  skip alive entries checked more recently than this
 * @param opts.concurrency number of instances health-checked in parallel
 * @param opts.after/opts.limit  bound this call to a slice of the sorted candidate list:
 *   rows strictly after `after`, at most `limit`. Hosts with per-request ceilings
 *   (Workers free tier) page through with the batch.nextAfter cursor the previous call
 *   returned; leave unset everywhere else.
 */
export async function syncInstanceUrls(
  service: Service,
  urls: string[],
  opts: {
    note?: string
    recheckWindowMs?: number
    concurrency?: number
    after?: string
    limit?: number
    /** Cap on per-candidate verdicts echoed back in `results` (0 disables). */
    detailLimit?: number
  } = {},
): Promise<InstanceSyncResult> {
  if (cfBindings()) opts = { ...opts, limit: Math.min(opts.limit ?? 8, 10), concurrency: Math.min(opts.concurrency ?? 3, 3) }
  await ensureSchema()

  const recheckWindowMs = opts.recheckWindowMs ?? DEFAULT_RECHECK_WINDOW_MS
  const concurrency = opts.concurrency ?? DEFAULT_CONCURRENCY
  const detailLimit = Math.max(0, opts.detailLimit ?? 0)

  // Sorted so a bounded run can keyset-paginate on `after` — a live feed refetched
  // between calls may grow or shrink, but a >-cursor over the sorted set still converges
  // (a brand-new URL simply lands in a later or next sweep).
  // Upstream-blocked hosts are dropped here, in the shared core, so no feed can reintroduce them.
  const allUrls = Array.from(
    new Set(
      urls
        .map((u) => normalizeUrl(String(u)))
        .filter((u) => u.startsWith("http"))
        .filter((u) => !isBlockedInstanceUrl(u)),
    ),
  ).sort()
  const startIndex = opts.after == null ? 0 : allUrls.findIndex((u) => u > opts.after!)
  const from = startIndex < 0 ? allUrls.length : startIndex
  const work = opts.limit == null ? allUrls : allUrls.slice(from, from + Math.max(1, opts.limit))

  const result: InstanceSyncResult = {
    fetched: allUrls.length,
    skipped: 0,
    checked: 0,
    added: 0,
    updated: 0,
    failed: 0,
    rejected: 0,
    deferred: 0,
  }
  if (detailLimit > 0) result.results = []
  if (opts.limit != null) {
    result.batch = {
      total: allUrls.length,
      after: opts.after ?? null,
      nextAfter: work.length > 0 ? work[work.length - 1] : opts.after ?? null,
      done: from + work.length >= allUrls.length,
    }
  }
  if (work.length === 0) return result

  // Load existing fingerprints for this service so known-good, recently-checked entries are
  // skipped instead of re-probed on every sweep.
  const existingRows = await db
    .select({
      fingerprint: instanceEntries.fingerprint,
      lastCheckedAt: instanceEntries.lastCheckedAt,
      status: instanceEntries.status,
      disabled: instanceEntries.disabled,
      removed: instanceEntries.removed,
    })
    .from(instanceEntries)
    .where(and(eq(instanceEntries.service, service), inArray(instanceEntries.fingerprint,
      work.map((baseUrl) => fingerprint(service, "api", { baseUrl })),
    )))

  const fingerprintMap = new Map(existingRows.map((r) => [r.fingerprint, r]))

  async function checkAndUpsert(baseUrl: string) {
    const payload: Record<string, unknown> = opts.note ? { baseUrl, note: opts.note } : { baseUrl }
    const fp = fingerprint(service, "api", payload)
    const existing = fingerprintMap.get(fp)

    if (existing && !existing.removed) {
      const recentlyChecked =
        existing.lastCheckedAt &&
        Date.now() - new Date(existing.lastCheckedAt).getTime() < recheckWindowMs
      const currentlyAlive = existing.status === "alive" || existing.status === "preview"
      if (recentlyChecked && currentlyAlive && !existing.disabled) {
        result.skipped++
        return
      }
    }

    const check = await runCheck(service, "api", payload)
    // Same taint guard as the sweep: a verdict computed after the request's fetch
    // budget tripped may be a declined fetch flattened into "dead" by a check's own
    // error handling. Discard it — this candidate counts as unfinished, the batch
    // stops, and nextAfter already points before it for the next call to resume.
    if (fetchBudgetExceeded()) throw new FetchBudgetExhausted()
    if (result.results && result.results.length < detailLimit) {
      result.results.push({
        url: baseUrl,
        status: check.status,
        ok: check.ok,
        premium: check.premium,
        detail: check.detail,
      })
    }
    // A probe that reached no verdict (the host's own rate limiter answered, or a refresh did not
    // run) says nothing about the instance: nothing is persisted and the next sweep re-probes it.
    if (check.skipped) {
      result.deferred++
      return
    }
    result.checked++

    if (!check.ok) {
      result.failed++
      if (existing && !existing.removed) {
        await db
          .update(instanceEntries)
          .set({
            status: check.status,
            premium: check.premium,
            detail: check.detail,
            latencyMs: check.latencyMs,
            consecutiveFailures: sql`${instanceEntries.consecutiveFailures} + 1`,
            checkCount: sql`${instanceEntries.checkCount} + 1`,
            lastCheckedAt: new Date(),
          })
          .where(eq(instanceEntries.fingerprint, fp))
        result.updated++
      }
      return
    }

    if (!check.premium) {
      result.rejected++
      if (existing && !existing.removed) {
        await db
          .update(instanceEntries)
          .set({
            status: check.status,
            premium: false,
            detail: `reachable but not premium (${check.detail})`,
            latencyMs: check.latencyMs,
            disabled: true,
            checkCount: sql`${instanceEntries.checkCount} + 1`,
            lastCheckedAt: new Date(),
          })
          .where(eq(instanceEntries.fingerprint, fp))
        result.updated++
      }
      return
    }

    const label = maskLabel(service, "api", payload)
    const storedPayload = encryptAtRest(payload)
    const isNew = !existing

    await db
      .insert(instanceEntries)
      .values({
        service,
        label,
        payload: storedPayload,
        fingerprint: fp,
        status: check.status,
        premium: check.premium,
        detail: check.detail,
        latencyMs: check.latencyMs,
        checkCount: 1,
        okCount: 1,
        consecutiveFailures: 0,
        lastCheckedAt: new Date(),
        ...(check.ok ? { lastOkAt: sql`now()` } : {}),
        disabled: false,
        removed: false,
        removedAt: null,
      })
      .onConflictDoUpdate({
        target: instanceEntries.fingerprint,
        set: {
          status: check.status,
          premium: check.premium,
          detail: check.detail,
          latencyMs: check.latencyMs,
          consecutiveFailures: 0,
          disabled: false,
          removed: false,
          removedAt: null,
          checkCount: sql`${instanceEntries.checkCount} + 1`,
          okCount: sql`${instanceEntries.okCount} + 1`,
          ...(check.ok ? { lastOkAt: sql`now()` } : {}),
          lastCheckedAt: new Date(),
        },
      })

    if (isNew) result.added++
    else result.updated++
  }

  let next = 0
  let budgetHit = false
  // Candidates whose check returned are the consumed prefix; a candidate interrupted by
  // the fetch budget stays unfinished, and nextAfter must end before it so the next
  // slice resumes at exactly that URL.
  const finished = new Array<boolean>(work.length).fill(false)
  const workers = Array.from({ length: Math.min(concurrency, work.length) }, async () => {
    while (!budgetHit && next < work.length) {
      const idx = next++
      try {
        await checkAndUpsert(work[idx])
        finished[idx] = true
      } catch (e) {
        if (e instanceof FetchBudgetExhausted) {
          budgetHit = true
        } else {
          throw e
        }
      }
    }
  })
  await Promise.all(workers)

  if (opts.limit != null) {
    let consumed = 0
    while (consumed < work.length && finished[consumed]) consumed++
    result.batch = {
      total: allUrls.length,
      after: opts.after ?? null,
      nextAfter: consumed > 0 ? work[consumed - 1] : (opts.after ?? null),
      done: consumed === work.length && from + work.length >= allUrls.length,
      budgetExhausted: budgetHit,
    }
  }

  return result
}
