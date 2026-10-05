// SPDX-License-Identifier: GPL-3.0-or-later
import { NextResponse, type NextRequest } from "next/server"
import { claimApprovedKey } from "@/lib/api-keys"
import { getSessionUserId } from "@/lib/sessions"

export const dynamic = "force-dynamic"

const MESSAGES: Record<string, string> = {
  not_found: "That request does not exist.",
  not_approved: "That request has not been approved yet.",
  already_claimed: "You already revealed the key for this request. Create a new request for another key.",
  key_limit: "You have reached the active-key limit for your account. Revoke a key first.",
}

/**
 * Claim the key for an approved request: mints the key and shows its plaintext exactly once, to
 * its owner.
 *
 * Approval alone does not produce a key. The requester is the only party that ever sees the
 * plaintext, because it is generated here, returned in this one response and stored only as a
 * SHA-256 hash. There is no second reveal — losing it means requesting again.
 */
export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const userId = await getSessionUserId()
  if (!userId) return NextResponse.json({ error: "unauthorized" }, { status: 401 })

  const { id } = await ctx.params
  const requestId = Number.parseInt(id, 10)
  if (!Number.isFinite(requestId)) return NextResponse.json({ error: "invalid_id" }, { status: 400 })

  try {
    const result = await claimApprovedKey(userId, requestId)
    if (!result.ok) {
      return NextResponse.json(
        { error: result.error, detail: MESSAGES[result.error] ?? "Could not issue the key." },
        { status: result.error === "key_limit" ? 409 : 400 },
      )
    }
    return NextResponse.json(
      { ok: true, id: result.id, key: result.key, prefix: result.prefix },
      { headers: { "cache-control": "private, no-store" } },
    )
  } catch (err) {
    console.error(`[keys] claim request ${requestId} failed:`, err)
    return NextResponse.json(
      { error: "internal_error", detail: "Could not issue your key. Please try again shortly." },
      { status: 500 },
    )
  }
}
