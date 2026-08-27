import { NextResponse, type NextRequest } from "next/server"
import { getSessionUserId } from "@/lib/sessions"
import { setUserKeyDeleted, setUserKeyRevoked } from "@/lib/api-keys"

export const dynamic = "force-dynamic"

/**
 * Manage one of the signed-in user's keys.
 *  - `DELETE`            revoke (or `?undo=1` restore) — visible, inactive
 *  - `DELETE ?delete=1`  soft delete — hidden everywhere, row retained, key stops working
 */
export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const userId = await getSessionUserId()
  if (!userId) return NextResponse.json({ error: "unauthorized" }, { status: 401 })

  const { id: idRaw } = await params
  const id = Number.parseInt(idRaw, 10)
  if (!Number.isFinite(id)) return NextResponse.json({ error: "invalid_id" }, { status: 400 })

  if (req.nextUrl.searchParams.get("delete") === "1") {
    const updated = await setUserKeyDeleted(userId, id)
    if (!updated) return NextResponse.json({ error: "not_found" }, { status: 404 })
    return NextResponse.json({ ok: true, deleted: true })
  }

  const undo = req.nextUrl.searchParams.get("undo") === "1"
  const updated = await setUserKeyRevoked(userId, id, !undo)
  if (!updated) return NextResponse.json({ error: "not_found" }, { status: 404 })
  return NextResponse.json({ ok: true, revoked: !undo })
}
