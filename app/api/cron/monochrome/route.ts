// SPDX-License-Identifier: GPL-3.0-or-later
import { NextResponse, type NextRequest } from "next/server"
import { isCronAuthorized as authorized } from "@/lib/admin-auth"
import { writeInstanceSnapshot } from "@/lib/edge-snapshot"
import { fetchMonochromeUrls, syncMonochromeInstances } from "@/lib/monochrome"
import {
  SPOTIFLAC_QOBUZ_INSTANCES,
  SPOTIFLAC_TIDAL_INSTANCES,
  syncSpotiFlacInstances,
} from "@/lib/spotiflac"
import { syncInstanceUrls } from "@/lib/instance-sync"
import { invalidate } from "@/lib/ttl-cache"
import type { Service } from "@/lib/sources"

export const dynamic = "force-dynamic"
export const maxDuration = 60

/**
 * Instance-sync cron: monochrome plus SpotiFLAC's public Tidal and Qobuz lists. Each feed is
 * isolated so one being unreachable never blocks the others, and all share one
 * dedupe/health-check/premium-gate core, so an instance another feed already contributed is
 * updated in place rather than duplicated.
 *
 * Named for the route path the scheduled workflow already pings; the body covers every feed.
 *
 * Two modes:
 *
 *   GET /api/cron/monochrome                    — whole sync in one request. The mode the
 *     workflows use on hosts without a per-request ceiling (Vercel, Railway).
 *
 *   GET /api/cron/monochrome?feed=NAME&offset=K&limit=N — one bounded slice of one feed.
 *   GET /api/cron/monochrome?publish=1          — republish the snapshot after all feeds drain.
 *     On the Workers free tier a full sync's live probes would blow the 50-subrequest /
 *     ~10 ms-CPU budget, so the workflow pages every feed to `done` and then publishes once.
 *     Feed names: monochrome | spotiflac-tidal | spotiflac-qobuz.
 */

const BATCH_DEFAULT = 8
// One instance check is 1–3 upstream fetches; a feed fetch adds one more. 10 keeps a
// batch comfortably under the 50-subrequest ceiling.
const BATCH_MAX = 10

type FeedName = "monochrome" | "spotiflac-tidal" | "spotiflac-qobuz"

const FEEDS: Record<FeedName, { service: Service; note: string; urls: () => Promise<string[]> }> = {
  monochrome: { service: "tidal", note: "monochrome", urls: fetchMonochromeUrls },
  "spotiflac-tidal": { service: "tidal", note: "spotiflac", urls: async () => [...SPOTIFLAC_TIDAL_INSTANCES] },
  "spotiflac-qobuz": { service: "qobuz", note: "spotiflac", urls: async () => [...SPOTIFLAC_QOBUZ_INSTANCES] },
}

function clampInt(raw: string | null, fallback: number, lo: number, hi: number): number {
  const n = Number.parseInt(raw ?? "", 10)
  return Number.isFinite(n) ? Math.min(Math.max(n, lo), hi) : fallback
}

async function publishSnapshot() {
  await writeInstanceSnapshot()
  invalidate("discovery:")
  invalidate("snapshot:")
}

export async function GET(req: NextRequest) {
  if (!authorized(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 })

  const params = req.nextUrl.searchParams

  if (params.get("publish") === "1") {
    await publishSnapshot()
    return NextResponse.json({ ok: true, published: true, ranAt: new Date().toISOString() })
  }

  const feed = params.get("feed")
  if (feed != null) {
    const spec = FEEDS[feed as FeedName]
    if (!spec) {
      return NextResponse.json(
        { error: "unknown feed", feeds: Object.keys(FEEDS) },
        { status: 400 },
      )
    }
    const urls = await spec.urls()
    const offset = clampInt(params.get("offset"), 0, 0, Number.MAX_SAFE_INTEGER)
    const limit = clampInt(params.get("limit"), BATCH_DEFAULT, 1, BATCH_MAX)
    const result = await syncInstanceUrls(spec.service, urls, {
      note: spec.note,
      offset,
      limit,
    })
    return NextResponse.json({ ok: true, feed, ...result, ranAt: new Date().toISOString() })
  }

  // Whole-sync mode: unchanged behaviour for hosts that do not bound a request.
  const monochrome = await syncMonochromeInstances().catch((e) => ({
    error: e instanceof Error ? e.message : String(e),
  }))
  const spotiflac = await syncSpotiFlacInstances().catch((e) => ({
    error: e instanceof Error ? e.message : String(e),
  }))

  const ok = !("error" in monochrome) || !("error" in spotiflac)
  // Publish the servable URLs to the snapshot store so the discovery routes can answer from it
  // without waking the database; then drop the cached feeds (and the routes' cached snapshot
  // lookups) so the next client sees the new instances instead of waiting out the TTL.
  await publishSnapshot()
  return NextResponse.json(
    { ok, monochrome, spotiflac, ranAt: new Date().toISOString() },
    { status: ok ? 200 : 500 },
  )
}
