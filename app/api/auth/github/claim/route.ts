// SPDX-License-Identifier: GPL-3.0-or-later
import { NextResponse, type NextRequest } from "next/server"
import { ensureSchema } from "@/lib/db/ensure"
import {
  GITHUB_PENDING_COOKIE,
  findOwnedApiKey,
  findUserByGithubId,
  createGithubClaim,
  linkGithubToUser,
  readPendingCookie,
} from "@/lib/github-auth"
import { claimDecision } from "@/lib/github-cookies"
import { applySessionCookie } from "@/lib/sessions"
import { USERNAME_PATTERN, findUserByUsername } from "@/lib/users"
import { clientIp, rateLimit, tooManyRequests } from "@/lib/rate-limit"

export const dynamic = "force-dynamic"

// Claim attempts guess at other people's keys — keep the window tight.
const CLAIM_LIMIT = 10
const CLAIM_WINDOW_MS = 10 * 60_000

/**
 * Claim an EXISTING (legacy) username for the pending GitHub identity.
 *
 *   { username, apiKey }  -> sha256(apiKey) must match an ACTIVE api_keys row whose
 *                            user_id is the claimed account's — possessing the
 *                            account's own live read key is the ownership proof.
 *                            A REVOKED key still identifies the owner but cannot
 *                            self-authorize a link: it files a pending claim for
 *                            admin review instead. Old keys keep working unchanged
 *                            for apps either way.
 *   { username }          -> files a pending github_claims row for admin review.
 */
export async function POST(req: NextRequest) {
  const identity = await readPendingCookie(req.cookies.get(GITHUB_PENDING_COOKIE)?.value)
  if (!identity) {
    return NextResponse.json(
      { error: "github_pending_missing", detail: "Start the GitHub sign-in again — the link expired." },
      { status: 401 },
    )
  }

  const perIp = rateLimit(`gh-claim:${clientIp(req.headers)}`, CLAIM_LIMIT, CLAIM_WINDOW_MS)
  if (!perIp.ok) return tooManyRequests(perIp.retryAfterSec, "github-claim")

  let body: { username?: string; apiKey?: string }
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: "invalid_body" }, { status: 400 })
  }

  const username = body.username?.trim().toLowerCase() ?? ""
  if (!USERNAME_PATTERN.test(username)) {
    return NextResponse.json(
      { error: "invalid_input", detail: "Username must be 3-24 characters: lowercase letters, digits, underscores." },
      { status: 400 },
    )
  }

  try {
    await ensureSchema()
    const target = await findUserByUsername(username)
    if (!target) {
      return NextResponse.json(
        { error: "username_free", detail: "That username is not registered — pick it via the choose-username step." },
        { status: 404 },
      )
    }
    if (target.disabled) {
      return NextResponse.json({ error: "account_disabled" }, { status: 403 })
    }
    if (target.githubId != null && target.githubId !== identity.id) {
      return NextResponse.json(
        { error: "already_linked", detail: "That account is already linked to a different GitHub login." },
        { status: 409 },
      )
    }
    // This GitHub identity must not be parked on a different account either.
    const holder = await findUserByGithubId(identity.id)
    if (holder && holder.id !== target.id) {
      return NextResponse.json(
        { error: "github_id_in_use", detail: "This GitHub login is already linked to another account." },
        { status: 409 },
      )
    }

    const apiKey = body.apiKey?.trim() ?? ""
    if (apiKey.length > 0) {
      const owned = await findOwnedApiKey(target.id, apiKey)
      const decision = claimDecision(owned)
      if (decision === "reject") {
        return NextResponse.json(
          { error: "claim_proof_failed", detail: "That key is not one of this account's existing API keys." },
          { status: 403 },
        )
      }
      if (decision === "pending") {
        const claim = await createGithubClaim(
          identity.id,
          identity.login,
          username,
          "claimant presented a revoked key — needs manual review",
        )
        return NextResponse.json({
          ok: true,
          status: "claim_pending",
          claimId: claim.id,
          detail: "That key is revoked, so the claim needs admin review instead.",
        })
      }
      // "link": active key proved ownership. The link itself is atomic — a row that
      // was claimed between the read above and this write reports a conflict.
      const linked = await linkGithubToUser(target.id, identity.id)
      if (!linked) {
        return NextResponse.json(
          { error: "claim_conflict", detail: "That account was just linked elsewhere — retry the sign-in." },
          { status: 409 },
        )
      }
      const res = NextResponse.json({ ok: true, status: "claimed", username: linked.username })
      await applySessionCookie(res, target.id)
      res.cookies.set(GITHUB_PENDING_COOKIE, "", { httpOnly: true, path: "/", maxAge: 0 })
      return res
    }

    const claim = await createGithubClaim(identity.id, identity.login, username)
    return NextResponse.json({
      ok: true,
      status: "claim_pending",
      claimId: claim.id,
      detail: "Claim filed for admin review. Sign in again once it is approved.",
    })
  } catch (e) {
    console.error("[github-auth] claim failed:", e)
    return NextResponse.json({ error: "internal_error" }, { status: 500 })
  }
}
