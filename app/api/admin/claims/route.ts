// SPDX-License-Identifier: GPL-3.0-or-later
import { NextResponse, type NextRequest } from "next/server"
import { resolveAdmin } from "@/lib/admin-auth"
import { listPendingClaims } from "@/lib/github-auth"

export const dynamic = "force-dynamic"

/** Pending GitHub username claims awaiting review. Same gate as /api/admin/requests. */
export async function GET(req: NextRequest) {
  const actor = await resolveAdmin(req)
  if (!actor) return NextResponse.json({ error: "unauthorized" }, { status: 401 })
  try {
    const claims = await listPendingClaims()
    return NextResponse.json({ claims })
  } catch (e) {
    console.error("[admin] list claims failed:", e)
    return NextResponse.json({ error: "internal_error" }, { status: 500 })
  }
}
