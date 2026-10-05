// SPDX-License-Identifier: GPL-3.0-or-later
import { NextResponse, type NextRequest } from "next/server"
import { isCronAuthorized as authorized } from "@/lib/admin-auth"
import { writeInstanceSnapshot } from "@/lib/edge-snapshot"
import { syncMonochromeInstances } from "@/lib/monochrome"
import { syncSpotiFlacInstances } from "@/lib/spotiflac"
import { invalidate } from "@/lib/ttl-cache"

export const dynamic = "force-dynamic"
export const maxDuration = 60

/**
 * Instance-sync cron: monochrome plus SpotiFLAC's public Tidal and Qobuz lists. Each feed is
 * isolated so one being unreachable never blocks the others, and all share one
 * dedupe/health-check/premium-gate core, so an instance another feed already contributed is
 * updated in place rather than duplicated.
 *
 * Named for the route path the scheduled workflow already pings; the body covers every feed.
 */
export async function GET(req: NextRequest) {
  if (!authorized(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 })

  const monochrome = await syncMonochromeInstances().catch((e) => ({
    error: e instanceof Error ? e.message : String(e),
  }))
  const spotiflac = await syncSpotiFlacInstances().catch((e) => ({
    error: e instanceof Error ? e.message : String(e),
  }))

  const ok = !("error" in monochrome) || !("error" in spotiflac)
  // Publish the servable URLs to Blob so the discovery routes can answer from it without waking
  // the database; then drop the cached feeds (and the routes' cached snapshot lookups) so the next
  // client sees the new instances instead of waiting out the TTL.
  await writeInstanceSnapshot()
  invalidate("discovery:")
  invalidate("snapshot:")
  return NextResponse.json(
    { ok, monochrome, spotiflac, ranAt: new Date().toISOString() },
    { status: ok ? 200 : 500 },
  )
}
