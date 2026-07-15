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

async function checkQobuzAccount(payload: Record<string, unknown>): Promise<CheckResult> {
  const token = String(payload.token ?? "").trim()
  const appId = String(payload.appId ?? "").trim()
  if (!token || !appId) {
    return { ok: false, premium: false, status: "dead", latencyMs: 0, detail: "missing token/appId" }
  }
  try {
    const { res, ms } = await timedFetch(
      `https://www.qobuz.com/api.json/0.2/user/get?app_id=${encodeURIComponent(appId)}&user_auth_token=${encodeURIComponent(token)}`,
    )
    if (!res.ok) {
      return { ok: false, premium: false, status: "dead", latencyMs: ms, detail: `HTTP ${res.status}` }
    }
    const body = (await res.text()).toLowerCase()
    const valid = body.includes('"id"') || body.includes("credential")
    if (!valid) return { ok: false, premium: false, status: "dead", latencyMs: ms, detail: "invalid user" }
    const premium = /lossless|hi-res|hires|studio|sublime|"format_id"\s*:\s*(6|7|27)/.test(body)
    return { ok: true, premium, status: classify(true, premium), latencyMs: ms, detail: "user ok" }
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
