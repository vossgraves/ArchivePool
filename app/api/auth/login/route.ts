// SPDX-License-Identifier: GPL-3.0-or-later
import { NextResponse, type NextRequest } from "next/server"
import { cfWaitUntil, webLoginDisabled } from "@/lib/cf-env"
import { setSessionCookie } from "@/lib/sessions"
import { findUserByUsername, updateLastLogin } from "@/lib/users"
import { clientIp, rateLimit, tooManyRequests } from "@/lib/rate-limit"

export const dynamic = "force-dynamic"

// Brute-force posture: scrypt verification is intentionally slow (N=16384), and the error is
// uniform so usernames cannot be enumerated. This adds the missing temporal dimension —
// 10 attempts per IP+username and 30 per IP per 10 minutes. Serverless instances each keep
// their own window (see lib/rate-limit.ts), so this raises the cost of an online attack by
// roughly the instance count rather than stopping it absolutely — sufficient for a site whose
// only secret behind login is per-user API key management.
const ATTEMPT_LIMIT = 10
const IP_ATTEMPT_LIMIT = 30
const ATTEMPT_WINDOW_MS = 10 * 60_000

export async function POST(req: NextRequest) {
  if (webLoginDisabled()) {
    return NextResponse.json(
      {
        error: "web_login_unavailable",
        detail:
          "Password sign-in is unavailable on this deployment — use Sign in with GitHub instead (/api/auth/github/start), or bearer read keys programmatically.",
      },
      { status: 503, headers: { "cache-control": "private, no-store", "retry-after": "60" } },
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
  if (!username || !password) {
    return NextResponse.json({ error: "invalid_input" }, { status: 400 })
  }

  const ipAddr = clientIp(req.headers)
  const perAccount = rateLimit(`login-acct:${ipAddr}:${username}`, ATTEMPT_LIMIT, ATTEMPT_WINDOW_MS)
  if (!perAccount.ok) return tooManyRequests(perAccount.retryAfterSec, "login")
  const perIp = rateLimit(`login-ip:${ipAddr}`, IP_ATTEMPT_LIMIT, ATTEMPT_WINDOW_MS)
  if (!perIp.ok) return tooManyRequests(perIp.retryAfterSec, "login")

  const user = await findUserByUsername(username)
  // Lazy-imported: the scrypt module never loads on the Workers path (it early-returns
  // above), keeping the ~30-80 ms hash — and its code — out of free-tier requests.
  const { verifyPassword } = await import("@/lib/passwords")
  // Uniform error for unknown user / wrong password / disabled account so the
  // response cannot be used to enumerate registered usernames.
  if (!user || user.disabled || !(await verifyPassword(password, user.passwordHash))) {
    return NextResponse.json({ error: "invalid_credentials" }, { status: 401 })
  }

  const ip = clientIp(req.headers)
  const ua = (req.headers.get("user-agent") ?? "").slice(0, 256)
  // Best-effort; on Workers cfWaitUntil keeps it alive past the response.
  cfWaitUntil(updateLastLogin(user.id, ip, ua).catch(() => {}))

  await setSessionCookie(user.id, req.url)
  return NextResponse.json({ username: user.username })
}
