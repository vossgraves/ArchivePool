import "server-only"
import { and, desc, eq, sql } from "drizzle-orm"
import { decryptAtRest, encryptForClient } from "./crypto"
import { db } from "./db"
import { sourceEntries } from "./db/schema"
import { CATEGORIES, type Kind, type Service } from "./sources"

export interface CategoryStatus {
  service: Service
  kind: Kind
  label: string
  total: number
  alive: number
  premium: number
  dead: number
  pending: number
  uptimePct: number | null
  lastCheckedAt: string | null
  health: "operational" | "degraded" | "down" | "unknown"
}

/** Aggregate, credential-free status for the public page. */
export async function getStatus(): Promise<CategoryStatus[]> {
  const rows = await db
    .select({
      service: sourceEntries.service,
      kind: sourceEntries.kind,
      status: sourceEntries.status,
      premium: sourceEntries.premium,
      checkCount: sourceEntries.checkCount,
      okCount: sourceEntries.okCount,
      lastCheckedAt: sourceEntries.lastCheckedAt,
    })
    .from(sourceEntries)
    .where(eq(sourceEntries.removed, false))

  return CATEGORIES.map((cat) => {
    const items = rows.filter((r) => r.service === cat.service && r.kind === cat.kind)
    const alive = items.filter((r) => r.status === "alive" || r.status === "preview").length
    const premium = items.filter((r) => r.status === "alive" && r.premium).length
    const dead = items.filter((r) => r.status === "dead").length
    const pending = items.filter((r) => r.status === "pending").length
    const totalChecks = items.reduce((a, r) => a + r.checkCount, 0)
    const totalOk = items.reduce((a, r) => a + r.okCount, 0)
    const uptimePct = totalChecks > 0 ? Math.round((totalOk / totalChecks) * 1000) / 10 : null
    const lastChecked = items
      .map((r) => r.lastCheckedAt)
      .filter(Boolean)
      .sort()
      .pop()

    let health: CategoryStatus["health"] = "unknown"
    if (items.length > 0) {
      if (alive > 0 && premium > 0) health = "operational"
      else if (alive > 0) health = "degraded"
      else health = "down"
    }

    return {
      service: cat.service,
      kind: cat.kind,
      label: cat.label,
      total: items.length,
      alive,
      premium,
      dead,
      pending,
      uptimePct,
      lastCheckedAt: lastChecked ? new Date(lastChecked).toISOString() : null,
      health,
    }
  })
}

/**
 * The single definition of "this entry may be handed to an app": not removed, not auto-disabled,
 * and status alive or preview. `preview` counts because Tidal API keys commonly sit there while
 * serving fine. Anything gating pool availability MUST use this, not an ad-hoc status compare —
 * the admin UI mirrors it in isServable() and the two disagreeing is a real bug source.
 */
export const servableWhere = and(
  eq(sourceEntries.removed, false),
  eq(sourceEntries.disabled, false),
  sql`${sourceEntries.status} in ('alive','preview')`,
)

/**
 * How many entries a single request may hold per category.
 *
 * Deliberately not 1. The ArchiveTune app's only failure recovery is client-side:
 * LosslessStreamResolver iterates `PoolAccountManager.tidalAccounts()` and tries the next
 * credential when one fails. Leasing a single entry would turn any bad credential into a hard
 * playback failure on already-installed APKs, which cannot be fixed by a server change. A small
 * lease keeps that fallback working while cutting exposure from "the entire pool" to a handful.
 * Revisit once /api/report ships in the app and can request a replacement mid-session.
 */
export const LEASE_PER_CATEGORY = 3

/**
 * Leases up to LEASE_PER_CATEGORY entries per category instead of returning the whole pool.
 *
 * Selection is premium-first, then least-recently-leased, so traffic spreads across the pool
 * rather than hammering one account. `lastLeasedAt` is stamped after selection.
 *
 * Availability is never traded for exposure: a category holding fewer entries than the lease
 * size returns everything it has, and an empty category returns an empty list rather than an
 * error, so a thin pool degrades quality instead of breaking playback.
 */
export async function leasePool() {
  const rows = await db
    .select()
    .from(sourceEntries)
    .where(servableWhere)
    // NULLS FIRST: a never-leased entry is the least recently used, so it goes out before one
    // that already has a timestamp. Postgres defaults to NULLS LAST for ASC, hence explicit.
    // `id` last makes the ordering total, so equal timestamps can never produce an unstable
    // (and therefore unpredictable) rotation order.
    .orderBy(
      desc(sourceEntries.premium),
      sql`${sourceEntries.lastLeasedAt} asc nulls first`,
      sourceEntries.id,
    )

  const leasedIds: number[] = []

  // Credentials are stored encrypted at rest. Decrypt with the server key, then re-encrypt the
  // sensitive fields with the client key so the JSON leaving the server is ciphertext end-to-end
  // (the app decrypts locally). The route fails closed when POOL_CLIENT_KEY is absent.
  const group = (service: Service, kind: Kind) => {
    const picked = rows.filter((r) => r.service === service && r.kind === kind).slice(0, LEASE_PER_CATEGORY)
    for (const r of picked) leasedIds.push(r.id)
    return picked.map((r) => ({
      id: r.id,
      premium: r.premium,
      status: r.status,
      latencyMs: r.latencyMs,
      lastCheckedAt: r.lastCheckedAt ? new Date(r.lastCheckedAt).toISOString() : null,
      ...encryptForClient(decryptAtRest(r.payload)),
    }))
  }

  const pool = {
    tidal: { apis: group("tidal", "api"), accounts: group("tidal", "account") },
    qobuz: { apis: group("qobuz", "api"), accounts: group("qobuz", "account") },
    // Deezer is account-only. `apis` stays an empty list for shape symmetry so the app can parse
    // every service with the same code path.
    deezer: { apis: group("deezer", "api"), accounts: group("deezer", "account") },
  }

  // Stamp after selection so rotation advances.
  //
  // Each id gets a DISTINCT timestamp, 1ms apart. A single `SET last_leased_at = now()` over all
  // of them writes one identical value, which leaves the next request's ORDER BY facing a tie it
  // must break arbitrarily — entries then recur across consecutive calls instead of rotating.
  // Staggering keeps the ordering total, so the queue advances predictably.
  //
  // A failure here must not deny a client credentials it already holds, so the error is
  // swallowed; the only cost is that the same entries may be picked again next time.
  if (leasedIds.length > 0) {
    try {
      const base = Date.now()
      await db.transaction(async (tx) => {
        for (const [i, id] of leasedIds.entries()) {
          await tx
            .update(sourceEntries)
            .set({ lastLeasedAt: new Date(base + i) })
            .where(eq(sourceEntries.id, id))
        }
      })
    } catch (err) {
      console.error("[pool] failed to stamp lease timestamps", err)
    }
  }

  return { pool, leasedCount: leasedIds.length }
}

/**
 * Instance base URLs for one service, ranked premium-first. Shaped as `{ streaming, api }`
 * so the ArchiveTune app's existing `discoverInstances()` parser consumes it unchanged.
 */
export async function getDiscovery(service: Service): Promise<{ streaming: string[]; api: string[] }> {
  const rows = await db
    .select({
      payload: sourceEntries.payload,
      premium: sourceEntries.premium,
      status: sourceEntries.status,
    })
    .from(sourceEntries)
    .where(
      and(
        eq(sourceEntries.service, service),
        eq(sourceEntries.kind, "api"),
        eq(sourceEntries.removed, false),
        eq(sourceEntries.disabled, false),
        sql`${sourceEntries.status} in ('alive','preview')`,
      ),
    )
    .orderBy(desc(sourceEntries.premium), desc(sourceEntries.lastCheckedAt))

  const urls = Array.from(
    new Set(
      rows
        .map((r) => (r.payload as { baseUrl?: string })?.baseUrl?.trim())
        .filter((u): u is string => !!u && u.length > 0),
    ),
  )
  // The app treats "streaming" as the preferred audio-serving list; we expose the same URLs
  // there so verified instances are tried first, and mirror them under "api".
  return { streaming: urls, api: urls }
}
