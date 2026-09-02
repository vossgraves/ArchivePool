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
    // Disabled entries (auto-disabled by the sweep, or non-premium per pool policy) are not
    // served to anyone, so they must not count as alive/premium on the public page.
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
 * The single definition of "this entry may be handed to an app": not removed, not auto-disabled,
 * and status alive or preview. `preview` counts because Tidal API keys commonly sit there while
 * serving fine. Anything gating pool availability MUST use this, not an ad-hoc status compare —
 * the admin UI mirrors it in isServable() and the two disagreeing is a real bug source.
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
 * How many entries a single request may hold per category.
 *
 * Tokens are limited to 3 per app — the app caches them locally and only re-fetches when the
 * cached token is dead (health sweep marks dead, client reports via /api/report). Instances are
 * not limited the same way because they are stateless base URLs; the same instance can serve
 * many apps. A new token is only leased when the app's locally cached one fails its health
 * check, not on every request.
 *
 * Deliberately not 1 for tokens: LosslessStreamResolver iterates PoolAccountManager accounts
 * and tries the next credential when one fails. Leasing a single token would turn any bad
 * credential into a hard playback failure. Three gives fallback while cutting exposure.
 *
 * This is also the per-key sticky window: the number of entries one read key holds for a
 * service (see LEASE_TTL_HOURS below). There is deliberately no separate "window size" constant
 * — a second number meaning the same thing as this one would only drift from it.
 */
export const LEASE_PER_CATEGORY = 3
export const LEASE_PER_CATEGORY_ACCOUNT = 3 // tokens: 3 per app, only if dead
export const LEASE_PER_CATEGORY_API = 10 // instances: more, stateless

/**
 * How long a per-key lease stays sticky (see `api_key_leases` and [leaseAccounts]).
 *
 * NOT 24h, even though that matches PoolAccountManager's refresh cadence on the app: a 24h TTL
 * would expire right as the app's next scheduled refresh asks for a new feed, so the lease would
 * almost never still be valid and the whole mechanism would degrade to the pre-lease
 * reshuffle-every-time behaviour. 72h keeps a daily-refreshing app on the same credentials
 * across a missed day or two, while a device that goes fully quiet for three days returns its
 * slots to the pool for other keys.
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
  // Credentials are stored encrypted at rest. Decrypt with the server key, then re-encrypt the
  // sensitive fields with the client key (per-requester derived key for v2 clients, static
  // POOL_CLIENT_KEY for legacy ones) so the JSON leaving the server is ciphertext end-to-end
  // (the app decrypts locally). The routes fail closed when no key is available.
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
 * Leases account credentials per service: premium-first, then least-recently-leased, so traffic
 * spreads across the pool rather than hammering one account. `lastLeasedAt` is stamped after
 * selection. Availability is never traded for exposure: a thin pool degrades (fewer entries)
 * instead of erroring.
 *
 * [keyId] makes this sticky: when given, entries the key already holds in `api_key_leases`
 * (still fresh within LEASE_TTL_HOURS, still servable) are ordered ahead of everything else, so
 * the existing per-service slice picks them first and a key keeps seeing the same credentials
 * across requests instead of a fresh premium-first rotation every time. A key with fewer held
 * entries than the window simply fills the rest from the global ordering — same thin-pool
 * degradation as always, just per key instead of only per pool. [keyId] null (gating off, no
 * key resolved) collapses this to exactly the pre-lease global rotation.
 */
export async function leaseAccounts(clientKey?: Buffer | null, keyId?: number | null) {
  await ensureSchema()

  // No resolved key: join nothing, so every row's "held" ordering key is false for every row —
  // the ORDER BY below then behaves exactly as it did before per-key leases existed.
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
    // Non-servable entries are excluded here, not filtered afterwards, so a key whose leased
    // entry died is never stranded on it — the slot silently refills from the rest of the pool.
    .where(accountServableWhere)
    // Tier 1: entries this key already holds outrank everything else, including an unheld
    // premium entry — the app has these tokens cached locally, and churning them for a
    // marginally "better" pick costs more than the ordering gains. NULLS FIRST on
    // lastLeasedAt: a never-leased entry is the least recently used, so it goes out before one
    // that already has a timestamp (Postgres defaults to NULLS LAST for ASC, hence explicit).
    // `id` last makes the ordering total, so ties can never produce an unstable rotation order.
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
    // Deezer is account-only; empty instance lists keep the shape symmetric for parsers.
    deezer: group("deezer"),
    // Apple Music is account-only as well: the credential is the personal Media-User-Token
    // (0.Ap…) from a contributor's web session. The dev (Bearer) JWT is deliberately NOT
    // pooled — apps self-scrape a fresh web token, so pooling a long-lived JWT would only
    // widen the blast radius.
    "apple-music": group("apple-music"),
  }

  await stampLeases(leasedIds, accountEntries)
  await recordKeyLeases(keyId ?? null, picked)
  return { accounts, leasedCount: leasedIds.length }
}

/**
 * Leases instance entries per service (same ordering/stamping rules as [leaseAccounts]).
 * Kept separate from credentials so a caller can never receive tokens by asking for
 * instances. Instance payloads are not secret (baseUrl must be readable), so the entries pass
 * through `toLeased` unchanged apart from any optional encrypted extras (e.g. note).
 */
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
 * Stamps lease timestamps after selection so rotation advances.
 *
 * Each id gets a DISTINCT timestamp, 1ms apart. A single `SET last_leased_at = now()` over all
 * of them writes one identical value, which leaves the next request's ORDER BY facing a tie it
 * must break arbitrarily — entries then recur across consecutive calls instead of rotating.
 * Staggering keeps the ordering total, so the queue advances predictably.
 *
 * A failure here must not deny a client credentials it already holds, so the error is
 * swallowed; the only cost is that the same entries may be picked again next time.
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
 * Records/refreshes this key's leases so it stays sticky on the next request. Same
 * never-deny-credentials error policy as [stampLeases]: a bookkeeping failure is logged and
 * swallowed, never surfaced to the caller — the only cost is that the next request re-rotates
 * instead of staying sticky.
 *
 * `ON CONFLICT DO UPDATE` makes concurrent same-key requests benign: two racing requests may
 * briefly leave the key holding more than LEASE_PER_CATEGORY_ACCOUNT rows for a service, but the
 * slice in [leaseAccounts] (not this table) is what bounds the served set, and any excess rows
 * simply age out past LEASE_TTL_HOURS and stop being selected.
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
 * One replacement credential for [service] after a key reported one of its leased entries dead
 * or not_premium (see /api/report). Returns null when the pool has nothing this key does not
 * already hold within the TTL — a "replacement" the key already has is worse than none.
 *
 * Same selection ordering as [leaseAccounts] (premium-first, then least-recently-leased) and the
 * same [toLeased] shape, so the app's existing feed parsers consume the replacement unchanged.
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
 * Releases one key's lease on [entryId], so the slot refills with something else on the key's
 * next feed fetch. Called from /api/report when a key reports an entry dead or not_premium.
 *
 * Returns true only when a lease row actually existed and was deleted. /api/report uses this as
 * proof the pool itself handed this exact entry to this exact key (via leaseAccounts or an
 * earlier leaseReplacement) before deciding whether to issue a replacement — without it, any
 * registered key could report arbitrary ids it never leased and harvest a fresh credential for
 * every one, turning the report endpoint into the very pool-walking oracle per-key leases exist
 * to close. Errors are swallowed and treated as "no lease found" — a bookkeeping failure here
 * must not fail the report itself, and must not accidentally unlock a replacement either.
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

/**
 * Instance base URLs for one service, ranked premium-first. Shaped as `{ streaming, api }`
 * so the ArchiveTune app's existing `discoverInstances()` parser consumes it unchanged.
 */
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
