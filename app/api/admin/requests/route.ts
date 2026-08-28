import { NextResponse } from "next/server"
import { verifyAdmin } from "@/lib/auth"
import { db } from "@/lib/db"
import { apiKeyRequests, users } from "@/lib/db/schema"
import { desc, eq } from "drizzle-orm"

export const dynamic = "force-dynamic"

export async function GET(req: Request) {
  if (!verifyAdmin(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 })
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
      username: users.username,
    })
    .from(apiKeyRequests)
    .leftJoin(users, eq(apiKeyRequests.userId, users.id))
    .orderBy(desc(apiKeyRequests.createdAt))
  return NextResponse.json(rows, { headers: { "cache-control": "private, no-store" } })
}
