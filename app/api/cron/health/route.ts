// SPDX-License-Identifier: GPL-3.0-or-later
import { NextResponse, type NextRequest } from "next/server"
import { isCronAuthorized as authorized } from "@/lib/admin-auth"
import { runHealthSweep } from "@/lib/health-sweep"
import { writeInstanceSnapshot } from "@/lib/edge-snapshot"
import { invalidate } from "@/lib/ttl-cache"

export const dynamic = "force-dynamic"
export const maxDuration = 60

/**
 * Free Workers answer at most 50 subrequests and ~10 ms CPU per request. A full
 * sweep's live probes (~4 fetches each over ~130 entries) sit far outside that, so
 * on those hosts the scheduler drives the sweep as a loop of bounded calls:
 *
 *   GET /api/cron/health?batch=N        → checks up to N stale entries
 *   repeat until the body has "done":true
 *
 * Each call drains the stalest-first list until N verdicts are written, 12 rows are
 * consumed, or it ends — consumed counts skips too, because a check that bails inside
 * refresh cooling can still have spent upstream fetches. The body returns `cursor`, the
 * keyset of the last consumed row; pass it back as `&cursor=` so a skipped prefix cannot
 * head every batch and starve the tail. The
 * snapshot publish and the "status" invalidation ride the batch that finishes, so
 * the feed is never republished mid-sweep.
 *
 * Called with NO `batch` parameter it still performs the whole sweep in one run —
 * the path Vercel/Railway/self-hosted deployments (and a manual trigger) use.
 */
const BATCH_DEFAULT = 8
// ~4 upstream fetches per entry worst case (refresh + probe + fallbacks), plus an
// R2 put on the finishing batch — 10 keeps the total comfortably under 50.
const BATCH_MAX = 10

function batchLimit(raw: string): number {
  const n = Number.parseInt(raw, 10)
  return Number.isFinite(n) && n > 0 ? Math.min(n, BATCH_MAX) : BATCH_DEFAULT
}

export async function GET(req: NextRequest) {
  if (!authorized(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 })

  const batch = req.nextUrl.searchParams.get("batch")
  const summary = await runHealthSweep(
    batch == null
      ? {}
      : { limit: batchLimit(batch), cursor: req.nextUrl.searchParams.get("cursor") ?? undefined },
  )

  // The board's figures just changed; drop the cached copy so the next reader sees this sweep
  // rather than waiting out the TTL.
  invalidate("status")
  if (summary.done) {
    // The sweep also flips instances alive/dead/disabled, and the discovery feeds answer from the
    // snapshot — which the 12-hourly instance sync is what rewrites. Without this the feeds
    // would keep handing out a base URL this sweep just marked dead for up to 12 hours, and the
    // snapshot's own age check cannot catch it because the copy is still well inside its TTL.
    // Only the finishing batch publishes: rewriting the object N times per sweep would just burn
    // the same writes louder.
    await writeInstanceSnapshot()
    invalidate("snapshot:")
  }
  return NextResponse.json({ ok: true, ...summary, ranAt: new Date().toISOString() })
}
