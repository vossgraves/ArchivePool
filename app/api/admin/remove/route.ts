import { eq } from "drizzle-orm"
import { NextResponse, type NextRequest } from "next/server"
import { db } from "@/lib/db"
import { sourceEntries } from "@/lib/db/schema"

export const dynamic = "force-dynamic"

function authorized(req: NextRequest): boolean {
  const adminToken = process.env.ADMIN_TOKEN
  if (!adminToken) return false
  return req.headers.get("authorization") === `Bearer ${adminToken}`
}

// Owner-only hard removal / re-instatement of a contributed entry.
export async function POST(req: NextRequest) {
  if (!authorized(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 })

  let body: { id?: number; action?: "remove" | "restore" }
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: "invalid body" }, { status: 400 })
  }

  if (!body.id) return NextResponse.json({ error: "id required" }, { status: 400 })
  const removed = body.action !== "restore"

  await db.update(sourceEntries).set({ removed }).where(eq(sourceEntries.id, body.id))
  return NextResponse.json({ ok: true, id: body.id, removed })
}

// List everything including removed entries, for owner moderation tooling.
export async function GET(req: NextRequest) {
  if (!authorized(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 })
  const rows = await db.select().from(sourceEntries)
  return NextResponse.json({
    count: rows.length,
    entries: rows.map((r) => ({
      id: r.id,
      service: r.service,
      kind: r.kind,
      label: r.label,
      status: r.status,
      premium: r.premium,
      disabled: r.disabled,
      removed: r.removed,
      consecutiveFailures: r.consecutiveFailures,
      lastCheckedAt: r.lastCheckedAt,
    })),
  })
}
