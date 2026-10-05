// SPDX-License-Identifier: GPL-3.0-or-later
import { NextResponse, type NextRequest } from "next/server"
import { getSessionUserId } from "@/lib/sessions"
import { deleteUserApiKey, setUserKeyRevoked } from "@/lib/api-keys"

export const dynamic = "force-dynamic"

/**
 * Manage one of the signed-in user's keys.
 *  - `DELETE`              revoke (or `?undo=1` restore) — the key stays listed, it just stops
 *                          authenticating. Reversible, and the right move when a device is lost.
 *  - `DELETE ?delete=1`    permanent removal of the key row. Not reversible: only the SHA-256
 *                          hash was stored, so there is nothing left to show or restore.
 */
export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const userId = await getSessionUserId()
  if (!userId) return NextResponse.json({ error: "unauthorized" }, { status: 401 })

  const { id: idRaw } = await params
  const id = Number.parseInt(idRaw, 10)
  if (!Number.isFinite(id)) return NextResponse.json({ error: "invalid_id" }, { status: 400 })

  try {
    if (req.nextUrl.searchParams.get("delete") === "1") {
      const gone = await deleteUserApiKey(userId, id)
      if (!gone) return NextResponse.json({ error: "not_found" }, { status: 404 })
      return NextResponse.json({ ok: true, deleted: true })
    }

    const undo = req.nextUrl.searchParams.get("undo") === "1"
    const updated = await setUserKeyRevoked(userId, id, !undo)
    if (!updated) return NextResponse.json({ error: "not_found" }, { status: 404 })
    return NextResponse.json({ ok: true, revoked: !undo })
  } catch (err) {
    console.error(`[keys] update key ${id} failed:`, err)
    return NextResponse.json(
      { error: "internal_error", detail: "Could not change that key. Try again shortly." },
      { status: 500 },
    )
  }
}
