// SPDX-License-Identifier: GPL-3.0-or-later
import { NextResponse, type NextRequest } from "next/server"
import {
  GITHUB_OAUTH_COOKIE,
  authorizeUrl,
  githubConfigured,
  issueOauthCookie,
  pkceChallenge,
} from "@/lib/github-auth"

export const dynamic = "force-dynamic"

/**
 * Begin GitHub sign-in. Stores the state nonce + PKCE verifier in one signed
 * HttpOnly cookie (no server-side store) and redirects to GitHub.
 */
export async function GET(req: NextRequest) {
  if (!githubConfigured()) {
    return NextResponse.json(
      { error: "github_auth_unconfigured", detail: "GitHub sign-in is not configured on this deployment." },
      { status: 503 },
    )
  }

  const origin = new URL(req.url).origin
  const { cookieValue, state, verifier } = await issueOauthCookie()
  const res = NextResponse.redirect(authorizeUrl(origin, state, await pkceChallenge(verifier)))
  res.cookies.set(GITHUB_OAUTH_COOKIE, cookieValue, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: 600,
  })
  return res
}
