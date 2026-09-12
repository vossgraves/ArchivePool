import "server-only"
import { and, desc, eq, sql } from "drizzle-orm"
import { decryptAtRest, encryptForClient } from "./crypto"
import { db } from "./db"
import { accountEntries, apiKeyLeases, instanceEntries } from "./db/schema"
import { ensureSchema } from "./db/ensure"
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
  await ensureSchema()
  const accounts = await db
    .select({
      service: accountEntries.service,
      status: accountEntries.status,
      premium: accountEntries.premium,
      disabled: accountEntries.disabled,
      checkCount: accountEntries.checkCount,
      okCount: accountEntries.okCount,
      lastCheckedAt: accountEntries.lastCheckedAt,
    })
    .from(accountEntries)
    .where(eq(accountEntries.removed, false))
  const instances = await db
    .select({
      service: instanceEntries.service,
      status: instanceEntries.status,
      premium: instanceEntries.premium,
      disabled: instanceEntries.disabled,
      checkCount: instanceEntries.checkCount,
      okCount: instanceEntries.okCount,
      lastCheckedAt: instanceEntries.lastCheckedAt,
    })
    .from(instanceEntries)
    .where(eq(instanceEntries.removed, false))

  const rows = [
    ...accounts.map((r) => ({ ...r, kind: "account" as const })),
    ...instances.map((r) => ({ ...r, kind: "api" as const })),
  ]

  return CATEGORIES.map((cat) => {
    const items = rows.filter((r) => r.service === cat.service && r.kind === cat.kind)
    // Disabled entries are served to nobody, so they must not read as alive here.
    const alive = items.filter((r) => !r.disabled && (r.status === "alive" || r.status === "preview")).length
    const premium = items.filter((r) => !r.disabled && r.status === "alive" && r.premium).length
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
 * The single definition of "may be handed to an app". `preview` counts — Tidal keys commonly sit
 * there while serving fine. Never hand-roll a status compare instead; the admin UI mirrors this
 * in isServable(), and the two drifting apart has caused real bugs.
 */
export const accountServableWhere = and(
  eq(accountEntries.removed, false),
  eq(accountEntries.disabled, false),
  sql`${accountEntries.status} in ('alive','preview')`,
)

export const instanceServableWhere = and(
  eq(instanceEntries.removed, false),
  eq(instanceEntries.disabled, false),
  sql`${instanceEntries.status} in ('alive','preview')`,
)

/**
 * Entries one request may hold per category, and the per-key sticky window. Not 1 for tokens:
 * the app tries the next credential when one fails, so a single lease turns any bad credential
 * into a hard playback failure. See docs/LEASE_RESEARCH.md.
 */
export const LEASE_PER_CATEGORY = 3
export const LEASE_PER_CATEGORY_ACCOUNT = 3 // tokens: 3 per app, only if dead
export const LEASE_PER_CATEGORY_API = 10 // instances: more, stateless

/**
 * Not 24h: that matches the app's refresh cadence exactly, so every lease would expire just as
 * the next refresh asked for a feed and the mechanism would degrade to reshuffling every time.
 */
const LEASE_TTL_HOURS = 72

interface LeasedEntry {
  id: number
  premium: boolean
  status: string
  latencyMs: number | null
  lastCheckedAt: string | null
  [key: string]: unknown
}

function toLeased(
  row: {
    id: number
    premium: boolean
    status: string
    latencyMs: number | null
    lastCheckedAt: Date | null
    payload: Record<string, unknown>
  },
  clientKey?: Buffer | null,
): LeasedEntry {
  // Decrypt at rest, re-encrypt for the client, so what leaves the server is ciphertext
  // end-to-end. Routes fail closed when no key is available.
  return {
    id: row.id,
    premium: row.premium,
    status: row.status,
    latencyMs: row.latencyMs,
    lastCheckedAt: row.lastCheckedAt ? new Date(row.lastCheckedAt).toISOString() : null,
    ...encryptForClient(decryptAtRest(row.payload), clientKey),
  }
}

/**
 * Leases account credentials per service: held-by-this-key first, then premium, then
 * least-recently-leased. A thin pool degrades to fewer entries rather than erroring.
 * A null [keyId] collapses this to the plain global rotation.
 */
export async function leaseAccounts(clientKey?: Buffer | null, keyId?: number | null) {
  await ensureSchema()

  const heldByKey =
    keyId == null
      ? sql`false`
      : sql`${apiKeyLeases.entryId} = ${accountEntries.id}
            and ${apiKeyLeases.keyId} = ${keyId}
            and ${apiKeyLeases.leasedAt} > now() - make_interval(hours => ${LEASE_TTL_HOURS})`

  const rows = await db
    .select({
      id: accountEntries.id,
      service: accountEntries.service,
      premium: accountEntries.premium,
      status: accountEntries.status,
      latencyMs: accountEntries.latencyMs,
      lastCheckedAt: accountEntries.lastCheckedAt,
      payload: accountEntries.payload,
    })
    .from(accountEntries)
    .leftJoin(apiKeyLeases, heldByKey)
    // Excluded here rather than filtered afterwards, so a key whose leased entry died is never
    // stranded on it — the slot refills from the rest of the pool.
    .where(accountServableWhere)
    // Held entries outrank even an unheld premium one: the app has these cached, and churning
    // them costs more than the better pick gains. NULLS FIRST because Postgres defaults to
    // NULLS LAST on ASC and a never-leased entry is the least recently used. `id` makes the
    // order total, so ties cannot rotate unstably.
    .orderBy(
      sql`(${apiKeyLeases.keyId} is not null) desc`,
      desc(accountEntries.premium),
      sql`${accountEntries.lastLeasedAt} asc nulls first`,
      accountEntries.id,
    )

  const leasedIds: number[] = []
  const picked: { id: number; service: Service }[] = []
  const group = (service: Service) => {
    const rowsForService = rows.filter((r) => r.service === service).slice(0, LEASE_PER_CATEGORY_ACCOUNT)
    for (const r of rowsForService) {
      leasedIds.push(r.id)
      picked.push({ id: r.id, service })
    }
    return rowsForService.map((r) => toLeased(r, clientKey))
  }

  const accounts = {
    tidal: group("tidal"),
    qobuz: group("qobuz"),
    // Deezer and Apple Music are account-only; empty instance lists keep the shape symmetric.
    // Apple's dev JWT is deliberately not pooled — apps self-scrape a fresh one, so pooling a
    // long-lived token would only widen the blast radius.
    deezer: group("deezer"),
    "apple-music": group("apple-music"),
  }

  await stampLeases(leasedIds, accountEntries)
  await recordKeyLeases(keyId ?? null, picked)
  return { accounts, leasedCount: leasedIds.length }
}

/** Kept separate from [leaseAccounts] so a caller can never receive tokens by asking for URLs. */
export async function leaseInstances(clientKey?: Buffer | null) {
  await ensureSchema()
  const rows = await db
    .select()
    .from(instanceEntries)
    .where(instanceServableWhere)
    .orderBy(
      desc(instanceEntries.premium),
      sql`${instanceEntries.lastLeasedAt} asc nulls first`,
      instanceEntries.id,
    )

  const leasedIds: number[] = []
  const group = (service: Service) => {
    const picked = rows.filter((r) => r.service === service).slice(0, LEASE_PER_CATEGORY_API)
    for (const r of picked) leasedIds.push(r.id)
    return picked.map((r) => toLeased(r, clientKey))
  }

  const apis = {
    tidal: group("tidal"),
    qobuz: group("qobuz"),
    deezer: group("deezer"),
    "apple-music": group("apple-music"),
  }

  await stampLeases(leasedIds, instanceEntries)
  return { apis, leasedCount: leasedIds.length }
}

/**
 * Legacy combined lease: both accounts and instances, as served by /api/sources for app builds
 * predating the split. New clients should consume /api/accounts (tokens) and
 * /api/instances/[service] (URLs) separately.
 */
export async function leasePool(clientKey?: Buffer | null, keyId?: number | null) {
  const [{ accounts }, { apis }] = await Promise.all([
    leaseAccounts(clientKey, keyId),
    leaseInstances(clientKey),
  ])
  return {
    pool: {
      tidal: { apis: apis.tidal, accounts: accounts.tidal },
      qobuz: { apis: apis.qobuz, accounts: accounts.qobuz },
      deezer: { apis: apis.deezer, accounts: accounts.deezer },
      "apple-music": { apis: apis["apple-music"], accounts: accounts["apple-music"] },
    },
  }
}

/**
 * Each id gets a DISTINCT timestamp, 1ms apart. One `SET last_leased_at = now()` across all of
 * them writes an identical value, and the next request's ORDER BY then breaks the tie
 * arbitrarily — entries recur instead of rotating. Errors are swallowed: a bookkeeping failure
 * must never deny a client credentials it already holds.
 */
async function stampLeases(
  ids: number[],
  table: typeof accountEntries | typeof instanceEntries,
) {
  if (ids.length === 0) return
  try {
    const base = Date.now()
    await db.transaction(async (tx) => {
      for (const [i, id] of ids.entries()) {
        await tx
          .update(table)
          .set({ lastLeasedAt: new Date(base + i) })
          .where(eq(table.id, id))
      }
    })
  } catch (err) {
    console.error("[pool] failed to stamp lease timestamps", err)
  }
}

/**
 * Same swallow-errors policy as [stampLeases]. `ON CONFLICT DO UPDATE` makes racing same-key
 * requests benign: the slice in [leaseAccounts], not this table, bounds what is actually served,
 * and any excess rows age out past the TTL.
 */
async function recordKeyLeases(keyId: number | null, picked: { id: number; service: Service }[]) {
  if (keyId == null || picked.length === 0) return
  try {
    await db
      .insert(apiKeyLeases)
      .values(picked.map((p) => ({ keyId, entryId: p.id, service: p.service, leasedAt: new Date() })))
      .onConflictDoUpdate({
        target: [apiKeyLeases.keyId, apiKeyLeases.entryId],
        set: { leasedAt: sql`excluded.leased_at`, service: sql`excluded.service` },
      })
  } catch (err) {
    console.error("[pool] failed to record per-key leases", err)
  }
}

/**
 * One replacement credential after a key reports a leased entry dead. Null when the pool holds
 * nothing the key does not already have — a replacement it already holds is worse than none.
 */
export async function leaseReplacement(
  service: Service,
  keyId: number,
  clientKey: Buffer | null,
  excludeId: number,
): Promise<LeasedEntry | null> {
  await ensureSchema()
  const [row] = await db
    .select({
      id: accountEntries.id,
      premium: accountEntries.premium,
      status: accountEntries.status,
      latencyMs: accountEntries.latencyMs,
      lastCheckedAt: accountEntries.lastCheckedAt,
      payload: accountEntries.payload,
    })
    .from(accountEntries)
    .where(
      and(
        accountServableWhere,
        eq(accountEntries.service, service),
        sql`${accountEntries.id} <> ${excludeId}`,
        sql`not exists (
          select 1 from api_key_leases l
          where l.key_id = ${keyId} and l.entry_id = ${accountEntries.id}
            and l.leased_at > now() - make_interval(hours => ${LEASE_TTL_HOURS})
        )`,
      ),
    )
    .orderBy(
      desc(accountEntries.premium),
      sql`${accountEntries.lastLeasedAt} asc nulls first`,
      accountEntries.id,
    )
    .limit(1)

  if (!row) return null

  await stampLeases([row.id], accountEntries)
  await recordKeyLeases(keyId, [{ id: row.id, service }])
  return toLeased(row, clientKey)
}

/**
 * Releases one key's lease on [entryId]. True only when a row actually existed: /api/report
 * treats that as proof the pool handed this exact entry to this exact key before issuing a
 * replacement. Without the check, any registered key could report ids it never leased and
 * harvest a credential for each — the pool-walking oracle that per-key leases exist to close.
 * Errors read as "no lease found", so a bookkeeping failure cannot unlock a replacement either.
 */
export async function releaseLease(keyId: number, entryId: number): Promise<boolean> {
  try {
    const deleted = await db
      .delete(apiKeyLeases)
      .where(and(eq(apiKeyLeases.keyId, keyId), eq(apiKeyLeases.entryId, entryId)))
      .returning({ entryId: apiKeyLeases.entryId })
    return deleted.length > 0
  } catch (err) {
    console.error("[pool] failed to release lease", err)
    return false
  }
}

/** Shaped as `{ streaming, api }` so the app's `discoverInstances()` parser is unchanged. */
export async function getDiscovery(service: Service): Promise<{ streaming: string[]; api: string[] }> {
  await ensureSchema()
  const rows = await db
    .select({
      payload: instanceEntries.payload,
      premium: instanceEntries.premium,
      status: instanceEntries.status,
    })
    .from(instanceEntries)
    .where(
      and(
        eq(instanceEntries.service, service),
        eq(instanceEntries.removed, false),
        eq(instanceEntries.disabled, false),
        sql`${instanceEntries.status} in ('alive','preview')`,
      ),
    )
    .orderBy(desc(instanceEntries.premium), desc(instanceEntries.lastCheckedAt))

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
