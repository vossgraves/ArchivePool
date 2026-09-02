import { NextResponse, type NextRequest } from "next/server"
import { isAdminAuthorized as authorized } from "@/lib/admin-auth"
import { deleteApiKey } from "@/lib/api-keys"
import { ensureSchema } from "@/lib/db/ensure"

export const dynamic = "force-dynamic"

/**
 * Permanently delete one key.
 *
 * This is the admin panel's only true removal. Revoking is reversible and soft-deleting (what a
 * user gets from their dashboard) keeps the row and its hash; neither is what "get this key out
 * of the database" means. The plaintext is never recoverable anyway — only its SHA-256 hash is
 * stored — so deleting is safe: any client still presenting it simply stops authenticating.
 */
export async function DELETE(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  if (!authorized(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 })

  const { id } = await ctx.params
  const keyId = Number.parseInt(id, 10)
  if (!Number.isFinite(keyId)) return NextResponse.json({ error: "invalid_id" }, { status: 400 })

  try {
    await ensureSchema()
    const deleted = await deleteApiKey(keyId)
    if (!deleted) return NextResponse.json({ error: "not_found" }, { status: 404 })
    return NextResponse.json({ ok: true, id: keyId })
  } catch (err) {
    console.error(`[admin] delete key ${keyId} failed:`, err)
    return NextResponse.json(
      { error: "internal_error", detail: "Could not delete that key." },
      { status: 500 },
    )
  }
}
