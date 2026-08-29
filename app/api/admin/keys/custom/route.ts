import { NextResponse, type NextRequest } from "next/server"
import { isAdminAuthorized as authorized } from "@/lib/admin-auth"
import { createApiKeyWithValue } from "@/lib/api-keys"

export const dynamic = "force-dynamic"

/**
 * Admin: create a read key with a KNOWN value.
 *
 * Normally keys are random (generateKey) and the plaintext is shown once. After a database
 * loss, however, every stored hash is gone while apps keep presenting the key baked into
 * their builds — this endpoint lets the operator re-seed a key whose value matches the
 * deployment's SOURCE_PROVIDER_KEY secret instead of rebuilding every client.
 */
export async function POST(req: NextRequest) {
  if (!authorized(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 })

  let body: { name?: string; value?: string }
  try {
    body = await req.json()
  } catch {
    body = {}
  }
  const name = (body.name ?? "restored").trim().slice(0, 64) || "restored"
  const value = (body.value ?? "").trim()

  if (!/^atp_[A-Za-z0-9]{24,}$/.test(value)) {
    return NextResponse.json(
      {
        error: "invalid_value",
        detail: "Key must start with 'atp_' followed by at least 24 alphanumeric characters.",
      },
      { status: 400 },
    )
  }

  const created = await createApiKeyWithValue(name, value)
  if (!created) {
    return NextResponse.json(
      { error: "exists", detail: "A key with this value already exists." },
      { status: 409 },
    )
  }
  return NextResponse.json({ id: created.id, prefix: created.prefix })
}
