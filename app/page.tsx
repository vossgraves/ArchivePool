import Link from "next/link"
import { SiteHeader } from "@/components/site-header"
import { StatusBoard } from "@/components/status-board"

export default function Page() {
  return (
    <main className="min-h-dvh">
      <SiteHeader active="status" />

      <div className="mx-auto max-w-5xl px-5 py-10">
        <section className="mb-10 flex flex-col gap-6">
          <div className="flex flex-col gap-3">
            <span className="font-mono text-xs uppercase tracking-[0.2em] text-muted-foreground">
              ArchiveTune · Community Sources
            </span>
            <h1 className="text-pretty text-3xl font-semibold tracking-tight sm:text-4xl">
              Live status for Tidal &amp; Qobuz sources
            </h1>
            <p className="max-w-2xl text-pretty leading-relaxed text-muted-foreground">
              Anyone can contribute an API endpoint or account. Every entry is health-checked on a
              schedule; only the ones that pass are served to the app. No credentials are shown here.
            </p>
          </div>
        </section>

        <StatusBoard />

        <section className="mt-10 flex flex-col items-start gap-4 rounded-xl border border-dashed border-border p-6 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex flex-col gap-1">
            <h2 className="font-semibold">Have a working source?</h2>
            <p className="text-sm text-muted-foreground">
              Share an API instance or account to keep the pool alive for everyone.
            </p>
          </div>
          <Link
            href="/submit"
            className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-opacity hover:opacity-90"
          >
            Contribute a source
          </Link>
        </section>

        <footer className="mt-12 flex flex-wrap items-center gap-x-6 gap-y-2 border-t border-border pt-6 font-mono text-xs text-muted-foreground">
          <span>App pool feed:</span>
          <Link href="/api/sources" className="underline underline-offset-4 hover:text-foreground">
            /api/sources
          </Link>
          <Link href="/api/status" className="underline underline-offset-4 hover:text-foreground">
            /api/status
          </Link>
        </footer>
      </div>
    </main>
  )
}
