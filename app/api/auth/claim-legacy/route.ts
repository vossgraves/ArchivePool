// SPDX-License-Identifier: GPL-3.0-or-later
import { NextResponse, type NextRequest } from "next/server"
import { eq } from "drizzle-orm"
import { db } from "@/lib/db"
import { ensureSchema } from "@/lib/db/ensure"
import { users } from "@/lib/db/schema"
import {
  createGithubClaim,
  findClaimableUser,
  findOwnedApiKey,
  transferLegacyAccount,
} from "@/lib/github-auth"
import { claimDecision } from "@/lib/github-cookies"
import { getSessionUserId } from "@/lib/sessions"
import { USERNAME_PATTERN } from "@/lib/users"
import { clientIp, dbRateLimit, tooManyRequests } from "@/lib/rate-limit"

export const dynamic = "force-dynamic"

// Claim attempts guess at other people's keys — keep the windows tight, and
// rate-limit THREE ways: the signed-in account, the targeted legacy name
// (shared across claimers so a target cannot be brute-forced by several
// accounts), and the source IP.
const PER_USER_LIMIT = 10
const PER_NAME_LIMIT = 5
const PER_IP_LIMIT = 20
const CLAIM_WINDOW_MS = 10 * 60_000

const NO_STORE = { "cache-control": "private, no-store" } as const

/**
 * Recover a LEGACY (pre-GitHub) account from the dashboard. The signed-in user
 * proves ownership with one of the legacy account's own API keys; on proof,
 * every per-user row (api_keys — same hashes, so apps keep working — and
 * api_key_requests) moves to their account and the legacy row is marked
 * claimed+disabled, atomically.
 *
 *   { username, apiKey }  -> sha256(apiKey) must match an ACTIVE api_keys row of
 *                            the target, re-verified FOR UPDATE inside the transfer
 *                            transaction itself (a key revoked or deleted between
 *                            the pre-check and the transfer loses there). A REVOKED
 *                            key still identifies the owner but cannot
 *                            self-authorize: it files a pending claim.
 *   { username }          -> files a pending github_claims row for admin review
 *                            (GitHub-linked accounts only — the claim binds a
 *                            GitHub identity to the decision).
 *
 * Password verification is NOT the proof path: the stored scrypt hashes are
 * intentionally expensive (~30-80 ms) and cannot be verified inside the
 * Workers free 10 ms CPU budget. An existing API key is the ownership proof.
 */
export async function POST(req: NextRequest) {
  const userId = await getSessionUserId()
  if (!userId) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401, headers: NO_STORE })
  }

  // DB-backed buckets: Workers isolates do not share process memory, so a
  // local limiter would silently multiply the ceiling by the isolate count.
  // Fails closed — a limiter outage denies the claim.
  const perIp = await dbRateLimit(`legacy-claim:ip:${clientIp(req.headers)}`, PER_IP_LIMIT, CLAIM_WINDOW_MS)
  if (!perIp.ok) return tooManyRequests(perIp.retryAfterSec, "legacy-claim")
  const perUser = await dbRateLimit(`legacy-claim:user:${userId}`, PER_USER_LIMIT, CLAIM_WINDOW_MS)
  if (!perUser.ok) return tooManyRequests(perUser.retryAfterSec, "legacy-claim")

  let body: { username?: string; apiKey?: string }
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: "invalid_body" }, { status: 400, headers: NO_STORE })
  }

  const username = body.username?.trim().toLowerCase() ?? ""
  if (!USERNAME_PATTERN.test(username)) {
    return NextResponse.json(
      { error: "invalid_input", detail: "Usernames are 3-24 characters: lowercase letters, digits, underscores." },
      { status: 400, headers: NO_STORE },
    )
  }

  const perName = await dbRateLimit(`legacy-claim:name:${username}`, PER_NAME_LIMIT, CLAIM_WINDOW_MS)
  if (!perName.ok) return tooManyRequests(perName.retryAfterSec, "legacy-claim")

  try {
    await ensureSchema()
    const target = await findClaimableUser(username)
    if (!target || target.id === userId) {
      return NextResponse.json(
        { error: "not_found", detail: "That legacy username is not registered." },
        { status: 404, headers: NO_STORE },
      )
    }
    if (target.disabled) {
      return NextResponse.json({ error: "account_disabled" }, { status: 403, headers: NO_STORE })
    }
    if (target.claimedBy != null || target.githubId != null) {
      return NextResponse.json(
        { error: "already_claimed", detail: "That account is already linked to a sign-in." },
        { status: 409, headers: NO_STORE },
      )
    }

    const [me] = await db
      .select({ githubId: users.githubId, githubLogin: users.githubLogin })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1)
    if (!me) return NextResponse.json({ error: "unauthorized" }, { status: 401, headers: NO_STORE })

    const apiKey = body.apiKey?.trim() ?? ""
    if (apiKey.length > 0) {
      const owned = await findOwnedApiKey(target.id, apiKey)
      const decision = claimDecision(owned)
      if (decision === "reject") {
        return NextResponse.json(
          { error: "claim_proof_failed", detail: "That key is not one of this account's existing API keys." },
          { status: 403, headers: NO_STORE },
        )
      }
      if (decision === "pending") {
        const claim = await fileReviewClaim(me, username, "claimant presented a revoked key — needs manual review")
        if (!claim) return reviewUnavailable()
        return NextResponse.json({
          ok: true,
          status: "claim_pending",
          claimId: claim.id,
          detail: "That key is revoked, so the claim needs admin review instead.",
        }, { headers: NO_STORE })
      }
      // Active key proved ownership. The transfer re-verifies the proof under
      // lock inside its transaction — a key revoked or deleted between the
      // pre-check above and the transfer's re-read loses there, not here.
      const moved = await transferLegacyAccount(userId, target.id, apiKey)
      if (!moved.ok) {
        if (moved.error === "proof_revoked") {
          const claim = await fileReviewClaim(me, username, "key was revoked during the claim — needs manual review")
          if (!claim) return reviewUnavailable()
          return NextResponse.json({
            ok: true,
            status: "claim_pending",
            claimId: claim.id,
            detail: "That key is revoked, so the claim needs admin review instead.",
          }, { headers: NO_STORE })
        }
        if (moved.error === "proof_failed") {
          return NextResponse.json(
            { error: "claim_proof_failed", detail: "That key is not one of this account's existing API keys." },
            { status: 403, headers: NO_STORE },
          )
        }
        if (moved.error === "claimer_not_live" || moved.error === "claimer_gone") {
          return NextResponse.json({ error: "account_disabled" }, { status: 403, headers: NO_STORE })
        }
        return NextResponse.json(
          { error: moved.error, detail: "That account was just claimed elsewhere — it is no longer claimable." },
          { status: 409, headers: NO_STORE },
        )
      }
      return NextResponse.json(
        {
          ok: true,
          status: "claimed",
          transferred: { keys: moved.keys, requests: moved.requests },
          detail: `Recovered @${username}: ${moved.keys} key${moved.keys === 1 ? "" : "s"} moved to your account and keep working unchanged.`,
        },
        { headers: NO_STORE },
      )
    }

    // No key offered: file a pending claim for admin review. The queue binds a
    // GitHub identity to the decision, so only GitHub-linked accounts can file.
    const claim = await fileReviewClaim(me, username)
    if (!claim) return reviewUnavailable()
    return NextResponse.json({
      ok: true,
      status: "claim_pending",
      claimId: claim.id,
      detail: "Claim filed for admin review.",
    }, { headers: NO_STORE })
  } catch (e) {
    console.error("[claim-legacy] failed:", e)
    return NextResponse.json({ error: "internal_error" }, { status: 500, headers: NO_STORE })
  }
}

async function fileReviewClaim(
  me: { githubId: number | null; githubLogin: string },
  username: string,
  provenance = "",
): Promise<{ id: number } | null> {
  if (me.githubId == null) return null
  return createGithubClaim(me.githubId, me.githubLogin || `github:${me.githubId}`, username, provenance)
}

function reviewUnavailable() {
  return NextResponse.json(
    {
      error: "proof_required",
      detail: "A claim without an API key needs admin review, which is only available to GitHub-linked accounts. Paste one of that account's API keys to recover it instantly.",
    },
    { status: 400, headers: NO_STORE },
  )
}
