import { eq } from "drizzle-orm"
import { NextResponse, type NextRequest } from "next/server"
import { resolveAdmin } from "@/lib/admin-auth"
import { decryptAtRest } from "@/lib/crypto"
import { db } from "@/lib/db"
import { accountEntries, instanceEntries } from "@/lib/db/schema"
import { ensureSchema } from "@/lib/db/ensure"

export const dynamic = "force-dynamic"

// TEMPORARY DEBUG: returns a decrypted account payload for live protocol testing.
// Admin-token gated. REMOVE AFTER TESTING.
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
  const [a] = await db.select().from(accountEntries).where(eq(accountEntries.id, body.id)).limit(1)
  if (a) {
    return NextResponse.json({ ok: true, id: a.id, kind: "account", service: a.service, payload: decryptAtRest(a.payload) })
  }
  const [i] = await db.select().from(instanceEntries).where(eq(instanceEntries.id, body.id)).limit(1)
  if (i) {
    return NextResponse.json({ ok: true, id: i.id, kind: "api", service: i.service, payload: decryptAtRest(i.payload) })
  }
  return NextResponse.json({ error: "not found" }, { status: 404 })
}
