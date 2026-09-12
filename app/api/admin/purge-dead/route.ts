import { and, eq } from "drizzle-orm"
import { NextResponse, type NextRequest } from "next/server"
import { resolveAdmin } from "@/lib/admin-auth"
import { recordAudit } from "@/lib/audit"
import { db } from "@/lib/db"
import { accountEntries, instanceEntries } from "@/lib/db/schema"
import { ensureSchema } from "@/lib/db/ensure"

export const dynamic = "force-dynamic"

// Bulk-removes every entry whose status is "dead" and hasn't been removed yet, across both
// split tables (account credentials and instance URLs).
export async function POST(req: NextRequest) {
  const actor = await resolveAdmin(req)
  if (!actor) return NextResponse.json({ error: "unauthorized" }, { status: 401 })

  await ensureSchema()
  const accounts = await db
    .select({ id: accountEntries.id })
    .from(accountEntries)
    .where(and(eq(accountEntries.status, "dead"), eq(accountEntries.removed, false)))
  const instances = await db
    .select({ id: instanceEntries.id })
    .from(instanceEntries)
    .where(and(eq(instanceEntries.status, "dead"), eq(instanceEntries.removed, false)))

  const removed = accounts.length + instances.length
  if (removed === 0) {
    return NextResponse.json({ ok: true, removed: 0 })
  }

  await db
    .update(accountEntries)
    .set({ removed: true })
    .where(and(eq(accountEntries.status, "dead"), eq(accountEntries.removed, false)))
  await db
    .update(instanceEntries)
    .set({ removed: true })
    .where(and(eq(instanceEntries.status, "dead"), eq(instanceEntries.removed, false)))

  await recordAudit(req, actor, "entry.purge_dead", "entries", {
    removed,
    accountIds: accounts.map((r) => r.id),
    instanceIds: instances.map((r) => r.id),
  })
  return NextResponse.json({ ok: true, removed })
}
