// SPDX-License-Identifier: GPL-3.0-or-later
import { NextResponse, type NextRequest } from "next/server"
import { resolveAdmin } from "@/lib/admin-auth"
import { recordAudit } from "@/lib/audit"
import { approveGithubClaim, rejectGithubClaim } from "@/lib/github-auth"

export const dynamic = "force-dynamic"

const MIN_REJECTION_NOTE = 10

/**
 * Review one legacy-account claim: `{ action: "approve" }` transfers the legacy
 * username's per-user rows (api_keys — same hashes, so they keep working — and
 * api_key_requests) to the claim's GitHub account and marks the legacy row
 * claimed+disabled; `{ action: "reject", note: "…" }` files a visible reason.
 * Same gate and audit trail as /api/admin/requests/[id].
 */
export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const actor = await resolveAdmin(req)
  if (!actor) return NextResponse.json({ error: "unauthorized" }, { status: 401 })

  const { id } = await ctx.params
  const claimId = Number.parseInt(id, 10)
  if (!Number.isFinite(claimId)) return NextResponse.json({ error: "invalid_id" }, { status: 400 })

  let body: { action?: string; note?: string }
  try {
    body = await req.json()
  } catch {
    body = {}
  }
  const note = (body.note ?? "").trim().slice(0, 500)

  try {
    if (body.action === "approve") {
      const result = await approveGithubClaim(claimId, actor.userId)
      if (result == null) return NextResponse.json({ error: "not_found_or_not_pending" }, { status: 404 })
      if ("error" in result) {
        return NextResponse.json({ error: result.error }, { status: 409 })
      }
      await recordAudit(req, actor, "claim.approve", `claim:${claimId}`, { username: result.username })
      return NextResponse.json({ ok: true, status: "approved", username: result.username })
    }

    if (body.action === "reject") {
      if (note.length < MIN_REJECTION_NOTE) {
        return NextResponse.json(
          { error: "note_required", detail: `Rejection reason must be at least ${MIN_REJECTION_NOTE} characters.` },
          { status: 400 },
        )
      }
      const ok = await rejectGithubClaim(claimId, actor.userId, note)
      if (!ok) return NextResponse.json({ error: "not_found_or_not_pending" }, { status: 404 })
      await recordAudit(req, actor, "claim.reject", `claim:${claimId}`, { note })
      return NextResponse.json({ ok: true, status: "rejected" })
    }

    return NextResponse.json({ error: "invalid_action" }, { status: 400 })
  } catch (err) {
    console.error(`[admin] review claim ${claimId} failed:`, err)
    return NextResponse.json(
      { error: "internal_error", detail: "Could not record that decision. Check the database." },
      { status: 500 },
    )
  }
}
