// SPDX-License-Identifier: GPL-3.0-or-later
import { NextResponse, type NextRequest } from "next/server"
import { isCronAuthorized as authorized } from "@/lib/admin-auth"
import { runHealthSweep } from "@/lib/health-sweep"
import { writeInstanceSnapshot } from "@/lib/edge-snapshot"
import { invalidate } from "@/lib/ttl-cache"

export const dynamic = "force-dynamic"
export const maxDuration = 60

export async function GET(req: NextRequest) {
  if (!authorized(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 })

  const summary = await runHealthSweep()
  // The board's figures just changed; drop the cached copy so the next reader sees this sweep
  // rather than waiting out the TTL.
  invalidate("status")
  // The sweep also flips instances alive/dead/disabled, and the discovery feeds answer from the
  // Blob snapshot — which the 12-hourly instance sync is what rewrites. Without this the feeds
  // would keep handing out a base URL this sweep just marked dead for up to 12 hours, and the
  // snapshot's own age check cannot catch it because the copy is still well inside its TTL.
  await writeInstanceSnapshot()
  invalidate("snapshot:")
  return NextResponse.json({ ok: true, ...summary, ranAt: new Date().toISOString() })
}
