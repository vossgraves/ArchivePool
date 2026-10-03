// Qobuz credential-based login for the pool website.
//
// Qobuz has no device/PKCE flow like Tidal. The closest equivalent is:
//   POST https://www.qobuz.com/api.json/0.2/user/login
//   with username, password, app_id → returns user_auth_token immediately.
//
// The app_secret is not returned by the API. It is embedded in the web player JS bundle, so we
// fetch the player page server-side (no CORS) and scrape it.

import { createHash } from "node:crypto"

// Public Qobuz web-player app credentials. These are widely known and used by every
// open-source Qobuz client (streamrip, qobuz-dl, etc.) — they are NOT private.
//
// Qobuz has two distinct public app registrations in play, and they are NOT interchangeable:
//
//   950096963 (this one) + the play.qobuz.com secret — signs stream requests fine, but
//       `user/login` answers "User authentication is required" for valid credentials. It is a
//       web-player-only registration, which is why password sign-in appeared to be broken.
//   712109809 + the open.qobuz.com secret — `user/login` works AND signs streams, verified
//       end to end (a signed getFileUrl returns real track data, not a signature error).
//
// So: sign with what an entry already stores (its own pair), and log in with the login-capable
// pair. Entries contributed before this split keep 950096963 and continue to work unchanged.
export const QOBUZ_APP_ID = "950096963"
export const QOBUZ_LOGIN_APP_ID = "712109809"
export const QOBUZ_LOGIN_APP_SECRET = "589be88e4538daea11f509d29e4a23b1"

const LOGIN_URL = "https://www.qobuz.com/api.json/0.2/user/login"

const SECRET_SOURCES: Record<string, { page: string; origin: string }> = {
  [QOBUZ_APP_ID]: { page: "https://play.qobuz.com/login", origin: "https://play.qobuz.com" },
  [QOBUZ_LOGIN_APP_ID]: { page: "https://open.qobuz.com/", origin: "https://open.qobuz.com" },
}

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
    app_id: QOBUZ_LOGIN_APP_ID,
  })
  const res = await fetch(LOGIN_URL, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      "x-app-id": QOBUZ_LOGIN_APP_ID,
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
 * Scrapes the Qobuz web player that serves [appId]'s registration and extracts the app_secret from
 * its JS bundle.
 *
 * Qobuz embeds the secret as a 32-char lowercase hex string in one of its bundle scripts; the
 * technique is identical to what streamrip / qobuz-dl use. The secret is per-registration, so an
 * unknown appId falls back to the play.qobuz.com player.
 */
export async function scrapeQobuzAppSecret(appId = QOBUZ_APP_ID): Promise<string | null> {
  const { page, origin } = SECRET_SOURCES[appId] ?? SECRET_SOURCES[QOBUZ_APP_ID]
  try {
    const pageRes = await fetch(page, {
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
      scriptUrls.push(src.startsWith("http") ? src : `${origin}${src}`)
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
 * Returns true only when Qobuz answered and did not reject the signature. A network error is
 * NOT a validated secret: the caller maps `false` to the `needs_secret` state so the user can
 * paste one manually, which is safer than proceeding with an unverified secret.
 */
export async function validateAppSecret(
  appSecret: string,
  userAuthToken: string,
  appId = QOBUZ_APP_ID,
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
    `&app_id=${encodeURIComponent(appId)}&user_auth_token=${encodeURIComponent(userAuthToken)}`
  try {
    const res = await fetch(url, {
      headers: { "x-app-id": appId, "x-user-auth-token": userAuthToken, "user-agent": UA },
      cache: "no-store",
      signal: AbortSignal.timeout(12_000),
    })
    const body = await res.text()
    // A bad secret returns an explicit "InvalidRequestSignature" error.
    if (body.toLowerCase().includes("invalid request signature")) return false
    return true
  } catch {
    // Network error or timeout — we could not confirm the secret. Not validated.
    return false
  }
}
