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
