// SPDX-License-Identifier: GPL-3.0-or-later
import "server-only"

import { cfBindings } from "@/lib/cf-env"
import { chargeResource } from "@/lib/resource-budget"

/** Guarded snapshot storage. Reads never write; schema checks fail closed on storage errors. */

interface KVStore {
  get(key: string): Promise<string | null>
  put(key: string, value: string, options?: { expirationTtl?: number }): Promise<unknown>
}

function store(): KVStore | null {
  const binding = cfBindings()?.POOL_SNAPSHOTS
  return binding ? (binding as KVStore) : null
}

/** Read [key], or null when the binding is absent, the key is missing or KV fails. Never throws. */
export async function kvGetText(key: string, failClosed = false): Promise<string | null> {
  const kv = store()
  if (!kv) return null
  try {
    await chargeResource("reads")
    return await kv.get(key)
  } catch (err) {
    if (failClosed) throw err
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
