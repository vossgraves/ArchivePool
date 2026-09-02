import { redirect } from "next/navigation"
import { eq } from "drizzle-orm"
import { db } from "@/lib/db"
import { users } from "@/lib/db/schema"
import { getSessionUserId } from "@/lib/sessions"
import { SiteHeader } from "@/components/site-header"
import { PageHeader } from "@/components/page-header"
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
  // A valid signature whose account has since been deleted must not render an empty dashboard.
  if (!user) redirect("/login")

  return (
    <div className="min-h-dvh">
      <SiteHeader />
      <main id="content" className="mx-auto max-w-3xl px-4 pb-16 pt-8">
        <PageHeader
          eyebrow="Dashboard"
          title="API keys"
          description="Request a key, reveal an approved one, and revoke or delete the ones you no longer use."
        />
        <Dashboard username={user.username} />
      </main>
    </div>
  )
}
