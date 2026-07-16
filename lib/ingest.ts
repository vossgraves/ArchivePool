import { sql } from "drizzle-orm"
import { encryptAtRest } from "@/lib/crypto"
import { db } from "@/lib/db"
import { sourceEntries } from "@/lib/db/schema"
import { runCheck, type CheckResult } from "@/lib/health"
import { fingerprint, maskLabel, type Kind, type Service } from "@/lib/sources"

export interface IngestResult {
  ok: boolean
  saved: boolean
  status: string
  premium: boolean
  detail: string
}

/**
 * Runs a live health check on a candidate source and upserts it into the pool, deduped by
 * fingerprint. Shared by the manual submit form and the Tidal OAuth device flow so both paths
 * behave identically (same validation, same dedupe, same auto-disable accounting).
 */
export async function ingestSource(
  service: Service,
  kind: Kind,
  payload: Record<string, unknown>,
): Promise<IngestResult> {
  // Fingerprint, label and the live health check all run on the PLAINTEXT payload; only the value
  // persisted to the database is encrypted, so dedupe and validation behaviour is unchanged.
  const fp = fingerprint(service, kind, payload)
  const label = maskLabel(service, kind, payload)
  const result: CheckResult = await runCheck(service, kind, payload, fp)
  const storedPayload = encryptAtRest(payload)

  await db
    .insert(sourceEntries)
    .values({
      service,
      kind,
      label,
      payload: storedPayload,
      fingerprint: fp,
      status: result.status,
      premium: result.premium,
      detail: result.detail,
      latencyMs: result.latencyMs,
      checkCount: 1,
      okCount: result.ok ? 1 : 0,
      consecutiveFailures: result.ok ? 0 : 1,
      lastCheckedAt: new Date(),
      removed: false,
      disabled: false,
    })
    .onConflictDoUpdate({
      target: sourceEntries.fingerprint,
      set: {
        payload: storedPayload,
        label,
        status: result.status,
        premium: result.premium,
        detail: result.detail,
        latencyMs: result.latencyMs,
        checkCount: sql`${sourceEntries.checkCount} + 1`,
        okCount: sql`${sourceEntries.okCount} + ${result.ok ? 1 : 0}`,
        consecutiveFailures: result.ok ? 0 : sql`${sourceEntries.consecutiveFailures} + 1`,
        lastCheckedAt: new Date(),
        removed: false,
      },
    })

  return {
    ok: result.ok,
    saved: true,
    status: result.status,
    premium: result.premium,
    detail: result.detail,
  }
}

/**
 * Turns a save/DB error into a human-readable cause. Most "could not save" failures in a fresh
 * deploy are configuration problems (no DATABASE_URL, or the schema was never applied), so we
 * detect those explicitly instead of returning a generic message.
 */
export function describeSaveError(e: unknown): string {
  const msg = (e instanceof Error ? e.message : String(e ?? "")).toLowerCase()
  if (!process.env.DATABASE_URL) {
    return "The server has no DATABASE_URL set. Add your database connection string in the host's environment variables."
  }
  if (msg.includes('relation "source_entries" does not exist') || msg.includes("source_entries") && msg.includes("does not exist")) {
    return "The database has no tables yet. Run scripts/schema.sql against it once, then try again."
  }
  if (msg.includes("no unique or exclusion constraint") || msg.includes("on conflict")) {
    return "The database schema is out of date (missing the fingerprint unique constraint). Re-run scripts/schema.sql."
  }
  if (msg.includes("econnrefused") || msg.includes("timeout") || msg.includes("terminating connection") || msg.includes("connect")) {
    return "Could not reach the database. Check that DATABASE_URL is correct and the database is reachable from the host."
  }
  return "Could not save to the database. Check the server logs for the underlying error."
}
