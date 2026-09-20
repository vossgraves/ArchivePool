import "server-only"

/**
 * A tiny in-process TTL cache for the pool's read-mostly feeds.
 *
 * Every poll from an app client or the status board costs a database query — and on Neon's Free
 * plan the compute is billed by the time it stays awake, not by the query. A woken compute holds
 * for five minutes after the last query (a window the Free plan does not let you shorten), so a
 * single poll per minute keeps a project awake around the clock: that is how this pool spent 440
 * hours of compute in a 30-day month and got suspended for exceeding its 100 CU-hour allowance.
 *
 * Instances change when a sweep runs and the board's figures change when a health sweep runs —
 * hours apart — while clients poll far more often than that. Caching the read for a few minutes
 * collapses a burst of concurrent polls into one query and lets the compute go back to sleep.
 *
 * Deliberately NOT used for leasing (`leaseAccounts`/`leaseInstances`): those write
 * `last_leased_at` on every call, by design, so caching them would silently stop the pool
 * rotating.
 *
 * Process-local, not shared: a hit only helps within the life of one serverless instance. That
 * still covers the case that matters — several clients polling the same warm instance at once —
 * and it needs no extra infrastructure.
 */

interface CacheEntry {
  value: unknown
  expiresAt: number
}

/** Keyed by feed name (`discovery:tidal`, `status`), so plain records are enough. */
const store: Record<string, CacheEntry> = {}
const inFlight: Record<string, Promise<unknown> | undefined> = {}

/**
 * Read through the cache under [key], loading on a miss.
 *
 * Concurrent misses share one load: without that, ten clients arriving together would still run
 * ten queries, which is the burst this exists to absorb.
 */
export async function cached<T>(key: string, ttlMs: number, load: () => Promise<T>): Promise<T> {
  const hit = store[key]
  if (hit && hit.expiresAt > Date.now()) return hit.value as T

  const pending = inFlight[key]
  if (pending) return pending as Promise<T>

  const promise = load()
    .then((value) => {
      store[key] = { value, expiresAt: Date.now() + ttlMs }
      return value
    })
    .finally(() => {
      delete inFlight[key]
    })

  inFlight[key] = promise
  return promise
}

/** Drop every entry whose key starts with [prefix] — used after a sweep so its results show at once. */
export function invalidate(prefix: string): void {
  for (const key of Object.keys(store)) {
    if (key.startsWith(prefix)) delete store[key]
  }
}

/** TTL for the instance/discovery feed: sweeps run every 6 hours, so minutes of staleness are free. */
export const DISCOVERY_TTL_MS = 5 * 60 * 1000

/** TTL for the status board's figures, which only move when a health sweep runs. */
export const STATUS_TTL_MS = 5 * 60 * 1000