import { createHash } from "node:crypto"
import { sql } from "drizzle-orm"
import { db } from "@/lib/db"
import { accountEntries } from "@/lib/db/schema"
import { encryptAtRest } from "@/lib/crypto"
import type { Kind, Service, Status } from "./sources"

export interface CheckResult {
  ok: boolean
  premium: boolean
  status: Status
  latencyMs: number
  detail: string
}

const TIMEOUT_MS = 12_000

// Tidal device-flow OAuth client (same public credentials used by all open-source tooling).
const TIDAL_CLIENT_ID = "zU4XHVVkc2tDPo4t"
const TIDAL_CLIENT_SECRET = "VJKhDFqJPqvsPVNBV6ukXTJmwlvbttP7wlMlrc72se4="
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
    if (!bundle) return ampTokenCache?.token ?? null
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
      premium = /hi_res|hires|lossless|flac|24bit|"quality"\s*:\s*"(lossless|hi_res|hi-res)/.test(text)
    } catch {
      premium = false
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

async function tryRefreshTidalToken(
  payload: Record<string, unknown>,
  entryFingerprint?: string,
): Promise<string | null> {
  // Contributors are handed a single value labelled "Token" which is in fact the refresh token,
  // so fall back to it when no separate refreshToken was supplied. Without this every Tidal
  // submission failed its live check and was rejected as dead.
  const refreshToken =
    String(payload.refreshToken ?? "").trim() || String(payload.token ?? "").trim()
  if (!refreshToken) return null

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
      // Only a scope rejection is worth retrying; anything else (bad token, revoked) fails both.
      const err = (await res.json().catch(() => ({}))) as { error?: string }
      if (err.error !== "invalid_scope") return null
    }
    if (!ok || !json) return null
    const newToken = json.access_token
    if (!newToken) return null

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

    return newToken
  } catch {
    return null
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
      if (!exchanged) {
        return { ok: false, premium: false, status: "dead", latencyMs: 0, detail: "refresh token rejected" }
      }
      token = exchanged
    }

    // Validate the OAuth access token against Tidal's session endpoint.
    let { res, ms } = await timedFetch("https://api.tidal.com/v1/sessions", {
      headers: tidalHeaders(token),
    })

    // On 401 — attempt a refresh before giving up.
    if (res.status === 401) {
      const refreshed = await tryRefreshTidalToken(payload, entryFingerprint)
      if (refreshed) {
        token = refreshed
        const retry = await timedFetch("https://api.tidal.com/v1/sessions", {
          headers: tidalHeaders(token),
        })
        res = retry.res
        ms = retry.ms
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

async function checkQobuzAccount(payload: Record<string, unknown>): Promise<CheckResult> {
  const token = String(payload.token ?? "").trim()
  const appId = String(payload.appId ?? "").trim()
  const appSecret = String(payload.appSecret ?? "").trim()
  if (!token || !appId || !appSecret) {
    return { ok: false, premium: false, status: "dead", latencyMs: 0, detail: "missing token/appId/appSecret" }
  }
  try {
    const { res, ms } = await timedFetch(
      `https://www.qobuz.com/api.json/0.2/user/get?app_id=${encodeURIComponent(appId)}&user_auth_token=${encodeURIComponent(token)}`,
      { headers: qobuzHeaders(appId, token) },
    )
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

/** Only a lossless plan can serve FLAC, so a free account reports "preview", not "alive". */
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
    const { res, ms } = await timedFetch(`${AMP_BASE}/v1/me/storefront`, {
      headers: {
        authorization: `Bearer ${devToken}`,
        "media-user-token": token,
        origin: "https://music.apple.com",
        referer: "https://music.apple.com/",
        "user-agent": APPLE_UA,
      },
    })
    if (!res.ok) {
      return { ok: false, premium: false, status: "dead", latencyMs: ms, detail: `HTTP ${res.status}` }
    }
    const json = (await res.json()) as { data?: { id?: string; attributes?: { name?: string } }[] }
    const storefront = json?.data?.[0]?.id
    if (!storefront) {
      return { ok: false, premium: false, status: "dead", latencyMs: ms, detail: "no storefront in response" }
    }
    // Active-subscription detection: a storefront resolving is the strongest cheap signal we
    // have (anonymous/invalid tokens are rejected outright with 401/403).
    return { ok: true, premium: true, status: "alive", latencyMs: ms, detail: `storefront ${storefront}` }
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

async function checkDeezerAccount(payload: Record<string, unknown>): Promise<CheckResult> {
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

    return {
      ok: true,
      premium,
      status: classify(true, premium),
      latencyMs: ms,
      detail: premium ? "session ok (lossless)" : "session ok (lossy only)",
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
  if (kind === "api") return checkApi(service, payload)
  if (service === "tidal") return checkTidalAccount(payload, entryFingerprint)
  if (service === "deezer") return checkDeezerAccount(payload)
  if (service === "apple-music") return checkAppleMusicAccount(payload)
  if (service === "amazon-music") return checkAmazonMusicAccount(payload)
  return checkQobuzAccount(payload)
}

function reason(e: unknown): string {
  if (e instanceof Error) {
    if (e.name === "AbortError") return "timeout"
    return e.message.slice(0, 120)
  }
  return "error"
}
