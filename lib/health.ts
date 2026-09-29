import { createHash } from "node:crypto"
import { eq, sql } from "drizzle-orm"
import { db } from "@/lib/db"
import { accountEntries } from "@/lib/db/schema"
import { decryptAtRest, encryptAtRest } from "@/lib/crypto"
import { qobuzLogin, scrapeQobuzAppSecret, type QobuzLoginResult } from "./qobuz-oauth"
import { fingerprint, type Kind, type Service, type Status } from "./sources"

export interface CheckResult {
  ok: boolean
  premium: boolean
  status: Status
  latencyMs: number
  detail: string
}

const TIMEOUT_MS = 12_000

// Tidal device-flow OAuth client.
//
// The previous registration (zU4XHVVkc2tDPo4t) was retired by Tidal: it still answers
// device_authorization, but every token it mints carries internal cid 3235 and the refresh grant
// rejects them with "Client id 3235 not found" (natom/streamrip#897, #901; replaced by #932).
// This is the client streamrip v2.2.0 ships.
const TIDAL_CLIENT_ID = "fX2JxdmntZWK0ixT"
const TIDAL_CLIENT_SECRET = "1Nn9AfDAjxrgJFJbKNWLeAyKGVGmINuXPPLHVXAvxAg="
const TIDAL_TOKEN_ENDPOINT = "https://auth.tidal.com/v1/oauth2/token"

// Tidal's own TV/device client UA — used for all Tidal API calls so sessions are not
// flagged for appearing to come from an unrecognised user agent.
const TIDAL_UA = "TIDAL/1000 (Linux; Android 10)"

// Probing a Media-User-Token needs a dev JWT, so the pool self-scrapes the web-player token
// rather than asking contributors for a second credential.
const AMP_BASE = "https://amp-api.music.apple.com"
const APPLE_MUSIC_HOME = "https://music.apple.com/"
const APPLE_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36"
const AMP_TOKEN_TTL_MS = 24 * 60 * 60 * 1000
let ampTokenCache: { token: string; exp: number; at: number } | null = null

/** Decode a JWT payload without verifying the signature (token freshness check only). */
function decodeJwtPayload(jwt: string): Record<string, unknown> | null {
  try {
    const part = jwt.split(".")[1]
    if (!part) return null
    const json = Buffer.from(part.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8")
    return JSON.parse(json) as Record<string, unknown>
  } catch {
    return null
  }
}

/** Mirrors the app-side scraper: home page → JS bundle → ES256 JWTs → `iss: AMPWebPlay`. */
async function ampDevToken(): Promise<string | null> {
  const now = Date.now() / 1000
  if (ampTokenCache && ampTokenCache.exp - 60 > now && Date.now() - ampTokenCache.at < AMP_TOKEN_TTL_MS) {
    return ampTokenCache.token
  }
  try {
    const home = await fetch(APPLE_MUSIC_HOME, {
      headers: { "user-agent": APPLE_UA },
      cache: "no-store",
    })
    if (!home.ok) return ampTokenCache?.token ?? null
    const html = await home.text()
    const bundle = /assets\/index-[^"']+\.js/.exec(html)?.[0]
    if (!bundle) {
      console.warn("[health] apple dev token: no web-player bundle script found on music.apple.com")
      return ampTokenCache?.token ?? null
    }
    const jsRes = await fetch(`https://music.apple.com/${bundle}`, {
      headers: { "user-agent": APPLE_UA },
      cache: "no-store",
    })
    if (!jsRes.ok) return ampTokenCache?.token ?? null
    const js = await jsRes.text()
    const candidates = js.match(/eyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g) ?? []
    for (const candidate of candidates) {
      const payload = decodeJwtPayload(candidate)
      const exp = typeof payload?.exp === "number" ? payload.exp : 0
      const iss = typeof payload?.iss === "string" ? payload.iss : ""
      if (iss === "AMPWebPlay" && exp - 60 > now) {
        ampTokenCache = { token: candidate, exp, at: Date.now() }
        return candidate
      }
    }
    console.warn("[health] apple dev token: no usable AMPWebPlay JWT in the web-player bundle")
    return ampTokenCache?.token ?? null
  } catch {
    return ampTokenCache?.token ?? null
  }
}

async function timedFetch(url: string, init?: RequestInit): Promise<{ res: Response; ms: number }> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)
  const started = Date.now()
  try {
    const res = await fetch(url, {
      ...init,
      signal: controller.signal,
      headers: { "user-agent": "ArchiveTune-SourcePool/1.0", ...(init?.headers ?? {}) },
      cache: "no-store",
    })
    return { res, ms: Date.now() - started }
  } finally {
    clearTimeout(timer)
  }
}

function classify(ok: boolean, premium: boolean): Status {
  if (!ok) return "dead"
  return premium ? "alive" : "preview"
}

/**
 * The hi-res markers every instance probe looks for, whichever body it is reading. Literal `flac`
 * matches a capability list; the `"quality"` arm matches a track or manifest field. Mirrors Go's
 * `hiResRe`.
 */
const HI_RES_RE = /hi_res|hires|lossless|flac|24bit|"quality"\s*:\s*"(lossless|hi_res|hi-res)/

/** Alive when the base URL answers without a server error; premium inferred from a probe. */
async function checkApi(service: Service, payload: Record<string, unknown>): Promise<CheckResult> {
  const baseUrl = String(payload.baseUrl ?? "").trim().replace(/\/+$/, "")
  if (!baseUrl) return { ok: false, premium: false, status: "dead", latencyMs: 0, detail: "missing baseUrl" }

  const healthPath = String(payload.healthPath ?? "").trim()
  const target = healthPath ? `${baseUrl}${healthPath.startsWith("/") ? "" : "/"}${healthPath}` : baseUrl

  try {
    const { res, ms } = await timedFetch(target)
    const reachable = res.status < 500
    if (!reachable) {
      return { ok: false, premium: false, status: "dead", latencyMs: ms, detail: `HTTP ${res.status}` }
    }

    let premium = false
    // Best-effort premium probe: read a small body and look for hi-res markers.
    const probeUrl = String(payload.probeUrl ?? "").trim()
    try {
      const probeTarget = probeUrl ? (probeUrl.startsWith("http") ? probeUrl : `${baseUrl}${probeUrl.startsWith("/") ? "" : "/"}${probeUrl}`) : target
      const { res: probeRes } = await timedFetch(probeTarget)
      const text = (await probeRes.text()).slice(0, 20_000).toLowerCase()
      premium = HI_RES_RE.test(text)
    } catch {
      premium = false
    }

    return { ok: true, premium, status: classify(true, premium), latencyMs: ms, detail: `HTTP ${res.status}` }
  } catch (e) {
    return { ok: false, premium: false, status: "dead", latencyMs: 0, detail: reason(e) }
  }
}

/** Every Amazon instance serves its liveness document here unless the contributor overrides it. */
const AMAZON_HEALTH_PATH = "/health"

/**
 * `status` values an Amazon instance uses to say it is NOT serving. Deliberately a denylist: an
 * instance that answers its health endpoint at all is up unless it names one of these, so a new
 * liveness word cannot silently turn every healthy instance dead. Compared with `=== true` so a
 * status that collides with an `Object.prototype` name is not mistaken for a match.
 */
const AMAZON_HEALTH_ERROR_STATUSES: Record<string, true> = {
  error: true,
  err: true,
  fail: true,
  failed: true,
  failure: true,
  down: true,
  dead: true,
  unhealthy: true,
  unavailable: true,
  offline: true,
  disabled: true,
}

/**
 * Amazon Music instances.
 *
 * A self-hosted Amazon instance publishes its own liveness document, so unlike the Tidal/Qobuz
 * restream check this one can ask the instance directly: `GET {baseUrl}{healthPath || "/health"}`
 * must answer HTTP 2xx *and* a JSON object whose `status` is not an error. The generic checkApi
 * cannot express that — it treats anything below 500 as reachable, so an instance answering
 * `{"status":"error"}` with a 200 would be handed to every app as working.
 *
 * Premium comes from the same hi-res markers every other instance uses, read from `probeUrl` when
 * one is given and from the health body otherwise. An instance that reports a bare
 * `{"status":"ok"}` is therefore `preview`, and the pool's admission policy declines to store it —
 * that is the existing pool-wide rule, not an Amazon-specific one, and it is what keeps a lossy
 * instance out of a lossless pool.
 */
async function checkAmazonMusicInstance(payload: Record<string, unknown>): Promise<CheckResult> {
  const baseUrl = String(payload.baseUrl ?? "").trim().replace(/\/+$/, "")
  if (!baseUrl) return { ok: false, premium: false, status: "dead", latencyMs: 0, detail: "missing baseUrl" }

  const healthPath = String(payload.healthPath ?? "").trim() || AMAZON_HEALTH_PATH
  const target = `${baseUrl}${healthPath.startsWith("/") ? "" : "/"}${healthPath}`

  try {
    const { res, ms } = await timedFetch(target)
    if (res.status < 200 || res.status >= 300) {
      return { ok: false, premium: false, status: "dead", latencyMs: ms, detail: `HTTP ${res.status}` }
    }

    const body = (await res.text()).slice(0, 20_000)
    let parsed: unknown
    try {
      parsed = JSON.parse(body)
    } catch {
      return { ok: false, premium: false, status: "dead", latencyMs: ms, detail: "health response is not JSON" }
    }
    const record = typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : null
    if (!record || record.status === undefined || record.status === null) {
      return { ok: false, premium: false, status: "dead", latencyMs: ms, detail: "health response has no status" }
    }
    // Only a named status is comparable: `String(value)` would render `false` as "false" and a
    // number as its digits, and a blank one means the instance said nothing useful.
    const named = typeof record.status === "string" ? record.status.trim() : String(record.status)
    if (!named) {
      return { ok: false, premium: false, status: "dead", latencyMs: ms, detail: "health response has an empty status" }
    }
    if (AMAZON_HEALTH_ERROR_STATUSES[named.toLowerCase()] === true) {
      return { ok: false, premium: false, status: "dead", latencyMs: ms, detail: `status: ${named}` }
    }

    let premium = HI_RES_RE.test(body.toLowerCase())
    const probeUrl = String(payload.probeUrl ?? "").trim()
    if (probeUrl) {
      // Same rule as every other instance: an explicit probe replaces the health body as the
      // capability signal, so the contributor decides what "lossless" is measured against.
      premium = false
      try {
        const probeTarget = probeUrl.startsWith("http") ? probeUrl : `${baseUrl}${probeUrl.startsWith("/") ? "" : "/"}${probeUrl}`
        const { res: probeRes } = await timedFetch(probeTarget)
        const probeText = (await probeRes.text()).slice(0, 20_000).toLowerCase()
        premium = HI_RES_RE.test(probeText)
      } catch {
        premium = false
      }
    }

    return { ok: true, premium, status: classify(true, premium), latencyMs: ms, detail: `HTTP ${res.status}` }
  } catch (e) {
    return { ok: false, premium: false, status: "dead", latencyMs: 0, detail: reason(e) }
  }
}

/**
 * Deezer instances.
 *
 * A self-hosted Deezer instance publishes its own liveness document, so like the Amazon tier this
 * one asks the instance directly: `GET {baseUrl}{healthPath || "/health"}` must answer HTTP 2xx
 * with a JSON object that says it is serving. The generic checkApi cannot express that — it treats
 * anything below 500 as reachable, so an instance answering `{"ok":false,…}` with a 200 would be
 * handed to every app as working.
 *
 * Two community shapes are in the wild, both verified 2026-09:
 *  - Ultra MAX (github.com/PaRaN01a-hash/ultramax-music, helper/app.py `GET /health`): the helper
 *    authenticates against Deezer with the caller's ARL and answers `{"ok":true,"user":{…}}`, or
 *    HTTP 500 `{"ok":false,"error":…}` when the ARL is refused.
 *  - The Monochrome Deezer fallback (dzr.tabs-vs-spaces.wtf, `deezer-fallback-api-base-url` in its
 *    web bundle): `/` and `/health` serve the same account-pool document
 *    `{"ok":bool,"accounts":{"total","available","dead","cooling",…},"defaultFormat":"FLAC",…}`.
 *
 * The verdict is therefore: an explicit `ok:false` is dead; otherwise a present `accounts` block
 * with nothing available or cooling is dead; otherwise the newest `ok:true`/`user` document is
 * alive. Premium comes from the same hi-res markers every other instance uses (`defaultFormat:
 * "FLAC"` matches the literal `flac` arm), read from `probeUrl` when one is given.
 */
async function checkDeezerInstance(payload: Record<string, unknown>): Promise<CheckResult> {
  const baseUrl = String(payload.baseUrl ?? "").trim().replace(/\/+$/, "")
  if (!baseUrl) return { ok: false, premium: false, status: "dead", latencyMs: 0, detail: "missing baseUrl" }

  const healthPath = String(payload.healthPath ?? "").trim() || "/health"
  const target = `${baseUrl}${healthPath.startsWith("/") ? "" : "/"}${healthPath}`

  try {
    const { res, ms } = await timedFetch(target)
    if (res.status < 200 || res.status >= 300) {
      return { ok: false, premium: false, status: "dead", latencyMs: ms, detail: `HTTP ${res.status}` }
    }

    const body = (await res.text()).slice(0, 20_000)
    let parsed: unknown
    try {
      parsed = JSON.parse(body)
    } catch {
      return { ok: false, premium: false, status: "dead", latencyMs: ms, detail: "health response is not JSON" }
    }
    const record = typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : null
    if (!record) {
      return { ok: false, premium: false, status: "dead", latencyMs: ms, detail: "health response is not an object" }
    }

    const accounts = typeof record.accounts === "object" && record.accounts !== null
      ? (record.accounts as Record<string, unknown>)
      : null
    const hasUser = typeof record.user === "object" && record.user !== null

    if (record.ok === false) {
      return { ok: false, premium: false, status: "dead", latencyMs: ms, detail: "status: not ok" }
    }
    if (accounts) {
      // An instance whose whole pool is exhausted still answers its document, so the counts —
      // not the HTTP status — are what say it can serve right now.
      const total = Number(accounts.total ?? 0)
      const available = Number(accounts.available ?? 0)
      const cooling = Number(accounts.cooling ?? 0)
      if (total > 0 && available === 0 && cooling === 0) {
        return { ok: false, premium: false, status: "dead", latencyMs: ms, detail: "no accounts available" }
      }
    } else if (!hasUser && record.ok !== true) {
      return { ok: false, premium: false, status: "dead", latencyMs: ms, detail: "health response has no status" }
    }

    let premium = HI_RES_RE.test(body.toLowerCase())
    const probeUrl = String(payload.probeUrl ?? "").trim()
    if (probeUrl) {
      premium = false
      try {
        const probeTarget = probeUrl.startsWith("http") ? probeUrl : `${baseUrl}${probeUrl.startsWith("/") ? "" : "/"}${probeUrl}`
        const { res: probeRes } = await timedFetch(probeTarget)
        const probeText = (await probeRes.text()).slice(0, 20_000).toLowerCase()
        premium = HI_RES_RE.test(probeText)
      } catch {
        premium = false
      }
    }

    return { ok: true, premium, status: classify(true, premium), latencyMs: ms, detail: `HTTP ${res.status}` }
  } catch (e) {
    return { ok: false, premium: false, status: "dead", latencyMs: 0, detail: reason(e) }
  }
}

/** Refreshes a Tidal access token and writes it back, so later checks use the new one. */
/**
 * True when a Tidal JWT is a refresh token rather than an access token. The payload is read
 * without verifying the signature, which is safe because the answer only decides which grant to
 * attempt — Tidal is still the thing that accepts or rejects it.
 */
function isTidalRefreshToken(token: string): boolean {
  const payload = token.split(".")[1]
  if (!payload) return false
  try {
    const json = Buffer.from(payload.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8")
    return (JSON.parse(json) as { type?: string }).type === "o2_refresh"
  } catch {
    return false
  }
}

/**
 * True when a Tidal access JWT is expired or expires within the margin. Uses the file's own
 * unverified JWT decoder — the answer only decides whether to refresh pro-actively.
 */
export function isTidalAccessExpired(token: string, marginSecs = 300): boolean {
    const exp = decodeJwtPayload(token)?.exp
    if (typeof exp !== "number" || exp <= 0) return false
    return exp - marginSecs <= Date.now() / 1000
}

/**
 * Refreshes a Tidal account payload's access token when it is expired or near expiry, persisting
 * the new token. Returns the (possibly refreshed) access token, or null when no refresh is
 * possible. Used pro-actively before serving a lease so apps never receive an hours-dead token.
 */
export async function ensureFreshTidalToken(
    payload: Record<string, unknown>,
    entryFingerprint?: string,
): Promise<string | null> {
    const token = String(payload.token ?? "").trim()
    if (!token || isTidalRefreshToken(token)) return token || null
    if (!isTidalAccessExpired(token)) return token
    return (await tryRefreshTidalToken(payload, entryFingerprint)).token
}

async function tryRefreshTidalToken(
  payload: Record<string, unknown>,
  entryFingerprint?: string,
): Promise<{ token: string | null; detail: string }> {
  // Contributors are handed a single value labelled "Token" which is in fact the refresh token,
  // so fall back to it when no separate refreshToken was supplied. Without this every Tidal
  // submission failed its live check and was rejected as dead.
  const refreshToken =
    String(payload.refreshToken ?? "").trim() || String(payload.token ?? "").trim()
  if (!refreshToken) return { token: null, detail: "no refresh token" }

  // Requesting a superset of a token's granted scopes makes Tidal answer 400 invalid_scope on
  // tokens minted elsewhere. Fall back to the narrower scope rather than calling it dead.
  const scopes = ["r_usr+w_usr+w_sub", "r_usr+w_usr"]

  try {
    let json: { access_token?: string; refresh_token?: string; expires_in?: number } | undefined
    let ok = false
    for (const scope of scopes) {
      const body = new URLSearchParams({
        client_id: TIDAL_CLIENT_ID,
        client_secret: TIDAL_CLIENT_SECRET,
        refresh_token: refreshToken,
        grant_type: "refresh_token",
        scope,
      })
      const res = await fetch(TIDAL_TOKEN_ENDPOINT, {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          "user-agent": TIDAL_UA,
        },
        body,
        cache: "no-store",
      })
      if (res.ok) {
        json = (await res.json()) as { access_token?: string; refresh_token?: string; expires_in?: number }
        ok = true
        break
      }
      const err = (await res.json().catch(() => ({}))) as {
        error?: string
        error_description?: string
      }
      // Tidal retires client registrations. When that happens the grant fails with
      // "invalid_client / Client id N not found" for EVERY credential minted by that client,
      // no matter which client_id the caller presents — the id comes from the token itself.
      // Surfacing it precisely is the difference between "this account died" and "the whole
      // onboarding path is dead", which is what the board has to tell an operator.
      if (err.error === "invalid_client" && /client id .* not found/i.test(err.error_description ?? "")) {
        return { token: null, detail: `refresh client retired by Tidal (${err.error_description})` }
      }
      // Only a scope rejection is worth retrying; anything else (bad token, revoked) fails both.
      if (err.error !== "invalid_scope") {
        return { token: null, detail: `refresh rejected: ${err.error ?? res.status}` }
      }
    }
    if (!ok || !json) return { token: null, detail: "refresh failed" }
    const newToken = json.access_token
    if (!newToken) return { token: null, detail: "refresh returned no access token" }

    // Persist the refreshed token back to the DB so it doesn't expire again on the next cycle.
    // Tidal accounts now live in account_entries; the fingerprint is unique there.
    if (entryFingerprint) {
      const newPayload = {
        ...payload,
        token: newToken,
        // Tidal sometimes rotates the refresh token; keep the new one if provided.
        ...(json.refresh_token ? { refreshToken: json.refresh_token } : {}),
      }
      await db
        .update(accountEntries)
        .set({ payload: encryptAtRest(newPayload) })
        .where(sql`fingerprint = ${entryFingerprint}`)
        .catch(() => { /* best-effort — don't fail health check on DB error */ })
    }

    return { token: newToken, detail: "refreshed" }
  } catch {
    return { token: null, detail: "refresh threw" }
  }
}

async function checkTidalAccount(
  payload: Record<string, unknown>,
  entryFingerprint?: string,
): Promise<CheckResult> {
  let token = String(payload.token ?? "").trim()
  if (!token) return { ok: false, premium: false, status: "dead", latencyMs: 0, detail: "missing token" }

  const tidalHeaders = (t: string) => ({
    authorization: `Bearer ${t}`,
    "user-agent": TIDAL_UA,
  })

  try {
    // A refresh token would 401 as a Bearer, so exchange it first rather than spending a
    // round-trip proving that.
    if (isTidalRefreshToken(token)) {
      const exchanged = await tryRefreshTidalToken(payload, entryFingerprint)
      if (!exchanged.token) {
        return { ok: false, premium: false, status: "dead", latencyMs: 0, detail: exchanged.detail }
      }
      token = exchanged.token
    }

    // Validate the OAuth access token against Tidal's session endpoint.
    let { res, ms } = await timedFetch("https://api.tidal.com/v1/sessions", {
      headers: tidalHeaders(token),
    })

    // On 401 — attempt a refresh before giving up.
    if (res.status === 401) {
      const refreshed = await tryRefreshTidalToken(payload, entryFingerprint)
      if (refreshed.token) {
        token = refreshed.token
        const retry = await timedFetch("https://api.tidal.com/v1/sessions", {
          headers: tidalHeaders(token),
        })
        res = retry.res
        ms = retry.ms
      } else {
        // The access token died and the refresh path explains why — report that, not a bare 401,
        // so the board distinguishes a dead credential from a dead Tidal client registration.
        return { ok: false, premium: false, status: "dead", latencyMs: ms, detail: refreshed.detail }
      }
    }

    if (res.status === 401 || res.status === 403) {
      return { ok: false, premium: false, status: "dead", latencyMs: ms, detail: "token rejected" }
    }
    if (!res.ok) {
      return { ok: false, premium: false, status: "dead", latencyMs: ms, detail: `HTTP ${res.status}` }
    }

    // A valid session implies an active account; hi-res capability is best-effort.
    let premium = true
    try {
      const session = (await res.json()) as { userId?: number; countryCode?: string }
      if (session?.userId && session?.countryCode) {
        const sub = await timedFetch(
          `https://api.tidal.com/v1/users/${session.userId}/subscription?countryCode=${session.countryCode}`,
          { headers: tidalHeaders(token) },
        )
        if (sub.res.ok) {
          const body = (await sub.res.text()).toLowerCase()
          premium = /hi_res|hires|lossless|premium|hifi/.test(body)
        }
      }
    } catch {
      /* keep optimistic premium=true */
    }
    return { ok: true, premium, status: classify(true, premium), latencyMs: ms, detail: "session ok" }
  } catch (e) {
    return { ok: false, premium: false, status: "dead", latencyMs: 0, detail: reason(e) }
  }
}

// format_id 5 (MP3 320) is not subscription-gated, so a rejection here means a bad signature
// rather than the account's plan.
const QOBUZ_PROBE_TRACK_ID = "5966783"
const QOBUZ_PROBE_FORMAT_ID = "5"

// Query params alone cause intermittent 401s and false "dead" results; the official clients
// send these headers. The UA must stay in sync with qobuz-oauth.ts or rotation detection trips.
const QOBUZ_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"

function qobuzHeaders(appId: string, token: string): Record<string, string> {
  return {
    "X-App-Id": appId,
    "X-User-Auth-Token": token,
    "user-agent": QOBUZ_UA,
  }
}

/**
 * Signs a `track/getFileUrl` request exactly as the app does, so a wrong app_secret is rejected
 * at submit time instead of failing silently during playback.
 */
async function checkQobuzAppSecret(
  appId: string,
  appSecret: string,
  token: string,
): Promise<{ ok: boolean; detail: string; ms: number }> {
  const ts = Math.floor(Date.now() / 1000).toString()
  const sig = createHash("md5")
    .update(`trackgetFileUrlformat_id${QOBUZ_PROBE_FORMAT_ID}intentstreamtrack_id${QOBUZ_PROBE_TRACK_ID}${ts}${appSecret}`)
    .digest("hex")
  const url =
    `https://www.qobuz.com/api.json/0.2/track/getFileUrl?request_ts=${ts}&request_sig=${sig}` +
    `&track_id=${QOBUZ_PROBE_TRACK_ID}&format_id=${QOBUZ_PROBE_FORMAT_ID}&intent=stream` +
    `&app_id=${encodeURIComponent(appId)}&user_auth_token=${encodeURIComponent(token)}`
  try {
    const { res, ms } = await timedFetch(url, { headers: qobuzHeaders(appId, token) })
    const body = (await res.text()).toLowerCase()
    // A bad app_secret yields a signature error (HTTP 400). Everything else (a signed URL, or a
    // plan/geo restriction on this specific track) means the secret itself is valid.
    if (body.includes("invalid request signature") || body.includes("invalidrequestsignature")) {
      return { ok: false, detail: "invalid app_secret", ms }
    }
    return { ok: true, detail: "secret ok", ms }
  } catch (e) {
    return { ok: false, detail: reason(e), ms: 0 }
  }
}

/**
 * Qobuz rotates the web-player `app_secret`. Every pooled account stores its own copy, so a
 * rotation invalidates all of them at once — each starts failing the signature probe even though
 * its user token is still perfect, and without healing the whole tier goes dark until every
 * contributor re-submits. Re-scrape the current secret, prove it against a known-good token, and
 * rewrite it into every entry that still carries the stale one.
 *
 * Returns the working secret, or null when the secret is not the problem (or the bundle could not
 * be read, in which case we must not churn every credential on a transient fetch failure).
 */
async function healQobuzAppSecret(appId: string, staleSecret: string, probeToken: string): Promise<string | null> {
  let fresh: string | null = null
  try {
    fresh = await scrapeQobuzAppSecret()
  } catch {
    return null
  }
  if (!fresh || fresh === staleSecret) return null
  // Prove the freshly-scraped secret actually signs, so a garbled scrape cannot be written to
  // every account and turn a recoverable rotation into an outage.
  const probe = await checkQobuzAppSecret(appId, fresh, probeToken)
  if (!probe.ok) return null

  // Rewrite every Qobuz account still holding the stale secret. The fingerprint is derived from the
  // user token (see fingerprint()), not the secret, so this does not fork dedupe.
  const rows = await db.select().from(accountEntries).where(eq(accountEntries.service, "qobuz"))
  for (const row of rows) {
    let plain: Record<string, unknown>
    try {
      plain = decryptAtRest(row.payload)
    } catch {
      continue
    }
    if (String(plain.appSecret ?? "").trim() !== staleSecret) continue
    await db
      .update(accountEntries)
      .set({ payload: encryptAtRest({ ...plain, appSecret: fresh }) })
      .where(sql`id = ${row.id}`)
      .catch(() => { /* best-effort — a single row must not abort the heal */ })
  }
  return fresh
}

/**
 * Re-logs into Qobuz with a stored credential and swaps in the fresh `user_auth_token`.
 *
 * A Qobuz user token is a plain bearer credential: it has no refresh endpoint, so the only way to
 * bring a revoked/rotated account back is a fresh `user/login`. Accounts contributed through
 * /api/qobuz/login carry the email + password, so the pool can keep them alive on its own instead
 * of the contributor re-submitting every time Qobuz invalidates them.
 *
 * Token-only contributions have nothing to renew with and are correctly skipped.
 *
 * The row is updated in place, matched on the OLD fingerprint, and the fingerprint is rewritten
 * alongside the token — fingerprint() is derived from the token, so upserting on the new one would
 * create a duplicate row and leave the dead entry behind.
 */
async function renewQobuzToken(
  payload: Record<string, unknown>,
  oldFingerprint?: string,
): Promise<{ token: string | null; detail: string }> {
  const email = String(payload.username ?? "").trim()
  const password = String(payload.password ?? "").trim()
  if (!email || !password) return { token: null, detail: "no stored credential to renew with" }
  if (!oldFingerprint) return { token: null, detail: "no fingerprint to update" }

  let login: QobuzLoginResult
  try {
    login = await qobuzLogin(email, password)
  } catch (e) {
    return { token: null, detail: `re-login failed: ${e instanceof Error ? e.message : "error"}` }
  }
  const fresh = login.userAuthToken
  if (!fresh) return { token: null, detail: "re-login returned no token" }

  const nextPayload: Record<string, unknown> = {
    ...payload,
    token: fresh,
    ...(login.countryCode ? { countryCode: login.countryCode } : {}),
  }
  await db
    .update(accountEntries)
    .set({
      payload: encryptAtRest(nextPayload),
      fingerprint: fingerprint("qobuz", "account", nextPayload),
    })
    .where(sql`fingerprint = ${oldFingerprint}`)
    .catch(() => { /* best-effort — the token still works this round */ })
  return { token: fresh, detail: "re-logged in" }
}
async function checkQobuzAccount(
  payload: Record<string, unknown>,
  entryFingerprint?: string,
): Promise<CheckResult> {
  let token = String(payload.token ?? "").trim()
  const appId = String(payload.appId ?? "").trim()
  const appSecret = String(payload.appSecret ?? "").trim()
  if (!token || !appId || !appSecret) {
    return { ok: false, premium: false, status: "dead", latencyMs: 0, detail: "missing token/appId/appSecret" }
  }
  try {
    let { res, ms } = await timedFetch(
      `https://www.qobuz.com/api.json/0.2/user/get?app_id=${encodeURIComponent(appId)}&user_auth_token=${encodeURIComponent(token)}`,
      { headers: qobuzHeaders(appId, token) },
    )
    if (!res.ok && (res.status === 401 || res.status === 403)) {
      // A rejected user token is usually rotated or revoked, not gone. Accounts that arrived
      // through the sign-in form carry the credential needed to log in again, so renew rather than
      // dropping a contributor who did nothing wrong.
      const renewed = await renewQobuzToken(payload, entryFingerprint).catch((e) => ({
        token: null,
        detail: `renew threw: ${e instanceof Error ? e.message : "error"}`,
      }))
      if (renewed.token) {
        token = renewed.token
        const retry = await timedFetch(
          `https://www.qobuz.com/api.json/0.2/user/get?app_id=${encodeURIComponent(appId)}&user_auth_token=${encodeURIComponent(token)}`,
          { headers: qobuzHeaders(appId, token) },
        )
        res = retry.res
        ms += retry.ms
      } else {
        return { ok: false, premium: false, status: "dead", latencyMs: ms, detail: `token rejected (${renewed.detail})` }
      }
    }
    if (!res.ok) {
      return { ok: false, premium: false, status: "dead", latencyMs: ms, detail: `HTTP ${res.status}` }
    }
    const body = (await res.text()).toLowerCase()
    const valid = body.includes('"id"') || body.includes("credential")
    if (!valid) return { ok: false, premium: false, status: "dead", latencyMs: ms, detail: "invalid user" }
    const premium = /lossless|hi-res|hires|studio|sublime|"format_id"\s*:\s*(6|7|27)/.test(body)
    // The user token is valid; now confirm the app_secret actually signs stream requests, since a
    // token without a working secret cannot resolve any audio in the app.
    const secretCheck = await checkQobuzAppSecret(appId, appSecret, token)
    if (!secretCheck.ok) {
      // A failed signature on a token that just authenticated is almost always Qobuz having
      // rotated the web-player app_secret, not a bad account. Re-scrape and rewrite the new secret
      // into every entry still holding the stale one, then re-test — otherwise one rotation takes
      // the entire tier offline until every contributor resubmits.
      const healed = await healQobuzAppSecret(appId, appSecret, token).catch(() => null)
      if (healed) {
        const retest = await checkQobuzAppSecret(appId, healed, token)
        if (retest.ok) {
          return {
            ok: true,
            premium,
            status: classify(true, premium),
            latencyMs: ms + secretCheck.ms + retest.ms,
            detail: "user ok, app_secret rotated and re-verified",
          }
        }
      }
      return { ok: false, premium, status: "dead", latencyMs: ms + secretCheck.ms, detail: secretCheck.detail }
    }
    return { ok: true, premium, status: classify(true, premium), latencyMs: ms + secretCheck.ms, detail: "user + secret ok" }
  } catch (e) {
    return { ok: false, premium: false, status: "dead", latencyMs: 0, detail: reason(e) }
  }
}

// Deezer's mobile gateway. The ARL cookie is exchanged for a session via getUserData, which also
// reports the plan and the license_token needed to request stream URLs.
const DEEZER_GATEWAY =
  "https://www.deezer.com/ajax/gw-light.php?method=deezer.getUserData&input=3&api_version=1.0&api_token="
const DEEZER_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"

/**
 * Asks Apple's web-playback endpoint for a real stream URL. This is the only call that proves a
 * Media-User-Token can still actually play something.
 *
 * A song that simply is not available in the account's storefront is NOT a dead token — that would
 * flip healthy accounts off the pool on a regional catalogue gap — so only Apple's own
 * "session has ended" style answers count as death. Anything else is reported as inconclusive and
 * the caller keeps the entry.
 */
async function probeAppleWebPlayback(
  mediaUserToken: string,
  devToken: string,
): Promise<{ ok: boolean; lossless: boolean; detail: string; latencyMs: number }> {
  // Probe ids only — never content. A long-standing, widely licensed track; if a given storefront
  // simply does not carry it, the answer is "inconclusive", which is not a death.
  const songIds = ["1499378108", "6792884101"]
  for (const songId of songIds) {
    // The request shape is Apple's web player contract: the song goes in the BODY as
    // `salableAdamId`, and the two tokens travel as HEADERS. Sending them in the body (or
    // omitting Authorization) is answered with failureType 2002 regardless of whether the
    // token is actually good, which would make every account look dead.
    const { res, ms } = await timedFetch("https://play.itunes.apple.com/WebObjects/MZPlay.woa/wa/webPlayback", {
      method: "POST",
      headers: {
        "content-type": "application/json; charset=utf-8",
        authorization: `Bearer ${devToken}`,
        "media-user-token": mediaUserToken,
        origin: "https://music.apple.com",
        referer: "https://music.apple.com/",
        "user-agent": APPLE_UA,
      },
      body: JSON.stringify({ salableAdamId: songId, language: "en-us" }),
    })
    if (!res.ok) {
      // 5xx is Apple's problem, not the token's; try the next id before judging.
      if (res.status >= 500) continue
      return { ok: false, lossless: false, detail: `webPlayback HTTP ${res.status}`, latencyMs: ms }
    }
    const json = (await res.json().catch(() => null)) as {
      failureType?: string | number
      customerMessage?: string
      songList?: Array<{ assets?: Array<{ flavor?: string; URL?: string }> }>
    } | null
    const assets = json?.songList?.[0]?.assets ?? []
    // A playable ctrp (AES-CTR) asset is the proof. cbcp is FairPlay and unusable here.
    const ctrp = assets.filter((a) => String(a.flavor ?? "").includes("ctrp") && a.URL)
    if (ctrp.length > 0) {
      // `meta.subscription.active` is true for trials and region-limited plans that still only
      // serve lossy streams, so it is NOT evidence of a lossless entitlement. The bitrate in the
      // flavor string is: the app treats 321..1411 as lossless, so the pool must measure the same
      // thing — otherwise it labels a 256 kbps-only account "premium" and leases it to apps asking
      // for FLAC, which then silently fall back to the worst stream available.
      const maxKbps = ctrp.reduce((max, a) => {
        const kbps = Number(/(\d+)$/.exec(String(a.flavor ?? ""))?.[1] ?? 0)
        return Number.isFinite(kbps) && kbps > max ? kbps : max
      }, 0)
      const lossless = maxKbps >= 321
      return {
        ok: true,
        lossless,
        detail: lossless
          ? `playback ok (ctrp ${maxKbps} kbps)`
          : `playback ok but lossy only (ctrp ${maxKbps} kbps)`,
        latencyMs: ms,
      }
    }
    // No assets. A session/authorisation failure is terminal; a missing track is not.
    const failure = String(json?.failureType ?? "")
    const message = String(json?.customerMessage ?? "").toLowerCase()
    if (failure === "2002" || message.includes("session has ended") || message.includes("sign in again")) {
      return { ok: false, lossless: false, detail: `webPlayback: ${json?.customerMessage ?? "session ended"}`, latencyMs: ms }
    }
  }
  return { ok: true, lossless: false, detail: "webPlayback inconclusive (no probe track available)", latencyMs: 0 }
}

async function checkAppleMusicAccount(payload: Record<string, unknown>): Promise<CheckResult> {
  const token = String(payload.token ?? "").trim()
  // Media-User-Tokens always start with "0." — anything else is a paste error.
  if (!token.startsWith("0.")) {
    return { ok: false, premium: false, status: "dead", latencyMs: 0, detail: "missing or invalid media-user-token" }
  }

  try {
    const devToken = await ampDevToken()
    if (!devToken) {
      // Cannot probe without a dev JWT; report pending rather than dead so a transient
      // scraping failure does not wipe healthy entries from rotation.
      return { ok: false, premium: false, status: "pending", latencyMs: 0, detail: "no dev token available" }
    }
    const { res, ms } = await timedFetch(`${AMP_BASE}/v1/me/account?meta=subscription`, {
      headers: {
        authorization: `Bearer ${devToken}`,
        "media-user-token": token,
        // gamdl (which reads the same endpoint) carries the token as a cookie; Apple accepts either
        // carrier, so send both and the probe cannot hinge on which one this session prefers.
        cookie: `media-user-token=${token}`,
        origin: "https://music.apple.com",
        referer: "https://music.apple.com/",
        "user-agent": APPLE_UA,
      },
    })
    if (!res.ok) {
      return { ok: false, premium: false, status: "dead", latencyMs: ms, detail: `HTTP ${res.status}` }
    }
    const json = (await res.json()) as {
      meta?: { subscription?: { active?: boolean; storefront?: string } }
    }
    const subscription = json?.meta?.subscription
    if (!subscription || typeof subscription.active !== "boolean") {
      // Nothing to read an entitlement from: report pending rather than dead, so an unrecognised
      // response shape does not wipe healthy entries from rotation.
      return { ok: false, premium: false, status: "pending", latencyMs: ms, detail: "no subscription info in response" }
    }
    const storefront = typeof subscription.storefront === "string" ? subscription.storefront : ""
    const detail = storefront ? `storefront ${storefront}` : "storefront unknown"
    const active = subscription.active
    // A resolving storefront alone does not prove a paid plan — `meta.subscription.active` is false
    // for a signed-in free account, which must report "preview" rather than "alive".
    if (!active) {
      return {
        ok: true,
        premium: false,
        status: classify(true, false),
        latencyMs: ms,
        detail: `${detail} (no active subscription)`,
      }
    }

    // An active subscription says nothing about whether the token can still play. Apple keeps
    // `/v1/me/account` answering 200 + active=true long after a Media-User-Token stops being able
    // to obtain a stream, and the only way to learn that is to ask for one. Without this probe the
    // pool kept leasing tokens that 401-free catalog searches could never play, which is why Apple
    // looked healthy on the board while every app reported "did not resolve".
    const playback = await probeAppleWebPlayback(token, devToken)
    if (!playback.ok) {
      return { ok: false, premium: false, status: "dead", latencyMs: playback.latencyMs, detail: playback.detail }
    }

    // `active` is necessary but not sufficient: trials and some regional plans report active and
    // still only ever serve lossy streams. The pool is a lossless pool, so the verdict follows the
    // bitrate Apple actually offered. A lossy-only account reports "preview" and is auto-disabled
    // by the sweep, which stops it being leased to apps that asked for FLAC.
    return {
      ok: true,
      premium: playback.lossless,
      status: classify(true, playback.lossless),
      latencyMs: ms + playback.latencyMs,
      detail: `${detail}, ${playback.detail}`,
    }
  } catch (err) {
    return {
      ok: false,
      premium: false,
      status: "pending",
      latencyMs: 0,
      detail: `probe error: ${err instanceof Error ? err.message : "unknown"}`,
    }
  }
}

/**
 * Rotates a Deezer ARL without the contributor. The cookie is not a long-lived secret: it
 * naturally expires on roughly a day, which is why a pool of submitted ARLs bleeds out and every
 * contributor has to re-submit daily. Deezer does issue a replacement from a live session, in two
 * steps (the flow used by philippe44/lms-deezer's `refreshArl`, which re-runs it every 24h):
 *
 *   1. `deezer.getUserData` with the current ARL cookie → `SESSION_ID` + `checkForm`
 *   2. `user.getArl` with `api_token=checkForm` and a `sid` cookie → a fresh ARL
 *
 * The new value is persisted so the pool holds the rotated one. Best-effort throughout: a failure
 * here must never turn a working account into a dead one.
 */
async function rotateDeezerArl(
  arl: string,
  entryFingerprint?: string,
): Promise<{ arl: string | null; detail: string }> {
  const base = "https://www.deezer.com/ajax/gw-light.php"
  const userRes = await timedFetch(
    `${base}?method=deezer.getUserData&input=3&api_version=1.0&api_token=`,
    { headers: { cookie: `arl=${arl}`, "user-agent": DEEZER_UA } },
  )
  if (!userRes.res.ok) return { arl: null, detail: `getUserData HTTP ${userRes.res.status}` }
  const userJson = (await userRes.res.json().catch(() => null)) as {
    results?: { SESSION_ID?: string; checkForm?: string }
  } | null
  const sessionId = String(userJson?.results?.SESSION_ID ?? "").trim()
  const checkForm = String(userJson?.results?.checkForm ?? "").trim()
  if (!sessionId || !checkForm) return { arl: null, detail: "no session to rotate from" }

  const arlRes = await timedFetch(
    `${base}?method=user.getArl&input=3&api_version=1.0&api_token=${encodeURIComponent(checkForm)}`,
    { headers: { cookie: `sid=${sessionId}`, "user-agent": DEEZER_UA } },
  )
  if (!arlRes.res.ok) return { arl: null, detail: `getArl HTTP ${arlRes.res.status}` }
  const arlJson = (await arlRes.res.json().catch(() => null)) as { results?: unknown } | null
  const rotated = String(arlJson?.results ?? "").trim()
  if (!rotated || rotated === arl) return { arl: null, detail: "rotation returned nothing new" }

  if (entryFingerprint) {
    // Best-effort persistence — a DB hiccup must not fail the health check.
    await db
      .update(accountEntries)
      .set({ payload: encryptAtRest({ arl: rotated }) })
      .where(sql`fingerprint = ${entryFingerprint}`)
      .catch(() => { /* ignore */ })
  }
  return { arl: rotated, detail: "arl rotated" }
}

async function checkDeezerAccount(
  payload: Record<string, unknown>,
  entryFingerprint?: string,
): Promise<CheckResult> {
  const arl = String(payload.arl ?? "").trim()
  if (!arl) return { ok: false, premium: false, status: "dead", latencyMs: 0, detail: "missing arl" }

  try {
    const { res, ms } = await timedFetch(DEEZER_GATEWAY, {
      headers: { cookie: `arl=${arl}`, "user-agent": DEEZER_UA },
    })
    if (!res.ok) {
      return { ok: false, premium: false, status: "dead", latencyMs: ms, detail: `HTTP ${res.status}` }
    }

    const json = (await res.json()) as {
      results?: {
        USER?: {
          USER_ID?: number
          OPTIONS?: Record<string, unknown>
        }
        checkForm?: string
      }
    }
    const user = json?.results?.USER
    // An expired or invalid ARL still returns HTTP 200, but with USER_ID 0 and no session token.
    const userId = Number(user?.USER_ID ?? 0)
    if (!userId) {
      return { ok: false, premium: false, status: "dead", latencyMs: ms, detail: "arl rejected" }
    }

    const options = user?.OPTIONS ?? {}
    const licenseToken = String(options.license_token ?? "").trim()
    if (!licenseToken) {
      return { ok: false, premium: false, status: "dead", latencyMs: ms, detail: "no license_token" }
    }

    // web_sound_quality advertises the formats the plan allows; lossless implies FLAC access.
    const quality = options.web_sound_quality
    const lossless =
      typeof quality === "object" && quality !== null
        ? Boolean((quality as Record<string, unknown>).lossless)
        : false
    const premium = lossless || Boolean(options.web_hq)

    // A live ARL can mint a replacement for itself, so rotate rather than waiting out the expiry
    // that has been costing contributors a daily re-submit. A rotation problem must never
    // downgrade an otherwise healthy account.
    const rotation = await rotateDeezerArl(arl, entryFingerprint).catch((e) => ({
      arl: null,
      detail: `rotation error: ${reason(e)}`,
    }))
    const session = premium ? "session ok (lossless)" : "session ok (lossy only)"

    return {
      ok: true,
      premium,
      status: classify(true, premium),
      latencyMs: ms,
      detail: rotation.arl ? `${session}, arl rotated` : `${session} (${rotation.detail})`,
    }
  } catch (e) {
    return { ok: false, premium: false, status: "dead", latencyMs: 0, detail: reason(e) }
  }
}

/**
 * Amazon Music accounts.
 *
 * There is no probe to run: Amazon's Music Web API is approval-gated, so a pool deployment cannot
 * ask Amazon whether a session is still good. The check therefore verifies the *shape* only and
 * accepts a well-formed entry, with the real verdict coming from the app — when a session is
 * rejected during playback, the app reports it dead and the entry leaves rotation on the next
 * sweep. Anything malformed is rejected here instead of being handed to every user of the pool.
 *
 * Do not read `alive` as "Amazon confirmed this works". It means "this is well-formed enough to
 * hand out, and nothing has reported it dead yet".
 */
async function checkAmazonMusicAccount(payload: Record<string, unknown>): Promise<CheckResult> {
  const session = String(payload.session ?? "").trim()
  if (!session) {
    return { ok: false, premium: false, status: "dead", latencyMs: 0, detail: "missing session artifact" }
  }
  if (session.length < 16) {
    return { ok: false, premium: false, status: "dead", latencyMs: 0, detail: "session artifact looks truncated" }
  }
  return {
    ok: true,
    premium: payload.premium === true,
    status: "alive",
    latencyMs: 0,
    detail: "unverified (shape only) — Amazon's API has no public probe; the app reports failures",
  }
}

export async function runCheck(
  service: Service,
  kind: Kind,
  payload: Record<string, unknown>,
  entryFingerprint?: string,
): Promise<CheckResult> {
  // Amazon and Deezer instances publish their own liveness documents, so they are checked
  // against those rather than through the generic reachability rule.
  if (kind === "api" && service === "deezer") return checkDeezerInstance(payload)
  if (kind === "api" && service === "amazon-music") return checkAmazonMusicInstance(payload)
  if (kind === "api") return checkApi(service, payload)
  if (service === "tidal") return checkTidalAccount(payload, entryFingerprint)
  if (service === "deezer") return checkDeezerAccount(payload, entryFingerprint)
  if (service === "apple-music") return checkAppleMusicAccount(payload)
  if (service === "amazon-music") return checkAmazonMusicAccount(payload)
  return checkQobuzAccount(payload, entryFingerprint)
}

function reason(e: unknown): string {
  if (e instanceof Error) {
    if (e.name === "AbortError") return "timeout"
    return e.message.slice(0, 120)
  }
  return "error"
}
