import { NextResponse, type NextRequest } from "next/server"
import { getSessionUserId } from "@/lib/sessions"
import { createUserApiKey, listUserApiKeys } from "@/lib/api-keys"

export const dynamic = "force-dynamic"

const MAX_KEYS_PER_USER = 10

/** List the signed-in user's API keys (never returns plaintext). */
export async function GET() {
  const userId = await getSessionUserId()
  if (!userId) return NextResponse.json({ error: "unauthorized" }, { status: 401 })
  const keys = await listUserApiKeys(userId)
  return NextResponse.json(
    { keys },
    { headers: { "cache-control": "private, no-store" } },
  )
}

/** Request (create) a new API key. The plaintext is returned exactly once. */
export async function POST(req: NextRequest) {
  const userId = await getSessionUserId()
  if (!userId) return NextResponse.json({ error: "unauthorized" }, { status: 401 })

  let body: { name?: string }
  try {
    body = await req.json()
  } catch {
    body = {}
  }
  const name = (body.name ?? "").trim().slice(0, 64) || "My key"

  const existing = await listUserApiKeys(userId)
  if (existing.filter((k) => !k.revoked).length >= MAX_KEYS_PER_USER) {
    return NextResponse.json(
      { error: "key_limit", detail: `At most ${MAX_KEYS_PER_USER} active keys per account.` },
      { status: 409 },
    )
  }

  const created = await createUserApiKey(userId, name)
  return NextResponse.json(
    {
      id: created.id,
      prefix: created.prefix,
      // Shown ONCE. Only the SHA-256 hash is stored server-side.
      key: created.key,
    },
    { headers: { "cache-control": "private, no-store" } },
  )
}
