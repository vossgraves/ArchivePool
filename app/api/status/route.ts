import { NextResponse } from "next/server"
import { HISTORY_DAYS, getPoolHistory, getStatus } from "@/lib/queries"

export const dynamic = "force-dynamic"

export async function GET() {
  const [categories, history] = await Promise.all([
    getStatus(),
    // History is additive to the documented payload and non-fatal: the board's figures matter more
    // than its trend line, so a slow aggregate must not take the whole feed down with it.
    getPoolHistory().catch((err) => {
      console.error("[status] history unavailable:", err)
      return { overall: [], categories: [] }
    }),
  ])
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
