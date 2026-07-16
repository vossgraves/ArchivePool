import { revalidatePath } from "next/cache"
import { NextResponse, type NextRequest } from "next/server"
import { describeSaveError, ingestSource } from "@/lib/ingest"
import { QOBUZ_APP_ID, qobuzLogin, scrapeQobuzAppSecret, validateAppSecret } from "@/lib/qobuz-oauth"

export const dynamic = "force-dynamic"

/**
 * POST /api/qobuz/login
 * Body: { username: string, password: string }
 *
 * Logs in to Qobuz, scrapes the app_secret from the web player bundle, validates both,
 * then ingests the account into the pool — exactly like the Tidal device flow.
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

  // Step 2: scrape the app_secret from the web player bundle.
  const appSecret = await scrapeQobuzAppSecret()
  const secretOk = appSecret ? await validateAppSecret(appSecret, loginResult.userAuthToken) : false

  if (!appSecret || !secretOk) {
    // Login succeeded but we can't get a working secret — return the token anyway
    // so the user can still manually paste the app_secret if needed.
    return NextResponse.json({
      state: "needs_secret",
      userAuthToken: loginResult.userAuthToken,
      appId: QOBUZ_APP_ID,
      userId: loginResult.userId,
      countryCode: loginResult.countryCode,
      detail: "Signed in, but could not scrape app_secret from bundle. Please paste it manually.",
    })
  }

  // Step 3: build payload and ingest, just like Tidal's device poll endpoint.
  const payload: Record<string, unknown> = {
    token: loginResult.userAuthToken,
    appId: QOBUZ_APP_ID,
    appSecret,
    username: loginResult.username ?? username,
    countryCode: loginResult.countryCode,
    note: "Added via Qobuz sign-in",
  }

  try {
    const result = await ingestSource("qobuz", "account", payload)
    revalidatePath("/")
    return NextResponse.json({
      state: "authorized",
      saved: true,
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
