import { NextResponse, type NextRequest } from "next/server"
import { resolveAdmin } from "@/lib/admin-auth"
import { recordAudit } from "@/lib/audit"
import { runHealthSweep } from "@/lib/health-sweep"
import { syncMonochromeInstances } from "@/lib/monochrome"

export const dynamic = "force-dynamic"
export const maxDuration = 60

/**
 * POST /api/admin/force-check
 * Immediately re-checks every non-removed entry (bypassing the 6h stale threshold)
 * and also triggers a fresh monochrome instance sync. Admin token required.
 */
export async function POST(req: NextRequest) {
  const actor = await resolveAdmin(req)
  if (!actor) return NextResponse.json({ error: "unauthorized" }, { status: 401 })

  const [sweepResult, monoResult] = await Promise.all([
    runHealthSweep(true),
    syncMonochromeInstances(),
  ])

  await recordAudit(req, actor, "entry.force_check", "entries")

  return NextResponse.json({
    ok: true,
    sweep: sweepResult,
    monochrome: monoResult,
    ranAt: new Date().toISOString(),
  })
}
