import "server-only"
import { eq, sql } from "drizzle-orm"
import { encryptAtRest } from "@/lib/crypto"
import { db } from "@/lib/db"
import { sourceEntries } from "@/lib/db/schema"
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
      fingerprint: sourceEntries.fingerprint,
      lastCheckedAt: sourceEntries.lastCheckedAt,
      status: sourceEntries.status,
      disabled: sourceEntries.disabled,
      removed: sourceEntries.removed,
    })
    .from(sourceEntries)
    .where(sql`${sourceEntries.service} = 'tidal' and ${sourceEntries.kind} = 'api'`)

  const fingerprintMap = new Map(existingRows.map((r) => [r.fingerprint, r]))

  // Re-check threshold: skip if last check was under 6 hours ago and the entry
  // is currently alive/preview and not disabled. New entries always get checked.
  const SIX_HOURS_MS = 6 * 60 * 60 * 1000

  for (const baseUrl of allUrls) {
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
        continue
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
          .update(sourceEntries)
          .set({
            status: check.status,
            premium: check.premium,
            detail: check.detail,
            latencyMs: check.latencyMs,
            consecutiveFailures: sql`${sourceEntries.consecutiveFailures} + 1`,
            checkCount: sql`${sourceEntries.checkCount} + 1`,
            lastCheckedAt: new Date(),
          })
          .where(eq(sourceEntries.fingerprint, fp))
        result.updated++
      }
      continue
    }

    // 5. Upsert the passing instance.
    const label = maskLabel("tidal", "api", payload)
    const storedPayload = encryptAtRest(payload)

    const isNew = !existing
    await db
      .insert(sourceEntries)
      .values({
        service: "tidal",
        kind: "api",
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
        target: sourceEntries.fingerprint,
        set: {
          status: check.status,
          premium: check.premium,
          detail: check.detail,
          latencyMs: check.latencyMs,
          consecutiveFailures: 0,
          disabled: false,
          removed: false,
          checkCount: sql`${sourceEntries.checkCount} + 1`,
          okCount: sql`${sourceEntries.okCount} + 1`,
          lastCheckedAt: new Date(),
        },
      })

    if (isNew) result.added++
    else result.updated++
  }

  return result
}
