import { NextResponse, type NextRequest } from "next/server"
import { eq, sql } from "drizzle-orm"
import { verifyReadKey } from "@/lib/api-keys"
import { db } from "@/lib/db"
import { healthLog, sourceEntries } from "@/lib/db/schema"
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
 */
export async function POST(req: NextRequest) {
  // Mirrors the sources/discovery gate: read-key enforced only when READ_KEYS_ENFORCED=true, so a
  // build without a baked-in key can still report.
  if (!(await verifyReadKey(req, false))) {
    return NextResponse.json(
      { error: "unauthorized", detail: "A valid read key is required to report." },
      { status: 401, headers: { "cache-control": "private, no-store" } },
    )
  }

  let body: { service?: unknown; kind?: unknown; report?: unknown; id?: unknown; fingerprint?: unknown }
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: "invalid body" }, { status: 400, headers: { "cache-control": "private, no-store" } })
  }

  const { service, kind } = body
  if (!isService(service) || !isKind(kind)) {
    return NextResponse.json(
      { error: "invalid service/kind" },
      { status: 400, headers: { "cache-control": "private, no-store" } },
    )
  }
  const report = String(body.report ?? "")
  if (!REPORT_TYPES[report]) {
    return NextResponse.json(
      { error: "invalid report type", detail: 'expected "dead" or "not_premium"' },
      { status: 400, headers: { "cache-control": "private, no-store" } },
    )
  }

  // Locate the entry compactly: prefer the numeric id from /api/sources, fall back to the
  // deterministic fingerprint used at submission time.
  const id = Number(body.id)
  const fingerprint = String(body.fingerprint ?? "").trim()
  if (!Number.isInteger(id) || id <= 0) {
    if (!fingerprint) {
      return NextResponse.json(
        { error: "id or fingerprint required" },
        { status: 400, headers: { "cache-control": "private, no-store" } },
      )
    }
  }

  const [entry] = id > 0
    ? await db.select().from(sourceEntries).where(eq(sourceEntries.id, id)).limit(1)
    : await db.select().from(sourceEntries).where(eq(sourceEntries.fingerprint, fingerprint)).limit(1)
  if (!entry || entry.removed) {
    return NextResponse.json(
      { error: "not found" },
      { status: 404, headers: { "cache-control": "private, no-store" } },
    )
  }

  if (report === "dead") {
    const nextConsecutive = entry.consecutiveFailures + 1
    const disable = nextConsecutive >= DISABLE_AFTER_REPORTS
    await db
      .update(sourceEntries)
      .set({
        // A reported-dead entry is not handed to new leases while the sweep decides.
        status: disable ? "dead" : "pending",
        disabled: disable,
        consecutiveFailures: nextConsecutive,
        detail: `app report: dead (${nextConsecutive}/${DISABLE_AFTER_REPORTS})`,
        checkCount: sql`${sourceEntries.checkCount} + 1`,
        lastCheckedAt: new Date(),
      })
      .where(eq(sourceEntries.id, entry.id))
    await db.insert(healthLog).values({
      entryId: entry.id,
      ok: false,
      premium: entry.premium,
      detail: `app report: dead (${nextConsecutive}/${DISABLE_AFTER_REPORTS})`,
    })
    return NextResponse.json(
      {
        ok: true,
        entryId: entry.id,
        action: disable ? "disabled" : "demoted",
        status: disable ? "dead" : "pending",
      },
      { headers: { "cache-control": "private, no-store", "access-control-allow-origin": "*" } },
    )
  }

  // not_premium: works, but the premium flag was wrong. Clear it so premium-first lease ordering
  // and status rendering treat the account honestly. The sweep may set it back if the server-side
  // probe disagrees.
  await db
    .update(sourceEntries)
    .set({
      premium: false,
      detail: "app report: not premium",
      lastCheckedAt: new Date(),
    })
    .where(eq(sourceEntries.id, entry.id))
  await db.insert(healthLog).values({
    entryId: entry.id,
    ok: true,
    premium: false,
    detail: "app report: not premium",
  })
  return NextResponse.json(
    { ok: true, entryId: entry.id, action: "premium_cleared", status: entry.status },
    { headers: { "cache-control": "private, no-store", "access-control-allow-origin": "*" } },
  )
}
