import { createHash } from "node:crypto"
import type { Kind, Service, Status } from "./sources"

export interface CheckResult {
  ok: boolean
  premium: boolean
  status: Status
  latencyMs: number
  detail: string
}

const TIMEOUT_MS = 12_000

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
 * API / instance check: the entry is a restream base URL. We consider it alive
 * if it responds without a server error. Premium (lossless/hi-res capable) is
 * inferred from an optional probe endpoint whose JSON mentions a hi-res marker.
 */
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

async function checkTidalAccount(payload: Record<string, unknown>): Promise<CheckResult> {
  const token = String(payload.token ?? "").trim()
  if (!token) return { ok: false, premium: false, status: "dead", latencyMs: 0, detail: "missing token" }
  try {
    // Validate the OAuth access token against Tidal's session endpoint.
    const { res, ms } = await timedFetch("https://api.tidal.com/v1/sessions", {
      headers: { authorization: `Bearer ${token}` },
    })
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
          { headers: { authorization: `Bearer ${token}` } },
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

// A stable, widely-available public Qobuz track used only to verify that the app_secret produces a
// valid request signature. format_id 5 (MP3 320) is not subscription-gated, so a rejection here is
// due to a bad signature/secret rather than the account's plan.
const QOBUZ_PROBE_TRACK_ID = "5966783"
const QOBUZ_PROBE_FORMAT_ID = "5"

// Qobuz authenticates API calls via headers, not just query params. Sending app_id/token only as
// query params causes intermittent HTTP 401s; the official clients send these headers, so we mirror
// that to avoid false "dead" results. We keep the query params too for maximum compatibility.
function qobuzHeaders(appId: string, token: string): Record<string, string> {
  return {
    "X-App-Id": appId,
    "X-User-Auth-Token": token,
    // A browser-like UA — Qobuz rejects some unrecognized agents with a 401.
    "user-agent":
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
  }
}

/**
 * Validates the app_secret by signing a `track/getFileUrl` request exactly the way the ArchiveTune
 * app does — md5("trackgetFileUrlformat_id{fmt}intentstreamtrack_id{id}{ts}{secret}"). A wrong secret
 * makes Qobuz return an InvalidRequestSignature error, which we surface as a clear failure so bad
 * credentials are rejected at submit time instead of silently failing during playback.
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

export async function runCheck(
  service: Service,
  kind: Kind,
  payload: Record<string, unknown>,
): Promise<CheckResult> {
  if (kind === "api") return checkApi(service, payload)
  if (service === "tidal") return checkTidalAccount(payload)
  return checkQobuzAccount(payload)
}

function reason(e: unknown): string {
  if (e instanceof Error) {
    if (e.name === "AbortError") return "timeout"
    return e.message.slice(0, 120)
  }
  return "error"
}
