// SPDX-License-Identifier: GPL-3.0-or-later
import type { Metadata } from "next"
import { SiteHeader } from "@/components/site-header"
import { PageHeader } from "@/components/page-header"
import { AdminGate } from "@/components/admin-gate"
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "@/components/ui/breadcrumb"

export const metadata: Metadata = {
  title: "Admin · Source Pool",
  robots: { index: false, follow: false },
}

export default function AdminPage() {
  return (
    <div className="min-h-dvh">
      <SiteHeader />
      <main id="content" className="w-full px-3 py-6 sm:px-4 md:px-6 flex-1">
        <Breadcrumb className="mb-4">
          <BreadcrumbList>
            <BreadcrumbItem>
              <BreadcrumbLink href="/">ArchivePool</BreadcrumbLink>
            </BreadcrumbItem>
            <BreadcrumbSeparator />
            <BreadcrumbItem>
              <BreadcrumbLink href="/">Management</BreadcrumbLink>
            </BreadcrumbItem>
            <BreadcrumbSeparator />
            <BreadcrumbItem>
              <BreadcrumbPage>Admin Control</BreadcrumbPage>
            </BreadcrumbItem>
          </BreadcrumbList>
        </Breadcrumb>
        <PageHeader
          eyebrow="Admin"
          title="Pool control"
          description="Review key requests, manage read keys, and moderate contributed sources. Every action here changes live data, so each one is confirmed and reported."
        />
        <AdminGate />
      </main>
    </div>
  )
}
