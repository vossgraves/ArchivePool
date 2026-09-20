import { NextResponse, type NextRequest } from "next/server"
import { identifyReadKey } from "@/lib/api-keys"
import { readInstanceSnapshot } from "@/lib/edge-snapshot"
import { getDiscovery } from "@/lib/queries"
import { clientIp, rateLimit } from "@/lib/rate-limit"
import { DISCOVERY_TTL_MS, cached } from "@/lib/ttl-cache"

export const dynamic = "force-dynamic"

// Shared posture with /api/instances/[service]: per-IP (so one client cannot starve the rest) and
// far above what the app's one-fetch-per-15–24h rotation can hit. See lib/rate-limit.ts.
const IP_LIMIT = 60
const IP_WINDOW_MS = 60_000

// App-compatible discovery feed. ArchiveTune's TidalAudioProvider.discoverInstances()
// parses this { streaming, api } shape directly. Requires a valid per-app key when
// READ_KEYS_ENFORCED=true; a key scoped to another service is refused, and on any rejection
// we return an empty feed with 401 so the app degrades gracefully rather than crashing.
export async function GET(req: NextRequest) {
  const verdict = rateLimit(`feed-ip:${clientIp(req.headers)}`, IP_LIMIT, IP_WINDOW_MS)
  if (!verdict.ok) {
    return NextResponse.json(
      { streaming: [], api: [] },
      { status: 429, headers: { "retry-after": String(verdict.retryAfterSec) } },
    )
  }

  const identity = await identifyReadKey(req)
  if (!identity.ok || (identity.scope && identity.scope !== "tidal")) {
    return NextResponse.json({ streaming: [], api: [] }, { status: 401 })
  }

  try {
    // Snapshot first (public URLs, zero database cost); see the instances route for the rationale.
    const snapshot = await cached("snapshot:tidal", DISCOVERY_TTL_MS, () =>
      readInstanceSnapshot("tidal"),
    )
    if (snapshot) {
      return NextResponse.json(snapshot, {
        headers: { "cache-control": "public, s-maxage=300, stale-while-revalidate=3600" },
      })
    }

    const data = await cached("discovery:tidal", DISCOVERY_TTL_MS, () => getDiscovery("tidal"))
    return NextResponse.json(data, {
      headers: { "cache-control": "private, no-store" },
    })
  } catch {
    return NextResponse.json({ streaming: [], api: [] })
  }
}