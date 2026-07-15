import { sql } from "drizzle-orm"
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
  const fp = fingerprint(service, kind, payload)
  const label = maskLabel(service, kind, payload)
  const result: CheckResult = await runCheck(service, kind, payload)

  await db
    .insert(sourceEntries)
    .values({
      service,
      kind,
      label,
      payload,
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
        payload,
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
