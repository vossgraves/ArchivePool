// SPDX-License-Identifier: GPL-3.0-or-later
import { NextResponse, type NextRequest } from "next/server"
import { and, eq, or, sql } from "drizzle-orm"
import { identifyReadKey, readKeyFromRequest } from "@/lib/api-keys"
import { clientEncryptionEnabled, deriveClientKey } from "@/lib/crypto"
import { db } from "@/lib/db"
import { accountEntries, healthLog, instanceEntries } from "@/lib/db/schema"
import { ensureSchema } from "@/lib/db/ensure"
import { leaseReplacement, releaseLease } from "@/lib/queries"
import { checkEntryById } from "@/lib/health-sweep"
import { clientIp, keyId, rateLimit, tooManyRequests } from "@/lib/rate-limit"
import { isKind, isService } from "@/lib/sources"

export const dynamic = "force-dynamic"

// Keyed on IP because reports may arrive without a key. See docs/REPORT_ENDPOINT.md.
// Low because every report costs one live provider check: a legitimate app reports a credential at
// most a few times ever, and this caps what one address can spend on Qobuz / Tidal / Deezer / Apple.
const REPORT_IP_LIMIT = 20
const REPORT_KEY_LIMIT = 20
const REPORT_WINDOW_MS = 5 * 60_000

// A single report can be noise, so auto-disable only once several apps agree.
const DISABLE_AFTER_REPORTS = 3

// A stored check verdict younger than this stands in for a fresh live check on a report. The
// thundering herd is real: the few accounts a baked app key holds get re-reported thousands of
// times a day (every install sharing the key leases the same LRU entries), and re-verifying each
// report is what actually harms the pool — Tidal starts answering `abuse_detected` to a refresh
// token exchanged that often, and each verify costs ~5 DB writes plus a health_log row. Inside
// the window the stored status already says what another probe would: recent and alive means the
// report is treated exactly as a verify that passed (lease released, replacement offered);
// recent and dead means the entry is already parked and the park path is a no-op.
const REPORT_VERIFY_COOLDOWN_MS = 15 * 60_000

// How long a claimed verify holds before another instance may retry — just long enough to cover
// one probe (12s health timeout plus refresh chains). If the claimant dies mid-probe, reports
// keep answering from the stored verdict until this lapses; they never pile onto the provider.
const VERIFY_LEASE_SECS = 120

// The probe a claim pays for must finish well inside the lease: every fetch in the check chain
// honours this signal, so a hung provider cannot hold the lease hostage or make the next claim
// double up on it.
const PROBE_BUDGET_MS = 45_000

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

  // The report's start on the DATABASE's clock, captured BEFORE the entry snapshot: the
  // park/failure UPDATE below refuses to apply when the verdict it would act on is no longer the
  // row's current one, and both sides of that comparison must share one time source.
  const startedRows = await db.execute(sql`select now() as now`)
  const reportStartedAt = (startedRows.rows[0] as { now: Date }).now

  // Ids are globally unique, fingerprints only per table, so prefer the id. `service` comes
  // from the resolved row: a client must not steer which service a replacement is drawn from.
  // The stored verdict columns come along too — inside REPORT_VERIFY_COOLDOWN_MS they stand in
  // for the live probe a report would otherwise trigger (see below).
  let entry: {
    id: number
    kind: "account" | "api"
    service: string
    status: string
    disabled: boolean
    premium: boolean
    lastCheckedAt: Date | null
    lastOkAt: Date | null
  } | null = null
  const entryColumns = (t: typeof accountEntries | typeof instanceEntries) => ({
    id: t.id,
    service: t.service,
    status: t.status,
    disabled: t.disabled,
    premium: t.premium,
    lastCheckedAt: t.lastCheckedAt,
    lastOkAt: t.lastOkAt,
  })
  if (id) {
    const [account] = await db
      .select(entryColumns(accountEntries))
      .from(accountEntries)
      .where(eq(accountEntries.id, id))
      .limit(1)
    if (account) {
      entry = { ...account, kind: "account" }
    } else {
      const [instance] = await db
        .select(entryColumns(instanceEntries))
        .from(instanceEntries)
        .where(eq(instanceEntries.id, id))
        .limit(1)
      if (instance) entry = { ...instance, kind: "api" }
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
        .select(entryColumns(table))
        .from(table)
        .where(eq(table.fingerprint, fingerprint))
        .limit(1)
      if (row) {
        entry = { ...row, kind: table === accountEntries ? "account" : "api" }
        break
      }
    }
  }

  if (!entry) {
    return NextResponse.json({ error: "unknown entry" }, { status: 404 })
  }

  const table = entry.kind === "account" ? accountEntries : instanceEntries

  // A stored verdict is the entry's last *check* outcome, kept separate from serving policy:
  // 'alive'/'preview' mean the probe succeeded (premium flag tells entitlement), 'dead' means it
  // failed, 'pending' that none has decided yet. `disabled` is deliberately NOT folded in — a
  // working-but-lossy entry is disabled by policy while its check verdict stays ok, and a report
  // about it must resolve exactly as the live probe would (see docs/REPORT_ENDPOINT.md).
  const storedVerdict = (row: { status: string; premium: boolean }) => ({
    ok: row.status === "alive" || row.status === "preview",
    premium: row.premium,
  })
  const isFresh = (checkedAt: Date | null | undefined) =>
    checkedAt != null && Date.now() - new Date(checkedAt).getTime() < REPORT_VERIFY_COOLDOWN_MS
  const readVerdictRow = async () => {
    const [row] = await db
      .select({
        status: table.status,
        premium: table.premium,
        lastCheckedAt: table.lastCheckedAt,
        lastOkAt: table.lastOkAt,
      })
      .from(table)
      .where(eq(table.id, entry.id))
      .limit(1)
    return row ?? null
  }

  /**
   * Resolve what a live check would say without paying for one when it is not needed:
   *  - the verdict is still inside REPORT_VERIFY_COOLDOWN_MS → the stored row answers.
   *  - it is stale → claim the per-entry verify lease first (an atomic UPDATE ... RETURNING that
   *    succeeds only when no other instance holds it), then re-read: another instance's probe may
   *    have landed between our first read and the claim, or be in flight right now — either way
   *    the stored verdict is what non-claimants and racers use. Only the claimant whose re-read
   *    is still stale runs the real provider probe.
   * `probed` reports whether a real check ran this call, which the dead-report path needs for
   * failure accounting: a probe that ran already recorded its own result inside checkEntryById.
   * `lastOkAtSeen` is the last_ok_at attached to the verdict being acted on — the park UPDATE
   * applies only while that exact value is still current, so a success landing between the
   * verdict read and the write makes the write a no-op instead of overwriting the win.
   */
  const verifyReport = async (): Promise<{
    verdict: { ok: boolean; premium: boolean } | null
    probed: boolean
    lastOkAtSeen: Date | null
  }> => {
    if (isFresh(entry.lastCheckedAt))
      return { verdict: storedVerdict(entry), probed: false, lastOkAtSeen: entry.lastOkAt }

    const [claimed] = await db
      .update(table)
      .set({ verifyLeaseUntil: sql`now() + make_interval(secs => ${VERIFY_LEASE_SECS})` })
      .where(
        and(
          eq(table.id, entry.id),
          sql`(${table.verifyLeaseUntil} is null or ${table.verifyLeaseUntil} < now())`,
        ),
      )
      .returning({ id: table.id })

    const fresh = await readVerdictRow()

    if (!claimed) {
      // Another instance is verifying (or its probe just landed): use whatever is on record now.
      return {
        verdict: fresh ? storedVerdict(fresh) : storedVerdict(entry),
        probed: false,
        lastOkAtSeen: fresh ? fresh.lastOkAt : entry.lastOkAt,
      }
    }

    // We hold the lease. If the re-read is fresh, that verdict is as good as probing again —
    // and one fewer upstream call is the point of the cooldown.
    if (fresh && isFresh(fresh.lastCheckedAt))
      return { verdict: storedVerdict(fresh), probed: false, lastOkAtSeen: fresh.lastOkAt }

    const verdict = await checkEntryById(entry.id, AbortSignal.timeout(PROBE_BUDGET_MS)).catch(() => null)
    // For a probe that FAILED the row's last_ok_at is untouched, so the pre-probe value from the
    // claim-time re-read is still the marker the park guard must see unchanged.
    return { verdict, probed: true, lastOkAtSeen: fresh ? fresh.lastOkAt : entry.lastOkAt }
  }

  if (reportType === "dead") {
    // Verify-before-park: a report usually means the app's cached copy went stale (Tidal kills
    // access tokens hourly, apps cache them for a day), not that the account died. The live check
    // already records itself and resets a healthy entry, so only a failing one is parked.
    const { verdict: live, probed, lastOkAtSeen } = await verifyReport()
    if (live == null || !live.ok) {
      // Failure accounting, in one atomic UPDATE ... RETURNING so racing reports on different
      // instances cannot both conclude "below threshold":
      //  - probed + verdict fail → checkEntryById already counted the failure; just park.
      //  - probed + null         → the check could not run, so the report itself is the failure
      //                            (and the only check signal — checkCount too, as before).
      //  - not probed            → the stored verdict came off the record; the report is the
      //                            qualifying signal DISABLE_AFTER_REPORTS watches.
      const reportCounts = !probed || live == null
      // Count, park and threshold-disable in ONE statement:
      //  - the counter increments in place, so a racing report on another instance folds in
      //    rather than two snapshots overwriting each other;
      //  - disabled is OR-ed with the new count crossing the threshold, so this write can only
      //    add a disable, never undo one — and it fires whether the +1 comes from this report
      //    (reportCounts) or was already counted by the probe that just ran;
      //  - the verdict-equality guard makes the whole thing a no-op when the verdict's own
      //    marker (last_ok_at) is no longer what we read: a success landing between the verdict
      //    read and this write changes last_ok_at, and a fresh success always outranks a
      //    report-driven failure. The reportStartedAt clause keeps the same protection against
      //    a success that predates our verdict read but postdates the report's arrival.
      await db
        .update(table)
        .set({
          status: "pending", // demoted: not handed out fresh until the sweep re-verifies
          disabled: sql`${table.disabled} or (${table.consecutiveFailures} + ${reportCounts ? 1 : 0}) >= ${DISABLE_AFTER_REPORTS}`,
          ...(reportCounts
            ? {
                consecutiveFailures: sql`${table.consecutiveFailures} + 1`,
                ...(live == null ? { checkCount: sql`${table.checkCount} + 1` } : {}),
              }
            : {}),
        })
        .where(
          and(
            eq(table.id, entry.id),
            sql`(${table.lastOkAt} is not distinct from ${lastOkAtSeen})`,
            or(sql`${table.lastOkAt} is null`, sql`${table.lastOkAt} < ${reportStartedAt}`),
          ),
        )
    }
  } else if (reportType === "not_premium") {
    // Reports are keyless and entry ids are small sequential integers, so an unverified report
    // would let one request switch a healthy account off and one address walk the whole pool.
    // The provider's own answer decides entitlement; a wrong report is discarded.
    const { verdict: live } = await verifyReport()
    if (live == null || !live.ok || live.premium) {
      // Also rejected when the check could not decide: a flaky network must not hand the abuse
      // back. Entitlement is judged only from a check that ran and succeeded, and that check has
      // already disabled the entry itself when the account really is not premium. Logged either
      // way, so a systematic false-reporter stays visible.
      await db.insert(healthLog).values({
        entryId: entry.id,
        ok: true,
        premium: true,
        latencyMs: null,
        detail: `app report: not_premium (rejected — ${
          live == null ? "live check unavailable" : !live.ok ? "live check failed" : "live check still premium"
        })`,
      })
      return NextResponse.json(
        { ok: true, id: entry.id, ignored: "not_premium" },
        { headers: { "cache-control": "private, no-store" } },
      )
    }
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
