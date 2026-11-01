// SPDX-License-Identifier: GPL-3.0-or-later
import { and, eq, or, sql } from "drizzle-orm"
import { NextResponse, type NextRequest } from "next/server"
import { isCronAuthorized } from "@/lib/admin-auth"
import { recordAudit } from "@/lib/audit"
import { db } from "@/lib/db"
import { accountEntries, instanceEntries } from "@/lib/db/schema"
import { ensureSchema } from "@/lib/db/ensure"
import { writeInstanceSnapshot } from "@/lib/edge-snapshot"
import { invalidate } from "@/lib/ttl-cache"

export const dynamic = "force-dynamic"
export const maxDuration = 60

// How long an entry must have been unservable before the purge takes it, on both axes: the row
// itself must be at least this old, and it must have logged NO servable check (ok && premium)
// inside the window. An entry that failed every probe for a week is not coming back on its own,
// but one that went dead yesterday still gets the sweeps to prove it — a flapping upstream must
// not empty the pool the way bulk-purging every `dead` row would.
const GRACE_DAYS = 7

// health_log has no kind column because entry ids are globally unique across both entry tables
// (shared source_entry_id_seq), so one NOT EXISTS subquery works unchanged for each table.
const eligible = (table: typeof accountEntries | typeof instanceEntries) =>
  and(
    eq(table.removed, false),
    or(eq(table.status, "dead"), eq(table.disabled, true)),
    sql`${table.createdAt} < now() - make_interval(days => ${GRACE_DAYS})`,
    sql`not exists (
          select 1 from health_log hl
          where hl.entry_id = ${table.id}
            and hl.ok and hl.premium
            and hl.checked_at > now() - make_interval(days => ${GRACE_DAYS})
        )`,
  )

// Scheduled counterpart of POST /api/admin/purge-dead: same soft-remove (removed = true keeps
// the audit trail and history), but scoped to entries that have been dead or disabled — and
// stayed that way — for at least GRACE_DAYS. Idempotent by construction: the UPDATE's WHERE is
// the eligibility predicate, so a second run in the same window simply matches nothing, and the
// audit row plus response both report real counts.
export async function GET(req: NextRequest) {
  if (!isCronAuthorized(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 })

  await ensureSchema()
  const accounts = await db
    .update(accountEntries)
    .set({ removed: true })
    .where(eligible(accountEntries))
    .returning({ id: accountEntries.id })
  const instances = await db
    .update(instanceEntries)
    .set({ removed: true })
    .where(eligible(instanceEntries))
    .returning({ id: instanceEntries.id })

  const removed = accounts.length + instances.length
  if (removed > 0) {
    // Purged entries leave the feeds and the board as of this run, not when TTLs expire.
    invalidate("status")
    invalidate("discovery:")
    if (instances.length > 0) await writeInstanceSnapshot()
    invalidate("snapshot:")
  }

  await recordAudit(req, { userId: null, label: "cron" }, "entry.purge_dead", "entries", {
    removed,
    graceDays: GRACE_DAYS,
    source: "cron",
    accountIds: accounts.map((r) => r.id),
    instanceIds: instances.map((r) => r.id),
  })

  return NextResponse.json({
    ok: true,
    removed,
    removedAccounts: accounts.length,
    removedInstances: instances.length,
    graceDays: GRACE_DAYS,
    ranAt: new Date().toISOString(),
  })
}
