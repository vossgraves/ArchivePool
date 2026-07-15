import { NextResponse, type NextRequest } from "next/server"
import { createApiKey, listApiKeys, setKeyRevoked } from "@/lib/api-keys"

export const dynamic = "force-dynamic"

function authorized(req: NextRequest): boolean {
  const adminToken = process.env.ADMIN_TOKEN
  if (!adminToken) return false
  return req.headers.get("authorization") === `Bearer ${adminToken}`
}

// List all keys (no hashes / plaintext ever returned).
export async function GET(req: NextRequest) {
  if (!authorized(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 })
  const keys = await listApiKeys()
  return NextResponse.json({ keys })
}

// Create a new key. The plaintext is returned exactly once here.
export async function POST(req: NextRequest) {
  if (!authorized(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 })

  let body: { name?: string }
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: "invalid body" }, { status: 400 })
  }

  const name = body.name?.trim()
  if (!name) return NextResponse.json({ error: "name required" }, { status: 400 })

  const created = await createApiKey(name)
  return NextResponse.json({ ok: true, ...created })
}

// Revoke or restore a key: { id, revoked }.
export async function PATCH(req: NextRequest) {
  if (!authorized(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 })

  let body: { id?: number; revoked?: boolean }
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: "invalid body" }, { status: 400 })
  }

  if (!body.id) return NextResponse.json({ error: "id required" }, { status: 400 })
  await setKeyRevoked(body.id, body.revoked !== false)
  return NextResponse.json({ ok: true, id: body.id, revoked: body.revoked !== false })
}
