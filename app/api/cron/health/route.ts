import { eq, sql } from "drizzle-orm"
import { NextResponse, type NextRequest } from "next/server"
import { decryptAtRest } from "@/lib/crypto"
import { db } from "@/lib/db"
import { healthLog, sourceEntries } from "@/lib/db/schema"
import { runCheck } from "@/lib/health"
import type { Kind, Service } from "@/lib/sources"

export const dynamic = "force-dynamic"
export const maxDuration = 60

const AUTO_DISABLE_AFTER = 5  // consecutive failures before an entry leaves the pool
const CONCURRENCY = 6
// Only re-check an entry if it hasn't been checked in the last 6 hours. The cron fires
// every 30 min but we don't need to hammer every entry that frequently.
const STALE_AFTER_MS = 6 * 60 * 60 * 1000

function authorized(req: NextRequest): boolean {
  // Vercel Cron requests include this header. Manual runs can pass the admin/cron secret.
  if (req.headers.get("x-vercel-cron")) return true
  const auth = req.headers.get("authorization")
  const cronSecret = process.env.CRON_SECRET
  const adminToken = process.env.ADMIN_TOKEN
  if (cronSecret && auth === `Bearer ${cronSecret}`) return true
  if (adminToken && auth === `Bearer ${adminToken}`) return true
  return false
}

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
  // Skip entries that were checked recently unless force=true (e.g. admin manual trigger).
  const now = Date.now()
  const entries = force
    ? allEntries
    : allEntries.filter((e) => !e.lastCheckedAt || now - new Date(e.lastCheckedAt).getTime() > STALE_AFTER_MS)

  const skipped = allEntries.length - entries.length
  let checked = 0
  let disabled = 0
  let reenabled = 0

  await mapLimit(entries, CONCURRENCY, async (entry) => {
    const result = await runCheck(entry.service as Service, entry.kind as Kind, decryptAtRest(entry.payload))
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

  // Trim old health-log rows to keep the table lean (keep ~30 days).
  await db.execute(sql`delete from health_log where checked_at < now() - interval '30 days'`)

  return { checked, skipped, disabled, reenabled }
}

export async function GET(req: NextRequest) {
  if (!authorized(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 })
  const summary = await runHealthSweep()
  return NextResponse.json({ ok: true, ...summary, ranAt: new Date().toISOString() })
}
