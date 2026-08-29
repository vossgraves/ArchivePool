import { NextResponse } from "next/server"
import { eq } from "drizzle-orm"
import { db } from "@/lib/db"
import { users } from "@/lib/db/schema"
import { getSessionUserId } from "@/lib/sessions"

export const dynamic = "force-dynamic"

export async function GET() {
  const userId = await getSessionUserId()
  if (!userId) return NextResponse.json({ error: "unauthorized" }, { status: 401 })

  const [user] = await db
    .select({ username: users.username })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1)
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 })

  return NextResponse.json({ username: user.username })
}
