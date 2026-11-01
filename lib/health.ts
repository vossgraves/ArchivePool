// SPDX-License-Identifier: GPL-3.0-or-later
import { createHash } from "node:crypto"
import { and, eq, sql } from "drizzle-orm"
import { db } from "@/lib/db"
import { accountEntries, poolState } from "@/lib/db/schema"
import { decryptAtRest, encryptAtRest } from "@/lib/crypto"
import { chargeFetch } from "./cf-env"
import { qobuzLogin, scrapeQobuzAppSecret, type QobuzLoginResult } from "./qobuz-oauth"
import { TIDAL_CLIENT_ID, TIDAL_CLIENT_SECRET } from "./tidal-oauth"
import { fingerprint, type Kind, type Service, type Status } from "./sources"

export interface CheckResult {
  ok: boolean
  premium: boolean
  status: Status
  latencyMs: number
  detail: string
  // The check never reached a verdict (refresh cooldown, lost refresh claim): persistence and
  // report accounting must treat it as a no-op — no counter, no verdict, no health_log row.
  skipped?: boolean
}

const TIMEOUT_MS = 12_000

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
async function ampDevToken(deadline?: AbortSignal): Promise<string | null> {
  const now = Date.now() / 1000
  if (ampTokenCache && ampTokenCache.exp - 60 > now && Date.now() - ampTokenCache.at < AMP_TOKEN_TTL_MS) {
    return ampTokenCache.token
  }
  try {
    chargeFetch()
    const home = await fetch(APPLE_MUSIC_HOME, {
      headers: { "user-agent": APPLE_UA },
      signal: probeSignal(deadline),
      cache: "no-store",
    })
    if (!home.ok) return ampTokenCache?.token ?? null
    const html = await home.text()
    const bundle = /assets\/index-[^"']+\.js/.exec(html)?.[0]
    if (!bundle) {
      console.warn("[health] apple dev token: no web-player bundle script found on music.apple.com")
      return ampTokenCache?.token ?? null
    }
    chargeFetch()
    const jsRes = await fetch(`https://music.apple.com/${bundle}`, {
      headers: { "user-agent": APPLE_UA },
      signal: probeSignal(deadline),
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

async function timedFetch(
  url: string,
  init?: RequestInit,
  deadline?: AbortSignal,
): Promise<{ res: Response; ms: number }> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)
  // A caller-supplied deadline bounds the whole probe, not just this request: whichever signal
  // fires first wins, so a report-path check cannot outlive the verify lease that paid for it.
  const signal = deadline ? AbortSignal.any([controller.signal, deadline]) : controller.signal
  const started = Date.now()
  try {
    chargeFetch()
    const res = await fetch(url, {
      ...init,
      signal,
      headers: { "user-agent": "ArchiveTune-SourcePool/1.0", ...(init?.headers ?? {}) },
      cache: "no-store",
    })
    return { res, ms: Date.now() - started }
  } finally {
    clearTimeout(timer)
  }
}

/**
 * TIMEOUT_MS merged with an optional overall probe deadline — the raw fetch sites (Tidal token
 * refresh, the Apple dev-token scrape, the Qobuz OAuth helpers) get the same composition
 * timedFetch applies without growing their own controller plumbing.
 */
function probeSignal(deadline?: AbortSignal): AbortSignal {
  const own = AbortSignal.timeout(TIMEOUT_MS)
  return deadline ? AbortSignal.any([own, deadline]) : own
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
async function checkApi(service: Service, payload: Record<string, unknown>, deadline?: AbortSignal): Promise<CheckResult> {
  const baseUrl = String(payload.baseUrl ?? "").trim().replace(/\/+$/, "")
  if (!baseUrl) return { ok: false, premium: false, status: "dead", latencyMs: 0, detail: "missing baseUrl" }

  const healthPath = String(payload.healthPath ?? "").trim()
  const target = healthPath ? `${baseUrl}${healthPath.startsWith("/") ? "" : "/"}${healthPath}` : baseUrl

  try {
    const { res, ms } = await timedFetch(target, undefined, deadline)
    const reachable = res.status < 500
    if (!reachable) {
      return { ok: false, premium: false, status: "dead", latencyMs: ms, detail: `HTTP ${res.status}` }
    }

    let premium = false
    // Best-effort premium probe: read a small body and look for hi-res markers.
    const probeUrl = String(payload.probeUrl ?? "").trim()
    try {
      const probeTarget = probeUrl ? (probeUrl.startsWith("http") ? probeUrl : `${baseUrl}${probeUrl.startsWith("/") ? "" : "/"}${probeUrl}`) : target
      const { res: probeRes } = await timedFetch(probeTarget, undefined, deadline)
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
async function checkAmazonMusicInstance(payload: Record<string, unknown>, deadline?: AbortSignal): Promise<CheckResult> {
  const baseUrl = String(payload.baseUrl ?? "").trim().replace(/\/+$/, "")
  if (!baseUrl) return { ok: false, premium: false, status: "dead", latencyMs: 0, detail: "missing baseUrl" }

  const healthPath = String(payload.healthPath ?? "").trim() || AMAZON_HEALTH_PATH
  const target = `${baseUrl}${healthPath.startsWith("/") ? "" : "/"}${healthPath}`

  try {
    const { res, ms } = await timedFetch(target, undefined, deadline)
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
        const { res: probeRes } = await timedFetch(probeTarget, undefined, deadline)
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
async function checkDeezerInstance(payload: Record<string, unknown>, deadline?: AbortSignal): Promise<CheckResult> {
  const baseUrl = String(payload.baseUrl ?? "").trim().replace(/\/+$/, "")
  if (!baseUrl) return { ok: false, premium: false, status: "dead", latencyMs: 0, detail: "missing baseUrl" }

  const healthPath = String(payload.healthPath ?? "").trim() || "/health"
  const target = `${baseUrl}${healthPath.startsWith("/") ? "" : "/"}${healthPath}`

  try {
    const { res, ms } = await timedFetch(target, undefined, deadline)
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
        const { res: probeRes } = await timedFetch(probeTarget, undefined, deadline)
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
 * True when a Tidal JWT is a refresh token rather than an access token. The payload is read
 * without verifying the signature, which is safe because the answer only decides which grant to
 * attempt — Tidal is still the thing that accepts or rejects it.
 */
export function isTidalRefreshToken(token: string): boolean {
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
  deadline?: AbortSignal,
): Promise<string | null> {
  const token = String(payload.token ?? "").trim()
  if (!token || isTidalRefreshToken(token)) return token || null
  if (!isTidalAccessExpired(token)) return token
  return (await tryRefreshTidalToken(payload, entryFingerprint, deadline)).token
}

// ── Refresh single-flight + backoff ─────────────────────────────────────────
// Every credential-refresh path funnels through this claim: whoever wins the conditional
// UPDATE refreshes; everyone else waits for the claimant's row write instead of double-POSTing.
// Tidal rotates refresh tokens, so a second concurrent POST spends the credential the first one
// just invalidated — python-tidal's threading.Lock pattern, stretched across serverless
// instances. The claim outlives the worst probe (45 s) so a successor cannot win mid-refresh.
const REFRESH_CLAIM_SECS = 60
const REFRESH_LOSER_TRIES = 3
const REFRESH_LOSER_WAIT_MS = 500
// Cooldown tiers for the Tidal token endpoint: abuse_detected/429 doubles from 15 min up to
// 6 h while it keeps arriving; a plain network/5xx failure cools for just 2 min. Either way the
// check is skipped, never reported dead — the provider's rate limiter is not a verdict.
const REFRESH_TRANSIENT_COOLDOWN_SECS = 2 * 60
const REFRESH_ABUSE_COOLDOWN_SECS = 15 * 60
const REFRESH_ABUSE_COOLDOWN_MAX_SECS = 6 * 60 * 60
// Pool-wide tripwire: this many abuse rejections inside a minute puts ALL Tidal refreshes on a
// short hold, because the endpoint's abuse scoring is per-client, not per-account.
const GLOBAL_ABUSE_KEY = "tidal_refresh_abuse"
const GLOBAL_ABUSE_HITS = 5
const GLOBAL_ABUSE_WINDOW_SECS = 60
const GLOBAL_COOLDOWN_SECS = 2 * 60

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

interface RefreshRow {
  payload: Record<string, unknown>
  refreshInFlightUntil: Date | null
  refreshCooldownUntil: Date | null
  refreshBackoffMs: number | null
}

const isLive = (t: Date | null) => t != null && new Date(t).getTime() > Date.now()

async function readRefreshRow(fingerprint: string): Promise<RefreshRow | null> {
  const [row] = await db
    .select({
      payload: accountEntries.payload,
      refreshInFlightUntil: accountEntries.refreshInFlightUntil,
      refreshCooldownUntil: accountEntries.refreshCooldownUntil,
      refreshBackoffMs: accountEntries.refreshBackoffMs,
    })
    .from(accountEntries)
    .where(eq(accountEntries.fingerprint, fingerprint))
    .limit(1)
  // Stored credentials are field-encrypted — decrypt before the serve-compare reads token.
  return row ? { ...row, payload: decryptAtRest(row.payload) } : null
}

/** A won claim plus the row's current (decrypted) credential at claim time. */
interface RefreshClaim {
  claim: Date
  payload: Record<string, unknown>
}

/**
 * Conditional claim: stamp refresh_in_flight_until iff nobody currently holds it AND no
 * cooldown is live. Both predicates sit in the same UPDATE's WHERE, so a cooldown written
 * between the caller's earlier read and this claim cannot be slipped past — the claim is the
 * authority, not the read. The deadline is computed here rather than with now() on the DB side:
 * it is compared for equality on release, and a Postgres-generated timestamptz has microsecond
 * precision the JavaScript Date round-trip would lose — a claim we could never clear again.
 *
 * RETURNING the payload matters as much as the claim: Tidal rotates refresh tokens, so the
 * credential the caller snapshotted may already have been consumed by another instance's
 * refresh. The refresh POST must always use the value this claim just read.
 */
async function claimRefresh(fingerprint: string): Promise<RefreshClaim | null> {
  const claim = new Date(Date.now() + REFRESH_CLAIM_SECS * 1000)
  const [row] = await db
    .update(accountEntries)
    .set({ refreshInFlightUntil: claim })
    .where(
      and(
        eq(accountEntries.fingerprint, fingerprint),
        sql`(refresh_in_flight_until is null or refresh_in_flight_until < now())`,
        sql`(refresh_cooldown_until is null or refresh_cooldown_until <= now())`,
      ),
    )
    .returning({ claim: accountEntries.refreshInFlightUntil, payload: accountEntries.payload })
  // Column is nullable so drizzle types the returning as Date|null — it was just stamped.
  return row ? { claim: row.claim ?? claim, payload: decryptAtRest(row.payload) } : null
}

/**
 * Release OUR claim and persist the outcome in the same atomic UPDATE — a rotated credential
 * rides along, so a loser re-reading the row sees only claim-held or claim-cleared-with-result,
 * never a half state. A successful refresh also clears any old cooldown.
 */
async function finishRefresh(
  fingerprint: string,
  claim: Date,
  outcome: {
    payload?: Record<string, unknown>
    fingerprint?: string // credential rewrites (Qobuz re-login) swap the dedupe key too
    cooldownUntil?: Date
    backoffMs?: number | null // persist the abuse-hold duration; a successful refresh resets it
  } = {},
): Promise<void> {
  await db
    .update(accountEntries)
    .set({
      refreshInFlightUntil: null,
      ...(outcome.payload ? { payload: encryptAtRest(outcome.payload) } : {}),
      ...(outcome.fingerprint ? { fingerprint: outcome.fingerprint } : {}),
      ...(outcome.cooldownUntil
        ? { refreshCooldownUntil: outcome.cooldownUntil }
        : outcome.payload
          ? { refreshCooldownUntil: null }
          : {}),
      ...(outcome.backoffMs !== undefined
        ? { refreshBackoffMs: outcome.backoffMs }
        : outcome.payload
          ? { refreshBackoffMs: null }
          : {}),
    })
    .where(and(eq(accountEntries.fingerprint, fingerprint), eq(accountEntries.refreshInFlightUntil, claim)))
    .catch(() => {
      /* a lapsed claim self-heals — the wait budget above keeps losers bounded regardless */
    })
}

type RefreshGate =
  | { kind: "claim"; claim: RefreshClaim | null } // caller may POST — with claim.payload when set
  | { kind: "serve"; token: string } // another instance's refresh landed — serve its token
  | { kind: "skip"; detail: string } // cooldown or lost claim — never a dead verdict

/**
 * Decide whether this instance may spend a credential refresh on the account right now:
 *  - refresh_cooldown_until or the shared abuse backoff in force → skip (a cooldown is not a
 *    verdict on the account, so callers map it to pending, never dead);
 *  - the conditional claim wins → caller POSTs and finishes through finishRefresh;
 *  - claim lost → poll the row: the claimant's finish either serves the fresh token
 *    ("serve the current token") or leaves nothing usable, in which case the check is skipped
 *    rather than poisoned by a stale credential.
 */
async function gateRefresh(
  fingerprint: string | undefined,
  knownToken: string,
  globalBackoff = false,
): Promise<RefreshGate> {
  if (!fingerprint) return { kind: "claim", claim: null } // no row identity → nothing to claim
  const row = await readRefreshRow(fingerprint)
  if (!row) return { kind: "claim", claim: null } // entry vanished mid-check
  if (isLive(row.refreshCooldownUntil)) return { kind: "skip", detail: "refresh cooling" }
  if (globalBackoff && (await tidalAbuseBackoffActive())) {
    return { kind: "skip", detail: "shared Tidal refresh backoff" }
  }
  // The claim UPDATE re-checks both predicates atomically — a cooldown landing between the read
  // above and this line still wins, because it is the UPDATE's WHERE that decides.
  const claimed = await claimRefresh(fingerprint)
  if (claimed) return { kind: "claim", claim: claimed }

  for (let i = 0; i < REFRESH_LOSER_TRIES; i++) {
    await sleep(REFRESH_LOSER_WAIT_MS)
    const cur = await readRefreshRow(fingerprint).catch(() => null)
    if (!cur) return { kind: "skip", detail: "entry removed mid-refresh" }
    if (isLive(cur.refreshInFlightUntil)) continue
    // Claim resolved: a different stored token means the claimant's refresh succeeded.
    const fresh = String(cur.payload?.token ?? "").trim()
    if (fresh && fresh !== knownToken) return { kind: "serve", token: fresh }
    if (isLive(cur.refreshCooldownUntil)) return { kind: "skip", detail: "refresh cooling" }
    return { kind: "skip", detail: "refresh attempted by another instance" }
  }
  return { kind: "skip", detail: "refresh claim held elsewhere" }
}

async function tidalAbuseBackoffActive(): Promise<boolean> {
  const [row] = await db
    .select({ value: poolState.value })
    .from(poolState)
    .where(eq(poolState.key, GLOBAL_ABUSE_KEY))
    .limit(1)
    .catch(() => [] as { value: Record<string, unknown> }[])
  const v = (row?.value ?? {}) as { global_until?: number; globalUntil?: string }
  const until =
    typeof v.global_until === "number"
      ? v.global_until * 1000 // epoch seconds, written by recordTidalAbuse's upsert
      : typeof v.globalUntil === "string"
        ? new Date(v.globalUntil).getTime() // legacy shape from the pre-atomic writer
        : 0
  return until > Date.now()
}

/**
 * Bump the shared abuse counter and, once the tripwire fires, set the global hold — all in ONE
 * upsert whose CASE arms evaluate against the row's stored window, so concurrent instances can
 * no longer read-then-write the count away from each other. Values are epoch seconds: the
 * comparisons stay pure arithmetic, no timestamp parsing anywhere.
 */
async function recordTidalAbuse(): Promise<void> {
  try {
    await db.execute(sql`
      insert into pool_state (key, value, updated_at)
      values (
        ${GLOBAL_ABUSE_KEY},
        jsonb_build_object(
          'hits', 1,
          'window_start', extract(epoch from now()),
          'global_until', 0
        ),
        now()
      )
      on conflict (key) do update set
        value = jsonb_build_object(
          'hits', case
            when extract(epoch from now()) - coalesce((pool_state.value->>'window_start')::float, 0)
                 > ${GLOBAL_ABUSE_WINDOW_SECS}
              then 1
            else coalesce((pool_state.value->>'hits')::int, 0) + 1
          end,
          'window_start', case
            when extract(epoch from now()) - coalesce((pool_state.value->>'window_start')::float, 0)
                 > ${GLOBAL_ABUSE_WINDOW_SECS}
              then extract(epoch from now())
            else coalesce((pool_state.value->>'window_start')::float, extract(epoch from now()))
          end,
          'global_until', case
            when (case
                    when extract(epoch from now()) - coalesce((pool_state.value->>'window_start')::float, 0)
                         > ${GLOBAL_ABUSE_WINDOW_SECS}
                      then 1
                    else coalesce((pool_state.value->>'hits')::int, 0) + 1
                  end) >= ${GLOBAL_ABUSE_HITS}
              then extract(epoch from now()) + ${GLOBAL_COOLDOWN_SECS}
            else coalesce((pool_state.value->>'global_until')::float, 0)
          end
        ),
        updated_at = now()
    `)
  } catch {
    /* heuristic only — never block a refresh decision on bookkeeping */
  }
}

/**
 * Exponential abuse cooldown: the PERSISTED hold doubles while rejections keep arriving —
 * 15 min, 30, 1h … 6h cap — and survives the cooldown itself expiring, because the duration
 * lives in refresh_backoff_ms rather than being re-derived from whatever cooldown remains.
 * A successful refresh writes it back to NULL via finishRefresh.
 */
function nextAbuseCooldown(previousMs: number | null): { until: Date; backoffMs: number } {
  const backoffMs = previousMs
    ? Math.min(previousMs * 2, REFRESH_ABUSE_COOLDOWN_MAX_SECS * 1000)
    : REFRESH_ABUSE_COOLDOWN_SECS * 1000
  return { until: new Date(Date.now() + backoffMs), backoffMs }
}

/** Refreshes a Tidal access token and writes it back, so later checks use the new one. */
async function tryRefreshTidalToken(
  payload: Record<string, unknown>,
  entryFingerprint?: string,
  deadline?: AbortSignal,
): Promise<{ token: string | null; detail: string; skip?: boolean }> {
  // Single-flight + backoff gate BEFORE reading the credential: the claim returns the row's
  // current decrypted payload, and the refresh POST must use THAT — the caller's snapshot may
  // predate another instance's rotation, which would double-spend the (now invalid) token. A
  // `skip` outcome means "not verified" — callers map it to pending, never dead.
  let claim: RefreshClaim | null = null
  let current = payload
  if (entryFingerprint) {
    const gate = await gateRefresh(entryFingerprint, String(payload.token ?? "").trim(), true)
    if (gate.kind === "serve") return { token: gate.token, detail: "served after another check's refresh" }
    if (gate.kind === "skip") return { token: null, detail: gate.detail, skip: true }
    claim = gate.claim
    if (claim) current = claim.payload
  }
  const finish = (outcome: Parameters<typeof finishRefresh>[2] = {}) =>
    entryFingerprint && claim ? finishRefresh(entryFingerprint, claim.claim, outcome) : Promise.resolve()

  // Contributors are handed a single value labelled "Token" which is in fact the refresh token,
  // so fall back to it when no separate refreshToken was supplied. Without this every Tidal
  // submission failed its live check and was rejected as dead.
  const refreshToken =
    String(current.refreshToken ?? "").trim() || String(current.token ?? "").trim()
  if (!refreshToken) {
    await finish()
    return { token: null, detail: "no refresh token" }
  }

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
      chargeFetch()
      const res = await fetch(TIDAL_TOKEN_ENDPOINT, {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          "user-agent": TIDAL_UA,
        },
        body,
        signal: probeSignal(deadline),
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
      // Tidal answers sustained refresh hammering with 429 or an abuse_detected error body —
      // neither says anything about the account, so the outcome is "cool off", not dead. The
      // hold doubles while it keeps arriving (15 min → 6 h), and enough hits inside a minute
      // engage the pool-wide backoff for every account.
      const abuseText = `${err.error ?? ""} ${err.error_description ?? ""}`
      if (res.status === 429 || /abuse/i.test(abuseText)) {
        const row = entryFingerprint ? await readRefreshRow(entryFingerprint).catch(() => null) : null
        const next = nextAbuseCooldown(row?.refreshBackoffMs ?? null)
        await finish({ cooldownUntil: next.until, backoffMs: next.backoffMs })
        await recordTidalAbuse()
        return {
          token: null,
          detail: `refresh rate-limited, cooling until ${next.until.toISOString()}`,
          skip: true,
        }
      }
      // A provider-side failure is transient — cool briefly and let the sweep re-verify soon
      // rather than writing a dead verdict over what may be a fine account.
      if (res.status >= 500) {
        await finish({ cooldownUntil: new Date(Date.now() + REFRESH_TRANSIENT_COOLDOWN_SECS * 1000) })
        return { token: null, detail: `refresh transient (HTTP ${res.status})`, skip: true }
      }
      // A retired client registration fails the grant with "Client id N not found" for EVERY
      // credential it minted, whichever client_id the caller presents (the id comes from the token
      // itself). Surfacing it separates "this account died" from "the onboarding path is dead".
      if (err.error === "invalid_client" && /client id .* not found/i.test(err.error_description ?? "")) {
        await finish()
        return { token: null, detail: `refresh client retired by Tidal (${err.error_description})` }
      }
      // Only a scope rejection is worth retrying; anything else (bad token, revoked) fails both —
      // a rejected refresh, not a bare 401, is what marks the credential dead.
      if (err.error !== "invalid_scope") {
        await finish()
        return { token: null, detail: `refresh rejected: ${err.error ?? res.status}` }
      }
    }
    if (!ok || !json) {
      await finish()
      return { token: null, detail: "refresh failed" }
    }
    const newToken = json.access_token
    if (!newToken) {
      await finish()
      return { token: null, detail: "refresh returned no access token" }
    }

    // Persist the refreshed token back to the DB so it doesn't expire again on the next cycle —
    // in the SAME update that releases the claim, so a waiting instance sees the new credential
    // and the cleared claim atomically. Tidal accounts live in account_entries; the fingerprint
    // is unique there.
    if (entryFingerprint) {
      const newPayload = {
        ...current,
        token: newToken,
        // Tidal sometimes rotates the refresh token; keep the new one if provided.
        ...(json.refresh_token ? { refreshToken: json.refresh_token } : {}),
      }
      if (claim) {
        await finish({ payload: newPayload })
      } else {
        await db
          .update(accountEntries)
          .set({ payload: encryptAtRest(newPayload) })
          .where(sql`fingerprint = ${entryFingerprint}`)
          .catch(() => { /* best-effort — don't fail health check on DB error */ })
      }
    }

    return { token: newToken, detail: "refreshed" }
  } catch {
    // A thrown fetch is the network case, not a verdict: brief cooldown and skip the check.
    await finish({ cooldownUntil: new Date(Date.now() + REFRESH_TRANSIENT_COOLDOWN_SECS * 1000) })
    return { token: null, detail: "refresh threw", skip: true }
  }
}

async function checkTidalAccount(
  payload: Record<string, unknown>,
  entryFingerprint?: string,
  deadline?: AbortSignal,
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
      const exchanged = await tryRefreshTidalToken(payload, entryFingerprint, deadline)
      if (!exchanged.token) {
        // A cooldown/claim skip means the account was never verified: not dead, and not even a
        // verdict — persistence must treat it as a no-op (skipped), not count it as a failure.
        return {
          ok: false,
          premium: false,
          status: exchanged.skip ? "pending" : "dead",
          latencyMs: 0,
          detail: exchanged.detail,
          skipped: exchanged.skip ?? false,
        }
      }
      token = exchanged.token
    }

    // Validate the OAuth access token against Tidal's session endpoint.
    let { res, ms } = await timedFetch("https://api.tidal.com/v1/sessions", {
      headers: tidalHeaders(token),
    }, deadline)

    // On 401 — attempt a refresh before giving up.
    if (res.status === 401) {
      const refreshed = await tryRefreshTidalToken(payload, entryFingerprint, deadline)
      if (refreshed.token) {
        token = refreshed.token
        const retry = await timedFetch(
          "https://api.tidal.com/v1/sessions",
          { headers: tidalHeaders(token) },
          deadline,
        )
        res = retry.res
        ms = retry.ms
      } else {
        return {
          ok: false,
          premium: false,
          status: refreshed.skip ? "pending" : "dead",
          latencyMs: ms,
          detail: refreshed.detail,
          skipped: refreshed.skip ?? false,
        }
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
          deadline,
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
  deadline?: AbortSignal,
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
    const { res, ms } = await timedFetch(url, { headers: qobuzHeaders(appId, token) }, deadline)
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
 * Qobuz rotates `app_secret` per app registration, and every pooled account stores its own copy, so
 * a rotation makes all of them fail the signature probe at once even though their user tokens are
 * fine. Re-scrape the secret for this app id, prove it signs with a known-good token, and rewrite it
 * into every entry of that app still carrying the stale one.
 *
 * Returns the working secret, or null when the secret is not the problem or the bundle could not
 * be read — a transient fetch failure must not churn every credential.
 */
async function healQobuzAppSecret(
  appId: string,
  staleSecret: string,
  probeToken: string,
  deadline?: AbortSignal,
): Promise<string | null> {
  const fresh = await scrapeQobuzAppSecret(appId, deadline)
  if (!fresh || fresh === staleSecret) return null
  const probe = await checkQobuzAppSecret(appId, fresh, probeToken, deadline)
  if (!probe.ok) return null

  // The fingerprint derives from the user token, not the secret, so this does not fork dedupe.
  const rows = await db.select().from(accountEntries).where(eq(accountEntries.service, "qobuz"))
  for (const row of rows) {
    let plain: Record<string, unknown>
    try {
      plain = decryptAtRest(row.payload)
    } catch {
      continue
    }
    if (String(plain.appId ?? "").trim() !== appId || String(plain.appSecret ?? "").trim() !== staleSecret) continue
    await db
      .update(accountEntries)
      .set({ payload: encryptAtRest({ ...plain, appSecret: fresh }) })
      .where(eq(accountEntries.id, row.id))
      .catch(() => { /* best-effort — a single row must not abort the heal */ })
  }
  return fresh
}

/**
 * Re-logs into Qobuz with a stored credential and swaps in the fresh `user_auth_token`. A user
 * token has no refresh endpoint, so a fresh `user/login` is the only way to revive a revoked one;
 * token-only contributions carry no credential and are skipped.
 *
 * The row is matched on the OLD fingerprint and the fingerprint is rewritten alongside the token:
 * it derives from the token, so upserting on the new one would duplicate the row and leave the
 * dead entry behind.
 */
async function renewQobuzToken(
  payload: Record<string, unknown>,
  oldFingerprint?: string,
  deadline?: AbortSignal,
): Promise<{ token: string | null; detail: string; skip?: boolean }> {
  if (!oldFingerprint) return { token: null, detail: "no fingerprint to update" }

  // Re-login is a credential refresh like Tidal's: single-flight it, or two concurrent checks
  // both POST user/login and double-write the row. When the claim wins, ITS payload is the
  // credential source — the caller's snapshot can predate another instance's rewrite.
  const gate = await gateRefresh(oldFingerprint, String(payload.token ?? "").trim())
  if (gate.kind === "serve") return { token: gate.token, detail: "renewed by another check" }
  if (gate.kind === "skip") return { token: null, detail: gate.detail, skip: true }
  const claim = gate.claim
  const current = claim?.payload ?? payload
  const finish = (outcome: Parameters<typeof finishRefresh>[2] = {}) =>
    claim ? finishRefresh(oldFingerprint, claim.claim, outcome) : Promise.resolve()

  const email = String(current.username ?? "").trim()
  const password = String(current.password ?? "").trim()
  if (!email || !password) {
    await finish()
    return { token: null, detail: "no stored credential to renew with" }
  }

  let login: QobuzLoginResult
  try {
    login = await qobuzLogin(email, password, deadline)
  } catch (e) {
    await finish()
    // A credential rejection is a verdict; a network throw is not — same split as the Tidal
    // refresh, where a transient failure must not kill the account.
    const message = e instanceof Error ? e.message : "error"
    const rejected = /incorrect|rejected/i.test(message)
    return { token: null, detail: `re-login failed: ${message}`, skip: !rejected }
  }
  const fresh = login.userAuthToken
  if (!fresh) {
    await finish()
    return { token: null, detail: "re-login returned no token" }
  }

  const nextPayload: Record<string, unknown> = {
    ...current,
    token: fresh,
    ...(login.countryCode ? { countryCode: login.countryCode } : {}),
  }
  // The row is matched on the OLD fingerprint and the fingerprint is rewritten alongside the
  // token: it derives from the token, so upserting on the new one would duplicate the row and
  // leave the dead entry behind. Claim and payload clear together in the same UPDATE.
  await finish({
    payload: nextPayload,
    fingerprint: fingerprint("qobuz", "account", nextPayload),
  })
  if (!claim) {
    await db
      .update(accountEntries)
      .set({
        payload: encryptAtRest(nextPayload),
        fingerprint: fingerprint("qobuz", "account", nextPayload),
      })
      .where(sql`fingerprint = ${oldFingerprint}`)
      .catch(() => { /* best-effort — the token still works this round */ })
  }
  return { token: fresh, detail: "re-logged in" }
}

async function checkQobuzAccount(
  payload: Record<string, unknown>,
  entryFingerprint?: string,
  deadline?: AbortSignal,
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
      deadline,
    )
    if (res.status === 401 || res.status === 403) {
      const renewed = await renewQobuzToken(payload, entryFingerprint, deadline).catch((e) => ({
        token: null,
        detail: `renew threw: ${e instanceof Error ? e.message : "error"}`,
        skip: true, // a thrown renew is the network case — not a dead verdict
      }))
      if (renewed.token) {
        token = renewed.token
        const retry = await timedFetch(
          `https://www.qobuz.com/api.json/0.2/user/get?app_id=${encodeURIComponent(appId)}&user_auth_token=${encodeURIComponent(token)}`,
          { headers: qobuzHeaders(appId, token) },
          deadline,
        )
        res = retry.res
        ms += retry.ms
      } else {
        return {
          ok: false,
          premium: false,
          status: renewed.skip ? "pending" : "dead",
          latencyMs: ms,
          detail: `token rejected (${renewed.detail})`,
          skipped: renewed.skip ?? false,
        }
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
    const secretCheck = await checkQobuzAppSecret(appId, appSecret, token, deadline)
    if (!secretCheck.ok) {
      // A failed signature on a token that just authenticated is almost always a rotated
      // app_secret, not a bad account.
      const healed = await healQobuzAppSecret(appId, appSecret, token, deadline).catch(() => null)
      if (healed) {
        const retest = await checkQobuzAppSecret(appId, healed, token, deadline)
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
 * Asks Apple's web-playback endpoint for a real stream URL, the only call that proves a
 * Media-User-Token can still play something.
 *
 * `lossless` is null when the probe could not decide. A song missing from the account's storefront
 * or an Apple-side error is not a dead token, so only Apple's own "session has ended" style answers
 * report `ok: false`.
 */
async function probeAppleWebPlayback(
  mediaUserToken: string,
  devToken: string,
  deadline?: AbortSignal,
): Promise<{ ok: boolean; lossless: boolean | null; detail: string; latencyMs: number }> {
  const songIds = ["1499378108", "6792884101"]
  for (const songId of songIds) {
    // Apple's web player contract: the song goes in the BODY as `salableAdamId` and the tokens in
    // HEADERS. Any other shape is answered with failureType 2002 whether or not the token is good,
    // which would make every account look dead.
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
    }, deadline)
    if (!res.ok) {
      if (res.status >= 500 || res.status === 429) continue
      return { ok: false, lossless: false, detail: `webPlayback HTTP ${res.status}`, latencyMs: ms }
    }
    const json = (await res.json().catch(() => null)) as {
      failureType?: string | number
      customerMessage?: string
      songList?: Array<{ assets?: Array<{ flavor?: string; URL?: string }> }>
    } | null
    const assets = json?.songList?.[0]?.assets ?? []
    // ctrp (AES-CTR) is the playable flavor; cbcp is FairPlay and unusable here.
    const ctrp = assets.filter((a) => String(a.flavor ?? "").includes("ctrp") && a.URL)
    if (ctrp.length > 0) {
      // `meta.subscription.active` is true for trials and region-limited plans that still only serve
      // lossy streams, so entitlement is read from the bitrate in the flavor string instead; the app
      // treats 321..1411 as lossless and the pool must measure the same thing.
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
    const failure = String(json?.failureType ?? "")
    const message = String(json?.customerMessage ?? "").toLowerCase()
    if (failure === "2002" || message.includes("session has ended") || message.includes("sign in again")) {
      return { ok: false, lossless: false, detail: `webPlayback: ${json?.customerMessage ?? "session ended"}`, latencyMs: ms }
    }
  }
  return { ok: true, lossless: null, detail: "webPlayback inconclusive (no probe track available)", latencyMs: 0 }
}

async function checkAppleMusicAccount(payload: Record<string, unknown>, deadline?: AbortSignal): Promise<CheckResult> {
  const token = String(payload.token ?? "").trim()
  // Media-User-Tokens always start with "0." — anything else is a paste error.
  if (!token.startsWith("0.")) {
    return { ok: false, premium: false, status: "dead", latencyMs: 0, detail: "missing or invalid media-user-token" }
  }

  try {
    const devToken = await ampDevToken(deadline)
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
    }, deadline)
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

    // Apple keeps `/v1/me/account` answering 200 + active=true long after a Media-User-Token can no
    // longer obtain a stream; only asking for one shows it.
    const playback = await probeAppleWebPlayback(token, devToken, deadline)
    if (!playback.ok) {
      return { ok: false, premium: false, status: "dead", latencyMs: playback.latencyMs, detail: playback.detail }
    }

    // The verdict follows the bitrate Apple offered, so a lossy-only account reports "preview" and
    // the sweep disables it. An inconclusive probe keeps the subscription verdict: disabling a
    // healthy account on a transient Apple error would be worse than one stale sweep.
    const premium = playback.lossless ?? true
    return {
      ok: true,
      premium,
      status: classify(true, premium),
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
 * Rotates a Deezer ARL without the contributor. The cookie expires after roughly a day, which is why
 * a pool of submitted ARLs bleeds out. Deezer issues a replacement from a live session in two steps
 * (the flow philippe44/lms-deezer's `refreshArl` re-runs every 24h):
 *
 *   1. `deezer.getUserData` with the current ARL cookie → `SESSION_ID` + `checkForm`
 *   2. `user.getArl` with `api_token=checkForm` and a `sid` cookie → a fresh ARL
 *
 * The new value is persisted. Best-effort throughout: a failure here must never turn a working
 * account into a dead one.
 */
async function rotateDeezerArl(
  payload: Record<string, unknown>,
  entryFingerprint?: string,
  deadline?: AbortSignal,
): Promise<{ arl: string | null; detail: string }> {
  const base = "https://www.deezer.com/ajax/gw-light.php"

  // Same single-flight as the token refreshers: two concurrent checks must not both run the
  // two-step rotation — the loser ARL is dead the moment the winner writes. No wait needed
  // here: rotation only runs after a check that already passed, so the loser keeps its valid
  // ARL and simply skips its own rotation. The claimed payload's ARL is the one to rotate —
  // the caller's snapshot may already be the loser's dead value.
  const claimed = entryFingerprint ? await claimRefresh(entryFingerprint) : null
  if (entryFingerprint && !claimed) return { arl: null, detail: "rotation in flight elsewhere" }
  const current = claimed?.payload ?? payload
  const arl = String(current.arl ?? "").trim()
  const finish = (outcome: Parameters<typeof finishRefresh>[2] = {}) =>
    entryFingerprint && claimed ? finishRefresh(entryFingerprint, claimed.claim, outcome) : Promise.resolve()

  try {
    const userRes = await timedFetch(
      `${base}?method=deezer.getUserData&input=3&api_version=1.0&api_token=`,
      { headers: { cookie: `arl=${arl}`, "user-agent": DEEZER_UA } },
      deadline,
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
      deadline,
    )
    if (!arlRes.res.ok) return { arl: null, detail: `getArl HTTP ${arlRes.res.status}` }
    const arlJson = (await arlRes.res.json().catch(() => null)) as { results?: unknown } | null
    const rotated = String(arlJson?.results ?? "").trim()
    if (!rotated || rotated === arl) return { arl: null, detail: "rotation returned nothing new" }

    if (entryFingerprint) {
      if (claimed) {
        // Persist + release in one guarded UPDATE — a claim that lapsed is not ours to clear.
        await finish({ payload: { ...current, arl: rotated } })
      } else {
        await db
          .update(accountEntries)
          .set({ payload: encryptAtRest({ ...current, arl: rotated }) })
          .where(sql`fingerprint = ${entryFingerprint}`)
          .catch(() => { /* best-effort — a DB hiccup must not fail the health check */ })
      }
    }
    return { arl: rotated, detail: "arl rotated" }
  } finally {
    // Every early return above still holds the claim — release it so losers do not wait out
    // REFRESH_CLAIM_SECS for a rotation that never lands.
    await finish()
  }
}

async function checkDeezerAccount(
  payload: Record<string, unknown>,
  entryFingerprint?: string,
  deadline?: AbortSignal,
): Promise<CheckResult> {
  const arl = String(payload.arl ?? "").trim()
  if (!arl) return { ok: false, premium: false, status: "dead", latencyMs: 0, detail: "missing arl" }

  try {
    const { res, ms } = await timedFetch(
      DEEZER_GATEWAY,
      { headers: { cookie: `arl=${arl}`, "user-agent": DEEZER_UA } },
      deadline,
    )
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

    const rotation = await rotateDeezerArl(payload, entryFingerprint, deadline).catch((e) => ({
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
  deadline?: AbortSignal,
): Promise<CheckResult> {
  // Amazon and Deezer instances publish their own liveness documents, so they are checked
  // against those rather than through the generic reachability rule.
  if (kind === "api" && service === "deezer") return checkDeezerInstance(payload, deadline)
  if (kind === "api" && service === "amazon-music") return checkAmazonMusicInstance(payload, deadline)
  if (kind === "api") return checkApi(service, payload, deadline)
  if (service === "tidal") return checkTidalAccount(payload, entryFingerprint, deadline)
  if (service === "deezer") return checkDeezerAccount(payload, entryFingerprint, deadline)
  if (service === "apple-music") return checkAppleMusicAccount(payload, deadline)
  if (service === "amazon-music") return checkAmazonMusicAccount(payload)
  return checkQobuzAccount(payload, entryFingerprint, deadline)
}

function reason(e: unknown): string {
  if (e instanceof Error) {
    if (e.name === "AbortError") return "timeout"
    return e.message.slice(0, 120)
  }
  return "error"
}
