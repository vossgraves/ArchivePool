import { NextResponse, type NextRequest } from "next/server"
import { isAdminAuthorized as authorized } from "@/lib/admin-auth"
import { db } from "@/lib/db"
import { ensureSchema } from "@/lib/db/ensure"
import { apiKeyRequests, users } from "@/lib/db/schema"
import { desc, eq } from "drizzle-orm"

export const dynamic = "force-dynamic"

export async function GET(req: NextRequest) {
  if (!authorized(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 })
  try {
    await ensureSchema()
    const rows = await db
      .select({
        id: apiKeyRequests.id,
        subject: apiKeyRequests.subject,
        reason: apiKeyRequests.reason,
        status: apiKeyRequests.status,
        ipAddress: apiKeyRequests.ipAddress,
        userAgent: apiKeyRequests.userAgent,
        createdAt: apiKeyRequests.createdAt,
        reviewedAt: apiKeyRequests.reviewedAt,
        reviewNote: apiKeyRequests.reviewNote,
        username: users.username,
      })
      .from(apiKeyRequests)
      .leftJoin(users, eq(apiKeyRequests.userId, users.id))
      .orderBy(desc(apiKeyRequests.createdAt))
    return NextResponse.json(rows, { headers: { "cache-control": "private, no-store" } })
  } catch (err) {
    console.error("[admin] list requests failed:", err)
    return NextResponse.json(
      { error: "internal_error", detail: "Could not load requests." },
      { status: 500, headers: { "cache-control": "private, no-store" } },
    )
  }
}
