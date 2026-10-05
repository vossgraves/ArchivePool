// SPDX-License-Identifier: GPL-3.0-or-later
import Link from "next/link"
import { ArrowUpRight } from "lucide-react"
import ParticleButton from "@/components/kokonutui/particle-button"
import { SiteHeader } from "@/components/site-header"
import { StatusBoard } from "@/components/status-board"
import { buttonVariants } from "@/components/ui/button"
import { cn } from "@/lib/utils"

export default function Page() {
  return (
    <div className="min-h-dvh">
      <SiteHeader active="status" />

      <main id="content" className="mx-auto max-w-5xl px-4 pb-16 pt-10 sm:pt-14">
        {/* Hero. Deliberately not a centred splash: this is a working status board, so the page
            opens left-aligned with the board itself one screen down, not a marketing fold. */}
        <section className="mb-10 flex flex-col gap-4">
          <span className="label-mono inline-flex w-fit items-center gap-2">
            <span className="relative flex size-1.5" aria-hidden="true">
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-ok opacity-70" />
              <span className="relative inline-flex size-1.5 rounded-full bg-ok" />
            </span>
            Checked every 6 hours
          </span>

          <h1 className="max-w-3xl text-3xl font-semibold leading-[1.1] tracking-tight text-balance sm:text-4xl">
            Live streaming sources, gated by keys
          </h1>

          <p className="max-w-[62ch] text-sm leading-relaxed text-muted-foreground text-pretty">
            The community pool behind ArchiveTune’s multi-source playback. Health-checked every
            six hours, credentials encrypted end-to-end, and the feed is never public — request a
            free API key with an account.
          </p>

          <div className="mt-1 flex flex-wrap items-center gap-2">
            {/* The one conversion action on the page, so it gets the particle burst — rendered as
                a real anchor via Base UI's `render` so middle-click, copy-link and prefetch all
                still behave. Every other button on the site stays plain: the flourish means
                something only while it is rare. */}
            <ParticleButton size="lg" render={<Link href="/signup" />}>
              Get an API key
            </ParticleButton>
            <Link
              href="/docs"
              className={cn(buttonVariants({ variant: "outline", size: "lg" }))}
            >
              Read the API docs
              <ArrowUpRight className="size-3.5" aria-hidden="true" />
            </Link>
            <span className="font-mono text-xs text-muted-foreground">free · no email required</span>
          </div>
        </section>

        <StatusBoard />

        <section className="mt-6 flex flex-col items-start gap-4 rounded-lg border border-border bg-card p-5 edge-lit sm:flex-row sm:items-center sm:justify-between">
          <div className="flex min-w-0 flex-col gap-1">
            <h2 className="text-sm font-semibold tracking-tight">Have a working source?</h2>
            <p className="max-w-[52ch] text-xs leading-relaxed text-muted-foreground text-pretty">
              Adding one keeps the pool alive for everyone. Verification is automatic and takes
              about a minute; signed-in contributors can choose to be credited.
            </p>
          </div>
          <Link
            href="/submit"
            className={cn(buttonVariants({ size: "lg" }), "w-full shrink-0 sm:w-auto")}
          >
            Contribute a source
          </Link>
        </section>

        <footer className="mt-12 flex flex-col gap-4 border-t border-border pt-6">
          <div className="flex flex-wrap items-center gap-x-4 gap-y-2 font-mono text-xs text-muted-foreground">
            <span className="text-foreground">Feeds</span>
            <Link
              href="/api/status"
              className="underline decoration-border underline-offset-4 transition-colors hover:text-foreground hover:decoration-current"
            >
              /api/status
            </Link>
            <Link
              href="/docs"
              className="underline decoration-border underline-offset-4 transition-colors hover:text-foreground hover:decoration-current"
            >
              /docs
            </Link>
            <span>/api/sources is key-gated</span>
          </div>
          <p className="max-w-[68ch] text-pretty text-xs leading-relaxed text-muted-foreground">
            Community project, unaffiliated with Tidal, Qobuz, Deezer or Apple Music. Credentials
            are stored encrypted and are never published — only aggregate health is public.
            Contributors are named on an entry only where they opted in at submission time.
          </p>
        </footer>
      </main>
    </div>
  )
}
