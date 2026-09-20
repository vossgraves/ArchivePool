import { NextResponse, type NextRequest } from "next/server"
import { isCronAuthorized as authorized } from "@/lib/admin-auth"
import { runHealthSweep } from "@/lib/health-sweep"
import { ingestExternalSources } from "@/lib/external-sources"
import { invalidate } from "@/lib/ttl-cache"

export const dynamic = "force-dynamic"
export const maxDuration = 60

export async function GET(req: NextRequest) {
  if (!authorized(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 })

  // Pull community token feeds (citegptapi n8n webhook, firehawk52 rendered page) and ingest
  // entries not already pooled. Errors are isolated: an unreachable feed must never block the
  // health sweep. Ingestion is bounded (dedupe by fingerprint + per-run cap), so the hourly
  // schedule only health-checks genuinely NEW credentials.
  let external: Awaited<ReturnType<typeof ingestExternalSources>> | null = null
  try {
    external = await ingestExternalSources()
  } catch (err) {
    external = {
      fetched: 0,
      inserted: 0,
      skippedKnown: 0,
      rejected: 0,
      errors: [err instanceof Error ? err.message : "unknown ingestion error"],
    }
  }

  const summary = await runHealthSweep()
  // The board's figures just changed; drop the cached copy so the next reader sees this sweep
  // rather than waiting out the TTL.
  invalidate("status")
  return NextResponse.json({ ok: true, external, ...summary, ranAt: new Date().toISOString() })
}
