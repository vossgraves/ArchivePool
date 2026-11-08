// SPDX-License-Identifier: GPL-3.0-or-later
import Link from "next/link"
import { ArrowLeft, Terminal } from "lucide-react"
import { DocsContent } from "@/components/docs-content"
import { SiteHeader } from "@/components/site-header"
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "@/components/ui/breadcrumb"
import { buttonVariants } from "@/components/ui/button"
import { cn } from "@/lib/utils"

export const metadata = {
  title: "API Documentation & Specifications · ArchivePool",
  description: "REST API endpoints, cryptographic lease formats, and pool governance specifications.",
}

export default function DocsPage() {
  return (
    <div className="min-h-dvh flex flex-col bg-transparent text-foreground">
      <SiteHeader active="docs" />

      <main id="content" className="w-full px-3 pb-16 pt-6 sm:px-4 md:px-6 flex-1">
        {/* Navigation Breadcrumb & Header */}
        <Breadcrumb className="mb-4">
          <BreadcrumbList>
            <BreadcrumbItem>
              <BreadcrumbLink href="/">ArchivePool</BreadcrumbLink>
            </BreadcrumbItem>
            <BreadcrumbSeparator />
            <BreadcrumbItem>
              <BreadcrumbLink href="/">Documentation</BreadcrumbLink>
            </BreadcrumbItem>
            <BreadcrumbSeparator />
            <BreadcrumbItem>
              <BreadcrumbPage>API Reference</BreadcrumbPage>
            </BreadcrumbItem>
          </BreadcrumbList>
        </Breadcrumb>

        <header className="mb-6 flex flex-col gap-3">
          <div className="flex flex-col justify-between gap-4 md:flex-row md:items-end">
            <div className="max-w-3xl">
              <div className="flex items-center gap-2 mb-1.5 font-mono text-[11px] text-muted-foreground">
                <span className="font-semibold text-foreground uppercase tracking-wider">
                  API Reference
                </span>
                <span aria-hidden="true">·</span>
                <span>v1.0 Specification</span>
              </div>
              <h1 className="text-2xl font-bold tracking-tight text-foreground sm:text-3xl">
                Source Pool API
              </h1>
              <p className="mt-2 text-xs leading-relaxed text-muted-foreground sm:text-sm text-pretty">
                ArchivePool provides live, health-verified streaming credentials to approved clients.
                Keys are free, instant, and authenticated as standard Bearer tokens. Explore endpoints,
                lease lifecycles, and error policies below.
              </p>
            </div>

            <div className="flex items-center gap-2 shrink-0">
              <Link
                href="/signup"
                className={cn(buttonVariants({ variant: "default", size: "sm" }), "h-8 text-xs font-medium")}
              >
                Get API Key
              </Link>
              <Link
                href="/dashboard"
                className={cn(buttonVariants({ variant: "outline", size: "sm" }), "h-8 text-xs font-mono")}
              >
                Dashboard
              </Link>
            </div>
          </div>
        </header>

        {/* Accordion Documentation System */}
        <DocsContent />

        {/* Footer */}
        <footer className="mt-12 border-t border-border/80 pt-6 flex flex-wrap items-center justify-between gap-3 text-xs font-mono text-muted-foreground">
          <div className="flex items-center gap-2">
            <Terminal className="size-3.5 text-muted-foreground" />
            <span>ArchivePool Public API v1.0.0</span>
          </div>
          <span>Cryptographically signed · Zero telemetry</span>
        </footer>
      </main>
    </div>
  )
}
