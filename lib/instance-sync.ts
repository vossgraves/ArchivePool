import "server-only"
import { eq, sql } from "drizzle-orm"
import { encryptAtRest } from "@/lib/crypto"
import { db } from "@/lib/db"
import { instanceEntries } from "@/lib/db/schema"
import { ensureSchema } from "@/lib/db/ensure"
import { runCheck } from "@/lib/health"
import { fingerprint, maskLabel, normalizeUrl, type Service } from "@/lib/sources"

export interface InstanceSyncResult {
  fetched: number // unique URLs handed in
  skipped: number // already in pool and recently checked (by fingerprint)
  checked: number // actually health-checked this run
  added: number // passed check, newly inserted
  updated: number // already existed, status updated
  failed: number // health check did not pass
  rejected: number // reachable but not premium/hi-res — not added (new) per pool policy
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
 */
export async function syncInstanceUrls(
  service: Service,
  urls: string[],
  opts: { note?: string; recheckWindowMs?: number; concurrency?: number } = {},
): Promise<InstanceSyncResult> {
  await ensureSchema()

  const recheckWindowMs = opts.recheckWindowMs ?? DEFAULT_RECHECK_WINDOW_MS
  const concurrency = opts.concurrency ?? DEFAULT_CONCURRENCY

  const allUrls = Array.from(
    new Set(urls.map((u) => normalizeUrl(u)).filter((u) => u.startsWith("http"))),
  )

  const result: InstanceSyncResult = {
    fetched: allUrls.length,
    skipped: 0,
    checked: 0,
    added: 0,
    updated: 0,
    failed: 0,
    rejected: 0,
  }
  if (allUrls.length === 0) return result

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
    .where(eq(instanceEntries.service, service))

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

    result.checked++
    const check = await runCheck(service, "api", payload)

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
        disabled: false,
        removed: false,
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
          checkCount: sql`${instanceEntries.checkCount} + 1`,
          okCount: sql`${instanceEntries.okCount} + 1`,
          lastCheckedAt: new Date(),
        },
      })

    if (isNew) result.added++
    else result.updated++
  }

  let next = 0
  const workers = Array.from({ length: Math.min(concurrency, allUrls.length) }, async () => {
    while (next < allUrls.length) {
      await checkAndUpsert(allUrls[next++])
    }
  })
  await Promise.all(workers)

  return result
}
