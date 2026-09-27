import "server-only"
import { and, desc, eq, sql } from "drizzle-orm"
import { decryptAtRest, encryptForClient } from "./crypto"
import { db } from "./db"
import { accountEntries, apiKeyLeases, apiKeyRequests, apiKeys, instanceEntries } from "./db/schema"
import { ensureSchema } from "./db/ensure"
import { CATEGORIES, type Kind, type Service } from "./sources"
import type { KeyScope } from "./api-keys"

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
/**
 * The board's figures, read through a short TTL cache.
 *
 * Nothing here changes between health sweeps, but the board and any monitoring poll it far more
 * often than that, and every miss wakes the database compute for five minutes. See lib/ttl-cache.ts.
 */
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
  sql`(${accountEntries.expiresAt} is null or ${accountEntries.expiresAt} > now())`,
)

export const instanceServableWhere = and(
  eq(instanceEntries.removed, false),
  eq(instanceEntries.disabled, false),
  sql`${instanceEntries.status} in ('alive','preview')`,
  sql`(${instanceEntries.expiresAt} is null or ${instanceEntries.expiresAt} > now())`,
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
 * A null [keyId] collapses this to the plain global rotation, and a null [scope] to every
 * service — a scoped key's groups other than its own come back empty.
 */
export async function leaseAccounts(clientKey?: Buffer | null, keyId?: number | null, scope?: KeyScope) {
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
    // A scoped key's row set is narrowed in SQL too, so it cannot even load another service's
    // credentials, let alone return them.
    .where(and(accountServableWhere, scope == null ? undefined : eq(accountEntries.service, scope)))
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
    // Apple Music is account-only, so its instance list stays empty and the shape stays
    // symmetric. Apple's dev JWT is deliberately not pooled — apps self-scrape a fresh one, so
    // pooling a long-lived token would only widen the blast radius.
    deezer: group("deezer"),
    "apple-music": group("apple-music"),
    "amazon-music": group("amazon-music"),
  }

  await stampLeases(leasedIds, accountEntries)
  await recordKeyLeases(keyId ?? null, picked)
  return { accounts, leasedCount: leasedIds.length }
}

/** Kept separate from [leaseAccounts] so a caller can never receive tokens by asking for URLs. */
export async function leaseInstances(clientKey?: Buffer | null, scope?: KeyScope) {
  await ensureSchema()
  const rows = await db
    .select()
    .from(instanceEntries)
    .where(and(instanceServableWhere, scope == null ? undefined : eq(instanceEntries.service, scope)))
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
    // Deezer and Amazon instances are pooled like any other: this group fills from
    // `instance_entries` rows for that service (see CATEGORIES in lib/sources.ts). Apple Music
    // has no instance tier, so its group is always empty.
    "amazon-music": group("amazon-music"),
  }

  await stampLeases(leasedIds, instanceEntries)
  return { apis, leasedCount: leasedIds.length }
}

/**
 * Legacy combined lease: both accounts and instances, as served by /api/sources for app builds
 * predating the split. New clients should consume /api/accounts (tokens) and
 * /api/instances/[service] (URLs) separately.
 */
export async function leasePool(clientKey?: Buffer | null, keyId?: number | null, scope?: KeyScope) {
  const [{ accounts }, { apis }] = await Promise.all([
    leaseAccounts(clientKey, keyId, scope),
    leaseInstances(clientKey, scope),
  ])
  return {
    pool: {
      tidal: { apis: apis.tidal, accounts: accounts.tidal },
      qobuz: { apis: apis.qobuz, accounts: accounts.qobuz },
      deezer: { apis: apis.deezer, accounts: accounts.deezer },
      "apple-music": { apis: apis["apple-music"], accounts: accounts["apple-music"] },
      "amazon-music": { apis: apis["amazon-music"], accounts: accounts["amazon-music"] },
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

/*
 * ---------------------------------------------------------------------------------------------
 * Dashboard reads. Everything below is for /dashboard and the status board; see docs/DASHBOARD.md.
 * They live here so no client component ever queries a pool table, and so none of them can reach
 * `payload` by accident: each selects its columns by name, and `payload` is never one of them.
 * ---------------------------------------------------------------------------------------------
 */

/** One day of health-check history. `pct` is null for a day nothing was checked, not 0. */
export interface UptimePoint {
  day: string
  /** Formatted server-side: an Intl format resolved in the browser would not match the SSR pass. */
  label: string
  checks: number
  ok: number
  pct: number | null
  /** Today, still accumulating checks — charts draw it dashed rather than as a fall. */
  partial: boolean
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]

/** health_log is pruned at 30 days by the sweep, so a longer window would silently flatten out. */
export const HISTORY_DAYS = 14

function dayKey(date: Date): string {
  return date.toISOString().slice(0, 10)
}

function dayGrid(days: number): { day: string; label: string; partial: boolean }[] {
  const today = new Date()
  today.setUTCHours(0, 0, 0, 0)
  return Array.from({ length: days }, (_, i) => {
    const date = new Date(today)
    date.setUTCDate(date.getUTCDate() - (days - 1 - i))
    return {
      day: dayKey(date),
      label: `${date.getUTCDate()} ${MONTHS[date.getUTCMonth()]}`,
      partial: i === days - 1,
    }
  })
}

function toPoints(
  buckets: Map<string, { checks: number; ok: number }>,
  days = HISTORY_DAYS,
): UptimePoint[] {
  return dayGrid(days).map((slot) => {
    const bucket = buckets.get(slot.day)
    const checks = bucket?.checks ?? 0
    const ok = bucket?.ok ?? 0
    return {
      ...slot,
      checks,
      ok,
      pct: checks > 0 ? Math.round((ok / checks) * 1000) / 10 : null,
    }
  })
}

interface HistoryRow {
  service: string
  kind: string
  day: string
  checks: number
  ok: number
}

/**
 * Daily pass rate per category, joined back to the entry tables because health_log records only an
 * entry id — ids are unique across the pair, which is what makes one join per table safe.
 */
async function readHistory(entryIds?: number[]): Promise<HistoryRow[]> {
  await ensureSchema()
  const scope =
    entryIds === undefined
      ? sql`true`
      : entryIds.length === 0
        ? sql`false`
        : sql`h.entry_id in ${entryIds}`
  const result = await db.execute(sql`
    with entries as (
      select id, service, 'account' as kind from account_entries
      union all
      select id, service, 'api' as kind from instance_entries
    )
    select e.service as service,
           e.kind as kind,
           to_char(date_trunc('day', h.checked_at at time zone 'utc'), 'YYYY-MM-DD') as day,
           count(*)::int as checks,
           count(*) filter (where h.ok)::int as ok
    from health_log h
    join entries e on e.id = h.entry_id
    where h.checked_at >= now() - make_interval(days => ${HISTORY_DAYS}) and ${scope}
    group by 1, 2, 3
  `)
  return (result.rows ?? []) as unknown as HistoryRow[]
}

function bucketBy(rows: HistoryRow[], match?: (row: HistoryRow) => boolean) {
  const buckets = new Map<string, { checks: number; ok: number }>()
  for (const row of rows) {
    if (match && !match(row)) continue
    const current = buckets.get(row.day) ?? { checks: 0, ok: 0 }
    current.checks += Number(row.checks)
    current.ok += Number(row.ok)
    buckets.set(row.day, current)
  }
  return buckets
}

/** Pool-wide daily history, plus the same series split per public category. */
export async function getPoolHistory(): Promise<{
  overall: UptimePoint[]
  categories: { service: Service; kind: Kind; points: UptimePoint[] }[]
}> {
  const rows = await readHistory()
  return {
    overall: toPoints(bucketBy(rows)),
    categories: CATEGORIES.map((cat) => ({
      service: cat.service,
      kind: cat.kind,
      points: toPoints(bucketBy(rows, (r) => r.service === cat.service && r.kind === cat.kind)),
    })),
  }
}

/** A read key the signed-in user owns. No hash, ever — only the prefix is renderable. */
export interface DashboardKey {
  id: number
  name: string
  reason: string
  prefix: string
  revoked: boolean
  useCount: number
  lastUsedAt: string | null
  createdAt: string
  /** Account entries this key is currently sticky on. See docs/LEASE_RESEARCH.md. */
  heldEntries: number
}

export interface DashboardRequest {
  id: number
  subject: string
  reason: string
  status: string
  reviewNote: string
  resultingKeyId: number | null
  createdAt: string
  reviewedAt: string | null
}

/** An entry one of the user's keys is holding. Masked label only; the payload is never selected. */
export interface DashboardLease {
  keyId: number
  keyName: string
  entryId: number
  service: string
  label: string
  status: string
  premium: boolean
  leasedAt: string
  expiresAt: string | null
  lastCheckedAt: string | null
}

export interface DashboardContribution {
  id: number
  kind: Kind
  service: string
  label: string
  status: string
  premium: boolean
  disabled: boolean
  removed: boolean
  expiresAt: string | null
  lastCheckedAt: string | null
  latencyMs: number | null
  checkCount: number
  okCount: number
  uptimePct: number | null
  createdAt: string
}

export interface DashboardSnapshot {
  keys: DashboardKey[]
  requests: DashboardRequest[]
  leases: DashboardLease[]
  contributions: DashboardContribution[]
  /** Daily pass rate across the user's own contributions. Empty when they have none. */
  contributionHistory: UptimePoint[]
  pool: CategoryStatus[]
  poolHistory: UptimePoint[]
  /** Which sections failed to load, so the page can say so instead of rendering a confident zero. */
  failed: string[]
}

const iso = (value: Date | string | null | undefined): string | null =>
  value == null ? null : new Date(value).toISOString()

/**
 * A dashboard section that cannot load must degrade to "unavailable" rather than 500 the page: a
 * reader whose history query timed out still needs the keys panel to revoke a leaked key.
 */
async function section<T>(name: string, load: () => Promise<T>, fallback: T, failed: string[]) {
  try {
    return await load()
  } catch (err) {
    console.error(`[dashboard] ${name} failed:`, err)
    failed.push(name)
    return fallback
  }
}

/**
 * Everything /dashboard renders, in one server-side read.
 *
 * [username] is the contributor credit, which is how an entry is tied back to a person at all —
 * the pool tables deliberately hold no user id (docs/SCHEMA.md). Anonymous contributions therefore
 * cannot appear here, and that is the contributor's choice being honoured, not a gap.
 */
export async function getDashboard(userId: number, username: string): Promise<DashboardSnapshot> {
  await ensureSchema()
  const failed: string[] = []

  const [keyRows, requestRows, leaseRows, accountRows, instanceRows, pool, poolHistory] =
    await Promise.all([
      section(
        "keys",
        () =>
          db
            .select({
              id: apiKeys.id,
              name: apiKeys.name,
              reason: apiKeys.reason,
              prefix: apiKeys.prefix,
              revoked: apiKeys.revoked,
              useCount: apiKeys.useCount,
              lastUsedAt: apiKeys.lastUsedAt,
              createdAt: apiKeys.createdAt,
            })
            .from(apiKeys)
            .where(and(eq(apiKeys.userId, userId), eq(apiKeys.deleted, false)))
            .orderBy(desc(apiKeys.createdAt)),
        [],
        failed,
      ),
      section(
        "requests",
        () =>
          db
            .select({
              id: apiKeyRequests.id,
              subject: apiKeyRequests.subject,
              reason: apiKeyRequests.reason,
              status: apiKeyRequests.status,
              reviewNote: apiKeyRequests.reviewNote,
              resultingKeyId: apiKeyRequests.resultingKeyId,
              createdAt: apiKeyRequests.createdAt,
              reviewedAt: apiKeyRequests.reviewedAt,
            })
            .from(apiKeyRequests)
            .where(eq(apiKeyRequests.userId, userId))
            .orderBy(desc(apiKeyRequests.createdAt)),
        [],
        failed,
      ),
      section(
        "leases",
        () =>
          db
            .select({
              keyId: apiKeyLeases.keyId,
              keyName: apiKeys.name,
              entryId: accountEntries.id,
              service: accountEntries.service,
              label: accountEntries.label,
              status: accountEntries.status,
              premium: accountEntries.premium,
              disabled: accountEntries.disabled,
              leasedAt: apiKeyLeases.leasedAt,
              expiresAt: accountEntries.expiresAt,
              lastCheckedAt: accountEntries.lastCheckedAt,
            })
            .from(apiKeyLeases)
            .innerJoin(apiKeys, eq(apiKeys.id, apiKeyLeases.keyId))
            .innerJoin(accountEntries, eq(accountEntries.id, apiKeyLeases.entryId))
            .where(
              and(
                eq(apiKeys.userId, userId),
                eq(apiKeys.deleted, false),
                // Expired lease rows are left behind deliberately (recordKeyLeases upserts rather
                // than prunes), so the TTL has to be applied on read or the panel shows holds the
                // pool would no longer honour.
                sql`${apiKeyLeases.leasedAt} > now() - make_interval(hours => ${LEASE_TTL_HOURS})`,
              ),
            )
            .orderBy(desc(apiKeyLeases.leasedAt)),
        [],
        failed,
      ),
      section(
        "contributions",
        () =>
          db
            .select({
              id: accountEntries.id,
              service: accountEntries.service,
              label: accountEntries.label,
              status: accountEntries.status,
              premium: accountEntries.premium,
              disabled: accountEntries.disabled,
              removed: accountEntries.removed,
              expiresAt: accountEntries.expiresAt,
              lastCheckedAt: accountEntries.lastCheckedAt,
              latencyMs: accountEntries.latencyMs,
              checkCount: accountEntries.checkCount,
              okCount: accountEntries.okCount,
              createdAt: accountEntries.createdAt,
            })
            .from(accountEntries)
            .where(eq(accountEntries.contributor, username))
            .orderBy(desc(accountEntries.createdAt)),
        [],
        failed,
      ),
      section(
        "contributions",
        () =>
          db
            .select({
              id: instanceEntries.id,
              service: instanceEntries.service,
              label: instanceEntries.label,
              status: instanceEntries.status,
              premium: instanceEntries.premium,
              disabled: instanceEntries.disabled,
              removed: instanceEntries.removed,
              expiresAt: instanceEntries.expiresAt,
              lastCheckedAt: instanceEntries.lastCheckedAt,
              latencyMs: instanceEntries.latencyMs,
              checkCount: instanceEntries.checkCount,
              okCount: instanceEntries.okCount,
              createdAt: instanceEntries.createdAt,
            })
            .from(instanceEntries)
            .where(eq(instanceEntries.contributor, username))
            .orderBy(desc(instanceEntries.createdAt)),
        [],
        failed,
      ),
      section("pool", () => getStatus(), [], failed),
      section("pool history", async () => (await getPoolHistory()).overall, [], failed),
    ])

  const held = new Map<number, number>()
  for (const lease of leaseRows) held.set(lease.keyId, (held.get(lease.keyId) ?? 0) + 1)

  const toContribution = (row: (typeof accountRows)[number], kind: Kind): DashboardContribution => ({
    id: row.id,
    kind,
    service: row.service,
    label: row.label,
    status: row.status,
    premium: row.premium,
    disabled: row.disabled,
    removed: row.removed,
    expiresAt: iso(row.expiresAt),
    lastCheckedAt: iso(row.lastCheckedAt),
    latencyMs: row.latencyMs,
    checkCount: row.checkCount,
    okCount: row.okCount,
    uptimePct: row.checkCount > 0 ? Math.round((row.okCount / row.checkCount) * 1000) / 10 : null,
    createdAt: iso(row.createdAt)!,
  })

  const contributions = [
    ...accountRows.map((r) => toContribution(r, "account")),
    ...instanceRows.map((r) => toContribution(r, "api")),
  ].sort((a, b) => b.createdAt.localeCompare(a.createdAt))

  const contributionHistory = await section(
    "contribution history",
    async () =>
      contributions.length === 0
        ? []
        : toPoints(bucketBy(await readHistory(contributions.map((c) => c.id)))),
    [],
    failed,
  )

  return {
    keys: keyRows.map((k) => ({
      id: k.id,
      name: k.name,
      reason: k.reason,
      prefix: k.prefix,
      revoked: k.revoked,
      useCount: k.useCount,
      lastUsedAt: iso(k.lastUsedAt),
      createdAt: iso(k.createdAt)!,
      heldEntries: held.get(k.id) ?? 0,
    })),
    requests: requestRows.map((r) => ({
      id: r.id,
      subject: r.subject,
      reason: r.reason,
      status: r.status,
      reviewNote: r.reviewNote,
      resultingKeyId: r.resultingKeyId,
      createdAt: iso(r.createdAt)!,
      reviewedAt: iso(r.reviewedAt),
    })),
    leases: leaseRows
      // A disabled entry is no longer served, so listing it as "held" would be a lie the reader
      // cannot check.
      .filter((l) => !l.disabled)
      .map((l) => ({
        keyId: l.keyId,
        keyName: l.keyName,
        entryId: l.entryId,
        service: l.service,
        label: l.label,
        status: l.status,
        premium: l.premium,
        leasedAt: iso(l.leasedAt)!,
        expiresAt: iso(l.expiresAt),
        lastCheckedAt: iso(l.lastCheckedAt),
      })),
    contributions,
    contributionHistory,
    pool,
    poolHistory,
    failed: Array.from(new Set(failed)),
  }
}
