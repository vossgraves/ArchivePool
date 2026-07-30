import type { Metadata } from "next"
import { SiteHeader } from "@/components/site-header"
import { AdminGate } from "@/components/admin-gate"

export const metadata: Metadata = {
  title: "Admin · Source Pool",
  robots: { index: false, follow: false },
}

export default function AdminPage() {
  return (
    <div className="min-h-dvh">
      <SiteHeader />
      <main className="mx-auto max-w-6xl px-5 py-10">
        <div className="mb-8">
          <h1 className="text-balance text-2xl font-semibold tracking-tight">Admin</h1>
          <p className="mt-1 text-pretty text-sm leading-relaxed text-muted-foreground">
            Review each source&apos;s accounts individually, re-check or remove them, manage per-app
            read keys, and moderate contributed sources. Keep your admin token private.
          </p>
        </div>
        <AdminGate />
      </main>
    </div>
  )
}
