// SPDX-License-Identifier: GPL-3.0-or-later
import { NextResponse, type NextRequest } from "next/server"
import { ensureSchema } from "@/lib/db/ensure"
import {
  GITHUB_PENDING_COOKIE,
  findUserByGithubId,
  readPendingCookie,
} from "@/lib/github-auth"
import { applySessionCookie } from "@/lib/sessions"
import { USERNAME_PATTERN, createUser, findUserByUsername } from "@/lib/users"
import { clientIp, rateLimit, tooManyRequests } from "@/lib/rate-limit"

export const dynamic = "force-dynamic"

const ATTEMPT_LIMIT = 20
const ATTEMPT_WINDOW_MS = 10 * 60_000

/**
 * Finish a first GitHub sign-in with a NEW username. Requires the pending-identity
 * cookie the callback issued — the username is the only thing the user chooses; the
 * GitHub identity itself can never be forged into the request.
 */
export async function POST(req: NextRequest) {
  const identity = await readPendingCookie(req.cookies.get(GITHUB_PENDING_COOKIE)?.value)
  if (!identity) {
    return NextResponse.json(
      { error: "github_pending_missing", detail: "Start the GitHub sign-in again — the link expired." },
      { status: 401 },
    )
  }

  const perIp = rateLimit(`gh-complete:${clientIp(req.headers)}`, ATTEMPT_LIMIT, ATTEMPT_WINDOW_MS)
  if (!perIp.ok) return tooManyRequests(perIp.retryAfterSec, "github-complete")

  let body: { username?: string }
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

    // Idempotent: the same GitHub completing twice just signs back in.
    const linked = await findUserByGithubId(identity.id)
    if (linked && !linked.disabled) {
      const res = NextResponse.json({ ok: true, status: "created", username: linked.username })
      await applySessionCookie(res, linked.id)
      res.cookies.set(GITHUB_PENDING_COOKIE, "", { httpOnly: true, path: "/", maxAge: 0 })
      return res
    }

    if (await findUserByUsername(username)) {
      return NextResponse.json(
        {
          error: "username_taken",
          claimable: true,
          detail: "That username is already registered — claim it with one of its API keys, or request an admin review.",
        },
        { status: 409 },
      )
    }

    const ip = clientIp(req.headers).slice(0, 64)
    const ua = (req.headers.get("user-agent") ?? "").slice(0, 256)
    // "github" is never a valid scrypt string, so password verification can never
    // succeed on OAuth-only accounts.
    const user = await createUser(username, "github", ip, ua, identity.id)
    const res = NextResponse.json({ ok: true, status: "created", username: user.username })
    await applySessionCookie(res, user.id)
    res.cookies.set(GITHUB_PENDING_COOKIE, "", { httpOnly: true, path: "/", maxAge: 0 })
    return res
  } catch (e) {
    console.error("[github-auth] complete failed:", e)
    return NextResponse.json({ error: "internal_error" }, { status: 500 })
  }
}
