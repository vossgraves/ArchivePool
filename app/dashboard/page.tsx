import { redirect } from "next/navigation"
import { eq } from "drizzle-orm"
import { db } from "@/lib/db"
import { users } from "@/lib/db/schema"
import { getSessionUserId } from "@/lib/sessions"
import { SiteHeader } from "@/components/site-header"
import { Dashboard } from "@/components/dashboard"

export const metadata = { title: "Dashboard" }

export default async function DashboardPage() {
  const userId = await getSessionUserId()
  if (!userId) redirect("/login")

  const [user] = await db
    .select({ username: users.username })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1)
  if (!user) redirect("/login")

  return (
    <div className="min-h-dvh">
      <SiteHeader />
      <main className="mx-auto max-w-3xl px-5 pb-16 pt-10 sm:pt-14">
        <Dashboard username={user.username} />
      </main>
    </div>
  )
}
