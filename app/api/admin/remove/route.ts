// SPDX-License-Identifier: GPL-3.0-or-later
import { eq } from "drizzle-orm"
import { NextResponse, type NextRequest } from "next/server"
import { resolveAdmin } from "@/lib/admin-auth"
import { recordAudit } from "@/lib/audit"
import { db } from "@/lib/db"
import { accountEntries, instanceEntries } from "@/lib/db/schema"
import { ensureSchema } from "@/lib/db/ensure"

export const dynamic = "force-dynamic"

// Owner-only hard removal / re-institute of a contributed entry. Ids are globally unique across
// account_entries/instance_entries (shared id sequence), so both tables are updated by id and
// exactly one row moves.
export async function POST(req: NextRequest) {
  const actor = await resolveAdmin(req)
  if (!actor) return NextResponse.json({ error: "unauthorized" }, { status: 401 })

  let body: { id?: number; action?: "remove" | "restore" }
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: "invalid body" }, { status: 400 })
  }

  if (!body.id) return NextResponse.json({ error: "id required" }, { status: 400 })
  const removed = body.action !== "restore"

  await ensureSchema()
  await db.update(accountEntries).set({ removed }).where(eq(accountEntries.id, body.id))
  await db.update(instanceEntries).set({ removed }).where(eq(instanceEntries.id, body.id))
  await recordAudit(req, actor, "entry.remove", `entry:${body.id}`, { removed })
  return NextResponse.json({ ok: true, id: body.id, removed })
}

// List everything including removed entries, for owner moderation tooling.
export async function GET(req: NextRequest) {
  const actor = await resolveAdmin(req)
  if (!actor) return NextResponse.json({ error: "unauthorized" }, { status: 401 })

  await ensureSchema()
  const accounts = await db.select().from(accountEntries)
  const instances = await db.select().from(instanceEntries)
  const rows = [
    ...accounts.map((r) => ({ ...r, kind: "account" as const })),
    ...instances.map((r) => ({ ...r, kind: "api" as const })),
  ].sort((a, b) => a.id - b.id)

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
      // Opt-in credit chosen at contribution time (null = anonymous). Display-only: this route is
      // admin-token gated, and the public feeds never carry it.
      contributor: r.contributor,
      consecutiveFailures: r.consecutiveFailures,
      lastCheckedAt: r.lastCheckedAt,
      // Health metrics for the per-source admin tables. `payload` is deliberately never
      // included: it holds the donor credential, and only the masked `label` may leave.
      detail: r.detail,
      latencyMs: r.latencyMs,
      checkCount: r.checkCount,
      okCount: r.okCount,
      createdAt: r.createdAt,
    })),
  })
}
