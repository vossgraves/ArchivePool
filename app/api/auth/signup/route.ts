// SPDX-License-Identifier: GPL-3.0-or-later
import { NextResponse, type NextRequest } from "next/server"
import { webLoginDisabled } from "@/lib/cf-env"
import { clientIp } from "@/lib/rate-limit"
import { setSessionCookie } from "@/lib/sessions"
import { USERNAME_PATTERN, countRecentUsersByIpUa, createUser, findUserByUsername } from "@/lib/users"

export const dynamic = "force-dynamic"

export async function POST(req: NextRequest) {
  if (webLoginDisabled()) {
    return NextResponse.json(
      {
        error: "web_login_unavailable",
        detail:
          "Password sign-up is unavailable on this deployment — use Sign in with GitHub instead (/api/auth/github/start), which also covers legacy username claims.",
      },
      { status: 503, headers: { "cache-control": "private, no-store" } },
    )
  }
  let body: { username?: string; password?: string }
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: "invalid_body" }, { status: 400 })
  }

  const username = body.username?.trim().toLowerCase() ?? ""
  const password = body.password ?? ""

  const problem =
    !USERNAME_PATTERN.test(username)
      ? "Username must be 3-24 characters: lowercase letters, digits, underscores."
      : password.length < 8 || password.length > 128
        ? "Password must be 8-128 characters."
        : null
  if (problem) {
    return NextResponse.json({ error: "invalid_input", detail: problem }, { status: 400 })
  }

  if (await findUserByUsername(username)) {
    return NextResponse.json(
      { error: "username_taken", detail: "That username is already registered." },
      { status: 409 },
    )
  }

  const ip = clientIp(req.headers)
  const ua = (req.headers.get("user-agent") ?? "").slice(0, 256)
  // Prevent mass account creation: at most 5 accounts per IP+UA per 24h
  if (ip && ua) {
    const recent = await countRecentUsersByIpUa(ip, ua, 24)
    if (recent >= 5) {
      return NextResponse.json(
        { error: "rate_limited", detail: "Too many accounts from this device/network. Try again later." },
        {
          status: 429,
          headers: {
            "retry-after": "86400",
            "cache-control": "private, no-store",
          },
        },
      )
    }
  }

  // Lazy-imported for the same reason as the login route's verifyPassword.
  const { hashPassword } = await import("@/lib/passwords")
  const user = await createUser(username, await hashPassword(password), ip, ua)
  await setSessionCookie(user.id, req.url)
  return NextResponse.json({ username: user.username })
}
