import type { Metadata } from "next"
import { SiteHeader } from "@/components/site-header"
import { SubmitForm } from "@/components/submit-form"

export const metadata: Metadata = {
  title: "Contribute a source · ArchiveTune Source Pool",
}

export default function SubmitPage() {
  return (
    <main className="min-h-dvh">
      <SiteHeader active="submit" />
      <div className="mx-auto max-w-2xl px-5 py-10">
        <div className="mb-8 flex flex-col gap-3">
          <h1 className="text-pretty text-3xl font-semibold tracking-tight">Contribute a source</h1>
          <p className="text-pretty leading-relaxed text-muted-foreground">
            Submissions are anonymous. Your entry is verified immediately, then re-checked on a
            schedule. Only passing sources are served to the app, and dead ones are auto-disabled.
          </p>
        </div>

        <SubmitForm />

        <div className="mt-10 rounded-md border border-dashed border-border p-4 text-sm leading-relaxed text-muted-foreground">
          <p className="mb-2 font-medium text-foreground">A note on sharing accounts</p>
          <p>
            Shared credentials are pooled publicly and used by many people, so they may be rate-limited
            or expire. Never submit an account you rely on personally.
          </p>
        </div>
      </div>
    </main>
  )
}
