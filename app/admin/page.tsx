import type { Metadata } from "next"
import { SiteHeader } from "@/components/site-header"
import { AdminKeys } from "@/components/admin-keys"

export const metadata: Metadata = {
  title: "Admin · Source Pool",
  robots: { index: false, follow: false },
}

export default function AdminPage() {
  return (
    <div className="min-h-dvh">
      <SiteHeader />
      <main className="mx-auto max-w-5xl px-5 py-10">
        <div className="mb-8">
          <h1 className="text-balance text-2xl font-semibold tracking-tight">Admin</h1>
          <p className="mt-1 text-pretty text-sm leading-relaxed text-muted-foreground">
            Manage per-app read keys. Apps must send a valid key to read the source pool and discovery
            feeds. Keep your admin token private.
          </p>
        </div>
        <AdminKeys />
      </main>
    </div>
  )
}
