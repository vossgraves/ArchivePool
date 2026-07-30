import Link from "next/link"
import { SiteHeader } from "@/components/site-header"
import { StatusBoard } from "@/components/status-board"

export default function Page() {
  return (
    <div className="min-h-dvh">
      <SiteHeader active="status" />

      <main id="content" className="mx-auto max-w-5xl px-5 pb-16 pt-12 sm:pt-16">
        <section className="mb-12 flex flex-col gap-5">
          <span className="inline-flex w-fit items-center gap-2 rounded-full border border-border bg-secondary/60 py-1 pl-2 pr-3 font-mono text-[0.65rem] uppercase tracking-[0.16em] text-muted-foreground">
            <span className="relative flex h-1.5 w-1.5">
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-ok opacity-70" />
              <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-ok" />
            </span>
            Checked every 30 minutes
          </span>

          {/* Tighter tracking and a heavier weight give the display line real presence; the
              previous 3xl/semibold read like body copy. */}
          <h1 className="max-w-3xl text-pretty text-[2rem] font-semibold leading-[1.08] tracking-[-0.03em] sm:text-5xl">
            Live status for every source in the pool
          </h1>

          <p className="max-w-[60ch] text-pretty leading-relaxed text-muted-foreground">
            Anyone can contribute a Tidal, Qobuz or Deezer source. Each one is health-checked on a
            schedule, and only the entries that pass are handed to the app. Credentials are never
            shown on this page.
          </p>
        </section>

        <StatusBoard />

        {/* Solid panel rather than the old dashed-border box: a dashed rule reads as a drop zone
            or an unfinished placeholder, not as a call to action. */}
        <section className="mt-12 flex flex-col items-start gap-5 rounded-xl border border-border bg-card p-6 edge-lit sm:flex-row sm:items-center sm:justify-between sm:gap-8">
          <div className="flex flex-col gap-1.5">
            <h2 className="text-lg font-semibold tracking-tight">Have a working source?</h2>
            <p className="max-w-[46ch] text-pretty text-sm leading-relaxed text-muted-foreground">
              Adding one keeps the pool alive for everyone. Submissions are anonymous and take
              about a minute.
            </p>
          </div>
          <Link
            href="/submit"
            className="w-full shrink-0 rounded-md bg-primary px-4 py-2.5 text-center text-sm font-medium text-primary-foreground transition-all duration-200 hover:opacity-90 active:scale-[0.98] sm:w-auto"
          >
            Contribute a source
          </Link>
        </section>

        <footer className="mt-14 flex flex-col gap-5 border-t border-border pt-7">
          <div className="flex flex-wrap items-center gap-x-5 gap-y-2 font-mono text-xs text-muted-foreground">
            <span className="text-foreground">Feeds</span>
            <Link
              href="/api/status"
              className="underline decoration-border underline-offset-4 transition-colors hover:text-foreground hover:decoration-current"
            >
              /api/status
            </Link>
            <Link
              href="/api/sources"
              className="underline decoration-border underline-offset-4 transition-colors hover:text-foreground hover:decoration-current"
            >
              /api/sources
            </Link>
            <span className="text-muted-foreground/70">key required</span>
          </div>
          {/* Stated inline rather than linked to a fabricated /privacy route — a dead legal link
              is worse than an honest one-line disclosure. */}
          <p className="max-w-[68ch] text-pretty text-xs leading-relaxed text-muted-foreground/80">
            Community project, unaffiliated with Tidal, Qobuz or Deezer. Submissions are stored
            encrypted and are not attributed to contributors. Only aggregate health is public.
          </p>
        </footer>
      </main>
    </div>
  )
}
