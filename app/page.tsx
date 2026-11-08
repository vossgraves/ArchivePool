// SPDX-License-Identifier: GPL-3.0-or-later
import Link from "next/link"
import { ArrowUpRight, Plus, Terminal } from "lucide-react"
import ParticleButton from "@/components/kokonutui/particle-button"
import { SiteHeader } from "@/components/site-header"
import { StatusBoard } from "@/components/status-board"
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "@/components/ui/breadcrumb"
import { buttonVariants } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import { cn } from "@/lib/utils"

export default function Page() {
  return (
    <div className="min-h-dvh flex flex-col bg-transparent text-foreground">
      <SiteHeader active="status" />

      <main id="content" className="w-full px-3 py-6 sm:px-4 md:px-6 flex-1">
        {/* BREADCRUMB */}
        <Breadcrumb className="mb-4">
          <BreadcrumbList>
            <BreadcrumbItem>
              <BreadcrumbLink href="/">ArchivePool</BreadcrumbLink>
            </BreadcrumbItem>
            <BreadcrumbSeparator />
            <BreadcrumbItem>
              <BreadcrumbLink href="/">Infrastructure</BreadcrumbLink>
            </BreadcrumbItem>
            <BreadcrumbSeparator />
            <BreadcrumbItem>
              <BreadcrumbPage>Source Pool</BreadcrumbPage>
            </BreadcrumbItem>
          </BreadcrumbList>
        </Breadcrumb>

        {/* TOP CONTROL / HEADER SECTION */}
        <section className="mb-8 flex flex-col gap-3">
          <div className="flex flex-col justify-between gap-4 md:flex-row md:items-end">
            <div className="max-w-3xl">
              <h1 className="text-2xl font-bold tracking-tight text-foreground sm:text-3xl">
                Source Pool
              </h1>
              <p className="mt-2 text-xs leading-relaxed text-muted-foreground sm:text-sm text-pretty">
                Live health and credential pool for community-contributed streaming sources.
                Verified on schedule, encrypted end-to-end at rest, and served via private API keys.
              </p>
            </div>

            <div className="flex flex-wrap items-center gap-2 shrink-0">
              <ParticleButton size="sm" render={<Link href="/signup" />} className="h-8 text-xs font-medium">
                Get an API key
              </ParticleButton>
              <Link
                href="/docs"
                className={cn(buttonVariants({ variant: "outline", size: "sm" }), "h-8 text-xs font-mono gap-1.5")}
              >
                <Terminal className="size-3.5 opacity-70" aria-hidden="true" />
                <span>API Docs</span>
              </Link>
              <Link
                href="/submit"
                className={cn(buttonVariants({ variant: "secondary", size: "sm" }), "h-8 text-xs font-medium gap-1")}
              >
                <Plus className="size-3.5" aria-hidden="true" />
                <span>Contribute</span>
              </Link>
            </div>
          </div>
        </section>

        {/* MAIN STATUS MONITOR */}
        <StatusBoard />

        {/* DEVELOPER-ORIENTED CONTRIBUTION CALLOUT */}
        <Card className="mt-8 border-border bg-card shadow-2xs">
          <CardContent className="p-4 sm:p-5">
            <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
              <div className="flex flex-col gap-1">
                <div className="flex items-center gap-2">
                  <span className="font-mono text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                    Community Network
                  </span>
                  <span className="inline-block size-1 rounded-full bg-border" aria-hidden="true" />
                  <span className="font-mono text-[10px] text-muted-foreground">Automated Testing</span>
                </div>
                <h3 className="text-sm font-semibold tracking-tight text-foreground">
                  Have a working streaming source?
                </h3>
                <p className="max-w-2xl text-xs leading-relaxed text-muted-foreground text-pretty">
                  Adding one keeps the pool resilient for audio clients and community tools. Verification is automated and runs in ~60s;
                  credentials are encrypted with AES-256-GCM.
                </p>
              </div>

              <div className="flex flex-col gap-1.5 shrink-0 sm:items-end">
                <Link
                  href="/submit"
                  className={cn(buttonVariants({ variant: "default", size: "sm" }), "h-8 px-3.5 text-xs font-medium w-full sm:w-auto")}
                >
                  <span>Contribute a source</span>
                  <ArrowUpRight className="size-3.5 ml-1" aria-hidden="true" />
                </Link>
                <span className="font-mono text-[10px] text-muted-foreground text-center sm:text-right">
                  No account required to submit
                </span>
              </div>
            </div>
          </CardContent>
        </Card>

        {/* FOOTER */}
        <footer className="mt-12 flex flex-col gap-4 border-t border-border/80 pt-6">
          <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-2 font-mono text-[11px] text-muted-foreground">
            <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
              <span className="font-semibold text-foreground uppercase tracking-wider">Endpoints:</span>
              <Link
                href="/api/status"
                className="underline decoration-border/80 underline-offset-4 transition-colors hover:text-foreground hover:decoration-foreground"
              >
                GET /api/status (public)
              </Link>
              <span className="text-border" aria-hidden="true">·</span>
              <Link
                href="/docs"
                className="underline decoration-border/80 underline-offset-4 transition-colors hover:text-foreground hover:decoration-foreground"
              >
                /docs
              </Link>
              <span className="text-border" aria-hidden="true">·</span>
              <span>GET /api/sources (key-gated)</span>
            </div>

            <span className="font-mono text-[10px] text-muted-foreground">
              ArchivePool · E2E Encrypted Feed
            </span>
          </div>

          <p className="text-pretty text-[11px] leading-relaxed text-muted-foreground">
            Independent community infrastructure project, unaffiliated with Tidal, Qobuz, Deezer or Apple Music.
            Credentials are stored encrypted and are never published — only aggregate health is public.
            Contributors are named on an entry only where opted-in at submission time.
          </p>
        </footer>
      </main>
    </div>
  )
}
