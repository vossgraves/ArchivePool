import { NextResponse, type NextRequest } from "next/server"
import { eq, sql } from "drizzle-orm"
import { identifyReadKey, readKeyFromRequest } from "@/lib/api-keys"
import { clientEncryptionEnabled, deriveClientKey } from "@/lib/crypto"
import { db } from "@/lib/db"
import { accountEntries, healthLog, instanceEntries } from "@/lib/db/schema"
import { ensureSchema } from "@/lib/db/ensure"
import { leaseReplacement, releaseLease } from "@/lib/queries"
import { clientIp, keyId, rateLimit, tooManyRequests } from "@/lib/rate-limit"
import { isKind, isService } from "@/lib/sources"

export const dynamic = "force-dynamic"

// Keyed on IP because reports may arrive without a key. See docs/REPORT_ENDPOINT.md.
const REPORT_IP_LIMIT = 60
const REPORT_KEY_LIMIT = 60
const REPORT_WINDOW_MS = 5 * 60_000

// A single report can be noise, so auto-disable only once several apps agree.
const DISABLE_AFTER_REPORTS = 3

const REPORT_TYPES: Record<string, true> = { dead: true, not_premium: true }

/** The real exposure ceiling on this endpoint. See docs/REPORT_ENDPOINT.md. */
const REPLACEMENTS_PER_HOUR = 3
const REPLACEMENT_WINDOW_MS = 60 * 60_000

/** A side channel, not a truth source — the hourly sweep arbitrates. See docs/REPORT_ENDPOINT.md. */
export async function POST(req: NextRequest) {
  // Enforced only when READ_KEYS_ENFORCED is set, so a build with no baked key can still report.
  const identity = await identifyReadKey(req, false)
  if (!identity.ok) {
    return NextResponse.json(
      { error: "unauthorized" },
      { status: 401, headers: { "cache-control": "private, no-store" } },
    )
  }

  const ipVerdict = rateLimit(`report-ip:${clientIp(req.headers)}`, REPORT_IP_LIMIT, REPORT_WINDOW_MS)
  if (!ipVerdict.ok) return tooManyRequests(ipVerdict.retryAfterSec, "report")
  const presentedKey = readKeyFromRequest(req)
  if (presentedKey) {
    const keyVerdict = rateLimit(`report-key:${keyId(presentedKey)}`, REPORT_KEY_LIMIT, REPORT_WINDOW_MS)
    if (!keyVerdict.ok) return tooManyRequests(keyVerdict.retryAfterSec, "report")
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

  // Ids are globally unique, fingerprints only per table, so prefer the id. `service` comes
  // from the resolved row: a client must not steer which service a replacement is drawn from.
  let entry: { id: number; kind: "account" | "api"; service: string } | null = null
  if (id) {
    const [account] = await db
      .select({ id: accountEntries.id, service: accountEntries.service })
      .from(accountEntries)
      .where(eq(accountEntries.id, id))
      .limit(1)
    if (account) {
      entry = { id: account.id, kind: "account", service: account.service }
    } else {
      const [instance] = await db
        .select({ id: instanceEntries.id, service: instanceEntries.service })
        .from(instanceEntries)
        .where(eq(instanceEntries.id, id))
        .limit(1)
      if (instance) entry = { id: instance.id, kind: "api", service: instance.service }
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
        .select({ id: table.id, service: table.service })
        .from(table)
        .where(eq(table.fingerprint, fingerprint))
        .limit(1)
      if (row) {
        entry = { id: row.id, kind: table === accountEntries ? "account" : "api", service: row.service }
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
    // Non-premium entries are not served at all. The sweep re-enables on a false report.
    await db
      .update(table)
      .set({
        premium: false,
        disabled: true,
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

  // Gated three ways — registered key, proven lease, hourly cap. See docs/REPORT_ENDPOINT.md.
  let replacement: Record<string, unknown> | null = null
  let encryption: "read-key" | "client-key" = "client-key"

  if (entry.kind === "account" && identity.keyId != null && isService(entry.service)) {
    const hadLease = await releaseLease(identity.keyId, entry.id)

    if (hadLease) {
      const v2 = req.headers.get("x-pool-client")?.trim().toLowerCase() === "v2"
      encryption = v2 ? "read-key" : "client-key"
      // Non-fatal, unlike /api/accounts: a client that cannot be encrypted for gets
      // replacement: null, never plaintext. The report itself must still succeed.
      const canEncrypt = v2 ? presentedKey != null : clientEncryptionEnabled()
      if (canEncrypt && presentedKey) {
        const verdict = rateLimit(
          `report-replacement-key:${keyId(presentedKey)}:${entry.service}`,
          REPLACEMENTS_PER_HOUR,
          REPLACEMENT_WINDOW_MS,
        )
        if (verdict.ok) {
          const replacementClientKey = v2 ? deriveClientKey(presentedKey) : null
          const picked = await leaseReplacement(entry.service, identity.keyId, replacementClientKey, entry.id)
          // Same envelope /api/accounts uses, so the app's feed parser is unchanged.
          if (picked) replacement = { [entry.service]: { accounts: [picked] } }
        }
      }
    }
  }

  return NextResponse.json(
    { ok: true, id: entry.id, encrypted: true, encryption, replacement },
    { headers: { "cache-control": "private, no-store" } },
  )
}
