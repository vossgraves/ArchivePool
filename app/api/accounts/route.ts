import { NextResponse, type NextRequest } from "next/server"
import { verifyReadKey } from "@/lib/api-keys"
import { clientEncryptionEnabled } from "@/lib/crypto"
import { leaseAccounts } from "@/lib/queries"

export const dynamic = "force-dynamic"

/**
 * ACCOUNT-CREDENTIALS-ONLY feed. This is the token half of the split pool:
 *  - /api/accounts  → this route. Account tokens/ARLs only. Never contains instance URLs.
 *  - /api/instances/[service] → instance base URLs only. Never contains credentials.
 *
 * Reading ALWAYS requires a valid per-app read key — the credential feed is never public, no
 * env toggle. Keys are created by user accounts on /dashboard (or admin-created for legacy CI
 * builds); the app presents one as Bearer. Response shape matches the `accounts` half of the
 * legacy /api/sources feed, so the same client parser handles both.
 */
export async function GET(req: NextRequest) {
  // Account credentials must never fall back to a plaintext response when client encryption is off.
  if (!clientEncryptionEnabled()) {
    return NextResponse.json(
      { error: "security_not_configured", detail: "Credential delivery is unavailable." },
      { status: 503, headers: { "cache-control": "private, no-store" } },
    )
  }

  // ALWAYS enforced: the credential feed is never public. Request a key with an
  // account on the site (/dashboard); the app presents it as a Bearer token.
  if (!(await verifyReadKey(req, true))) {
    return NextResponse.json(
      { error: "unauthorized", detail: "A valid API key is required to read the source pool. Create an account and request one on the site." },
      { status: 401, headers: { "cache-control": "private, no-store" } },
    )
  }

  // Leases a few accounts per service rather than returning the whole pool, so a leaked key
  // (or the POOL_CLIENT_KEY baked into the APK) exposes a handful of credentials instead of
  // every one we hold. See LEASE_PER_CATEGORY_ACCOUNT for why this is not 1.
  const { accounts } = await leaseAccounts()
  return NextResponse.json(
    {
      version: 2,
      generatedAt: new Date().toISOString(),
      // When true, sensitive fields (token/appId/…) are AES-256-GCM ciphertext in the
      // `enc:1:<iv>:<ct+tag>` format and must be decrypted with POOL_CLIENT_KEY.
      encrypted: clientEncryptionEnabled(),
      ...accounts,
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
