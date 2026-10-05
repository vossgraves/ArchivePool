// SPDX-License-Identifier: GPL-3.0-or-later
import type { Metadata } from "next"
import { SiteHeader } from "@/components/site-header"
import { PageHeader } from "@/components/page-header"
import { AdminGate } from "@/components/admin-gate"

export const metadata: Metadata = {
  title: "Admin · Source Pool",
  robots: { index: false, follow: false },
}

export default function AdminPage() {
  return (
    <div className="min-h-dvh">
      <SiteHeader />
      <main id="content" className="mx-auto max-w-5xl px-4 py-8">
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
