// SPDX-License-Identifier: GPL-3.0-or-later
import Link from "next/link"
import { ArrowLeft, Home, Terminal } from "lucide-react"
import { SiteHeader } from "@/components/site-header"
import { buttonVariants } from "@/components/ui/button"
import { cn } from "@/lib/utils"

export const metadata = {
  title: "404 Not Found · ArchivePool",
  description: "The requested endpoint or resource was not found.",
}

export default function NotFound() {
  return (
    <div className="min-h-dvh flex flex-col bg-background text-foreground">
      <SiteHeader />

      <main id="content" className="flex w-full flex-col items-center justify-center text-center gap-4 px-4 py-24 sm:py-32 flex-1">
        <div className="inline-flex items-center gap-2 rounded-full border border-border bg-secondary/40 px-3 py-1 font-mono text-[11px] text-muted-foreground">
          <span className="size-1.5 rounded-full bg-destructive" aria-hidden="true" />
          <span>HTTP 404 // NOT_FOUND</span>
        </div>

        <h1 className="text-3xl font-bold tracking-tight text-foreground sm:text-4xl">
          Resource Not Found
        </h1>

        <p className="max-w-md font-mono text-xs text-muted-foreground leading-relaxed">
          The requested page, pool category, or feed endpoint could not be resolved.
        </p>

        <div className="mt-4 flex flex-wrap items-center justify-center gap-2.5">
          <Link
            href="/"
            className={cn(buttonVariants({ variant: "default", size: "sm" }), "h-8 px-4 text-xs font-medium gap-1.5")}
          >
            <Home className="size-3.5" aria-hidden="true" />
            <span>Return to Source Pool</span>
          </Link>
          <Link
            href="/docs"
            className={cn(buttonVariants({ variant: "outline", size: "sm" }), "h-8 px-4 text-xs font-mono gap-1.5")}
          >
            <Terminal className="size-3.5 opacity-70" aria-hidden="true" />
            <span>API Docs</span>
          </Link>
        </div>
      </main>
    </div>
  )
}
