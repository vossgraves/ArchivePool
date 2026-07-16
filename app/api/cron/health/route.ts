import { NextResponse, type NextRequest } from "next/server"
import { runHealthSweep } from "@/lib/health-sweep"

export const dynamic = "force-dynamic"
export const maxDuration = 60

function authorized(req: NextRequest): boolean {
  // Authenticate the secret itself. Header presence alone is user-spoofable on public routes.
  const auth = req.headers.get("authorization")
  const cronSecret = process.env.CRON_SECRET
  const adminToken = process.env.ADMIN_TOKEN
  if (cronSecret && auth === `Bearer ${cronSecret}`) return true
  if (adminToken && auth === `Bearer ${adminToken}`) return true
  return false
}

export async function GET(req: NextRequest) {
  if (!authorized(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 })
  const summary = await runHealthSweep()
  return NextResponse.json({ ok: true, ...summary, ranAt: new Date().toISOString() })
}
