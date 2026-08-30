import { sql } from "drizzle-orm"
import { atRestEncryptionEnabled, encryptAtRest } from "@/lib/crypto"
import { db } from "@/lib/db"
import { accountEntries, instanceEntries } from "@/lib/db/schema"
import { ensureSchema } from "@/lib/db/ensure"
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
 * fingerprint. Shared by the manual submit form, the Tidal OAuth device flow and the external
 * community-token ingester so all paths behave identically (same validation, same dedupe, same
 * auto-disable accounting).
 *
 * Storage is split by kind: account credentials go to `account_entries` (always encrypted at
 * rest), instance base URLs to `instance_entries`.
 */
export async function ingestSource(
  service: Service,
  kind: Kind,
  payload: Record<string, unknown>,
): Promise<IngestResult> {
  await ensureSchema()
  if (kind === "account" && !atRestEncryptionEnabled()) {
    throw new Error("POOL_ENCRYPTION_KEY is required before account credentials can be accepted")
  }
  // Fingerprint, label and the live health check all run on the PLAINTEXT payload; only the value
  // persisted to the database is encrypted, so dedupe and validation behaviour is unchanged.
  const fp = fingerprint(service, kind, payload)
  const label = maskLabel(service, kind, payload)
  const result: CheckResult = await runCheck(service, kind, payload, fp)
  const storedPayload = encryptAtRest(payload)
  const table = kind === "account" ? accountEntries : instanceEntries

  await db
    .insert(table)
    .values({
      service,
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
      target: table.fingerprint,
      set: {
        payload: storedPayload,
        label,
        status: result.status,
        premium: result.premium,
        detail: result.detail,
        latencyMs: result.latencyMs,
        checkCount: sql`${table.checkCount} + 1`,
        okCount: sql`${table.okCount} + ${result.ok ? 1 : 0}`,
        consecutiveFailures: result.ok ? 0 : sql`${table.consecutiveFailures} + 1`,
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
  for (const table of ["account_entries", "instance_entries", "source_entries"]) {
    if (msg.includes(`relation "${table}" does not exist`) || (msg.includes(table) && msg.includes("does not exist"))) {
      return "The database has no tables yet. Run scripts/schema.sql against it once, then try again."
    }
  }
  if (msg.includes("no unique or exclusion constraint") || msg.includes("on conflict")) {
    return "The database schema is out of date (missing the fingerprint unique constraint). Re-run scripts/schema.sql."
  }
  if (msg.includes("econnrefused") || msg.includes("timeout") || msg.includes("terminating connection") || msg.includes("connect")) {
    return "Could not reach the database. Check that DATABASE_URL is correct and the database is reachable from the host."
  }
  return "Could not save to the database. Check the server logs for the underlying error."
}
