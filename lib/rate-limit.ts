// SPDX-License-Identifier: GPL-3.0-or-later
import "server-only"
import { createHash } from "node:crypto"
import { pool } from "@/lib/db"
import { ensureSchema } from "@/lib/db/ensure"
import { clientIp } from "@/lib/request-ip"

export { clientIp }

/**
 * Lightweight in-memory sliding-window rate limiter.
 *
 * Defends the credential feeds (per client, see below), the report endpoint (per IP) and the
 * login endpoint (per IP+username) against scripted abuse. No database writes per request —
 * Neon compute wakeups are metered, so a DB-backed bucket would cost more than the abuse it
 * stops. (`dbRateLimit` exists for the one bucket that must hold across instances.)
 *
 * Bucket identity matters more than the numbers. A build bakes ONE read key into every
 * install, so a bucket keyed on the key alone is a fleet-wide cap: at 30 leases / 5 min the
 * ~90th install to refresh in the same window gets a 429, and every install behind that key
 * shares the punishment. The credential feeds therefore key the *client* bucket on
 * `key + client address` (see lib/request-ip.ts for why XFF alone was "unknown" on Workers)
 * and only use a per-key total as an opt-in backstop. Leases are sticky per key for 72h
 * (`api_key_leases`), so a leaked key cannot walk the pool by rotating addresses anyway —
 * the per-key total is not what protects the pool.
 *
 * Honest limitation: Vercel serverless and Workers isolates each keep their own window, so
 * the effective ceiling is limit × instance-count on the fleet-wide (opt-in) bucket. Per
 * client buckets still bound one client's retry loop, which is the failure mode observed in
 * the field.
 *
 * Windows are pruned lazily on access; the Map is also capped so a flood of distinct keys
 * cannot grow memory unbounded (oldest buckets are evicted first).
 */

const MAX_BUCKETS = 10_000

interface Bucket {
  hits: number[]
}

const globalForLimiter = globalThis as unknown as {
  __poolRateBuckets?: Map<string, Bucket>
}

const buckets: Map<string, Bucket> = (globalForLimiter.__poolRateBuckets ??= new Map())

export interface RateVerdict {
  ok: boolean
  retryAfterSec: number
  remaining: number
}

/**
 * Records one hit against [id] and returns whether it is allowed under
 * [limit] requests per [windowMs]. Idempotent callers should only act on `ok`.
 */
export function rateLimit(id: string, limit: number, windowMs: number): RateVerdict {
  const now = Date.now()
  const bucket = buckets.get(id) ?? { hits: [] }
  bucket.hits = bucket.hits.filter((t) => now - t < windowMs)

  if (bucket.hits.length >= limit) {
    const oldest = bucket.hits[0]
    const retryAfterSec = Math.max(1, Math.ceil((windowMs - (now - oldest)) / 1000))
    buckets.set(id, bucket)
    return { ok: false, retryAfterSec, remaining: 0 }
  }

  bucket.hits.push(now)
  buckets.set(id, bucket)

  // Evict stale buckets when the map grows past the cap: cheapest effective policy is dropping
  // entries whose window is fully expired, then the oldest by insertion order.
  if (buckets.size > MAX_BUCKETS) {
    while (buckets.size > MAX_BUCKETS) {
      const first = buckets.keys().next().value
      if (first === undefined) break
      buckets.delete(first)
    }
  }

  return { ok: true, retryAfterSec: 0, remaining: limit - bucket.hits.length }
}

/**
 * Shared, atomic rate limit — the ONLY option for buckets that must hold across
 * Workers isolates and serverless instances (the legacy-claim endpoint: a claim
 * brute-force spread over isolates would defeat the process-local limiter above).
 *
 * One row per bucket in rate_limit_buckets, upserted inside a single statement so
 * concurrent hits can never lose a count; when the stored window_start is older
 * than [windowMs] the same upsert resets it. FAILS CLOSED: a limiter outage denies
 * the request rather than opening a brute-force window.
 */
export async function dbRateLimit(id: string, limit: number, windowMs: number): Promise<RateVerdict> {
  try {
    await ensureSchema()
    const { rows } = await pool.query<{ n: number; window_start: Date }>(
      `INSERT INTO rate_limit_buckets (bucket, window_start, n)
       VALUES ($1, now(), 1)
       ON CONFLICT (bucket) DO UPDATE SET
         window_start = CASE
           WHEN rate_limit_buckets.window_start < now() - $2 * interval '1 millisecond'
           THEN now() ELSE rate_limit_buckets.window_start END,
         n = CASE
           WHEN rate_limit_buckets.window_start < now() - $2 * interval '1 millisecond'
           THEN 1 ELSE rate_limit_buckets.n + 1 END
       RETURNING n, window_start`,
      [id, windowMs],
    )
    const n = Number(rows[0]?.n ?? limit + 1)
    const windowStart = new Date(rows[0]?.window_start ?? Date.now()).getTime()
    if (n <= limit) return { ok: true, retryAfterSec: 0, remaining: limit - n }
    return { ok: false, retryAfterSec: Math.max(1, Math.ceil((windowStart + windowMs - Date.now()) / 1000)), remaining: 0 }
  } catch (e) {
    console.error("[rate-limit] db bucket failed, denying request:", e)
    return { ok: false, retryAfterSec: 60, remaining: 0 }
  }
}

/** Stable, non-reversible id for a presented read key (its sha256 hex). */
export function keyId(readKey: string): string {
  return createHash("sha256").update(readKey).digest("hex").slice(0, 16)
}

/**
 * A limiter bucket that follows one client rather than the whole fleet: the key a build bakes
 * in is shared by every install, so keying on the key alone turns a per-client budget into a
 * global one. [scope] names the endpoint ("feed-key", "report-key"), [id] is the non-reversible
 * key id, and [ip] comes from [clientIp] — computed once by the route so both the per-IP and
 * the per-client buckets agree on one address.
 */
export function clientKeyBucket(scope: string, id: string, ip: string): string {
  return `${scope}:${id}:${ip}`
}

/**
 * A fleet-wide backstop for one read key. Disabled by default (0): a low cap here is exactly
 * the global 429 this fix removes. Set `POOL_KEY_FLEET_LIMIT` to a generous value (e.g. 3000
 * per 5 minutes) only if you want a tripwire against one leaked key rotating addresses; the
 * sticky per-key leases remain the thing that bounds what a key can actually walk.
 */
export function keyFleetLimit(): number {
  const configured = Number(process.env.POOL_KEY_FLEET_LIMIT ?? 0)
  return Number.isFinite(configured) && configured > 0 ? Math.floor(configured) : 0
}

/** A `429` response with the standard backoff hint. */
export function tooManyRequests(retryAfterSec: number, scope: string) {
  return Response.json(
    { error: "rate_limited", detail: `Too many ${scope} requests. Retry shortly.` },
    {
      status: 429,
      headers: {
        "retry-after": String(retryAfterSec),
        "cache-control": "private, no-store",
      },
    },
  )
}
