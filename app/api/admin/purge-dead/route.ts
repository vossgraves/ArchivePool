import { and, eq } from "drizzle-orm"
import { NextResponse, type NextRequest } from "next/server"
import { db } from "@/lib/db"
import { sourceEntries } from "@/lib/db/schema"

export const dynamic = "force-dynamic"

function authorized(req: NextRequest): boolean {
  const adminToken = process.env.ADMIN_TOKEN
  if (!adminToken) return false
  return req.headers.get("authorization") === `Bearer ${adminToken}`
}

// Bulk-removes every entry whose status is "dead" and hasn't been removed yet.
export async function POST(req: NextRequest) {
  if (!authorized(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 })

  const rows = await db
    .select({ id: sourceEntries.id })
    .from(sourceEntries)
    .where(and(eq(sourceEntries.status, "dead"), eq(sourceEntries.removed, false)))

  if (rows.length === 0) {
    return NextResponse.json({ ok: true, removed: 0 })
  }

  await db
    .update(sourceEntries)
    .set({ removed: true })
    .where(and(eq(sourceEntries.status, "dead"), eq(sourceEntries.removed, false)))

  return NextResponse.json({ ok: true, removed: rows.length })
}
