// SPDX-License-Identifier: GPL-3.0-or-later
import { NextResponse, type NextRequest } from "next/server"
import { ensureSchema } from "@/lib/db/ensure"
import {
  GITHUB_OAUTH_COOKIE,
  exchangeCode,
  fetchGithubUser,
  findUserByGithubId,
  githubConfigured,
  readOauthCookie,
} from "@/lib/github-auth"
import { applySessionCookie } from "@/lib/sessions"
import { clientIp } from "@/lib/rate-limit"
import { createGithubUser } from "@/lib/users"

export const dynamic = "force-dynamic"

function fail(req: NextRequest, code: string): NextResponse {
  return NextResponse.redirect(new URL(`/login?error=${code}`, req.url))
}

function clearOauthCookie(res: NextResponse): void {
  res.cookies.set(GITHUB_OAUTH_COOKIE, "", { httpOnly: true, path: "/", maxAge: 0 })
}

/**
 * GitHub redirect target. Verifies the signed state cookie, exchanges the code for
 * a token (PKCE), reads the numeric id + login from /user, then either signs the
 * known account in or CREATES one on the spot — the username is derived from the
 * GitHub login (collisions get suffixed, a legacy name is never taken over), so
 * there is no choose-username step and nothing else to ask the user for.
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
      await applySessionCookie(res, user.id, req.url)
      clearOauthCookie(res)
      return res
    }
    if (user?.disabled) return fail(req, "account_disabled")

    // First sign-in for this github_id: create the account immediately with a
    // username derived from the GitHub login — never a prompt, never a takeover.
    const ip = clientIp(req.headers).slice(0, 64)
    const ua = (req.headers.get("user-agent") ?? "").slice(0, 256)
    const created = await createGithubUser(identity.id, identity.login, ip, ua)
    if ("conflict" in created) {
      // A second tab finished first — sign into the account it created.
      const winner = await findUserByGithubId(identity.id)
      if (winner && !winner.disabled) {
        const res = NextResponse.redirect(new URL("/dashboard", req.url))
        await applySessionCookie(res, winner.id, req.url)
        clearOauthCookie(res)
        return res
      }
      return fail(req, "internal")
    }
    const res = NextResponse.redirect(new URL("/dashboard", req.url))
    await applySessionCookie(res, created.user.id, req.url)
    clearOauthCookie(res)
    return res
  } catch (e) {
    console.error("[github-auth] user lookup/create failed:", e)
    return fail(req, "internal")
  }
}
