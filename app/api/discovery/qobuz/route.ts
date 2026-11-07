// SPDX-License-Identifier: GPL-3.0-or-later
import type { NextRequest } from "next/server"
import { serveDiscovery } from "@/lib/discovery-feed"

export const dynamic = "force-dynamic"

/**
 * App-compatible discovery feed for Qobuz instances (`{ streaming, api }` shape).
 *
 * Alias of `/api/instances/qobuz`, kept for app builds that predate the split. The shared
 * implementation enforces the per-client rate limit, the scoped read key, the Cache API copy
 * and the ETag in one place — see lib/discovery-feed.ts.
 */
export async function GET(req: NextRequest) {
  return serveDiscovery("qobuz", req)
}
