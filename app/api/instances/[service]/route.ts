// SPDX-License-Identifier: GPL-3.0-or-later
import { NextResponse, type NextRequest } from "next/server"
import { serveDiscovery } from "@/lib/discovery-feed"
import { isService } from "@/lib/sources"

export const dynamic = "force-dynamic"

/**
 * INSTANCE-URLS-ONLY feed. This is the URL half of the split pool:
 *  - /api/instances/[service] → this route. Instance base URLs only; never credentials.
 *  - /api/accounts            → account tokens/ARLs only.
 *
 * Shape is `{ streaming, api }` — identical to the legacy /api/discovery/* routes (which remain
 * as aliases so existing app builds keep working). Requires a valid per-app read key when
 * READ_KEYS_ENFORCED=true; a key scoped to another service is refused, and on any rejection an
 * empty feed is returned with 401 so the app degrades gracefully.
 *
 * Limits, caching and ETag handling are shared with the aliases in lib/discovery-feed.ts. The
 * per-IP limit is keyed on the real client address, and the read-key check is memoized in KV,
 * so a poll costs no database statement on a warm key.
 */
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ service: string }> },
) {
  const { service } = await params
  if (!isService(service)) {
    return NextResponse.json({ streaming: [], api: [], error: "unknown service" }, { status: 404 })
  }
  return serveDiscovery(service, req)
}
