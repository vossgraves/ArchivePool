// SPDX-License-Identifier: GPL-3.0-or-later
import { NextResponse, type NextRequest } from "next/server"
import { identifyReadKey, readKeyFromRequest } from "@/lib/api-keys"
import { clientEncryptionEnabled, deriveClientKey } from "@/lib/crypto"
import { leasePool } from "@/lib/queries"
import {
  clientIp,
  clientKeyBucket,
  keyFleetLimit,
  keyId,
  rateLimit,
  tooManyRequests,
} from "@/lib/rate-limit"

export const dynamic = "force-dynamic"

// Same posture as /api/accounts: per-IP before auth (bounds key guessing), per client after
// auth (bounds one install's loop), and an opt-in per-key total. See that route for why the
// bucket is key + address rather than the key alone.
const IP_LIMIT = 120
const IP_WINDOW_MS = 60_000
const KEY_LIMIT = 60
const KEY_WINDOW_MS = 5 * 60_000

/**
 * LEGACY combined pool feed. Kept byte-compatible for app builds predating the account/instance
 * split — it returns both `apis` (instance URLs) and `accounts` (credentials) per service, from
 * the now-separate account_entries / instance_entries tables.
 *
 * New clients should consume the split feeds instead:
 *  - /api/accounts             → account credentials only (tokens/ARLs)
 *  - /api/instances/[service]  → instance base URLs only
 *
 * Reading ALWAYS requires a valid per-app read key — the credential feed is never public, no
 * env toggle. Keys are created by user accounts on /dashboard (or admin-created for legacy CI
 * builds); the app presents one as a Bearer token.
 *
 * One-secret design (X-Pool-Client: v2): sensitive fields are encrypted with a key derived from
 * the presented read key, so a v2 client needs ONLY that key. Legacy clients (no header) keep
 * receiving POOL_CLIENT_KEY ciphertext.
 */
export async function GET(req: NextRequest) {
  const ip = clientIp(req.headers)
  const ipVerdict = rateLimit(`feed-ip:${ip}`, IP_LIMIT, IP_WINDOW_MS)
  if (!ipVerdict.ok) return tooManyRequests(ipVerdict.retryAfterSec, "feed")

  const v2 = req.headers.get("x-pool-client")?.trim().toLowerCase() === "v2"
  if (!v2 && !clientEncryptionEnabled()) {
    return NextResponse.json(
      { error: "security_not_configured", detail: "Credential delivery is unavailable." },
      { status: 503, headers: { "cache-control": "private, no-store", "retry-after": "60" } },
    )
  }

  // ALWAYS enforced: the credential feed is never public. Request a key with an
  // account on the site (/dashboard); the app presents it as a Bearer token. identifyReadKey
  // also resolves the key's row id, so the account half of this feed can use the same sticky
  // per-key lease window as /api/accounts — see leaseAccounts.
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
    const clientVerdict = rateLimit(clientKeyBucket("feed-key", id, ip), KEY_LIMIT, KEY_WINDOW_MS)
    if (!clientVerdict.ok) return tooManyRequests(clientVerdict.retryAfterSec, "feed")
    const fleetLimit = keyFleetLimit()
    if (fleetLimit > 0) {
      const fleetVerdict = rateLimit(`feed-key-total:${id}`, fleetLimit, KEY_WINDOW_MS)
      if (!fleetVerdict.ok) return tooManyRequests(fleetVerdict.retryAfterSec, "feed")
    }
  }

  // Leases a few entries per category rather than returning the whole pool, so a leaked key
  // (or a baked-in build key) exposes a handful of credentials instead of every one we hold.
  // See LEASE_PER_CATEGORY_ACCOUNT for why this is not 1. `identity.scope` narrows a scoped key
  // to its one service; the other services stay present in the response as empty `{ apis, accounts }`
  // pairs, so the legacy shape is byte-compatible.
  const clientKey = v2 && readKey ? deriveClientKey(readKey) : null
  const { pool } = await leasePool(clientKey, identity.keyId, identity.scope)
  return NextResponse.json(
    {
      version: 1,
      generatedAt: new Date().toISOString(),
      // When true, sensitive fields (token/appId/…) are AES-256-GCM ciphertext in the
      // `enc:1:<iv>:<ct+tag>` format. `encryption` says which key protects them — see
      // /api/accounts for the two schemes.
      encrypted: true,
      encryption: v2 ? "read-key" : "client-key",
      // The split feeds that replace this combined response.
      accountsFeed: "/api/accounts",
      instancesFeed: "/api/instances/{service}",
      ...pool,
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
