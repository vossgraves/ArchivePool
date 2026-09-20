import { NextResponse, type NextRequest } from "next/server"
import { identifyReadKey } from "@/lib/api-keys"
import { SNAPSHOT_CACHE_CONTROL, readInstanceSnapshot } from "@/lib/edge-snapshot"
import { getDiscovery } from "@/lib/queries"
import { clientIp, rateLimit } from "@/lib/rate-limit"
import { DISCOVERY_TTL_MS, cached } from "@/lib/ttl-cache"

export const dynamic = "force-dynamic"

// Shared posture with /api/instances/[service]: per-IP (so one client cannot starve the rest) and
// far above what the app's one-fetch-per-15–24h rotation can hit. See lib/rate-limit.ts.
const IP_LIMIT = 60
const IP_WINDOW_MS = 60_000

// App-compatible discovery feed for Qobuz instances ({ streaming, api } shape).
// Requires a valid per-app key when READ_KEYS_ENFORCED=true; a key scoped to another service is
// refused, and on any rejection we return an empty feed with 401 so the app degrades gracefully.
export async function GET(req: NextRequest) {
  const verdict = rateLimit(`feed-ip:${clientIp(req.headers)}`, IP_LIMIT, IP_WINDOW_MS)
  if (!verdict.ok) {
    return NextResponse.json(
      { streaming: [], api: [] },
      { status: 429, headers: { "retry-after": String(verdict.retryAfterSec) } },
    )
  }

  const identity = await identifyReadKey(req)
  if (!identity.ok || (identity.scope && identity.scope !== "qobuz")) {
    return NextResponse.json({ streaming: [], api: [] }, { status: 401 })
  }

  try {
    // Snapshot first (public URLs, zero database cost); see the instances route for the rationale.
    const snapshot = await cached("snapshot:qobuz", DISCOVERY_TTL_MS, () =>
      readInstanceSnapshot("qobuz"),
    )
    if (snapshot) {
      return NextResponse.json(snapshot, {
        headers: { "cache-control": SNAPSHOT_CACHE_CONTROL },
      })
    }

    const data = await cached("discovery:qobuz", DISCOVERY_TTL_MS, () => getDiscovery("qobuz"))
    return NextResponse.json(data, {
      headers: { "cache-control": "private, no-store" },
    })
  } catch {
    return NextResponse.json({ streaming: [], api: [] })
  }
}