// SPDX-License-Identifier: GPL-3.0-or-later
import { NextResponse, type NextRequest } from "next/server"
import { identifyReadKey, readKeyFromRequest } from "@/lib/api-keys"
import { clientEncryptionEnabled, deriveClientKey } from "@/lib/crypto"
import { leaseAccounts } from "@/lib/queries"
import {
  clientIp,
  clientKeyBucket,
  keyFleetLimit,
  keyId,
  rateLimit,
  tooManyRequests,
} from "@/lib/rate-limit"

export const dynamic = "force-dynamic"

// Rate limits (defence against scripted abuse; the app itself fetches once per 15–24h):
//  - per IP, before auth: 120/min — bounds key-guessing against the constant-time compare and
//    DB lookups, without punishing users behind shared NAT. On Workers this used to be one
//    global "unknown" bucket; see lib/request-ip.ts.
//  - per client, after auth: 60 per 5 min on key + address. A build bakes ONE read key into
//    every install, so keying on the key alone (the old 30/5 min) made the ~90th install in a
//    window rate-limit the whole fleet. Leases are sticky per key for 72h, so this still
//    bounds a leaked key: rotating addresses cannot reshuffle its credential set.
//  - per key total: OFF by default. A low fleet-wide cap is exactly the global 429 this fixes.
//    Set POOL_KEY_FLEET_LIMIT only for a generous tripwire (see lib/rate-limit.ts).
const IP_LIMIT = 120
const IP_WINDOW_MS = 60_000
const KEY_LIMIT = 60
const KEY_WINDOW_MS = 5 * 60_000

/**
 * ACCOUNT-CREDENTIALS-ONLY feed. This is the token half of the split pool:
 *  - /api/accounts  → this route. Account tokens/ARLs only. Never contains instance URLs.
 *  - /api/instances/[service] → instance base URLs only. Never contains credentials.
 *
 * Reading ALWAYS requires a valid per-app read key — the credential feed is never public, no
 * env toggle. Keys are created by user accounts on /dashboard (or admin-created for legacy CI
 * builds); the app presents one as Bearer. Response shape matches the `accounts` half of the
 * legacy /api/sources feed, so the same client parser handles both.
 *
 * One-secret design (X-Pool-Client: v2): the response's sensitive fields are encrypted with a
 * key DERIVED from the read key the requester presented (sha256("archivepool-client:" + key)).
 * A v2 client therefore needs ONLY its read key — no POOL_CLIENT_KEY baked into the APK has to
 * match this deployment. Legacy clients (no header) keep receiving POOL_CLIENT_KEY ciphertext
 * and are refused with 503 when that static key is not configured on the server.
 */
export async function GET(req: NextRequest) {
  const ip = clientIp(req.headers)
  const ipVerdict = rateLimit(`feed-ip:${ip}`, IP_LIMIT, IP_WINDOW_MS)
  if (!ipVerdict.ok) return tooManyRequests(ipVerdict.retryAfterSec, "feed")

  const v2 = req.headers.get("x-pool-client")?.trim().toLowerCase() === "v2"
  if (!v2 && !clientEncryptionEnabled()) {
    // Account credentials must never fall back to a plaintext response when client encryption
    // is off — for legacy clients. v2 clients always get derived-key ciphertext (their read key
    // was verified below), so the gate does not apply to them.
    return NextResponse.json(
      { error: "security_not_configured", detail: "Credential delivery is unavailable." },
      { status: 503, headers: { "cache-control": "private, no-store", "retry-after": "60" } },
    )
  }

  // ALWAYS enforced: the credential feed is never public. Request a key with an
  // account on the site (/dashboard); the app presents it as a Bearer token. identifyReadKey
  // also resolves the key's row id in the same lookup, so its per-key lease window can stay
  // sticky across requests instead of reshuffling every fetch — see leaseAccounts.
  const identity = await identifyReadKey(req, true)
  if (!identity.ok) {
    return NextResponse.json(
      { error: "unauthorized", detail: "A valid API key is required to read the source pool. Create an account and request one on the site." },
      { status: 401, headers: { "cache-control": "private, no-store" } },
    )
  }

  const readKey = readKeyFromRequest(req)
  if (readKey) {
    const id = keyId(readKey)
    // One client's budget: a shared build key must not turn one busy install (or its retry
    // loop) into a fleet-wide 429.
    const clientVerdict = rateLimit(clientKeyBucket("feed-key", id, ip), KEY_LIMIT, KEY_WINDOW_MS)
    if (!clientVerdict.ok) return tooManyRequests(clientVerdict.retryAfterSec, "feed")
    // Opt-in fleet tripwire; disabled unless the deployment sets a generous value.
    const fleetLimit = keyFleetLimit()
    if (fleetLimit > 0) {
      const fleetVerdict = rateLimit(`feed-key-total:${id}`, fleetLimit, KEY_WINDOW_MS)
      if (!fleetVerdict.ok) return tooManyRequests(fleetVerdict.retryAfterSec, "feed")
    }
  }

  // Leases a few accounts per service rather than returning the whole pool, so a leaked key
  // (or a baked-in build key) exposes a handful of credentials instead of every one we hold.
  // See LEASE_PER_CATEGORY_ACCOUNT for why this is not 1. `identity.scope` narrows a scoped key
  // to its one service — the other groups come back empty, keeping the response shape intact.
  const clientKey = v2 && readKey ? deriveClientKey(readKey) : null
  const { accounts } = await leaseAccounts(clientKey, identity.keyId, identity.scope)
  return NextResponse.json(
    {
      version: 2,
      generatedAt: new Date().toISOString(),
      // When true, sensitive fields (token/appId/…) are AES-256-GCM ciphertext in the
      // `enc:1:<iv>:<ct+tag>` format. `encryption` says which key protects them:
      //  - "read-key"  → sha256("archivepool-client:" + the read key you presented)
      //  - "client-key"→ the deployment's static POOL_CLIENT_KEY (legacy clients only)
      encrypted: true,
      encryption: v2 ? "read-key" : "client-key",
      // Same per-service { accounts: [...] } shape as the legacy /api/sources feed's account
      // half, so the app's existing parser handles both feeds unchanged.
      tidal: { accounts: accounts.tidal },
      qobuz: { accounts: accounts.qobuz },
      deezer: { accounts: accounts.deezer },
      "apple-music": { accounts: accounts["apple-music"] },
      "amazon-music": { accounts: accounts["amazon-music"] },
    },
    {
      headers: {
        // Private: responses are per-key, so do not let shared caches store them.
        "cache-control": "private, no-store",
        "access-control-allow-origin": "*",
      },
    },
  )
}
