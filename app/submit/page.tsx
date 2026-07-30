import type { Metadata } from "next"
import Link from "next/link"
import { SiteHeader } from "@/components/site-header"
import { SubmitForm } from "@/components/submit-form"

export const metadata: Metadata = {
  // The suffix comes from the title template in app/layout.tsx.
  title: "Contribute a source",
}

export default function SubmitPage() {
  return (
    <div className="min-h-dvh">
      <SiteHeader active="submit" />

      <main id="content" className="mx-auto max-w-2xl px-5 pb-16 pt-10">
        <div className="mb-9 flex flex-col gap-4">
          {/* Explicit way back out of the form. */}
          <Link
            href="/"
            className="inline-flex w-fit items-center gap-1.5 font-mono text-xs uppercase tracking-[0.14em] text-muted-foreground transition-colors hover:text-foreground"
          >
            <svg
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              aria-hidden="true"
            >
              <path d="m15 18-6-6 6-6" />
            </svg>
            Status
          </Link>
          <h1 className="text-pretty text-[2rem] font-semibold leading-[1.1] tracking-[-0.03em] sm:text-4xl">
            Contribute a source
          </h1>
          <p className="max-w-[60ch] text-pretty leading-relaxed text-muted-foreground">
            Submissions are anonymous. Your entry is verified immediately, then re-checked on a
            schedule. Only passing sources are served to the app, and dead ones are auto-disabled.
          </p>
        </div>

        <SubmitForm />

        {/* This is a genuine warning, so it earns the warn signal colour — a left rule rather than
            the previous dashed box, which read as an empty placeholder. */}
        <aside className="mt-10 flex flex-col gap-2 rounded-r-md border-l-2 border-warn bg-card py-4 pl-4 pr-4 text-sm leading-relaxed">
          <p className="font-medium text-warn">A note on sharing accounts</p>
          <p className="max-w-[60ch] text-pretty text-muted-foreground">
            Shared credentials are pooled publicly and used by many people, so they may be
            rate-limited or expire. Never submit an account you rely on personally.
          </p>
        </aside>
      </main>
    </div>
  )
}
