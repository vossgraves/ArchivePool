// SPDX-License-Identifier: GPL-3.0-or-later
import "server-only"

import { cfBindings } from "@/lib/cf-env"
import { kvGetText, kvPutText } from "@/lib/pool-cache"
import { getAllDiscovery } from "@/lib/queries"
import { type Service } from "@/lib/sources"

/**
 * The pool's servable instance URLs, snapshotted by the sweep and read back by the
 * discovery routes. The URLs are public by design — the schema documents `baseUrl`
 * as "readable for discovery" — so one shared copy leaks nothing, while serving
 * polls from it lets the database compute stay asleep between sweeps. See
 * lib/ttl-cache.ts for what a woken compute costs.
 *
 * Storage backend, picked per deployment:
 *  - Cloudflare Workers: the `POOL_SNAPSHOTS` Workers KV namespace. The object is a
 *    few KB, rewritten in place a handful of times a day — far inside KV's free
 *    allotment (1k writes / 100k reads / 25 MiB per value) and needs no payment
 *    method, unlike R2 on a fresh account.
 *  - Vercel / elsewhere: Vercel Blob, exactly as before, behind BLOB_READ_WRITE_TOKEN.
 * Both are optional: an unconfigured store returns null and the routes fall back to
 * the (cached) database feed, which is the same degradation they already had.
 */

/** One stable key, rewritten in place each sweep, so a reader needs no lookup table. */
const SNAPSHOT_PATHNAME = "pool/instances.json"

/**
 * The instance sweep runs every 12 hours (see .github/workflows/monochrome-cron.yml), so a
 * snapshot is routinely up to 12h old. Twice that lets one missed sweep fall back to the database
 * instead of pinning every route to a day-old feed.
 */
const SNAPSHOT_TTL_MS = 24 * 60 * 60 * 1000

type Discovery = { streaming: string[]; api: string[]; stale?: boolean }
type Snapshot = Record<Service, Discovery>

// The TTL travels inside the value: KV keeps no uploaded timestamp, so readers check
// savedAt themselves — identical semantics to the old object-metadata check.
type StoredSnapshot = { savedAt: number; data: Snapshot }

/** The slice of the KVNamespace API this file uses — declared locally so no workers-types dep is needed. */
interface SnapshotStore {
  get(key: string): Promise<string | null>
  put(key: string, value: string, options?: { expirationTtl?: number }): Promise<unknown>
}

function snapshotStore(): SnapshotStore | null {
  const store = cfBindings()?.POOL_SNAPSHOTS
  return store ? (store as SnapshotStore) : null
}

function isDiscovery(value: unknown): value is Discovery {
  const v = value as Discovery | undefined
  return (
    !!v &&
    Array.isArray(v.streaming) &&
    v.streaming.every((url) => typeof url === "string") &&
    Array.isArray(v.api) &&
    v.api.every((url) => typeof url === "string")
  )
}

/**
 * Write every service's servable instance URLs to one object. Called at the end of the sweep.
 *
 * Nothing here propagates: a storage outage must not fail a sweep whose database work already
 * succeeded, and the routes treat an absent snapshot as "read Postgres" anyway.
 */
export async function writeInstanceSnapshot(): Promise<void> {
  const store = snapshotStore()
  // Blob only enters when there is no KV binding, so a Workers deploy never needs the token.
  const useBlob = !cfBindings() && !store && Boolean(process.env.BLOB_READ_WRITE_TOKEN)
  if (!store && !useBlob) return
  try {
    // One query for every service. The previous per-service Promise.all ran five statements
    // on every sweep/sync, and Hyperdrive Free meters each of them.
    const snapshot = await getAllDiscovery()
    const body = JSON.stringify({ savedAt: Date.now(), data: snapshot } satisfies StoredSnapshot)
    if (store) {
      // Keep the last good value during outages; readers mark its age instead of deleting it.
      await kvPutText(SNAPSHOT_PATHNAME, body)
    } else {
      // Lazy import: keeps @vercel/blob out of the Workers bundle entirely on builds
      // where this branch can never execute.
      const { put } = await import("@vercel/blob")
      await put(SNAPSHOT_PATHNAME, JSON.stringify(snapshot), {
        access: "public",
        contentType: "application/json",
        addRandomSuffix: false,
        allowOverwrite: true,
      })
    }
  } catch (err) {
    console.error("[pool] failed to write instance snapshot", err)
  }
}

/**
 * The snapshot for [service], or null when the store is unconfigured, the copy is missing or
 * older than [SNAPSHOT_TTL_MS], or anything else went wrong. Every failure collapses to the
 * same null because the caller's fallback — the cached database feed — is identical in each case.
 */
export async function readInstanceSnapshot(service: Service): Promise<Discovery | null> {
  const store = snapshotStore()
  if (store) {
    try {
      const raw = await kvGetText(SNAPSHOT_PATHNAME)
      if (!raw) return null
      const parsed = JSON.parse(raw) as Partial<StoredSnapshot> | null
      if (!parsed || typeof parsed.savedAt !== "number") return null
      const entry = parsed.data?.[service]
      return isDiscovery(entry) ? { ...entry, ...(Date.now() - parsed.savedAt > SNAPSHOT_TTL_MS ? { stale: true } : {}) } : null
    } catch {
      return null
    }
  }

  if (cfBindings()) return null
  if (!process.env.BLOB_READ_WRITE_TOKEN) return null
  try {
    const { get } = await import("@vercel/blob")
    // useCache:false — the pathname is overwritten in place, so a CDN-cached copy could otherwise
    // serve a superseded sweep for up to the blob's default month-long cache age.
    const blob = await get(SNAPSHOT_PATHNAME, { access: "public", useCache: false })
    if (!blob || blob.statusCode !== 200) return null
    if (Date.now() - blob.blob.uploadedAt.getTime() > SNAPSHOT_TTL_MS) return null
    const parsed = (await new Response(blob.stream).json()) as Partial<Snapshot> | null
    const entry = parsed?.[service]
    return isDiscovery(entry) ? entry : null
  } catch {
    return null
  }
}

/**
 * Cache-Control for a snapshot answer, resolved per request.
 *
 * Public caching is only honest while the feed is public. Vercel's CDN keys on the URL and does not
 * vary on `Authorization`, so a response cached from a keyed request would be handed straight to the
 * next anonymous caller — the key check would run once and then be bypassed for everyone afterwards.
 * With READ_KEYS_ENFORCED the answer must stay out of any shared cache; the client's own cache is a
 * different thing, and letting it hold the public URL list is what saves the invocation.
 *
 * A function rather than a constant because this module initializes at isolate cold start, before
 * the worker's env is injected into process.env — a top-level const would freeze "enforced" to
 * whatever the (empty) build-time env said. All three instance/discovery routes must agree on the
 * answer; one of them diverging is the leak this exists to prevent.
 *
 * `private` (not `no-store`) when keys are enforced: the body is identical public instance URLs
 * for every caller, so a shared cache must not store it (Vercel keys on URL, not Authorization),
 * but the app's own HTTP cache may keep it for five minutes. That is what lets a client skip the
 * revalidation request entirely and takes pressure off the Workers request quota. `no-store` also
 * forbade the conditional requests the ETag on these routes exists to enable.
 */
export function snapshotCacheControl(): string {
  return process.env.READ_KEYS_ENFORCED === "true"
    ? "private, max-age=300, stale-while-revalidate=3600"
    : "public, s-maxage=300, stale-while-revalidate=3600"
}
