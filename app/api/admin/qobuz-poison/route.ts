import { eq } from "drizzle-orm"
import { NextResponse, type NextRequest } from "next/server"
import { resolveAdmin } from "@/lib/admin-auth"
import { decryptAtRest, encryptAtRest } from "@/lib/crypto"
import { db } from "@/lib/db"
import { accountEntries } from "@/lib/db/schema"
import { ensureSchema } from "@/lib/db/ensure"

export const dynamic = "force-dynamic"

// TEMPORARY: poison an entry's token so the health check fails and the auto-renew path runs.
// Reports only WHICH fields the payload holds — never their values. REMOVE AFTER TESTING.
export async function POST(req: NextRequest) {
  const actor = await resolveAdmin(req)
  if (!actor) return NextResponse.json({ error: "unauthorized" }, { status: 401 })
  let body: { id?: number; poison?: boolean }
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: "invalid body" }, { status: 400 })
  }
  if (typeof body.id !== "number") return NextResponse.json({ error: "id required" }, { status: 400 })

  await ensureSchema()
  const [row] = await db.select().from(accountEntries).where(eq(accountEntries.id, body.id)).limit(1)
  if (!row) return NextResponse.json({ error: "not found" }, { status: 404 })
  const plain = decryptAtRest(row.payload)

  if (body.poison === false) return NextResponse.json({ ok: true, mode: "inspect", fields: Object.keys(plain) })

  // Replace the token with a syntactically valid but rejected value; keep everything else.
  const next = { ...plain, token: "poisoned-token-for-auto-renew-test-000000000000" }
  await db.update(accountEntries).set({ payload: encryptAtRest(next) }).where(eq(accountEntries.id, body.id))
  return NextResponse.json({ ok: true, mode: "poisoned", id: row.id, fieldsKept: Object.keys(next) })
}
