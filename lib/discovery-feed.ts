// SPDX-License-Identifier: GPL-3.0-or-later
import "server-only"

import { NextResponse, type NextRequest } from "next/server"
import { identifyDiscoveryKey } from "@/lib/api-keys"
import { cfBindings } from "@/lib/cf-env"
import { edgeGet, edgePut, isNotModified, weakEtag } from "@/lib/edge-cache"
import { readInstanceSnapshot, snapshotCacheControl } from "@/lib/edge-snapshot"
import type { DiscoveryFeed } from "@/lib/queries"
import { getDiscovery } from "@/lib/queries"
import { clientIp, rateLimit } from "@/lib/rate-limit"
import { DISCOVERY_TTL_MS, cached } from "@/lib/ttl-cache"
import type { Service } from "@/lib/sources"
import { databaseUnavailable } from "@/lib/resource-budget"

/**
 * One implementation behind `/api/instances/[service]` and the legacy `/api/discovery/*`
 * aliases. It lives here so the rate-limit identity, the edge cache and the ETag cannot drift
 * between the three routes — the previous copy-paste is how the Worker ended up with three
 * slightly different auth/limit paths.
 *
 * Request path, cheapest first:
 *   1. per-client rate limit (real address — see lib/request-ip.ts);
 *   2. read-key check, memoized per colo by key hash (no SQL on a hit);
 *   3. Cache API body (identical for every valid key; read only after auth);
 *   4. Workers KV instance snapshot (still the sweep's copy of record);
 *   5. database — only when the snapshot is missing/stale.
 *
 * A degraded read is never cached: an empty feed stored at the edge for five minutes would
 * outlast the database blip that produced it.
 */
const IP_LIMIT = 120
const IP_WINDOW_MS = 60_000
const EDGE_TTL_SEC = 300
const EMPTY: DiscoveryFeed = { streaming: [], api: [] }

export async function serveDiscovery(service: Service, req: NextRequest): Promise<Response> {
  const ip = clientIp(req.headers)
  const verdict = rateLimit(`feed-ip:${ip}`, IP_LIMIT, IP_WINDOW_MS)
  if (!verdict.ok) {
    return NextResponse.json(EMPTY, {
      status: 429,
      headers: {
        "retry-after": String(verdict.retryAfterSec),
        "cache-control": "private, no-store",
      },
    })
  }

  const identity = await identifyDiscoveryKey(req)
  // A null scope is "every service"; a scoped key may only read its own service.
  if (!identity.ok || (identity.scope && identity.scope !== service)) {
    return NextResponse.json(EMPTY, {
      status: 401,
      headers: { "cache-control": "private, no-store" },
    })
  }

  const cacheKey = `discovery:${service}`
  let body = await edgeGet(cacheKey)
  if (body == null) {
    const data = await loadDiscovery(service)
    if (data == null) {
      const archived = await edgeGet(`${cacheKey}:last-good`)
      if (archived) {
        body = JSON.stringify({ ...JSON.parse(archived), stale: true })
        await edgePut(cacheKey, body, 60)
        return feedResponse(body, req, true)
      }
      // Degraded (database/snapshot unavailable): answer the existing graceful shape, but do
      // not cache it.
      return feedResponse(JSON.stringify(cfBindings() ? { ...EMPTY, stale: true } : EMPTY), req, false)
    }
    body = JSON.stringify(data)
    await edgePut(cacheKey, body, EDGE_TTL_SEC)
    await edgePut(`${cacheKey}:last-good`, body, 7 * 86400)
  }
  if (identity.stale || await databaseUnavailable()) body = JSON.stringify({ ...JSON.parse(body), stale: true })
  return feedResponse(body, req, true)
}

async function loadDiscovery(service: Service): Promise<DiscoveryFeed | null> {
  try {
    // The snapshot is the sweep's copy of every service's URLs and costs no database query.
    const snapshot = await cached(`snapshot:${service}`, DISCOVERY_TTL_MS, () =>
      readInstanceSnapshot(service),
    )
    if (snapshot) return snapshot
    if (cfBindings()) return null
    // No snapshot (KV unconfigured, copy missing or stale): the cached database read.
    return await cached(`discovery:${service}`, DISCOVERY_TTL_MS, () => getDiscovery(service))
  } catch {
    return null
  }
}

function feedResponse(body: string, req: NextRequest, cacheable: boolean): Response {
  const etag = weakEtag(body)
  const cacheControl = snapshotCacheControl()
  // A degraded empty answer is not a validator target: answering 304 would let a client keep
  // an empty cache from before the blip.
  if (cacheable && isNotModified(req.headers.get("if-none-match"), etag)) {
    return new Response(null, {
      status: 304,
      headers: { etag, "cache-control": cacheControl, "access-control-allow-origin": "*" },
    })
  }
  return new Response(body, {
    status: 200,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": cacheable ? cacheControl : "private, no-store",
      etag,
      "access-control-allow-origin": "*",
    },
  })
}
