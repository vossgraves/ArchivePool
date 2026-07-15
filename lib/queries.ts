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

/** Full credential payloads for the app pool JSON (public per the chosen model). */
export async function getAlivePool() {
  const rows = await db
    .select()
    .from(sourceEntries)
    .where(
      and(
        eq(sourceEntries.removed, false),
        eq(sourceEntries.disabled, false),
        sql`${sourceEntries.status} in ('alive','preview')`,
      ),
    )
    .orderBy(desc(sourceEntries.premium), desc(sourceEntries.lastCheckedAt))

  // Credentials are stored encrypted at rest. Decrypt with the server key, then re-encrypt the
  // sensitive fields with the client key so the JSON leaving the server is ciphertext end-to-end
  // (the ArchiveTune app decrypts locally). When POOL_CLIENT_KEY is unset this is a no-op.
  const group = (service: Service, kind: Kind) =>
    rows
      .filter((r) => r.service === service && r.kind === kind)
      .map((r) => ({
        id: r.id,
        premium: r.premium,
        status: r.status,
        latencyMs: r.latencyMs,
        lastCheckedAt: r.lastCheckedAt ? new Date(r.lastCheckedAt).toISOString() : null,
        ...encryptForClient(decryptAtRest(r.payload)),
      }))

  return {
    tidal: { apis: group("tidal", "api"), accounts: group("tidal", "account") },
    qobuz: { apis: group("qobuz", "api"), accounts: group("qobuz", "account") },
  }
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
