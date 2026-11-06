// SPDX-License-Identifier: GPL-3.0-or-later
import { NextResponse, type NextRequest } from "next/server"
import { edgeGet, edgePut, isNotModified, weakEtag } from "@/lib/edge-cache"
import { HISTORY_DAYS, getPoolHistory, getStatus } from "@/lib/queries"
import { readStatusSnapshot, type StatusSnapshot } from "@/lib/status-snapshot"
import { STATUS_TTL_MS, cached } from "@/lib/ttl-cache"

export const dynamic = "force-dynamic"

/**
 * Aggregate, credential-free health for the public board.
 *
 * Three layers, cheapest first, because this endpoint is the only public read that cannot
 * degrade around its database figures:
 *   1. Cache API (per-colo, 5 minutes) — survives an isolate restart and costs no SQL;
 *   2. Workers KV snapshot written by the health sweep — one read, no SQL;
 *   3. the database, as before. The route deliberately does not write the KV snapshot itself:
 *      KV Free allows 1,000 writes/day, and the sweep already writes it once (see
 *      lib/status-snapshot.ts); a cold colo before the first sweep is covered by the edge copy.
 *
 * Hyperdrive Free meters every statement against 100,000/day; the board used to cost four of
 * them per cache miss per isolate, which is why it went dark first when the limit was hit.
 */
const EDGE_KEY = "status"
const EDGE_TTL_SEC = 300
// Matches the edge TTL: a warm isolate should not read KV more than once per five minutes.
const SNAPSHOT_MEMO_MS = 5 * 60_000

export async function GET(req: NextRequest) {
  const edgeBody = await edgeGet(EDGE_KEY)
  if (edgeBody) return respond(edgeBody, req)

  // Five minutes of in-process memo on top: a burst on one isolate should not read KV per
  // request, and the freshness matches the edge TTL.
  const snapshot = await cached<StatusSnapshot | null>("status:snapshot", SNAPSHOT_MEMO_MS, readStatusSnapshot)
  if (snapshot) {
    const body = JSON.stringify({
      generatedAt: new Date(snapshot.savedAt).toISOString(),
      categories: snapshot.categories,
      history: snapshot.history,
    })
    await edgePut(EDGE_KEY, body, EDGE_TTL_SEC)
    return respond(body, req)
  }

  let categories
  try {
    // Cached for a few minutes: these figures only move when a health sweep runs, while the
    // board and any monitoring poll far more often, and every miss wakes the database compute
    // for five minutes (lib/ttl-cache.ts).
    categories = await cached("status", STATUS_TTL_MS, getStatus)
  } catch (err) {
    console.error("[status] database unavailable:", err)
    return NextResponse.json(
      {
        error: "database_unavailable",
        detail: err instanceof Error ? err.message : "unknown database error",
      },
      {
        status: 503,
        headers: {
          "cache-control": "no-store",
          // Tell well-behaved clients to come back later instead of treating this as a
          // host-level failover (which used to walk them to a second, dead endpoint).
          "retry-after": "60",
          "access-control-allow-origin": "*",
        },
      },
    )
  }

  const history = await getPoolHistory().catch((err) => {
    // History is additive to the documented payload and non-fatal: the board's figures matter
    // more than its trend line, so a slow aggregate must not take the whole feed down with it.
    console.error("[status] history unavailable:", err)
    return { overall: [], categories: [] }
  })

  // Warm only the per-colo edge copy: KV is written by the sweep, not by polls (1k writes/day).
  const body = JSON.stringify({
    generatedAt: new Date().toISOString(),
    categories,
    history: { days: HISTORY_DAYS, ...history },
  })
  await edgePut(EDGE_KEY, body, EDGE_TTL_SEC)
  return respond(body, req)
}

function respond(body: string, req: NextRequest): Response {
  const etag = weakEtag(body)
  const headers = {
    "content-type": "application/json; charset=utf-8",
    // Five minutes at the edge, an hour of stale-while-revalidate behind it. The figures only
    // move when a health sweep runs (every 6 hours), so a CDN copy is as accurate as the
    // function's own cache — and unlike that cache it costs no invocation on hosts with a CDN.
    "cache-control": "public, s-maxage=300, stale-while-revalidate=3600",
    "access-control-allow-origin": "*",
    etag,
  }
  if (isNotModified(req.headers.get("if-none-match"), etag)) {
    return new Response(null, { status: 304, headers })
  }
  return new Response(body, { status: 200, headers })
}
