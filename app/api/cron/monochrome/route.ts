import { NextResponse, type NextRequest } from "next/server"
import { syncMonochromeInstances } from "@/lib/monochrome"

export const dynamic = "force-dynamic"
export const maxDuration = 60

function authorized(req: NextRequest): boolean {
  const auth = req.headers.get("authorization")
  const cronSecret = process.env.CRON_SECRET
  const adminToken = process.env.ADMIN_TOKEN
  if (cronSecret && auth === `Bearer ${cronSecret}`) return true
  if (adminToken && auth === `Bearer ${adminToken}`) return true
  return false
}

export async function GET(req: NextRequest) {
  if (!authorized(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 })

  try {
    const summary = await syncMonochromeInstances()
    return NextResponse.json({ ok: true, ...summary, ranAt: new Date().toISOString() })
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    return NextResponse.json({ ok: false, error: msg }, { status: 500 })
  }
}
