import { NextResponse, type NextRequest } from "next/server"
import { isCronAuthorized as authorized } from "@/lib/admin-auth"
import { runHealthSweep } from "@/lib/health-sweep"

export const dynamic = "force-dynamic"
export const maxDuration = 60

export async function GET(req: NextRequest) {
  if (!authorized(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 })
  const summary = await runHealthSweep()
  return NextResponse.json({ ok: true, ...summary, ranAt: new Date().toISOString() })
}
