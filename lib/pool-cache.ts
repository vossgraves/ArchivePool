// SPDX-License-Identifier: GPL-3.0-or-later
import "server-only"

import { cfBindings } from "@/lib/cf-env"
import { chargeResource } from "@/lib/resource-budget"

/**
 * Small helpers over the `POOL_SNAPSHOTS` Workers KV namespace.
 *
 * Why this exists: Hyperdrive Free meters **every database statement** (100,000/day) and
 * Workers KV meters reads (100,000/day) separately. A feed poll used to cost two SQL
 * statements just to authenticate the read key; replacing that with one KV read per key per
 * isolate (and none at all on a warm isolate) moves the work onto the cheaper meter and
 * keeps the database compute asleep.
 *
 * The namespace already holds the instance snapshot (`pool/instances.json`), so no new
 * binding is required. Keys added by this fix:
 *   - `schema:applied`     — the schema version whose migrations have already run
 *   - `pool/status.json`   — the sweep's status-board snapshot
 *
 * Read-key identities are NOT stored here: KV Free allows only 1,000 writes/day, and a shared
 * build key refreshed by many isolates would spend that budget on its own. That cache lives in
 * the per-colo Cache API (lib/edge-cache.ts), which is unmetered for writes.
 *
 * Off Workers `cfBindings()` is null, every read misses and every write is a no-op, so the
 * Vercel/Railway paths keep their existing database-only behaviour exactly.
 */

interface KVStore {
  get(key: string): Promise<string | null>
  put(key: string, value: string, options?: { expirationTtl?: number }): Promise<unknown>
}

function store(): KVStore | null {
  const binding = cfBindings()?.POOL_SNAPSHOTS
  return binding ? (binding as KVStore) : null
}

/** Read [key], or null when the binding is absent, the key is missing or KV fails. Never throws. */
export async function kvGetText(key: string): Promise<string | null> {
  const kv = store()
  if (!kv) return null
  try {
    await chargeResource("reads")
    return await kv.get(key)
  } catch (err) {
    console.error("[kv] read failed:", key, err instanceof Error ? err.message : err)
    return null
  }
}

/** Write [key], optionally with a TTL in seconds. Returns false when unavailable/failed. Never throws. */
export async function kvPutText(
  key: string,
  value: string,
  expirationTtl?: number,
): Promise<boolean> {
  const kv = store()
  if (!kv) return false
  try {
    await chargeResource("writes")
    await kv.put(key, value, expirationTtl == null ? undefined : { expirationTtl })
    return true
  } catch (err) {
    console.error("[kv] write failed:", key, err instanceof Error ? err.message : err)
    return false
  }
}
