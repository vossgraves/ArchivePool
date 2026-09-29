import { NextResponse, type NextRequest } from "next/server"
import { resolveAdmin } from "@/lib/admin-auth"
import { ingestSource } from "@/lib/ingest"
import { isKind, isService } from "@/lib/sources"

export const dynamic = "force-dynamic"

// TEMPORARY: admin-only manual ingest. REMOVE AFTER USE.
export async function POST(req: NextRequest) {
  const actor = await resolveAdmin(req)
  if (!actor) return NextResponse.json({ error: "unauthorized" }, { status: 401 })
  let body: { service?: string; kind?: string; payload?: Record<string, unknown>; contributor?: string | null }
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: "invalid body" }, { status: 400 })
  }
  if (!isService(body.service) || !isKind(body.kind) || !body.payload) {
    return NextResponse.json({ error: "service, kind and payload required" }, { status: 400 })
  }
  try {
    const result = await ingestSource(body.service, body.kind, body.payload, {
      contributor: body.contributor ?? null,
    })
    return NextResponse.json({ ok: true, ...result })
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "ingest failed" }, { status: 500 })
  }
}
