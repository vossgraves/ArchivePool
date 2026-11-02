// SPDX-License-Identifier: GPL-3.0-or-later
import "server-only"
import { createHash } from "node:crypto"
import { pool } from "@/lib/db"
import { ensureSchema } from "@/lib/db/ensure"

/**
 * Lightweight in-memory sliding-window rate limiter.
 *
 * Defends the credential feeds (per read key), the report endpoint (per IP) and the login
 * endpoint (per IP+username) against scripted abuse. No database writes per request — Neon
 * compute wakeups are metered, so a DB-backed bucket would cost more than the abuse it stops.
 *
 * Honest limitation: Vercel serverless runs several concurrent instances, each with its own
 * window, so the effective ceiling is limit × instance-count. That is still a large raise of
 * the bar against the realistic threat (a leaked key walking the pool via lease rotation, or
 * report-spam disabling healthy entries), and it never punishes the ArchiveTune app itself,
 * which self-throttles to one fetch per 15–24h.
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
    for (const [key, b] of buckets) {
      if (b.hits.length === 0 || now - b.hits[b.hits.length - 1] >= windowMs) buckets.delete(key)
    }
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

/** Best-effort client IP from the proxy headers Vercel sets. Empty when absent. */
export function clientIp(req: Headers): string {
  const fwd = req.get("x-forwarded-for")?.split(",")[0]?.trim()
  return (fwd || req.get("x-real-ip") || "unknown").slice(0, 64)
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
