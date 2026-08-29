import { NextResponse, type NextRequest } from "next/server"
import { isAdminAuthorized as authorized } from "@/lib/admin-auth"
import { approveKeyRequest, rejectKeyRequest } from "@/lib/api-keys"

export const dynamic = "force-dynamic"

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  if (!authorized(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 })
  const { id } = await ctx.params
  const requestId = Number.parseInt(id, 10)
  if (!Number.isFinite(requestId)) return NextResponse.json({ error: "invalid_id" }, { status: 400 })
  let body: { action?: string }
  try {
    body = await req.json()
  } catch {
    body = {}
  }
  const action = body.action
  // For approve we need an admin user id; use 0 as system if not available (admin token is not a user)
  const adminId = 0
  if (action === "approve") {
    const result = await approveKeyRequest(requestId, adminId)
    if (!result) return NextResponse.json({ error: "not_found_or_not_pending" }, { status: 404 })
    return NextResponse.json({ ok: true, key: result.key, prefix: result.prefix })
  }
  if (action === "reject") {
    const ok = await rejectKeyRequest(requestId, adminId)
    if (!ok) return NextResponse.json({ error: "not_found_or_not_pending" }, { status: 404 })
    return NextResponse.json({ ok: true })
  }
  return NextResponse.json({ error: "invalid_action" }, { status: 400 })
}
