import { NextResponse, type NextRequest } from "next/server"
import { identifyReadKey } from "@/lib/api-keys"
import { SNAPSHOT_CACHE_CONTROL, readInstanceSnapshot } from "@/lib/edge-snapshot"
import { getDiscovery } from "@/lib/queries"
import { clientIp, rateLimit } from "@/lib/rate-limit"
import { isService } from "@/lib/sources"
import { DISCOVERY_TTL_MS, cached } from "@/lib/ttl-cache"

export const dynamic = "force-dynamic"

// The ArchiveTune app self-throttles to one discovery fetch per 15–24h, so this sits far above any
// normal build's polling; it is keyed by IP so one noisy client cannot starve the rest. Serverless
// instances each keep their own window, which is fine for the abuse this guards against.
const IP_LIMIT = 60
const IP_WINDOW_MS = 60_000

/**
 * INSTANCE-URLS-ONLY feed. This is the URL half of the split pool:
 *  - /api/instances/[service] → this route. Instance base URLs only; never credentials.
 *  - /api/accounts            → account tokens/ARLs only.
 *
 * Shape is `{ streaming, api }` — identical to the legacy /api/discovery/[service] routes
 * (which remain as aliases so existing app builds keep working). Requires a valid per-app read
 * key when READ_KEYS_ENFORCED=true; a key scoped to another service is refused, and on any
 * rejection an empty feed is returned with 401 so the app degrades gracefully.
 */
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ service: string }> },
) {
  const { service } = await params
  if (!isService(service)) {
    return NextResponse.json({ streaming: [], api: [], error: "unknown service" }, { status: 404 })
  }

  const verdict = rateLimit(`feed-ip:${clientIp(req.headers)}`, IP_LIMIT, IP_WINDOW_MS)
  if (!verdict.ok) {
    return NextResponse.json(
      { streaming: [], api: [] },
      { status: 429, headers: { "retry-after": String(verdict.retryAfterSec) } },
    )
  }

  const identity = await identifyReadKey(req)
  // A null scope is "every service"; an anonymous caller (valid key absent, unenforced) is null too.
  if (!identity.ok || (identity.scope && identity.scope !== service)) {
    return NextResponse.json({ streaming: [], api: [] }, { status: 401 })
  }

  try {
    // Snapshot first: its body is instance URLs, public by design, and serving it costs the
    // database nothing. The lookup is cached briefly too, so a burst of polls does not each reach
    // Blob; the sweep invalidates this key when it rewrites the snapshot.
    const snapshot = await cached(`snapshot:${service}`, DISCOVERY_TTL_MS, () =>
      readInstanceSnapshot(service),
    )
    if (snapshot) {
      return NextResponse.json(snapshot, {
        headers: { "cache-control": SNAPSHOT_CACHE_CONTROL },
      })
    }

    // No snapshot (Blob unconfigured, copy missing or stale): the existing cached database read.
    // Instances only change when a sweep runs and clients poll far more often than that, and every
    // miss wakes the database compute for five minutes — see lib/ttl-cache.ts for what that costs.
    const data = await cached(`discovery:${service}`, DISCOVERY_TTL_MS, () => getDiscovery(service))
    return NextResponse.json(data, {
      headers: { "cache-control": "private, no-store" },
    })
  } catch {
    return NextResponse.json({ streaming: [], api: [] })
  }
}