// SPDX-License-Identifier: GPL-3.0-or-later
import { redirect } from "next/navigation"
import Link from "next/link"
import { eq } from "drizzle-orm"
import { db } from "@/lib/db"
import { users } from "@/lib/db/schema"
import { getDashboard } from "@/lib/queries"
import { getSessionUserId } from "@/lib/sessions"
import { SiteHeader } from "@/components/site-header"
import { PageHeader } from "@/components/page-header"
import { Dashboard } from "@/components/dashboard"
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "@/components/ui/breadcrumb"
import { buttonVariants } from "@/components/ui/button"
import { cn } from "@/lib/utils"

export const metadata = { title: "Dashboard" }

// Session-dependent — never let a prerendered/cached copy serve signed-out state.
export const dynamic = "force-dynamic"

export default async function DashboardPage() {
  const userId = await getSessionUserId()
  if (!userId) redirect("/login")

  const [user] = await db
    .select({ username: users.username, role: users.role })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1)
  // A valid signature whose account has since been deleted must not render an empty dashboard.
  if (!user) redirect("/login")

  // One read for the whole page. Rendering server-side is what lets the tiles, the keys list and
  // the charts be the same figures — the previous client fetch left them computed from two copies.
  const snapshot = await getDashboard(userId, user.username)

  return (
    <div className="min-h-dvh">
      <SiteHeader active="dashboard" />
      <main id="content" className="w-full px-3 pb-16 pt-6 sm:px-4 md:px-6 flex-1">
        <Breadcrumb className="mb-4">
          <BreadcrumbList>
            <BreadcrumbItem>
              <BreadcrumbLink href="/">ArchivePool</BreadcrumbLink>
            </BreadcrumbItem>
            <BreadcrumbSeparator />
            <BreadcrumbItem>
              <BreadcrumbLink href="/dashboard">Console</BreadcrumbLink>
            </BreadcrumbItem>
            <BreadcrumbSeparator />
            <BreadcrumbItem>
              <BreadcrumbPage>Dashboard</BreadcrumbPage>
            </BreadcrumbItem>
          </BreadcrumbList>
        </Breadcrumb>
        <PageHeader
          eyebrow="Dashboard"
          title="Your pool"
          description="Your keys and what they are holding, the sources you have contributed, and the pool health that decides what any of it can serve."
          actions={
            <>
              <Link
                href="/submit"
                className={cn(buttonVariants({ variant: "outline", size: "sm" }))}
              >
                Contribute a source
              </Link>
              {user.role === "admin" ? (
                <Link href="/admin" className={cn(buttonVariants({ variant: "outline", size: "sm" }))}>
                  Admin
                </Link>
              ) : null}
            </>
          }
        />
        <Dashboard username={user.username} snapshot={snapshot} />
      </main>
    </div>
  )
}
