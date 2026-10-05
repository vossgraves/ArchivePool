// SPDX-License-Identifier: GPL-3.0-or-later
import { revalidatePath } from "next/cache"
import { NextResponse, type NextRequest } from "next/server"
import { describeSaveError, ingestSource } from "@/lib/ingest"
import {
  QOBUZ_LOGIN_APP_ID,
  QOBUZ_LOGIN_APP_SECRET,
  qobuzLogin,
  scrapeQobuzAppSecret,
  validateAppSecret,
} from "@/lib/qobuz-oauth"
import { getSessionUserId } from "@/lib/sessions"
import { findUsernameById } from "@/lib/users"

export const dynamic = "force-dynamic"

/**
 * POST /api/qobuz/login
 * Body: { username: string, password: string }
 *
 * Logs in to Qobuz, scrapes the login registration's app_secret from its web player bundle,
 * validates both, then ingests the account into the pool — exactly like the Tidal device flow.
 */
export async function POST(req: NextRequest) {
  let username = ""
  let password = ""
  try {
    const body = (await req.json()) as { username?: string; password?: string }
    username = String(body.username ?? "").trim()
    password = String(body.password ?? "").trim()
  } catch {
    /* fall through to validation below */
  }

  if (!username || !password) {
    return NextResponse.json({ error: "missing_credentials", detail: "Email and password are required." }, { status: 400 })
  }

  // Step 1: sign in to Qobuz.
  let loginResult
  try {
    loginResult = await qobuzLogin(username, password)
  } catch (e) {
    const detail = e instanceof Error ? e.message : "Login failed."
    return NextResponse.json({ error: "login_failed", detail }, { status: 401 })
  }

  // The secret is per-registration: play.qobuz.com's belongs to the older app id and would not
  // sign for the login one, hence the scrape by app id with a known-value fallback.
  const appSecret = (await scrapeQobuzAppSecret(QOBUZ_LOGIN_APP_ID)) ?? QOBUZ_LOGIN_APP_SECRET
  const secretOk = await validateAppSecret(appSecret, loginResult.userAuthToken, QOBUZ_LOGIN_APP_ID)

  if (!secretOk) {
    // Login succeeded but we can't get a working secret — return the token anyway
    // so the user can still manually paste the app_secret if needed.
    return NextResponse.json({
      state: "needs_secret",
      userAuthToken: loginResult.userAuthToken,
      appId: QOBUZ_LOGIN_APP_ID,
      userId: loginResult.userId,
      countryCode: loginResult.countryCode,
      detail: "Signed in, but could not scrape app_secret from bundle. Please paste it manually.",
    })
  }

  // Step 3: build payload and ingest, just like Tidal's device poll endpoint. Credit the signed-in
  // website user when there is one — otherwise OAuth logins land anonymous and never appear on
  // anyone's dashboard contributions.
  const contributor = await getSessionUserId().then((id) => (id ? findUsernameById(id) : null)).catch(() => null)
  const payload: Record<string, unknown> = {
    token: loginResult.userAuthToken,
    appId: QOBUZ_LOGIN_APP_ID,
    appSecret,
    username: loginResult.username ?? username,
    // Kept so the pool can renew this account by itself. A Qobuz user_auth_token is a bearer
    // credential with no refresh endpoint: it dies when the user changes their password, revokes
    // sessions, or the account is locked, and nothing short of a fresh login can replace it. Without
    // the password every such account is a one-shot contribution the contributor has to re-submit.
    // The whole payload is encrypted at rest by ingestSource, and the admin API deliberately never
    // returns `payload` — so this is ciphertext on disk and absent from every response.
    password,
    countryCode: loginResult.countryCode,
    note: "Added via Qobuz sign-in",
  }

  try {
    const result = await ingestSource("qobuz", "account", payload, { contributor })
    revalidatePath("/")
    return NextResponse.json({
      state: "authorized",
      saved: result.saved,
      ok: result.ok,
      status: result.status,
      premium: result.premium,
      detail: result.detail,
    })
  } catch (e) {
    return NextResponse.json(
      { state: "authorized", saved: false, detail: describeSaveError(e) },
      { status: 500 },
    )
  }
}
