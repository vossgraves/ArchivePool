// SPDX-License-Identifier: GPL-3.0-or-later
import "server-only"

import { cfBindings } from "@/lib/cf-env"

/**
 * Which HTTP stack is serving this isolate. On Workers `cfBindings()` is non-null inside a
 * request; off Workers (Vercel, Railway, `next dev`) there is no Cloudflare context at all.
 * Cached after the first request so the per-request lookup is paid once per isolate.
 */
let workersRuntime: boolean | null = null

function onWorkers(): boolean {
  if (workersRuntime == null) workersRuntime = cfBindings() != null
  return workersRuntime
}

/**
 * Best-effort client address.
 *
 * Cloudflare Workers put the real peer in `cf-connecting-ip`. They do NOT add
 * `x-forwarded-for` to a Worker request — that header is added when a request goes to an
 * origin, and a client can set it itself. Reading only XFF on Workers therefore answered
 * "unknown" for every caller and collapsed every per-IP limiter into one global bucket: one
 * busy client (or one retry loop) could spend the whole fleet's allowance. That is the bug
 * this module exists to prevent.
 *
 * On hosts that terminate the request themselves (Vercel, Railway) XFF is platform-set and
 * stays the primary source. `x-real-ip` is the nginx-style fallback. `cf-connecting-ip` is
 * only trusted on Workers: on Vercel a client could send it, and trusting it there would let
 * a caller mint a fresh limiter bucket per request.
 *
 * "unknown" is returned when nothing is present, and callers treat it as one shared bucket —
 * never as an empty string that disables the limit.
 */
export function clientIp(req: Headers): string {
  const ip = onWorkers()
    ? req.get("cf-connecting-ip")?.trim() || "unknown"
    : req.get("x-forwarded-for")?.split(",")[0]?.trim() || req.get("x-real-ip")?.trim() || "unknown"
  return ip.slice(0, 64)
}
