// Qobuz credential-based login for the pool website.
//
// Qobuz has no device/PKCE flow like Tidal. The closest equivalent is:
//   POST https://www.qobuz.com/api.json/0.2/user/login
//   with username, password, app_id → returns user_auth_token immediately.
//
// The app_secret is not returned by the API. It is embedded in the web player JS bundle.
// We fetch the play.qobuz.com page server-side (no CORS) and scrape it.
//
// The same app_id / app_secret pair that works on the web player also works in the app
// because the signing algorithm is public and only the secret changes.

import { createHash } from "node:crypto"

// Public Qobuz web-player app credentials. These are widely known and used by every
// open-source Qobuz client (streamrip, qobuz-dl, etc.) — they are NOT private.
export const QOBUZ_APP_ID = "950096963"

const LOGIN_URL = "https://www.qobuz.com/api.json/0.2/user/login"
const PLAYER_URL = "https://play.qobuz.com/login"

// A stable, versioned Chrome UA consistent with what the Qobuz web player itself sends.
// Using a fixed string (not randomised per call) prevents Qobuz from flagging sessions for
// apparent UA rotation, which is a known cause of early token invalidation.
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"

export interface QobuzLoginResult {
  userAuthToken: string
  userId: string
  countryCode?: string
  username?: string
}

/**
 * Signs in with Qobuz credentials. Returns the user_auth_token on success.
 * Throws a user-friendly Error on failure.
 */
export async function qobuzLogin(
  username: string,
  password: string,
): Promise<QobuzLoginResult> {
  const body = new URLSearchParams({
    username,
    email: username,
    password,
    app_id: QOBUZ_APP_ID,
  })
  const res = await fetch(LOGIN_URL, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      "x-app-id": QOBUZ_APP_ID,
      "user-agent": UA,
    },
    body,
    cache: "no-store",
  })

  if (res.status === 401 || res.status === 400) {
    throw new Error("Incorrect email or password.")
  }
  if (!res.ok) {
    throw new Error(`Qobuz login failed: HTTP ${res.status}`)
  }

  const json = (await res.json()) as {
    user_auth_token?: string
    user?: {
      id?: number | string
      country_code?: string
      login?: string
    }
    status?: string
    message?: string
  }

  if (!json.user_auth_token) {
    const msg = json.message ?? json.status ?? "no token returned"
    throw new Error(`Login rejected: ${msg}`)
  }

  return {
    userAuthToken: json.user_auth_token,
    userId: String(json.user?.id ?? ""),
    countryCode: json.user?.country_code,
    username: json.user?.login ?? username,
  }
}

/**
 * Scrapes the Qobuz web player page and extracts the app_secret from the JS bundle.
 *
 * Qobuz embeds the secret as a 32-char lowercase hex string in one of its bundle scripts.
 * The technique is identical to what streamrip / qobuz-dl use.
 */
export async function scrapeQobuzAppSecret(): Promise<string | null> {
  try {
    // Step 1: load the player login page to find the bundle script URLs.
    const pageRes = await fetch(PLAYER_URL, {
      headers: { "user-agent": UA },
      cache: "no-store",
    })
    if (!pageRes.ok) return null
    const html = await pageRes.text()

    // Find all <script src="..."> bundle URLs.
    const scriptUrls: string[] = []
    const scriptRe = /<script[^>]+src="([^"]+\.js[^"]*)"[^>]*>/gi
    let m: RegExpExecArray | null
    while ((m = scriptRe.exec(html)) !== null) {
      const src = m[1]
      scriptUrls.push(src.startsWith("http") ? src : `https://play.qobuz.com${src}`)
    }

    // Step 2: scan each bundle for a 32-char hex string (the app_secret).
    // The secret appears in patterns like: app_secret:"<hex32>" or seed:"<hex32>".
    const secretRe = /(?:app_secret|secret|seed)\s*[:=]\s*"([a-f0-9]{32})"/i

    for (const url of scriptUrls) {
      try {
        const jsRes = await fetch(url, {
          headers: { "user-agent": UA },
          cache: "no-store",
        })
        if (!jsRes.ok) continue
        const js = await jsRes.text()
        const match = secretRe.exec(js)
        if (match?.[1]) return match[1]
      } catch {
        // Try next script
      }
    }
    return null
  } catch {
    return null
  }
}

/**
 * Quick validation: sign a probe request and verify the secret works.
 * Returns true if the secret signs correctly (or if we can't confirm due to network issues).
 */
export async function validateAppSecret(
  appSecret: string,
  userAuthToken: string,
): Promise<boolean> {
  const PROBE_TRACK = "5966783"
  const PROBE_FORMAT = "5"
  const ts = Math.floor(Date.now() / 1000).toString()
  const sig = createHash("md5")
    .update(
      `trackgetFileUrlformat_id${PROBE_FORMAT}intentstreamtrack_id${PROBE_TRACK}${ts}${appSecret}`,
    )
    .digest("hex")
  const url =
    `https://www.qobuz.com/api.json/0.2/track/getFileUrl?request_ts=${ts}&request_sig=${sig}` +
    `&track_id=${PROBE_TRACK}&format_id=${PROBE_FORMAT}&intent=stream` +
    `&app_id=${encodeURIComponent(QOBUZ_APP_ID)}&user_auth_token=${encodeURIComponent(userAuthToken)}`
  try {
    const res = await fetch(url, {
      headers: { "x-app-id": QOBUZ_APP_ID, "x-user-auth-token": userAuthToken, "user-agent": UA },
      cache: "no-store",
    })
    const body = await res.text()
    // A bad secret returns an explicit "InvalidRequestSignature" error.
    if (body.toLowerCase().includes("invalid request signature")) return false
    return true
  } catch {
    // Network error — assume ok to not block login on intermittent failures.
    return true
  }
}
