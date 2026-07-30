import { NextResponse, type NextRequest } from "next/server"
import { isAdminAuthorized as authorized } from "@/lib/admin-auth"
import { checkEntryById } from "@/lib/health-sweep"

export const dynamic = "force-dynamic"
// A single live credential check can be slow (Tidal may refresh an OAuth token first).
export const maxDuration = 60

// Owner-only: re-verify one pool entry on demand, without sweeping the whole pool.
export async function POST(req: NextRequest) {
  if (!authorized(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 })

  let body: { id?: number }
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: "invalid body" }, { status: 400 })
  }

  if (typeof body.id !== "number") {
    return NextResponse.json({ error: "id required" }, { status: 400 })
  }

  try {
    const result = await checkEntryById(body.id)
    if (!result) return NextResponse.json({ error: "not found" }, { status: 404 })
    return NextResponse.json({ ok: true, result })
  } catch (err) {
    // Surface the reason (e.g. missing POOL_ENCRYPTION_KEY) instead of a bare 500, so the
    // admin panel can show something actionable.
    const message = err instanceof Error ? err.message : "check failed"
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
