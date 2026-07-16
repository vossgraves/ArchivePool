import { NextResponse, type NextRequest } from "next/server"
import { runHealthSweep } from "@/lib/health-sweep"
import { syncMonochromeInstances } from "@/lib/monochrome"

export const dynamic = "force-dynamic"
export const maxDuration = 60

function authorized(req: NextRequest): boolean {
  const adminToken = process.env.ADMIN_TOKEN
  if (!adminToken) return false
  return req.headers.get("authorization") === `Bearer ${adminToken}`
}

/**
 * POST /api/admin/force-check
 * Immediately re-checks every non-removed entry (bypassing the 6h stale threshold)
 * and also triggers a fresh monochrome.tf instance sync. Admin token required.
 */
export async function POST(req: NextRequest) {
  if (!authorized(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 })

  const [sweepResult, monoResult] = await Promise.all([
    runHealthSweep(true),
    syncMonochromeInstances(),
  ])

  return NextResponse.json({
    ok: true,
    sweep: sweepResult,
    monochrome: monoResult,
    ranAt: new Date().toISOString(),
  })
}
