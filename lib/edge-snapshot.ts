import "server-only"

import { get, put } from "@vercel/blob"
import { getDiscovery } from "@/lib/queries"
import { SERVICES, type Service } from "@/lib/sources"

/**
 * The pool's servable instance URLs, snapshotted to Vercel Blob by the sweep and read back by the
 * discovery routes. The URLs are public by design — the schema documents `baseUrl` as "readable
 * for discovery" — so one shared copy leaks nothing, while serving polls from it lets the database
 * compute stay asleep between sweeps. See lib/ttl-cache.ts for what a woken compute costs.
 */

/** One stable pathname, rewritten in place each sweep, so a reader needs no lookup table. */
const SNAPSHOT_PATHNAME = "pool/instances.json"

/**
 * The instance sweep runs every 12 hours (see .github/workflows/monochrome-cron.yml), so a
 * snapshot is routinely up to 12h old. Twice that lets one missed sweep fall back to the database
 * instead of pinning every route to a day-old feed.
 */
const SNAPSHOT_TTL_MS = 24 * 60 * 60 * 1000

type Discovery = { streaming: string[]; api: string[] }
type Snapshot = Record<Service, Discovery>

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
 * Write every service's servable instance URLs to one blob. Called at the end of the sweep.
 *
 * Nothing here propagates: a Blob outage must not fail a sweep whose database work already
 * succeeded, and the routes treat an absent snapshot as "read Postgres" anyway.
 */
export async function writeInstanceSnapshot(): Promise<void> {
  if (!process.env.BLOB_READ_WRITE_TOKEN) return
  try {
    const discovered = await Promise.all(SERVICES.map((service) => getDiscovery(service)))
    const snapshot = {} as Snapshot
    SERVICES.forEach((service, index) => {
      snapshot[service] = discovered[index]
    })
    await put(SNAPSHOT_PATHNAME, JSON.stringify(snapshot), {
      access: "public",
      contentType: "application/json",
      addRandomSuffix: false,
      allowOverwrite: true,
    })
  } catch (err) {
    console.error("[pool] failed to write instance snapshot", err)
  }
}

/**
 * The snapshot for [service], or null when Blob is unconfigured, the copy is missing or older than
 * [SNAPSHOT_TTL_MS], or anything else went wrong. Every failure collapses to the same null because
 * the caller's fallback — the cached database feed — is identical in each case.
 */
export async function readInstanceSnapshot(service: Service): Promise<Discovery | null> {
  if (!process.env.BLOB_READ_WRITE_TOKEN) return null
  try {
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
 * Cache-Control for a snapshot answer, resolved once per deployment.
 *
 * Public caching is only honest while the feed is public. Vercel's CDN keys on the URL and does not
 * vary on `Authorization`, so a response cached from a keyed request would be handed straight to the
 * next anonymous caller — the key check would run once and then be bypassed for everyone afterwards.
 * With READ_KEYS_ENFORCED the answer is per-key and must stay private: the snapshot still saves the
 * database read, it just cannot also save the function invocation.
 *
 * A constant rather than a function because all three instance/discovery routes must agree on it;
 * one of them diverging is the leak this exists to prevent.
 */
export const SNAPSHOT_CACHE_CONTROL =
  process.env.READ_KEYS_ENFORCED === "true"
    ? "private, no-store"
    : "public, s-maxage=300, stale-while-revalidate=3600"