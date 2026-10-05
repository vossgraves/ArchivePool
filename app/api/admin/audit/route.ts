// SPDX-License-Identifier: GPL-3.0-or-later
import { NextResponse, type NextRequest } from "next/server"
import { resolveAdmin } from "@/lib/admin-auth"
import { listAudit } from "@/lib/audit"

export const dynamic = "force-dynamic"

export async function GET(req: NextRequest) {
  const actor = await resolveAdmin(req)
  if (!actor) return NextResponse.json({ error: "unauthorized" }, { status: 401 })

  const limit = Number(req.nextUrl.searchParams.get("limit") ?? 200)
  return NextResponse.json({ entries: await listAudit(Number.isFinite(limit) ? limit : 200) })
}
