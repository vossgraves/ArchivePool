import { NextResponse, type NextRequest } from "next/server"
import { verifyReadKey } from "@/lib/api-keys"
import { clientEncryptionEnabled } from "@/lib/crypto"
import { getAlivePool } from "@/lib/queries"

export const dynamic = "force-dynamic"

// Sensitive pool consumed by apps. Reading requires a valid per-app key when
// READ_KEYS_ENFORCED=true (send it as `Authorization: Bearer <key>`, `x-api-key`,
// or `?key=`). The public status page never hits this route.
export async function GET(req: NextRequest) {
  if (!(await verifyReadKey(req))) {
    return NextResponse.json(
      { error: "unauthorized", detail: "A valid API key is required to read the source pool." },
      { status: 401 },
    )
  }

  const pool = await getAlivePool()
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
