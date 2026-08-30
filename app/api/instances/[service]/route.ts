import { NextResponse, type NextRequest } from "next/server"
import { verifyReadKey } from "@/lib/api-keys"
import { getDiscovery } from "@/lib/queries"
import { isService } from "@/lib/sources"

export const dynamic = "force-dynamic"

/**
 * INSTANCE-URLS-ONLY feed. This is the URL half of the split pool:
 *  - /api/instances/[service] → this route. Instance base URLs only; never credentials.
 *  - /api/accounts            → account tokens/ARLs only.
 *
 * Shape is `{ streaming, api }` — identical to the legacy /api/discovery/[service] routes
 * (which remain as aliases so existing app builds keep working). Requires a valid per-app read
 * key; on auth failure an empty feed is returned with 401 so the app degrades gracefully.
 */
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ service: string }> },
) {
  const { service } = await params
  if (!isService(service)) {
    return NextResponse.json({ streaming: [], api: [], error: "unknown service" }, { status: 404 })
  }

  if (!(await verifyReadKey(req))) {
    return NextResponse.json({ streaming: [], api: [] }, { status: 401 })
  }
  try {
    const data = await getDiscovery(service)
    return NextResponse.json(data, {
      headers: { "cache-control": "private, no-store" },
    })
  } catch {
    return NextResponse.json({ streaming: [], api: [] })
  }
}
