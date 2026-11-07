// SPDX-License-Identifier: GPL-3.0-or-later
import "server-only"

/**
 * Edge-cache and validator helpers for the public JSON feeds.
 *
 * On Workers the Cache API is a per-colo key/value store that does not touch the database and
 * does not consume the Hyperdrive statement budget. That makes it the right place for the
 * instance feed (identical body for every valid read key) and the status board (public,
 * changes only when a sweep runs). The same Cache API call counts as a subrequest, so this
 * module is deliberately one match + one put per miss — far inside the 50-subrequest ceiling.
 *
 * On Vercel/Railway `caches` is not defined; every read misses and every write is a no-op.
 * Those hosts keep using `s-maxage` on the response, as before.
 */

interface CacheLike {
  match(request: Request): Promise<Response | undefined>
  put(request: Request, response: Response): Promise<void>
}

interface CacheStorageLike {
  default?: CacheLike
}

function edgeCache(): CacheLike | null {
  const storage = (globalThis as { caches?: CacheStorageLike }).caches
  return storage?.default ?? null
}

// A synthetic origin keeps cache keys stable and impossible to confuse with a real request.
// Version the prefix when a body shape changes so an old entry cannot be served as the new one.
const CACHE_ORIGIN = "https://edge-cache.archivepool.internal/"
const CACHE_VERSION = "v1"

function cacheRequest(name: string): Request {
  return new Request(`${CACHE_ORIGIN}${CACHE_VERSION}/${encodeURIComponent(name)}`, { method: "GET" })
}

/** Read one cached body, or null on a miss / any cache failure. Never throws. */
export async function edgeGet(name: string): Promise<string | null> {
  const cache = edgeCache()
  if (!cache) return null
  try {
    const hit = await cache.match(cacheRequest(name))
    return hit ? await hit.text() : null
  } catch {
    return null
  }
}

/** Store one body for [ttlSec]. Never throws: a cache outage must not fail the response. */
export async function edgePut(name: string, body: string, ttlSec: number): Promise<void> {
  const cache = edgeCache()
  if (!cache) return
  try {
    await cache.put(
      cacheRequest(name),
      new Response(body, {
        status: 200,
        headers: {
          "content-type": "application/json; charset=utf-8",
          // The Cache API takes the stored response's TTL from this header.
          "cache-control": `public, max-age=${Math.max(1, Math.floor(ttlSec))}`,
        },
      }),
    )
  } catch {
    /* best effort */
  }
}

/**
 * A weak ETag over the body: two independent 32-bit FNV-1a passes plus the byte length.
 * Not cryptographic — it only has to change when the body changes. Weak (`W/`) because the
 * body bytes are identical but intermediaries may re-encode them.
 */
export function weakEtag(body: string): string {
  let a = 0x811c9dc5
  let b = 0x01000193
  for (let i = 0; i < body.length; i++) {
    const code = body.charCodeAt(i)
    a = Math.imul(a ^ code, 0x01000193) >>> 0
    b = Math.imul(b ^ (code + i), 0x85ebca6b) >>> 0
  }
  return `W/"${a.toString(16)}${b.toString(16)}-${body.length.toString(16)}"`
}

/**
 * True when an `If-None-Match` header covers [etag]. Handles the common forms clients send:
 * `*`, a single weak/strong tag, and a comma-separated list. Comparison ignores the weak
 * prefix and optional quotes, per RFC 9110's weak comparison.
 */
export function isNotModified(ifNoneMatch: string | null, etag: string): boolean {
  if (!ifNoneMatch) return false
  if (ifNoneMatch.trim() === "*") return true
  const normalize = (value: string) => value.trim().replace(/^W\//, "").replace(/^"|"$/g, "")
  const wanted = normalize(etag)
  return ifNoneMatch
    .split(",")
    .map(normalize)
    .some((candidate) => candidate === wanted)
}
