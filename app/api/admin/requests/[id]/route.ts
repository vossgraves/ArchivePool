import { NextResponse, type NextRequest } from "next/server"
import { isAdminAuthorized as authorized } from "@/lib/admin-auth"
import { ensureSchema } from "@/lib/db/ensure"
import { approveKeyRequest, rejectKeyRequest } from "@/lib/api-keys"

export const dynamic = "force-dynamic"

const MIN_REJECTION_NOTE = 10

/**
 * Review one key request: `{ action: "approve" }` or
 * `{ action: "reject", note: "…" }`.
 *
 * The admin panel authenticates with a bearer token, not a site account, so there is no user id
 * to record as the reviewer. `reviewed_by` is a foreign key to `users.id` and this used to send
 * `0` as a "system" sentinel — no account can ever have id 0 (serial starts at 1), so every
 * approve and reject raised a constraint violation, the handler threw, and the button appeared to
 * do nothing. Null is the correct value for "the token holder".
 *
 * Approving does not mint a key. The requester claims it from their own dashboard
 * (see /api/requests/[id]/claim) so the one-time plaintext reaches the one person who needs it
 * and never passes through this panel.
 */
export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  if (!authorized(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 })

  const { id } = await ctx.params
  const requestId = Number.parseInt(id, 10)
  if (!Number.isFinite(requestId)) return NextResponse.json({ error: "invalid_id" }, { status: 400 })

  let body: { action?: string; note?: string }
  try {
    body = await req.json()
  } catch {
    body = {}
  }

  const note = (body.note ?? "").trim().slice(0, 500)

  try {
    await ensureSchema()

    if (body.action === "approve") {
      const result = await approveKeyRequest(requestId, null)
      if (!result) return NextResponse.json({ error: "not_found_or_not_pending" }, { status: 404 })
      return NextResponse.json({ ok: true, status: "approved", subject: result.subject })
    }

    if (body.action === "reject") {
      // A rejection with no reason is indistinguishable from silence for the requester, so the
      // panel is required to say something.
      if (note.length < MIN_REJECTION_NOTE) {
        return NextResponse.json(
          { error: "note_required", detail: `Rejection reason must be at least ${MIN_REJECTION_NOTE} characters.` },
          { status: 400 },
        )
      }
      const ok = await rejectKeyRequest(requestId, null, note)
      if (!ok) return NextResponse.json({ error: "not_found_or_not_pending" }, { status: 404 })
      return NextResponse.json({ ok: true, status: "rejected" })
    }

    return NextResponse.json({ error: "invalid_action" }, { status: 400 })
  } catch (err) {
    console.error(`[admin] review request ${requestId} failed:`, err)
    return NextResponse.json(
      { error: "internal_error", detail: "Could not record that decision. Check the database." },
      { status: 500 },
    )
  }
}
