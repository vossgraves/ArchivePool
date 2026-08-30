import { NextResponse, type NextRequest } from "next/server"
import { eq, sql } from "drizzle-orm"
import { verifyReadKey } from "@/lib/api-keys"
import { db } from "@/lib/db"
import { accountEntries, healthLog, instanceEntries } from "@/lib/db/schema"
import { ensureSchema } from "@/lib/db/ensure"
import { isKind, isService } from "@/lib/sources"

export const dynamic = "force-dynamic"

// App-reported failures are strong evidence (a real user hit the credential and it failed), but a
// single report can also be noise or a transient hiccup. The health sweep re-verifies from the
// server side anyway, so we only auto-disable a reported entry once several apps agree.
const DISABLE_AFTER_REPORTS = 3

const REPORT_TYPES: Record<string, true> = { dead: true, not_premium: true }

/**
 * Apps report what they observed at playback time. The pool records it and lets the sweep be the
 * arbiter:
 *
 *  - `dead` — an account/credential refused the app (bad token, expired ARL, revoked session).
 *    Bumps `consecutive_failures`; after DISABLE_AFTER_REPORTS reports the entry is disabled so
 *    it stops being served. Until then it is demoted to `pending` (not handed out fresh).
 *  - `not_premium` — the credential works but does not deliver the premium tier the pool
 *    believed it had. Clears the `premium` flag so lease ordering stops preferring it.
 *
 * This is deliberately a *side channel*, not a truth source: nothing is deleted, and the hourly
 * sweep re-checks every entry from the server side (Tidal tokens even rotate there), so false
 * reports decay on their own.
 *
 * Ids are globally unique across account_entries/instance_entries (shared id sequence); the
 * table is resolved by kind when provided (the app knows it) and by lookup otherwise.
 */
export async function POST(req: NextRequest) {
  // Mirrors the sources/discovery gate: read-key enforced only when READ_KEYS_ENFORCED=true, so a
  // build without a baked-in key can still report.
  if (!(await verifyReadKey(req, false))) {
    return NextResponse.json(
      { error: "unauthorized" },
      { status: 401, headers: { "cache-control": "private, no-store" } },
    )
  }

  let body: {
    service?: string
    kind?: string
    id?: number
    fingerprint?: string
    report?: string
  }
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: "invalid body" }, { status: 400 })
  }

  const reportType = String(body.report ?? "")
  if (!REPORT_TYPES[reportType]) {
    return NextResponse.json({ error: "unknown report type" }, { status: 400 })
  }

  await ensureSchema()

  const id = Number(body.id ?? 0) || null
  const fingerprint = String(body.fingerprint ?? "").trim() || null
  if (!id && !fingerprint) {
    return NextResponse.json({ error: "id or fingerprint required" }, { status: 400 })
  }

  // Resolve the entry across both split tables. Ids are globally unique (shared sequence);
  // fingerprints are only unique per table, so prefer id and fall back to fingerprint with a
  // kind hint when available.
  let entry: { id: number; kind: "account" | "api" } | null = null
  if (id) {
    const [account] = await db
      .select({ id: accountEntries.id })
      .from(accountEntries)
      .where(eq(accountEntries.id, id))
      .limit(1)
    if (account) {
      entry = { id: account.id, kind: "account" }
    } else {
      const [instance] = await db
        .select({ id: instanceEntries.id })
        .from(instanceEntries)
        .where(eq(instanceEntries.id, id))
        .limit(1)
      if (instance) entry = { id: instance.id, kind: "api" }
    }
  } else if (fingerprint) {
    const kindHint = isKind(body.kind) ? body.kind : null
    const tables =
      kindHint === "account"
        ? [accountEntries]
        : kindHint === "api"
          ? [instanceEntries]
          : [accountEntries, instanceEntries]
    for (const table of tables) {
      const [row] = await db
        .select({ id: table.id })
        .from(table)
        .where(eq(table.fingerprint, fingerprint))
        .limit(1)
      if (row) {
        entry = { id: row.id, kind: table === accountEntries ? "account" : "api" }
        break
      }
    }
  }

  if (!entry) {
    return NextResponse.json({ error: "unknown entry" }, { status: 404 })
  }

  const table = entry.kind === "account" ? accountEntries : instanceEntries

  if (reportType === "dead") {
    await db
      .update(table)
      .set({
        status: "pending", // demoted: not handed out fresh until the sweep re-verifies
        consecutiveFailures: sql`${table.consecutiveFailures} + 1`,
        checkCount: sql`${table.checkCount} + 1`,
      })
      .where(eq(table.id, entry.id))

    const [current] = await db
      .select({ consecutiveFailures: table.consecutiveFailures })
      .from(table)
      .where(eq(table.id, entry.id))
      .limit(1)

    if ((current?.consecutiveFailures ?? 0) >= DISABLE_AFTER_REPORTS) {
      await db.update(table).set({ disabled: true }).where(eq(table.id, entry.id))
    }
  } else if (reportType === "not_premium") {
    await db
      .update(table)
      .set({
        premium: false,
        checkCount: sql`${table.checkCount} + 1`,
      })
      .where(eq(table.id, entry.id))
  }

  await db.insert(healthLog).values({
    entryId: entry.id,
    ok: reportType !== "dead",
    premium: reportType !== "not_premium",
    latencyMs: null,
    detail: `app report: ${reportType}`,
  })

  return NextResponse.json({ ok: true, id: entry.id }, { headers: { "cache-control": "private, no-store" } })
}
