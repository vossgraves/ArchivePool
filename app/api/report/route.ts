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

// Reports may arrive without a key while READ_KEYS_ENFORCED is off, so the limiter keys on IP
// (and additionally on the key when one is presented). 60 per 5 min is far above any real
// device's dead-token chatter while making bulk `dead`-spam against healthy entries — the only
// unauthenticated write this endpoint allows — impractical. The sweep re-verifies hourly and
// re-enables wrongly disabled entries, so this is a bump, not a wall.
const REPORT_IP_LIMIT = 60
const REPORT_KEY_LIMIT = 60
const REPORT_WINDOW_MS = 5 * 60_000

// App-reported failures are strong evidence (a real user hit the credential and it failed), but a
// single report can also be noise or a transient hiccup. The health sweep re-verifies from the
// server side anyway, so we only auto-disable a reported entry once several apps agree.
const DISABLE_AFTER_REPORTS = 3

const REPORT_TYPES: Record<string, true> = { dead: true, not_premium: true }

/**
 * Replacement credentials handed back per hour, per service, per key, when a report resolves to
 * a real registered key (see the block after the healthLog insert below). A report is cheap to
 * forge, and a replacement is a real credential, so this is the actual exposure ceiling on this
 * endpoint: a key that reports every entry it holds dead can pull at most three fresh accounts
 * per service per hour instead of walking the pool. Three matches LEASE_PER_CATEGORY_ACCOUNT — a
 * device may replace its entire working set for one service once an hour, far beyond any real
 * dead-token rate. Same honest limitation as every other limiter here: the window is per
 * serverless instance, not global.
 */
const REPLACEMENTS_PER_HOUR = 3
const REPLACEMENT_WINDOW_MS = 60 * 60_000

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
  // build without a baked-in key can still report. identifyReadKey also resolves the key's row
  // id in the same lookup, which the replacement path below needs — a replacement is a real
  // credential, so it is only ever issued to a resolved, registered key, never to an anonymous
  // caller just because some Bearer header was present.
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

  // Resolve the entry across both split tables. Ids are globally unique (shared sequence);
  // fingerprints are only unique per table, so prefer id and fall back to fingerprint with a
  // kind hint when available. `service` comes from the resolved row, never from the client's
  // own `body.service` — a client must not be able to steer which service a later replacement
  // is drawn from.
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
    // Pool policy: non-premium entries are not served, so the report both clears the flag
    // and disables the entry. The sweep re-verifies hourly and re-enables it if the
    // server-side check still sees a premium entitlement (false reports self-heal).
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

  // A report the app can act on: the entry it just lost is released from this key's lease set,
  // and when the caller is a real registered key, one replacement is handed back in exactly the
  // shape /api/accounts uses (see leaseReplacement). This closes the gap where a device reported
  // a dead token and then had to wait for its next scheduled feed refresh to get a working one.
  // not_premium is covered too: it disables the entry unconditionally, so it costs the key a
  // slot just as surely as dead does (which only disables after DISABLE_AFTER_REPORTS agreeing
  // apps).
  //
  // Gated on identity.keyId != null: /api/report is open when READ_KEYS_ENFORCED is off
  // (identifyReadKey(req, false) above), and handing back a credential there would be a feed
  // that bypasses the always-enforced gate on /api/accounts. No resolved key, no replacement —
  // ever, regardless of what Bearer header was presented.
  //
  // Further gated on releaseLease() actually finding and deleting a row: without this, any
  // registered key could report ids it never received from /api/accounts (a service's entries
  // are sequential/enumerable) and harvest a fresh replacement for each one, up to the hourly
  // cap — reopening exactly the pool-walking exposure per-key sticky leases exist to close, just
  // through this endpoint instead of the feed. A lease row existing is proof the pool itself
  // handed this exact entry to this exact key at some point (via leaseAccounts or an earlier
  // replacement); reporting an entry the key never held still updates its status/health-log as
  // before (the report stays a side channel anyone can contribute to), it just never earns a
  // replacement.
  let replacement: Record<string, unknown> | null = null
  let encryption: "read-key" | "client-key" = "client-key"

  if (entry.kind === "account" && identity.keyId != null && isService(entry.service)) {
    const hadLease = await releaseLease(identity.keyId, entry.id)

    if (hadLease) {
      const v2 = req.headers.get("x-pool-client")?.trim().toLowerCase() === "v2"
      encryption = v2 ? "read-key" : "client-key"
      // Mirrors /api/accounts' encryption gate, but non-fatal here: a legacy client hitting a
      // server with no POOL_CLIENT_KEY configured gets replacement: null, never plaintext and
      // never a 503 — the report itself must still succeed regardless.
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
          // Same per-service { accounts: [...] } envelope /api/accounts uses, so the app's
          // existing feed parser consumes this unchanged.
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
