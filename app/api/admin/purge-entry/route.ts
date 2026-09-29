import { and, eq } from "drizzle-orm"
import { NextResponse, type NextRequest } from "next/server"
import { resolveAdmin } from "@/lib/admin-auth"
import { db } from "@/lib/db"
import { accountEntries, instanceEntries } from "@/lib/db/schema"
import { ensureSchema } from "@/lib/db/ensure"

export const dynamic = "force-dynamic"

// Destroys stored credentials for entries that are already out of rotation.
//
// A soft-removed entry is never leased (accountServableWhere filters removed = false), but its
// payload — the contributor's token, and for password sign-in their actual password — stays in the
// database indefinitely. That is the part worth deleting: the metadata can be kept for the Removed
// tab without keeping the secret.
//
//   mode "payload" — blank the payload, keep the row (default; the Removed tab still lists it)
//   mode "row"    — delete the row outright. api_key_leases cascades with it; health_log rows
//                   are FK-less append-only history and are trimmed after 30 days anyway.
//
// Admin token required. Irreversible by design — that is the point.
export async function POST(req: NextRequest) {
  const actor = await resolveAdmin(req)
  if (!actor) return NextResponse.json({ error: "unauthorized" }, { status: 401 })

  let body: { id?: number; mode?: "payload" | "row" }
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: "invalid body" }, { status: 400 })
  }
  if (typeof body.id !== "number") return NextResponse.json({ error: "id required" }, { status: 400 })
  const mode = body.mode === "row" ? "row" : "payload"

  await ensureSchema()

  // Ids are unique across both tables, so a delete matched by id can only ever hit one row.
  const [account] = await db.select().from(accountEntries).where(eq(accountEntries.id, body.id)).limit(1)
  const table = account ? accountEntries : instanceEntries
  const row = account ?? (await db.select().from(instanceEntries).where(eq(instanceEntries.id, body.id)).limit(1))[0]
  if (!row) return NextResponse.json({ error: "not found" }, { status: 404 })

  // Refuse to strip a credential that is still in rotation — that would break playback rather
  // than clean up after it.
  if (!row.removed) {
    return NextResponse.json(
      { error: "entry is not removed; remove it before purging its payload" },
      { status: 409 },
    )
  }

  if (mode === "row") {
    await db.delete(table).where(eq(table.id, body.id))
    return NextResponse.json({ ok: true, id: body.id, mode, deleted: true })
  }

  await db
    .update(table)
    .set({ payload: {} })
    .where(and(eq(table.id, body.id), eq(table.removed, true)))

  return NextResponse.json({ ok: true, id: body.id, mode, payloadCleared: true })
}
