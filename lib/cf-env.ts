// SPDX-License-Identifier: GPL-3.0-or-later
import "server-only"
import { getCloudflareContext } from "@opennextjs/cloudflare"

/**
 * Access to Cloudflare Workers bindings (Hyperdrive, R2, …) when the app runs on
 * Workers through @opennextjs/cloudflare.
 *
 * Plain `process.env` needs no help: the OpenNext wrapper copies every string-typed
 * binding (vars and secrets) into `process.env` at the start of each request, so all
 * existing env reads keep working on Workers unchanged. Only OBJECT bindings need
 * this module — they cannot be stringified, so they are read off the context env
 * instead.
 *
 * Every helper fails soft off-Workers (Vercel, Railway, plain `next dev`): the
 * context is absent there and the caller falls back to its process.env-based
 * behaviour, exactly as before this file existed.
 */

type Bindings = Record<string, unknown>

function context(): { env: Bindings; ctx: unknown } | null {
  try {
    const full = getCloudflareContext({ async: false }) as unknown as {
      env?: Bindings
      ctx?: unknown
    } | null
    if (!full?.env) return null
    return { env: full.env, ctx: full.ctx }
  } catch {
    return null
  }
}

/**
 * The worker's binding map (`env`), or null when not running under Cloudflare —
 * including module scope, which evaluates at cold start before the first request
 * has established a context. Call only inside request/server-action handling.
 */
export function cfBindings(): Bindings | null {
  return context()?.env ?? null
}

/**
 * The request's ExecutionContext — unique per request on Workers. It doubles as a
 * lifetime key: the runtime cancels JS-created sockets when a request completes,
 * so anything holding a live socket (a pg pool) must never outlive this object.
 * Null off-Workers.
 */
export function cfExecutionContext(): object | null {
  const ctx = context()?.ctx
  return ctx && typeof ctx === "object" ? ctx : null
}

/**
 * Schedule [work] to outlive the response on Workers (`ctx.waitUntil`); a no-op
 * everywhere else, where a bare floating promise survives on the warm instance.
 * Use for best-effort writes (telemetry bumps) that Workers would otherwise drop
 * when the response completes.
 */
/**
 * True when web login/signup must refuse to run: on Workers the free-tier CPU budget
 * (~10 ms) cannot run the scrypt password hash (N=16384, ~30-80 ms), so those routes
 * fail fast with 503 web_login_unavailable instead of timing out mid-hash. Set the
 * CF_WEB_LOGIN_ENABLED var to "true" to re-enable, e.g. on a paid plan where the CPU
 * budget is minutes. Off Workers this is always false — scrypt runs normally and is
 * never weakened.
 */
export function webLoginDisabled(): boolean {
  return cfBindings() != null && process.env.CF_WEB_LOGIN_ENABLED !== "true"
}

/**
 * Thrown when a request is about to spend one fetch past its outbound-subrequest
 * budget. It is a control-flow signal, not a verdict: check helpers that swallow it
 * inside their own error handling return an unreliable result, which callers (the
 * sweep) must detect via fetchBudgetExceeded() rather than persist.
 */
export class FetchBudgetExhausted extends Error {
  constructor() {
    super("outbound fetch budget exhausted for this request")
    this.name = "FetchBudgetExhausted"
  }
}

// Per-request spend, keyed on the ExecutionContext — the same lifetime key the pg pool
// uses, so every request gets its own budget. Workers free tier allows 50 subrequests
// per request; 40 leaves headroom for the route's own fetches (feed pulls, R2, retries).
const FETCH_BUDGET = 40
const fetchSpend = new WeakMap<object, number>()

/**
 * Charge one outbound fetch to the current request's budget, throwing
 * FetchBudgetExhausted once the next fetch would cross it. A no-op off Workers —
 * and anywhere a request context is absent — so callers can charge unconditionally
 * before every fetch.
 */
export function chargeFetch(): void {
  const ctx = cfExecutionContext()
  if (ctx == null) return
  const used = fetchSpend.get(ctx) ?? 0
  if (used >= FETCH_BUDGET) throw new FetchBudgetExhausted()
  fetchSpend.set(ctx, used + 1)
}

/**
 * True once this request's fetch budget is spent. A check whose declining chargeFetch
 * was flattened into a result by its own catch still returns — callers must treat any
 * verdict produced after this point as unreliable rather than persist it.
 */
export function fetchBudgetExceeded(): boolean {
  const ctx = cfExecutionContext()
  return ctx != null && (fetchSpend.get(ctx) ?? 0) >= FETCH_BUDGET
}

const MAX_REDIRECT_HOPS = 5
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308])

/**
 * fetch() with the per-request subrequest budget applied — including redirects.
 * Cloudflare counts every redirect hop as its own subrequest, so redirects are
 * followed manually (redirect: "manual", ≤5 hops) and each hop is charged instead
 * of hiding followers inside a single call. Method rules follow the fetch spec:
 * 303 always rewrites to GET (body dropped); 301/302 rewrite non-GET/HEAD to GET;
 * 307/308 preserve method and body. Everything else — signal, headers, cache — is
 * passed through untouched, so every check-path call site can swap to this wrapper
 * verbatim.
 */
export async function budgetedFetch(url: string, init?: RequestInit): Promise<Response> {
  let current = url
  let method = (init?.method ?? "GET").toUpperCase()
  let body = init?.body ?? null
  for (let hop = 0; ; hop++) {
    chargeFetch()
    const res = await fetch(current, { ...init, method, body, redirect: "manual" })
    if (!REDIRECT_STATUSES.has(res.status) || hop >= MAX_REDIRECT_HOPS) return res
    const location = res.headers.get("location")
    if (!location) return res
    try {
      await res.body?.cancel()
    } catch {
      /* best-effort body discard before the next hop */
    }
    current = new URL(location, current).toString()
    if (
      res.status === 303 ||
      ((res.status === 301 || res.status === 302) && method !== "GET" && method !== "HEAD")
    ) {
      method = "GET"
      body = null
    }
  }
}

export function cfWaitUntil(work: Promise<unknown>): void {
  try {
    const full = getCloudflareContext({ async: false }) as unknown as {
      ctx?: { waitUntil(p: Promise<unknown>): void }
    }
    full?.ctx?.waitUntil(work)
  } catch {
    // Not on Workers — the floating promise completes on the warm instance, as before.
  }
}
