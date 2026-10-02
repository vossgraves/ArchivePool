import { eq, sql } from "drizzle-orm"
import { atRestEncryptionEnabled, decryptAtRest, encryptAtRest } from "@/lib/crypto"
import { db } from "@/lib/db"
import { accountEntries, healthLog, instanceEntries } from "@/lib/db/schema"
import { ensureSchema } from "@/lib/db/ensure"
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

export async function runHealthSweep(force = false) {
  await ensureSchema()
  const allEntries = await allPoolEntries()
  if (allEntries.some((entry) => entry.kind === "account") && !atRestEncryptionEnabled()) {
    throw new Error("POOL_ENCRYPTION_KEY is required to process account credentials")
  }

  const now = Date.now()
  // Entries parked in `pending` by app `dead` reports are neither servable nor dead, so they are
  // re-verified promptly instead of waiting out the 6h stale window.
  const entries = force
    ? allEntries
    : allEntries.filter(
        (e) =>
          e.status === "pending" ||
          !e.lastCheckedAt ||
          now - new Date(e.lastCheckedAt).getTime() > STALE_AFTER_MS,
      )

  const skipped = allEntries.length - entries.length
  let checked = 0
  let disabled = 0
  let reenabled = 0

  await mapLimit(entries, CONCURRENCY, async (entry) => {
    const table = entry.kind === "account" ? accountEntries : instanceEntries
    const plaintextPayload = decryptAtRest(entry.payload)
    // Migrate rows written by older deployments before checking. A Tidal check may rotate its
    // refresh token, so migrating afterwards could overwrite the newly issued credential.
    await db
      .update(table)
      .set({ payload: encryptAtRest(plaintextPayload) })
      .where(eq(table.id, entry.id))
    const result = await runCheck(entry.service as Service, entry.kind as Kind, plaintextPayload, entry.fingerprint)
    checked++

    const nextConsecutive = result.ok ? 0 : entry.consecutiveFailures + 1
    let nextDisabled = entry.disabled
    if (!result.ok && nextConsecutive >= AUTO_DISABLE_AFTER) {
      if (!entry.disabled) disabled++
      nextDisabled = true
    } else if (result.ok && !result.premium) {
      // Working but no premium entitlement (free tier / lossy-only instance): disable
      // immediately — the pool only serves premium sources. Applies to every kind; the
      // entry self-heals on a later sweep if the entitlement returns (ok && premium).
      if (!entry.disabled) disabled++
      nextDisabled = true
    } else if (result.ok && entry.disabled) {
      nextDisabled = false
      reenabled++
    }

    await db
      .update(table)
      .set({
        status: result.status,
        premium: result.premium,
        detail: result.detail,
        latencyMs: result.latencyMs,
        consecutiveFailures: nextConsecutive,
        disabled: nextDisabled,
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

  await db.execute(sql`delete from health_log where checked_at < now() - interval '30 days'`)
  return { checked, skipped, disabled, reenabled }
}

/**
 * Check exactly one entry and persist the result, using the same rules as the full sweep
 * (auto-disable threshold, health_log append, at-rest payload migration). Used by the admin
 * panel so a single suspect account can be re-verified without sweeping the whole pool.
 *
 * Ids are globally unique across account_entries/instance_entries (shared sequence), so the
 * table is resolved by trying both.
 */
export async function checkEntryById(id: number) {
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
  // migrated payload afterwards would clobber the newly issued credential.
  await db
    .update(table)
    .set({ payload: encryptAtRest(plaintextPayload) })
    .where(eq(table.id, entry.id))

  const result = await runCheck(entry.service as Service, entry.kind as Kind, plaintextPayload, entry.fingerprint)

  const nextConsecutive = result.ok ? 0 : entry.consecutiveFailures + 1
  let nextDisabled = entry.disabled
  if (!result.ok && nextConsecutive >= AUTO_DISABLE_AFTER) nextDisabled = true
  else if (result.ok && !result.premium) nextDisabled = true // premium-only pool policy
  else if (result.ok && entry.disabled) nextDisabled = false

  await db
    .update(table)
    .set({
      status: result.status,
      premium: result.premium,
      detail: result.detail,
      latencyMs: result.latencyMs,
      consecutiveFailures: nextConsecutive,
      disabled: nextDisabled,
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

  return {
    id: entry.id,
    ok: result.ok,
    status: result.status,
    premium: result.premium,
    detail: result.detail,
    latencyMs: result.latencyMs,
    consecutiveFailures: nextConsecutive,
    disabled: nextDisabled,
  }
}
