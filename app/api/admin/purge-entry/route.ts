import { and, eq } from "drizzle-orm"
import { NextResponse, type NextRequest } from "next/server"
import { resolveAdmin } from "@/lib/admin-auth"
import { recordAudit } from "@/lib/audit"
import { db } from "@/lib/db"
import { accountEntries, instanceEntries } from "@/lib/db/schema"
import { ensureSchema } from "@/lib/db/ensure"

export const dynamic = "force-dynamic"

// Destroys the stored credentials of entries already out of rotation. A soft-removed entry is never
// leased, but its payload (the contributor's token and, for password sign-in, their password) would
// otherwise stay in the database indefinitely.
//
//   mode "payload": blank the payload, keep the row so the Removed tab still lists it (default)
//   mode "row":     delete the row; api_key_leases cascades, health_log is FK-less history that is
//                   trimmed after 30 days anyway
//
// Irreversible by design.
export async function POST(req: NextRequest) {
  const actor = await resolveAdmin(req)
  if (!actor) return NextResponse.json({ error: "unauthorized" }, { status: 401 })

  let body: { id?: number; mode?: "payload" | "row" }
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: "invalid body" }, { status: 400 })
  }
  const id = body.id
  if (typeof id !== "number" || !Number.isInteger(id)) {
    return NextResponse.json({ error: "id required" }, { status: 400 })
  }
  const mode = body.mode === "row" ? "row" : "payload"

  await ensureSchema()

  // Ids come from one sequence, so a match by id can only ever hit one row.
  const [account] = await db.select().from(accountEntries).where(eq(accountEntries.id, id)).limit(1)
  const table = account ? accountEntries : instanceEntries
  const row = account ?? (await db.select().from(instanceEntries).where(eq(instanceEntries.id, id)).limit(1))[0]
  if (!row) return NextResponse.json({ error: "not found" }, { status: 404 })

  // A credential still in rotation would break playback rather than be cleaned up.
  if (!row.removed) {
    return NextResponse.json(
      { error: "entry is not removed; remove it before purging its payload" },
      { status: 409 },
    )
  }

  if (mode === "row") {
    await db.delete(table).where(eq(table.id, id))
    await recordAudit(req, actor, "entry.purge", `entry:${id}`, { mode })
    return NextResponse.json({ ok: true, id, mode, deleted: true })
  }

  await db
    .update(table)
    .set({ payload: {} })
    .where(and(eq(table.id, id), eq(table.removed, true)))

  await recordAudit(req, actor, "entry.purge", `entry:${id}`, { mode })
  return NextResponse.json({ ok: true, id, mode, payloadCleared: true })
}
