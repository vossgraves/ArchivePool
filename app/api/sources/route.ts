import { NextResponse, type NextRequest } from "next/server"
import { verifyReadKey } from "@/lib/api-keys"
import { clientEncryptionEnabled } from "@/lib/crypto"
import { leasePool } from "@/lib/queries"

export const dynamic = "force-dynamic"

// Sensitive pool consumed by apps. Reading requires a valid per-app key when READ_KEYS_ENFORCED=true.
// When READ_KEYS_ENFORCED is absent or false, the endpoint is open so APKs without a baked-in key
// (Mhsm nightly, 4nx3b dev builds) can still fetch. Flip the env var to true to require keys.
export async function GET(req: NextRequest) {
  // Account credentials must never fall back to a plaintext response when client encryption is off.
  if (!clientEncryptionEnabled()) {
    return NextResponse.json(
      { error: "security_not_configured", detail: "Credential delivery is unavailable." },
      { status: 503, headers: { "cache-control": "private, no-store" } },
    )
  }

  // alwaysEnforce=false: honours the READ_KEYS_ENFORCED env var so the gate can be toggled
  // without a code deploy. Default is open (READ_KEYS_ENFORCED unset or "false").
  if (!(await verifyReadKey(req, false))) {
    return NextResponse.json(
      { error: "unauthorized", detail: "A valid API key is required to read the source pool." },
      { status: 401, headers: { "cache-control": "private, no-store" } },
    )
  }

  // Leases a few entries per category rather than returning the whole pool, so a leaked key
  // (or the POOL_CLIENT_KEY baked into the APK) exposes a handful of credentials instead of
  // every one we hold. See LEASE_PER_CATEGORY for why this is not 1.
  const { pool } = await leasePool()
  return NextResponse.json(
    {
      version: 1,
      generatedAt: new Date().toISOString(),
      // When true, sensitive fields (token/appId/…) are AES-256-GCM ciphertext in the
      // `enc:1:<iv>:<ct+tag>` format and must be decrypted with POOL_CLIENT_KEY.
      encrypted: clientEncryptionEnabled(),
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
