import { eq } from "drizzle-orm"
import { NextResponse, type NextRequest } from "next/server"
import { resolveAdmin } from "@/lib/admin-auth"
import { decryptAtRest } from "@/lib/crypto"
import { db } from "@/lib/db"
import { accountEntries } from "@/lib/db/schema"
import { ensureSchema } from "@/lib/db/ensure"

export const dynamic = "force-dynamic"

// TEMPORARY DEBUG: returns one decrypted Tidal access token for live resolve testing.
// Admin-token gated. DELETE THIS FILE after the test.
export async function POST(req: NextRequest) {
  const actor = await resolveAdmin(req)
  if (!actor) return NextResponse.json({ error: "unauthorized" }, { status: 401 })
  let body: { id?: number }
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: "invalid body" }, { status: 400 })
  }
  if (typeof body.id !== "number") return NextResponse.json({ error: "id required" }, { status: 400 })
  await ensureSchema()
  const [row] = await db.select().from(accountEntries).where(eq(accountEntries.id, body.id)).limit(1)
  if (!row) return NextResponse.json({ error: "not found" }, { status: 404 })
  const plain = decryptAtRest(row.payload as Record<string, unknown>)
  const token = String((plain as Record<string, unknown>).token ?? "")
  const refresh = String((plain as Record<string, unknown>).refreshToken ?? "")
  return NextResponse.json({ ok: true, id: row.id, service: row.service, tokenPrefix: token.slice(0, 12), token, hasRefresh: refresh.length > 0 })
}
