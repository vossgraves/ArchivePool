import { NextResponse, type NextRequest } from "next/server"
import { isCronAuthorized as authorized } from "@/lib/admin-auth"
import { syncMonochromeInstances } from "@/lib/monochrome"
import { syncSpotiFlacInstances } from "@/lib/spotiflac"

export const dynamic = "force-dynamic"
export const maxDuration = 60

/**
 * Instance-sync cron. Pools Tidal restream instances from every known instance feed:
 * monochrome.tf and SpotiFLAC's public HiFi list. Each feed is isolated so one being unreachable
 * never blocks the other, and both share the same dedupe/health-check/premium-gate core, so an
 * instance already contributed by the other feed (or by hand) is updated in place, not duplicated.
 *
 * Named `monochrome` for the route path the scheduled GitHub workflow already pings; the body now
 * covers all instance feeds.
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
  return NextResponse.json(
    { ok, monochrome, spotiflac, ranAt: new Date().toISOString() },
    { status: ok ? 200 : 500 },
  )
}
