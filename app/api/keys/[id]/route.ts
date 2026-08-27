import { NextResponse, type NextRequest } from "next/server"
import { getSessionUserId } from "@/lib/sessions"
import { setUserKeyRevoked } from "@/lib/api-keys"

export const dynamic = "force-dynamic"

/** Revoke (or with ?undo=1 restore) one of the signed-in user's keys. */
export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const userId = await getSessionUserId()
  if (!userId) return NextResponse.json({ error: "unauthorized" }, { status: 401 })

  const { id: idRaw } = await params
  const id = Number.parseInt(idRaw, 10)
  if (!Number.isFinite(id)) return NextResponse.json({ error: "invalid_id" }, { status: 400 })

  const undo = req.nextUrl.searchParams.get("undo") === "1"
  const updated = await setUserKeyRevoked(userId, id, !undo)
  if (!updated) return NextResponse.json({ error: "not_found" }, { status: 404 })
  return NextResponse.json({ ok: true, revoked: !undo })
}
