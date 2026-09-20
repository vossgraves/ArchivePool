import { NextResponse } from "next/server"
import { HISTORY_DAYS, getPoolHistory, getStatus, type CategoryStatus } from "@/lib/queries"
import { STATUS_TTL_MS, cached } from "@/lib/ttl-cache"

export const dynamic = "force-dynamic"

export async function GET() {
  // getStatus() is the one call here that cannot be degraded around: without it there are no
  // figures at all. Its failure used to surface as a bare 500 with an empty body, which tells an
  // operator nothing — the board could only say "not responding", and the actual reason (a
  // suspended Neon project, a rotated DATABASE_URL, connection slots exhausted) had to be dug out
  // of the function logs. The message is a connection error, never a credential, so it is safe to
  // return and turns a blank board into a diagnosis.
  let categories: CategoryStatus[]
  try {
    // Cached for a few minutes: these figures only move when a health sweep runs, while the board
    // and any monitoring poll far more often, and every miss wakes the database compute for five
    // minutes (lib/ttl-cache.ts). The cron route invalidates this when a sweep finishes, so the
    // staleness is bounded by the TTL rather than by the sweep interval.
    categories = await cached("status", STATUS_TTL_MS, getStatus)
  } catch (err) {
    console.error("[status] database unavailable:", err)
    return NextResponse.json(
      {
        error: "database_unavailable",
        detail: err instanceof Error ? err.message : "unknown database error",
      },
      {
        status: 503,
        headers: {
          "cache-control": "no-store",
          "access-control-allow-origin": "*",
        },
      },
    )
  }

  const history = await getPoolHistory().catch((err) => {
    // History is additive to the documented payload and non-fatal: the board's figures matter more
    // than its trend line, so a slow aggregate must not take the whole feed down with it.
    console.error("[status] history unavailable:", err)
    return { overall: [], categories: [] }
  })
  return NextResponse.json(
    {
      generatedAt: new Date().toISOString(),
      categories,
      history: { days: HISTORY_DAYS, ...history },
    },
    {
      headers: {
        "cache-control": "public, s-maxage=60, stale-while-revalidate=300",
        "access-control-allow-origin": "*",
      },
    },
  )
}
