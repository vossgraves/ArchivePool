// Tidal OAuth "device authorization" flow. This is the same grant used by TVs, the CLI, and
// open-source Tidal tooling: the user is shown a short code and a link.tidal.com URL, logs in on
// any device, and the server polls until Tidal issues tokens. No redirect URI is required, so it
// works cleanly from a website (unlike the app's WebView token-capture trick, which browsers block).

// Well-known public Tidal "TV/device" OAuth client.
//
// The previous registration (zU4XHVVkc2tDPo4t) was retired by Tidal: it still answers
// device_authorization, but every token it mints carries internal cid 3235, and the refresh
// grant then rejects them with "Client id 3235 not found" (natom/streamrip#897, #901; replaced by
// #932). This is the client streamrip v2.2.0 ships.
const CLIENT_ID = "fX2JxdmntZWK0ixT"
const CLIENT_SECRET = "1Nm5AfDAjxrgJFJbKNWLeAyKGVGmINuXPPLHVXAvxAg="
const SCOPE = "r_usr+w_usr+w_sub"

const DEVICE_AUTH_ENDPOINT = "https://auth.tidal.com/v1/oauth2/device_authorization"
const TOKEN_ENDPOINT = "https://auth.tidal.com/v1/oauth2/token"

// Matches the Tidal TV/device client UA used by the app's TidalAccountManager so all
// requests in the device flow appear consistent from Tidal's perspective.
const TIDAL_UA = "TIDAL/1000 (Linux; Android 10)"

export interface DeviceStart {
  deviceCode: string
  userCode: string
  verificationUri: string
  verificationUriComplete: string
  expiresIn: number
  interval: number
}

export type PollOutcome =
  | { state: "pending" }
  | { state: "slow_down" }
  | { state: "expired" }
  | { state: "error"; detail: string }
  | {
      state: "authorized"
      accessToken: string
      refreshToken?: string
      expiresIn?: number
      countryCode?: string
      userId?: number
    }

/** Kick off a device authorization. Returns the code + link to show the user. */
export async function startDeviceAuth(): Promise<DeviceStart> {
  const body = new URLSearchParams({ client_id: CLIENT_ID, scope: SCOPE })
  const res = await fetch(DEVICE_AUTH_ENDPOINT, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      "user-agent": TIDAL_UA,
    },
    body,
    cache: "no-store",
    // Match the Go device flow's 12s budget so a hung Tidal call cannot pin the route open.
    signal: AbortSignal.timeout(12_000),
  })
  if (!res.ok) {
    // Tidal explains a rejection in the body (`error`/`error_description`); include a short
    // snippet so the route's `detail` says why rather than only the status code.
    const snippet = (await res.text().catch(() => "")).trim().slice(0, 200)
    throw new Error(`device_authorization failed: HTTP ${res.status}${snippet ? ` ${snippet}` : ""}`)
  }
  const json = (await res.json()) as {
    deviceCode: string
    userCode: string
    verificationUri: string
    verificationUriComplete: string
    expiresIn: number
    interval: number
  }
  return {
    deviceCode: json.deviceCode,
    userCode: json.userCode,
    verificationUri: json.verificationUri,
    verificationUriComplete: json.verificationUriComplete,
    expiresIn: json.expiresIn,
    interval: json.interval,
  }
}

/** Poll once for a device code. Callers should wait `interval` seconds between polls. */
export async function pollDeviceToken(deviceCode: string): Promise<PollOutcome> {
  const body = new URLSearchParams({
    client_id: CLIENT_ID,
    client_secret: CLIENT_SECRET,
    device_code: deviceCode,
    grant_type: "urn:ietf:params:oauth:grant-type:device_code",
    scope: SCOPE,
  })
  const res = await fetch(TOKEN_ENDPOINT, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      "user-agent": TIDAL_UA,
    },
    body,
    cache: "no-store",
    // Same 12s budget as the Go poll and the device_authorization call above.
    signal: AbortSignal.timeout(12_000),
  })

  if (res.ok) {
    const json = (await res.json()) as {
      access_token: string
      refresh_token?: string
      expires_in?: number
      user?: { countryCode?: string; userId?: number }
    }
    return {
      state: "authorized",
      accessToken: json.access_token,
      refreshToken: json.refresh_token,
      expiresIn: json.expires_in,
      countryCode: json.user?.countryCode,
      userId: json.user?.userId,
    }
  }

  // Non-2xx: inspect the OAuth error to decide whether to keep polling.
  let error = ""
  try {
    const json = (await res.json()) as { error?: string }
    error = json.error ?? ""
  } catch {
    /* ignore parse errors */
  }

  switch (error) {
    case "authorization_pending":
      return { state: "pending" }
    case "slow_down":
      return { state: "slow_down" }
    case "expired_token":
    case "expired":
      return { state: "expired" }
    default:
      return { state: "error", detail: error || `HTTP ${res.status}` }
  }
}
