// SPDX-License-Identifier: GPL-3.0-or-later
import type { Metadata } from "next"
import Link from "next/link"
import {
  ArrowLeft,
  CheckCircle2,
  Clock,
  ExternalLink,
  Lock,
  Radio,
  Server,
  Shield,
  ShieldAlert,
  Sparkles,
} from "lucide-react"
import { db } from "@/lib/db"
import { users } from "@/lib/db/schema"
import { eq } from "drizzle-orm"
import { getSessionUserId } from "@/lib/sessions"
import { SiteHeader } from "@/components/site-header"
import { SubmitForm } from "@/components/submit-form"
import { Badge } from "@/components/ui/badge"
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "@/components/ui/breadcrumb"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"

export const metadata: Metadata = {
  title: "Contribute a Source · ArchivePool",
  description: "Contribute an audio streaming API instance or account credential to the community pool.",
}

export default async function SubmitPage() {
  let username: string | null = null
  try {
    const userId = await getSessionUserId()
    if (userId) {
      const [account] = await db
        .select({ username: users.username })
        .from(users)
        .where(eq(users.id, userId))
        .limit(1)
      username = account?.username ?? null
    }
  } catch (err) {
    console.error("[submit] session lookup failed:", err)
  }

  return (
    <div className="relative min-h-dvh flex flex-col bg-transparent text-foreground overflow-x-clip">
      <SiteHeader active="submit" />

      <main id="content" className="relative z-10 w-full px-3 pb-20 pt-6 sm:px-4 md:px-6 flex-1">
        {/* BREADCRUMB */}
        <Breadcrumb className="mb-4">
          <BreadcrumbList>
            <BreadcrumbItem>
              <BreadcrumbLink href="/">ArchivePool</BreadcrumbLink>
            </BreadcrumbItem>
            <BreadcrumbSeparator />
            <BreadcrumbItem>
              <BreadcrumbLink href="/">Community</BreadcrumbLink>
            </BreadcrumbItem>
            <BreadcrumbSeparator />
            <BreadcrumbItem>
              <BreadcrumbPage>Contribute Source</BreadcrumbPage>
            </BreadcrumbItem>
          </BreadcrumbList>
        </Breadcrumb>

        {/* HERO TITLE & STATS STRIP */}
        <div className="mb-8 flex flex-col gap-3">
          <div className="flex flex-col justify-between gap-4 md:flex-row md:items-end">
            <div className="max-w-3xl">
              <div className="flex flex-wrap items-center gap-2 mb-2">
                <Badge tone="ok" dot className="font-mono text-[10px]">
                  Live Submission Gateway
                </Badge>
                <span className="text-border" aria-hidden="true">·</span>
                <span className="font-mono text-xs text-muted-foreground">
                  AES-256-GCM Encrypted at Rest
                </span>
              </div>
              <h1 className="text-2xl font-bold tracking-tight text-foreground sm:text-3xl">
                Contribute a Source
              </h1>
              <p className="mt-2 text-xs leading-relaxed text-muted-foreground sm:text-sm text-pretty">
                Pool streaming instances and credentials to support resilient playback for community audio applications.
                Every submission undergoes a live synthetic probe test before being activated into rotation.
                {username ? ` Signed in as @${username}.` : " No account required."}
              </p>
            </div>

            <div className="flex flex-wrap items-center gap-2 shrink-0">
              <Link
                href="/docs"
                className="inline-flex items-center gap-1.5 rounded-md border border-border px-3 py-1.5 font-mono text-xs text-muted-foreground hover:bg-secondary hover:text-foreground transition-colors"
              >
                <span>Read API Specs</span>
                <ExternalLink className="size-3" />
              </Link>
            </div>
          </div>
        </div>

        {/* TWO-COLUMN WORKSPACE: FORM (8) + COMMUNITY GUIDANCE (4) */}
        <div className="grid grid-cols-1 gap-8 lg:grid-cols-12">
          {/* MAIN COLUMN: INTERACTIVE SOURCE FORM */}
          <div className="lg:col-span-8 flex flex-col gap-6">
            <SubmitForm username={username} />
          </div>

          {/* SIDEBAR COLUMN: SECURITY, PROTOCOL & BEST PRACTICES */}
          <aside className="lg:col-span-4 flex flex-col gap-6">
            {/* SECURITY ASSURANCE */}
            <Card className="border-border bg-card shadow-2xs">
              <CardHeader className="pb-3 border-b border-border/80 bg-secondary/15">
                <div className="flex items-center gap-2">
                  <Shield className="size-4 text-ok" />
                  <CardTitle className="text-xs font-mono font-semibold uppercase tracking-wider text-foreground">
                    Cryptographic Safety
                  </CardTitle>
                </div>
                <CardDescription className="text-xs">
                  How contributed tokens and secrets are stored and protected.
                </CardDescription>
              </CardHeader>
              <CardContent className="p-4 flex flex-col gap-3 text-xs leading-relaxed">
                <div className="flex items-start gap-2.5">
                  <Lock className="size-3.5 mt-0.5 shrink-0 text-muted-foreground" />
                  <div>
                    <strong className="text-foreground">AES-256-GCM Envelope Encryption</strong>
                    <p className="text-muted-foreground mt-0.5">
                      Plaintext secrets are encrypted in-memory before database commit. Keys are rotated on-prem.
                    </p>
                  </div>
                </div>
                <div className="flex items-start gap-2.5">
                  <Radio className="size-3.5 mt-0.5 shrink-0 text-muted-foreground" />
                  <div>
                    <strong className="text-foreground">Zero Plaintext In Public Feeds</strong>
                    <p className="text-muted-foreground mt-0.5">
                      The public `/api/status` endpoint exposes aggregate pool availability and health counts only.
                    </p>
                  </div>
                </div>
                <div className="flex items-start gap-2.5">
                  <Clock className="size-3.5 mt-0.5 shrink-0 text-muted-foreground" />
                  <div>
                    <strong className="text-foreground">Automated Health Probes</strong>
                    <p className="text-muted-foreground mt-0.5">
                      Periodic background sweeps test streams. Non-responsive or rate-limited sources are paused safely.
                    </p>
                  </div>
                </div>
              </CardContent>
            </Card>

            {/* ACCOUNT SAFETY WARNING */}
            <Card className="border-warn/30 bg-warn/5 shadow-2xs">
              <CardHeader className="pb-2">
                <div className="flex items-center gap-2">
                  <ShieldAlert className="size-4 text-warn" />
                  <CardTitle className="text-xs font-mono font-semibold uppercase tracking-wider text-warn">
                    Account Sharing Notice
                  </CardTitle>
                </div>
              </CardHeader>
              <CardContent className="p-4 pt-1 text-xs leading-relaxed text-muted-foreground flex flex-col gap-2">
                <p>
                  Pooled accounts service automated playback requests from multiple client applications simultaneously.
                </p>
                <p>
                  <strong className="text-foreground">Do not submit your primary private account</strong> if you depend on it for uninterrupted daily listening. Use dedicated or secondary accounts.
                </p>
              </CardContent>
            </Card>

            {/* SUPPORTED AUDIO FORMATS & QUALITIES */}
            <Card className="border-border bg-card shadow-2xs">
              <CardHeader className="pb-3 border-b border-border/80 bg-secondary/15">
                <CardTitle className="text-xs font-mono font-semibold uppercase tracking-wider text-foreground">
                  Streaming Quality Profiles
                </CardTitle>
              </CardHeader>
              <CardContent className="p-4 flex flex-col gap-2.5 text-xs">
                <div className="flex items-center justify-between pb-2 border-b border-border/60">
                  <span className="font-medium text-foreground">Tidal</span>
                  <span className="font-mono text-[11px] text-muted-foreground">FLAC 24-bit / 192kHz (Hi-Res)</span>
                </div>
                <div className="flex items-center justify-between pb-2 border-b border-border/60">
                  <span className="font-medium text-foreground">Qobuz</span>
                  <span className="font-mono text-[11px] text-muted-foreground">FLAC 24-bit Studio Master</span>
                </div>
                <div className="flex items-center justify-between pb-2 border-b border-border/60">
                  <span className="font-medium text-foreground">Deezer</span>
                  <span className="font-mono text-[11px] text-muted-foreground">16-bit FLAC / 320k MP3</span>
                </div>
                <div className="flex items-center justify-between pb-2 border-b border-border/60">
                  <span className="font-medium text-foreground">Apple Music</span>
                  <span className="font-mono text-[11px] text-muted-foreground">ALAC Lossless / AAC 256k</span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="font-medium text-foreground">Amazon Music</span>
                  <span className="font-mono text-[11px] text-muted-foreground">HD / Ultra HD Lossless</span>
                </div>
              </CardContent>
            </Card>

            {/* QUICK LINKS */}
            <div className="flex flex-col gap-2 rounded-lg border border-border/80 bg-secondary/20 p-4 text-xs">
              <span className="font-mono text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                Developer Resources
              </span>
              <Link
                href="/docs"
                className="text-foreground hover:underline font-medium inline-flex items-center gap-1.5"
              >
                <span>Read API Reference & Error Codes</span>
                <ArrowLeft className="size-3 rotate-180" />
              </Link>
              <Link
                href="/dashboard"
                className="text-muted-foreground hover:text-foreground font-medium inline-flex items-center gap-1.5"
              >
                <span>View your existing contributions</span>
                <ArrowLeft className="size-3 rotate-180" />
              </Link>
            </div>
          </aside>
        </div>
      </main>
    </div>
  )
}
