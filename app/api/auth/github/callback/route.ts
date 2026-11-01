// SPDX-License-Identifier: GPL-3.0-or-later
import { NextResponse, type NextRequest } from "next/server"
import { ensureSchema } from "@/lib/db/ensure"
import {
  GITHUB_OAUTH_COOKIE,
  GITHUB_PENDING_COOKIE,
  exchangeCode,
  fetchGithubUser,
  findUserByGithubId,
  githubConfigured,
  issuePendingCookie,
  readOauthCookie,
} from "@/lib/github-auth"
import { applySessionCookie } from "@/lib/sessions"

export const dynamic = "force-dynamic"

function fail(req: NextRequest, code: string): NextResponse {
  return NextResponse.redirect(new URL(`/login?error=${code}`, req.url))
}

/**
 * GitHub redirect target. Verifies the signed state cookie, exchanges the code for
 * a token (PKCE), reads the numeric id + login from /user, then either signs the
 * known account in or hands out a short-lived pending-identity cookie and sends the
 * browser to the choose-username / claim flow.
 */
export async function GET(req: NextRequest) {
  if (!githubConfigured()) return fail(req, "github_unconfigured")

  const origin = new URL(req.url).origin
  const params = req.nextUrl.searchParams
  const code = params.get("code")
  const state = params.get("state")
  if (!code || !state) return fail(req, "github_state")

  const oauth = await readOauthCookie(req.cookies.get(GITHUB_OAUTH_COOKIE)?.value)
  if (!oauth || oauth.state !== state) return fail(req, "github_state")

  let identity
  try {
    const token = await exchangeCode(origin, code, oauth.verifier)
    identity = await fetchGithubUser(token)
  } catch (e) {
    console.error("[github-auth] exchange/user fetch failed:", e)
    return fail(req, "github_exchange")
  }

  try {
    await ensureSchema()
    const user = await findUserByGithubId(identity.id)
    if (user && !user.disabled) {
      const res = NextResponse.redirect(new URL("/dashboard", req.url))
      await applySessionCookie(res, user.id)
      res.cookies.set(GITHUB_OAUTH_COOKIE, "", { httpOnly: true, path: "/", maxAge: 0 })
      return res
    }
    if (user?.disabled) return fail(req, "account_disabled")
  } catch (e) {
    console.error("[github-auth] user lookup failed:", e)
    return fail(req, "internal")
  }

  // Unknown github_id: park the VERIFIED identity in a short-lived signed cookie and
  // send the browser to choose a username or claim a legacy one.
  const res = NextResponse.redirect(new URL(`/login?github=choose&login=${encodeURIComponent(identity.login)}`, req.url))
  res.cookies.set(GITHUB_PENDING_COOKIE, await issuePendingCookie(identity), {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: 600,
  })
  res.cookies.set(GITHUB_OAUTH_COOKIE, "", { httpOnly: true, path: "/", maxAge: 0 })
  return res
}
