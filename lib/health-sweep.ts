import { eq, sql } from "drizzle-orm"
import { atRestEncryptionEnabled, decryptAtRest, encryptAtRest } from "@/lib/crypto"
import { db } from "@/lib/db"
import { healthLog, sourceEntries } from "@/lib/db/schema"
import { runCheck } from "@/lib/health"
import type { Kind, Service } from "@/lib/sources"

const AUTO_DISABLE_AFTER = 5
const CONCURRENCY = 6
const STALE_AFTER_MS = 6 * 60 * 60 * 1000

async function mapLimit<T>(items: T[], limit: number, fn: (item: T) => Promise<void>) {
  let i = 0
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) {
      const idx = i++
      await fn(items[idx])
    }
  })
  await Promise.all(workers)
}

export async function runHealthSweep(force = false) {
  const allEntries = await db.select().from(sourceEntries).where(eq(sourceEntries.removed, false))
  if (allEntries.some((entry) => entry.kind === "account") && !atRestEncryptionEnabled()) {
    throw new Error("POOL_ENCRYPTION_KEY is required to process account credentials")
  }

  const now = Date.now()
  const entries = force
    ? allEntries
    : allEntries.filter((e) => !e.lastCheckedAt || now - new Date(e.lastCheckedAt).getTime() > STALE_AFTER_MS)

  const skipped = allEntries.length - entries.length
  let checked = 0
  let disabled = 0
  let reenabled = 0

  await mapLimit(entries, CONCURRENCY, async (entry) => {
    const plaintextPayload = decryptAtRest(entry.payload)
    // Migrate rows written by older deployments before checking. A Tidal check may rotate its
    // refresh token, so migrating afterwards could overwrite the newly issued credential.
    await db
      .update(sourceEntries)
      .set({ payload: encryptAtRest(plaintextPayload) })
      .where(eq(sourceEntries.id, entry.id))
    const result = await runCheck(entry.service as Service, entry.kind as Kind, plaintextPayload, entry.fingerprint)
    checked++

    const nextConsecutive = result.ok ? 0 : entry.consecutiveFailures + 1
    let nextDisabled = entry.disabled
    if (!result.ok && nextConsecutive >= AUTO_DISABLE_AFTER) {
      if (!entry.disabled) disabled++
      nextDisabled = true
    } else if (result.ok && entry.disabled) {
      nextDisabled = false
      reenabled++
    }

    await db
      .update(sourceEntries)
      .set({
        status: result.status,
        premium: result.premium,
        detail: result.detail,
        latencyMs: result.latencyMs,
        consecutiveFailures: nextConsecutive,
        disabled: nextDisabled,
        checkCount: sql`${sourceEntries.checkCount} + 1`,
        okCount: sql`${sourceEntries.okCount} + ${result.ok ? 1 : 0}`,
        lastCheckedAt: new Date(),
      })
      .where(eq(sourceEntries.id, entry.id))

    await db.insert(healthLog).values({
      entryId: entry.id,
      ok: result.ok,
      premium: result.premium,
      latencyMs: result.latencyMs,
      detail: result.detail,
    })
  })

  await db.execute(sql`delete from health_log where checked_at < now() - interval '30 days'`)
  return { checked, skipped, disabled, reenabled }
}
