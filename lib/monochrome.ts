import "server-only"
import { eq, sql } from "drizzle-orm"
import { encryptAtRest } from "@/lib/crypto"
import { db } from "@/lib/db"
import { instanceEntries } from "@/lib/db/schema"
import { ensureSchema } from "@/lib/db/ensure"
import { runCheck } from "@/lib/health"
import { fingerprint, maskLabel, normalizeUrl } from "@/lib/sources"

/** Shape returned by https://monochrome.tf/instances.json */
interface MonochromeInstances {
  api?: string[]
  streaming?: string[]
}

const MONOCHROME_URL = "https://monochrome.tf/instances.json"
const FETCH_TIMEOUT_MS = 15_000

export interface MonochromeSyncResult {
  fetched: number   // unique URLs found in the feed
  skipped: number   // already in pool (by fingerprint)
  checked: number   // actually health-checked
  added: number     // passed check, newly inserted
  updated: number   // already existed, status updated
  failed: number    // health check did not pass
}

/**
 * Fetches the monochrome.tf instance list, deduplicates against existing pool
 * entries, health-checks each new URL, and upserts passing ones as
 * `service=tidal, kind=api` entries. Existing entries that share a fingerprint
 * are updated (status, latency, etc.) but never re-created from scratch.
 *
 * Returns a summary so the cron route can log and return it.
 */
export async function syncMonochromeInstances(): Promise<MonochromeSyncResult> {
  await ensureSchema()
  // 1. Fetch the feed.
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)
  let raw: MonochromeInstances
  try {
    const res = await fetch(MONOCHROME_URL, {
      signal: controller.signal,
      headers: { "user-agent": "ArchiveTune-SourcePool/1.0" },
      cache: "no-store",
    })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    raw = (await res.json()) as MonochromeInstances
  } finally {
    clearTimeout(timer)
  }

  // 2. Deduplicate: merge api + streaming arrays, normalise URLs, drop blanks.
  const allUrls = Array.from(
    new Set(
      [...(raw.api ?? []), ...(raw.streaming ?? [])]
        .map((u) => normalizeUrl(u))
        .filter((u) => u.startsWith("http")),
    ),
  )

  const result: MonochromeSyncResult = {
    fetched: allUrls.length,
    skipped: 0,
    checked: 0,
    added: 0,
    updated: 0,
    failed: 0,
  }

  if (allUrls.length === 0) return result

  // 3. Load existing fingerprints so we can skip known-good entries that were
  //    recently checked (avoid hammering instances on every 12h sweep).
  const existingRows = await db
    .select({
      fingerprint: instanceEntries.fingerprint,
      lastCheckedAt: instanceEntries.lastCheckedAt,
      status: instanceEntries.status,
      disabled: instanceEntries.disabled,
      removed: instanceEntries.removed,
    })
    .from(instanceEntries)
    .where(sql`${instanceEntries.service} = 'tidal'`)

  const fingerprintMap = new Map(existingRows.map((r) => [r.fingerprint, r]))

  // Re-check threshold: skip if last check was under 6 hours ago and the entry
  // is currently alive/preview and not disabled. New entries always get checked.
  const SIX_HOURS_MS = 6 * 60 * 60 * 1000

  // Check instances CONCURRENTLY instead of serially. Each health check allows up to 12s, and
  // monochrome.tf lists ~10 URLs — a serial worst case of 2 minutes exceeds the route's
  // maxDuration=60 and Vercel kills the invocation with FUNCTION_INVOCATION_TIMEOUT (the
  // intermittent HTTP 504s in the monochrome-cron workflow runs). 5 workers cap the worst case
  // at ~3 batches × 12s = 36s. Per-instance DB upserts stay sequential within a worker, so the
  // accounting (added/updated/failed) is unchanged.
  const CONCURRENCY = 5

  async function checkAndUpsert(baseUrl: string) {
    const payload: Record<string, unknown> = { baseUrl }
    const fp = fingerprint("tidal", "api", payload)
    const existing = fingerprintMap.get(fp)

    if (existing && !existing.removed) {
      const recentlyChecked =
        existing.lastCheckedAt &&
        Date.now() - new Date(existing.lastCheckedAt).getTime() < SIX_HOURS_MS
      const currentlyAlive =
        existing.status === "alive" || existing.status === "preview"

      if (recentlyChecked && currentlyAlive && !existing.disabled) {
        result.skipped++
        return
      }
    }

    // 4. Health-check the instance.
    result.checked++
    const check = await runCheck("tidal", "api", payload)

    if (!check.ok) {
      result.failed++
      // If it already exists in the pool, update its status so the sweep keeps
      // it accurate even when discovered via monochrome.
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

    // 5. Upsert the passing instance.
    const label = maskLabel("tidal", "api", payload)
    const storedPayload = encryptAtRest(payload)

    const isNew = !existing
    await db
      .insert(instanceEntries)
      .values({
        service: "tidal",
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
  const workers = Array.from({ length: Math.min(CONCURRENCY, allUrls.length) }, async () => {
    while (next < allUrls.length) {
      const url = allUrls[next++]
      await checkAndUpsert(url)
    }
  })
  await Promise.all(workers)

  return result
}
