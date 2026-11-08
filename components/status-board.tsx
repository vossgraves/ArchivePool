// SPDX-License-Identifier: GPL-3.0-or-later
"use client"

import { useEffect, useMemo, useState } from "react"
import Link from "next/link"
import useSWR from "swr"
import { motion, useReducedMotion } from "motion/react"
import {
  Activity,
  AlertTriangle,
  ArrowUpRight,
  Clock,
  ExternalLink,
  Layers,
  LayoutGrid,
  List,
  RefreshCw,
  Search,
  ShieldCheck,
  Terminal,
  X,
} from "lucide-react"
import type { CategoryStatus, UptimePoint } from "@/lib/queries"
import { Badge, StatusDot, TONE_TEXT, toneFor, type StatusTone } from "@/components/ui/badge"
import { Button, buttonVariants } from "@/components/ui/button"
import { BarSeries, SegmentBar, Sparkline, TrendChart } from "@/components/ui/chart"
import { CopyButton } from "@/components/ui/copy-button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Empty } from "@/components/ui/empty"
import { Frame, FrameDescription, FrameFooter, FrameHeader, FramePanel, FrameTitle } from "@/components/ui/frame"
import { Notice } from "@/components/ui/notice"
import { Panel } from "@/components/ui/panel"
import { Skeleton } from "@/components/ui/skeleton"
import { Stat, StatIndicator, StatLabel, StatValue, useCountUp } from "@/components/ui/stat"
import {
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableFooter,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { cn, formatAgo, formatCount, formatDateTime } from "@/lib/utils"

interface StatusPayload {
  generatedAt: string
  categories: CategoryStatus[]
  history?: {
    days: number
    overall: UptimePoint[]
    categories: { service: string; kind: string; points: UptimePoint[] }[]
  }
}

type Stats = Pick<CategoryStatus, "total" | "alive" | "premium" | "dead" | "pending">

async function fetcher(url: string): Promise<StatusPayload> {
  const res = await fetch(url)
  if (!res.ok) {
    const detail = await res
      .json()
      .then((body: { detail?: string }) => body?.detail)
      .catch(() => undefined)
    throw new Error(
      detail ? `status feed responded ${res.status}: ${detail}` : `status feed responded ${res.status}`,
    )
  }
  return (await res.json()) as StatusPayload
}

const SKELETON_COUNT = 6

const HEALTH: Record<CategoryStatus["health"], { label: string; tone: StatusTone }> = {
  operational: { label: "Operational", tone: toneFor("operational") },
  degraded: { label: "Degraded", tone: toneFor("degraded") },
  down: { label: "Down", tone: toneFor("down") },
  unknown: { label: "No data", tone: toneFor("unknown") },
}

const COLUMNS: { label: string; head: string }[] = [
  { label: "Category", head: "text-left" },
  { label: "Health", head: "text-left" },
  { label: "Total", head: "text-right" },
  { label: "Alive", head: "text-right" },
  { label: "Premium", head: "text-right" },
  { label: "Pending", head: "text-right" },
  { label: "Dead", head: "text-right" },
  { label: "Uptime", head: "text-right" },
  { label: "14d", head: "text-left" },
  { label: "Mix", head: "text-left" },
  { label: "Checked", head: "text-left" },
]
const COLUMN_COUNT = COLUMNS.length

const NUM_CELL = "px-3 py-2.5 text-right font-mono text-xs tabular-nums whitespace-nowrap"
const TXT_CELL = "px-3 py-2.5 whitespace-nowrap text-xs"
const ROW = "border-b border-border/60 transition-colors hover:bg-secondary/40 cursor-pointer"

function overallHealth(cats: CategoryStatus[]) {
  const known = cats.filter((c) => c.health !== "unknown")
  if (known.length === 0) return { label: "Awaiting first data", health: "unknown" as const }
  if (known.every((c) => c.health === "operational"))
    return { label: "All systems operational", health: "operational" as const }
  if (known.some((c) => c.health === "down"))
    return { label: "Partial outage detected", health: "down" as const }
  return { label: "Degraded performance", health: "degraded" as const }
}

function sumStats(cats: CategoryStatus[]): Stats {
  return cats.reduce<Stats>(
    (a, c) => ({
      total: a.total + c.total,
      alive: a.alive + c.alive,
      premium: a.premium + c.premium,
      dead: a.dead + c.dead,
      pending: a.pending + c.pending,
    }),
    { total: 0, alive: 0, premium: 0, dead: 0, pending: 0 }
  )
}

function rateTone(pct: number | null): StatusTone {
  if (pct === null) return "neutral"
  return pct >= 95 ? "ok" : pct >= 80 ? "warn" : "danger"
}

function asPoints(points: UptimePoint[] | undefined) {
  return (points ?? []).map((p) => ({ label: p.label, value: p.pct, partial: p.partial }))
}

function mixSegments(stats: Stats) {
  return [
    { value: stats.premium, tone: "ok" as const },
    { value: Math.max(stats.alive - stats.premium, 0), tone: "neutral" as const, muted: true },
    { value: stats.pending, tone: "warn" as const },
    { value: stats.dead, tone: "danger" as const },
  ]
}

export function StatusBoard({ fallback }: { fallback?: StatusPayload }) {
  const reduce = useReducedMotion()
  const animate = !reduce
  const { data, error, isLoading, mutate } = useSWR("/api/status", fetcher, {
    fallbackData: fallback,
    refreshInterval: 5 * 60 * 60 * 1000,
    revalidateOnFocus: true,
  })

  const categories = data?.categories ?? []
  const overall = overallHealth(categories)
  const totals = sumStats(categories)
  const aliveCount = useCountUp(totals.alive, animate)
  const premiumCount = useCountUp(totals.premium, animate)
  const trouble = categories.filter((c) => c.health === "degraded" || c.health === "down")
  const history = data?.history
  const windowChecks = (history?.overall ?? []).reduce((a, p) => a + p.checks, 0)
  const windowOk = (history?.overall ?? []).reduce((a, p) => a + p.ok, 0)
  const windowPct = windowChecks > 0 ? Math.round((windowOk / windowChecks) * 1000) / 10 : null
  const sparkFor = (service: string, kind: string) =>
    history?.categories.find((c) => c.service === service && c.kind === kind)?.points

  const [announcement, setAnnouncement] = useState<string | null>(null)
  const [refreshing, setRefreshing] = useState(false)
  const [serviceFilter, setServiceFilter] = useState<string>("all")
  const [searchQuery, setSearchQuery] = useState<string>("")
  const [mobileLayout, setMobileLayout] = useState<"table" | "cards">("table")
  const [selectedPool, setSelectedPool] = useState<CategoryStatus | null>(null)
  // The diagnostics dialog only opens after a client-side click, so derive the host from the
  // current tab rather than hardcoding one that is wrong for preview and self-hosted deploys.
  const leaseUrl = selectedPool
    ? `${typeof window !== "undefined" ? window.location.origin : ""}/api/sources?service=${selectedPool.service}&kind=${selectedPool.kind}`
    : ""

  async function refresh() {
    if (refreshing) return
    setRefreshing(true)
    setAnnouncement("Refreshing…")
    try {
      await mutate()
      setAnnouncement("Refreshed")
    } catch {
      setAnnouncement("Refresh failed — showing the last good figures")
    } finally {
      setRefreshing(false)
    }
  }

  useEffect(() => {
    if (!announcement) return
    const t = setTimeout(() => setAnnouncement(null), 6000)
    return () => clearTimeout(t)
  }, [announcement])

  const skeleton = isLoading && !data

  // Filtered categories for table display
  const filteredCategories = useMemo(() => {
    return categories.filter((c) => {
      const matchesService =
        serviceFilter === "all" || c.service.toLowerCase() === serviceFilter.toLowerCase()
      const query = searchQuery.trim().toLowerCase()
      const matchesSearch =
        !query ||
        c.label.toLowerCase().includes(query) ||
        c.service.toLowerCase().includes(query) ||
        c.kind.toLowerCase().includes(query)
      return matchesService && matchesSearch
    })
  }, [categories, serviceFilter, searchQuery])

  // Services available for filter tabs
  const availableServices = useMemo(() => {
    const set = new Set<string>()
    categories.forEach((c) => set.add(c.service))
    return Array.from(set)
  }, [categories])

  return (
    <div className="flex flex-col gap-6">
      {/* SECTION 1: LIVE TELEMETRY & HEALTH */}
      <Frame className="border-border bg-card shadow-2xs">
        <FrameHeader dots={true} className="[&>div]:flex-wrap [&>div]:gap-y-2 border-b border-border/80 bg-secondary/30 px-4 py-3 sm:px-5">
          <div className="flex min-w-0 basis-full items-center gap-2.5 sm:basis-auto sm:flex-1">
            <StatusDot
              tone={HEALTH[overall.health].tone}
              pulse={animate && overall.health === "operational"}
              className="size-2.5 shrink-0"
            />
            <div className="flex min-w-0 flex-wrap items-baseline gap-x-2.5 gap-y-0.5">
              <span className="text-sm font-semibold tracking-tight text-foreground">
                {overall.label}
              </span>
              <span className="font-mono text-xs text-muted-foreground">
                {data
                  ? `${categories.length} ${categories.length === 1 ? "pool" : "pools"} monitored · ${
                      trouble.length === 0
                        ? "zero active incidents"
                        : `${trouble.length} reporting incident`
                    }`
                  : "Connecting to status feed…"}
              </span>
            </div>
          </div>

          <div className="ml-auto flex shrink-0 items-center gap-2.5 sm:ml-0">
            <span
              className="inline-flex items-center gap-1.5 font-mono text-xs text-muted-foreground"
              title={data?.generatedAt ? formatDateTime(data.generatedAt) : undefined}
            >
              <Clock className="size-3 opacity-70" aria-hidden="true" />
              <span role="status" aria-live="polite">
                {announcement ? (
                  announcement
                ) : data?.generatedAt ? (
                  `Checked ${formatAgo(data.generatedAt)}`
                ) : (
                  "Awaiting first data"
                )}
              </span>
            </span>

            <Button
              variant="outline"
              size="sm"
              onClick={() => void refresh()}
              disabled={refreshing}
              className="h-7 gap-1.5 px-2.5 text-xs font-mono"
            >
              <RefreshCw
                className={cn("size-3", refreshing && "animate-spin text-foreground")}
                aria-hidden="true"
              />
              <span>{refreshing ? "Refreshing…" : "Refresh"}</span>
            </Button>
          </div>
        </FrameHeader>

        {/* 5-Column Metrics Grid */}
        <div className="grid grid-cols-2 divide-x divide-y divide-border/60 sm:grid-cols-3 sm:divide-y-0 lg:grid-cols-5 bg-card">
          {/* Stat 1: Total */}
          <div className="flex flex-col justify-between p-4 sm:p-4.5">
            <StatLabel>Total Sources</StatLabel>
            <div className="mt-2 flex items-baseline gap-2">
              {skeleton ? (
                <Skeleton className="h-7 w-16" />
              ) : (
                <StatValue>{data ? formatCount(totals.total) : "—"}</StatValue>
              )}
            </div>
            <StatIndicator tone="neutral" className="mt-1 text-muted-foreground">
              Across all categories
            </StatIndicator>
          </div>

          {/* Stat 2: Alive */}
          <div className="flex flex-col justify-between p-4 sm:p-4.5">
            <StatLabel>Alive & Serving</StatLabel>
            <div className="mt-2 flex items-baseline gap-2">
              {skeleton ? (
                <Skeleton className="h-7 w-16" />
              ) : (
                <>
                  <StatValue tone="ok">{data ? formatCount(aliveCount) : "—"}</StatValue>
                  {data && totals.total > 0 && (
                    <span className="font-mono text-xs text-muted-foreground tabular-nums">
                      ({Math.round((totals.alive / totals.total) * 100)}%)
                    </span>
                  )}
                </>
              )}
            </div>
            <StatIndicator tone="ok" className="mt-1">
              Passing health checks
            </StatIndicator>
          </div>

          {/* Stat 3: Premium */}
          <div className="flex flex-col justify-between p-4 sm:p-4.5">
            <StatLabel>Premium Tier</StatLabel>
            <div className="mt-2 flex items-baseline gap-2">
              {skeleton ? (
                <Skeleton className="h-7 w-14" />
              ) : (
                <StatValue className={totals.premium > 0 ? "text-foreground" : "text-muted-foreground"}>
                  {data ? formatCount(premiumCount) : "—"}
                </StatValue>
              )}
            </div>
            <StatIndicator tone="neutral" className="mt-1 text-muted-foreground">
              Hi-Res & lossless tier
            </StatIndicator>
          </div>

          {/* Stat 4: Dead */}
          <div className="flex flex-col justify-between p-4 sm:p-4.5">
            <StatLabel>Unreachable</StatLabel>
            <div className="mt-2 flex items-baseline gap-2">
              {skeleton ? (
                <Skeleton className="h-7 w-12" />
              ) : (
                <StatValue tone={totals.dead > 0 ? "danger" : "neutral"} className={totals.dead > 0 ? "text-destructive" : "text-muted-foreground"}>
                  {data ? formatCount(totals.dead) : "—"}
                </StatValue>
              )}
            </div>
            <StatIndicator tone={totals.dead > 0 ? "danger" : "neutral"} className="mt-1">
              {totals.dead > 0 ? "Quarantined by sweep" : "0 failing"}
            </StatIndicator>
          </div>

          {/* Stat 5: Uptime */}
          <div className="col-span-2 flex flex-col justify-between p-4 sm:col-span-1 sm:p-4.5">
            <StatLabel>14d Pass Rate</StatLabel>
            <div className="mt-2 flex items-baseline gap-2">
              {skeleton ? (
                <Skeleton className="h-7 w-16" />
              ) : (
                <StatValue tone={rateTone(windowPct)}>
                  {windowPct === null ? "—" : `${windowPct}%`}
                </StatValue>
              )}
            </div>
            <StatIndicator tone="neutral" className="mt-1 text-muted-foreground">
              {windowChecks > 0 ? `${formatCount(windowChecks)} sweep checks` : "Lifetime aggregate"}
            </StatIndicator>
          </div>
        </div>

        {/* Incident Alert if any pool degraded */}
        {data && trouble.length > 0 ? (
          <div className="border-t border-destructive/20 bg-destructive/5 px-4 py-3 sm:px-5">
            <div className="flex items-start gap-2.5">
              <AlertTriangle className="mt-0.5 size-4 shrink-0 text-destructive" aria-hidden="true" />
              <div className="flex-1">
                <p className="text-xs font-semibold text-destructive">
                  Degraded source categories detected
                </p>
                <ul className="mt-1.5 flex flex-wrap gap-x-4 gap-y-1 font-mono text-[11px] text-muted-foreground">
                  {trouble.map((c) => (
                    <li key={`${c.service}-${c.kind}`} className="flex items-center gap-1.5">
                      <span className="text-foreground">{c.label}:</span>
                      <span className={TONE_TEXT[HEALTH[c.health].tone]}>
                        {formatCount(c.alive)} of {formatCount(c.total)} alive
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            </div>
          </div>
        ) : null}
      </Frame>

      {/* Error Notice */}
      {error ? (
        <Notice tone="error">
          {data
            ? `Could not refresh status feed. Displaying cached snapshot from ${formatDateTime(data.generatedAt)}.`
            : "The status feed could not be loaded."}{" "}
          <span className="font-mono text-xs opacity-80">
            {error instanceof Error ? error.message : "feed unavailable"}
          </span>
        </Notice>
      ) : null}

      {/* SECTION 2: UPTIME TREND & CHECKS ANALYTICS */}
      {history && windowChecks > 0 ? (
        <Panel
          label={`Uptime & Verification · Last ${history.days} days`}
          description="Automated sweep health results. A day without bars indicates sweep pause or maintenance window."
          bodyClassName="grid gap-6 md:grid-cols-2"
        >
          <div className="flex flex-col gap-2">
            <div className="flex items-baseline justify-between gap-3">
              <h3 className="font-mono text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
                Daily Pass Rate
              </h3>
              <span className="font-mono text-sm font-semibold tabular-nums text-foreground">
                {windowPct === null ? "—" : `${formatCount(windowPct)}%`}
              </span>
            </div>
            <TrendChart
              max={100}
              maxLabel="100%"
              tone={rateTone(windowPct)}
              format={(n) => `${formatCount(n)}%`}
              points={asPoints(history.overall)}
            />
          </div>

          <div className="flex flex-col gap-2">
            <div className="flex items-baseline justify-between gap-3">
              <h3 className="font-mono text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
                Verification Sweeps
              </h3>
              <span className="font-mono text-sm font-semibold tabular-nums text-foreground">
                {formatCount(windowChecks)} total
              </span>
            </div>
            <BarSeries
              format={(n) => formatCount(n)}
              columns={history.overall.map((p) => ({
                label: p.label,
                partial: p.partial,
                segments: [
                  { label: "failed", value: p.checks - p.ok, tone: "danger" as const },
                  { label: "passed", value: p.ok, tone: "ok" as const },
                ],
              }))}
            />
          </div>
        </Panel>
      ) : null}

      {/* SECTION 3: POOLS HEALTH & ROBUSTNESS TABLE */}
      <section className="overflow-hidden rounded-lg border border-border bg-card shadow-2xs">
        {/* Table Toolbar */}
        <div className="flex flex-col gap-3 border-b border-border/80 p-4 sm:flex-row sm:items-center sm:justify-between sm:px-5">
          <div>
            <div className="flex items-center gap-2">
              <h2 className="font-mono text-xs font-semibold tracking-wider uppercase text-muted-foreground">
                Pool Categories
              </h2>
              <Badge tone="neutral" className="text-[10px]">
                {data ? `${filteredCategories.length} of ${categories.length}` : "6 pools"}
              </Badge>
            </div>
            <p className="mt-1 text-xs text-muted-foreground">
              Total is everything pooled; Alive is served by API. Click any category to inspect telemetry.
            </p>
          </div>

          {/* Filter tabs and search */}
          <div className="flex flex-wrap items-center gap-2">
            {/* Category filter tabs */}
            <div className="flex items-center rounded-md border border-border/80 bg-secondary/40 p-0.5">
              <button
                type="button"
                onClick={() => setServiceFilter("all")}
                className={cn(
                  "rounded-sm px-2.5 py-1 font-mono text-[11px] font-medium transition-colors",
                  serviceFilter === "all"
                    ? "bg-background text-foreground shadow-2xs"
                    : "text-muted-foreground hover:text-foreground"
                )}
              >
                All
              </button>
              {availableServices.map((svc) => (
                <button
                  key={svc}
                  type="button"
                  onClick={() => setServiceFilter(svc)}
                  className={cn(
                    "rounded-sm px-2.5 py-1 font-mono text-[11px] font-medium capitalize transition-colors",
                    serviceFilter === svc
                      ? "bg-background text-foreground shadow-2xs"
                      : "text-muted-foreground hover:text-foreground"
                  )}
                >
                  {svc}
                </button>
              ))}
            </div>

            {/* Quick search input */}
            <div className="relative">
              <Search
                className="pointer-events-none absolute left-2.5 top-1/2 size-3 -translate-y-1/2 text-muted-foreground"
                aria-hidden="true"
              />
              <input
                type="text"
                placeholder="Filter pools…"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="h-7 w-32 rounded-md border border-border/80 bg-background/50 pl-7 pr-6 font-mono text-[11px] text-foreground transition-colors placeholder:text-muted-foreground focus:border-ring focus:outline-none sm:w-40"
              />
              {searchQuery && (
                <button
                  type="button"
                  onClick={() => setSearchQuery("")}
                  className="absolute right-1.5 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground p-0.5 cursor-pointer"
                  aria-label="Clear filter"
                >
                  <X className="size-3" />
                </button>
              )}
            </div>

            {/* Mobile View Toggle */}
            <div className="flex sm:hidden items-center rounded-md border border-border/80 bg-secondary/40 p-0.5">
              <button
                type="button"
                onClick={() => setMobileLayout("table")}
                aria-label="Table view"
                className={cn(
                  "rounded-sm p-1 transition-colors",
                  mobileLayout === "table" ? "bg-background text-foreground shadow-2xs" : "text-muted-foreground"
                )}
              >
                <List className="size-3.5" />
              </button>
              <button
                type="button"
                onClick={() => setMobileLayout("cards")}
                aria-label="Cards view"
                className={cn(
                  "rounded-sm p-1 transition-colors",
                  mobileLayout === "cards" ? "bg-background text-foreground shadow-2xs" : "text-muted-foreground"
                )}
              >
                <LayoutGrid className="size-3.5" />
              </button>
            </div>
          </div>
        </div>

        {/* Mobile Cards View */}
        {mobileLayout === "cards" && (
          skeleton ? (
            <div className="flex flex-col divide-y divide-border/60 sm:hidden">
              {Array.from({ length: 4 }).map((_, i) => (
                <div key={i} className="flex flex-col gap-3 p-4">
                  <div className="flex items-center justify-between">
                    <div className="flex flex-col gap-1.5">
                      <Skeleton className="h-4 w-32" />
                      <Skeleton className="h-2.5 w-20" />
                    </div>
                    <Skeleton variant="pill" className="h-5 w-20" />
                  </div>
                  <div className="grid grid-cols-4 gap-2 border-y border-border/40 py-2.5">
                    {Array.from({ length: 4 }).map((_, j) => (
                      <div key={j} className="flex flex-col items-center gap-1.5">
                        <Skeleton className="h-2.5 w-8" />
                        <Skeleton className="h-3.5 w-10" />
                      </div>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <div className="flex flex-col divide-y divide-border/60 sm:hidden">
              {filteredCategories.length === 0 ? (
                <div className="p-6">
                  <Empty title="No matching pools">
                    No pools matched the selected filter or search term.
                  </Empty>
                </div>
              ) : (
                filteredCategories.map((cat) => {
                  const health = HEALTH[cat.health]
                  return (
                    <div
                      key={`${cat.service}-${cat.kind}`}
                      onClick={() => setSelectedPool(cat)}
                      className="flex flex-col gap-3 p-4 hover:bg-secondary/20 transition-colors cursor-pointer"
                    >
                      <div className="flex items-center justify-between">
                        <div>
                          <h4 className="text-sm font-semibold text-foreground">{cat.label}</h4>
                          <span className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
                            {cat.service} · {cat.kind}
                          </span>
                        </div>
                        <Badge tone={health.tone} dot>
                          {health.label}
                        </Badge>
                      </div>

                      <div className="grid grid-cols-4 gap-2 border-y border-border/40 py-2.5 text-center">
                        <div>
                          <span className="block font-mono text-[10px] text-muted-foreground">TOTAL</span>
                          <span className="font-mono text-xs font-semibold tabular-nums text-foreground">
                            {formatCount(cat.total)}
                          </span>
                        </div>
                        <div>
                          <span className="block font-mono text-[10px] text-muted-foreground">ALIVE</span>
                          <span className="font-mono text-xs font-semibold tabular-nums text-ok">
                            {formatCount(cat.alive)}
                          </span>
                        </div>
                        <div>
                          <span className="block font-mono text-[10px] text-muted-foreground">PREM</span>
                          <span className="font-mono text-xs font-semibold tabular-nums text-foreground">
                            {formatCount(cat.premium)}
                          </span>
                        </div>
                        <div>
                          <span className="block font-mono text-[10px] text-muted-foreground">UPTIME</span>
                          <span className="font-mono text-xs font-semibold tabular-nums text-foreground">
                            {cat.uptimePct === null ? "—" : `${formatCount(cat.uptimePct)}%`}
                          </span>
                        </div>
                      </div>

                      <div className="flex items-center justify-between text-[11px] text-muted-foreground">
                        <div className="flex items-center gap-2">
                          <span className="font-mono text-[10px]">Mix:</span>
                          <SegmentBar segments={mixSegments(cat)} className="w-24" />
                        </div>
                        <span className="font-mono text-[10px]">
                          {formatAgo(cat.lastCheckedAt)}
                        </span>
                      </div>
                    </div>
                  )
                })
              )}
            </div>
          )
        )}

        {/* Standard High-Density Data Table */}
        <div className={cn("relative w-full overflow-x-auto", mobileLayout === "cards" && "hidden sm:block")}>
          <Table className="min-w-[62rem] text-left text-xs">
            <TableCaption className="sr-only">
              Pool status by category: entry counts, uptime and the time of the last health check
            </TableCaption>
            <TableHeader>
              <TableRow className="border-b border-border/80 bg-secondary/30 hover:bg-secondary/30">
                {COLUMNS.map((col) => (
                  <TableHead
                    key={col.label}
                    scope="col"
                    className={cn(
                      "h-8 px-3 py-2 font-mono text-[11px] font-semibold uppercase tracking-wider text-muted-foreground",
                      col.head
                    )}
                  >
                    {col.label}
                  </TableHead>
                ))}
              </TableRow>
            </TableHeader>
            <TableBody>
              {skeleton ? (
                Array.from({ length: SKELETON_COUNT }).map((_, i) => (
                  <TableRow key={i} className="border-b border-border/60 hover:bg-transparent">
                    <TableCell className="px-3 py-2.5">
                      <div className="flex flex-col gap-1.5">
                        <Skeleton className="h-3.5 w-28 sm:w-32" />
                        <Skeleton className="h-2.5 w-16" />
                      </div>
                    </TableCell>
                    <TableCell className={TXT_CELL}>
                      <Skeleton variant="pill" className="h-5 w-20" />
                    </TableCell>
                    <TableCell className={NUM_CELL}>
                      <Skeleton className="ml-auto h-4 w-8" />
                    </TableCell>
                    <TableCell className={NUM_CELL}>
                      <Skeleton className="ml-auto h-4 w-8" />
                    </TableCell>
                    <TableCell className={NUM_CELL}>
                      <Skeleton className="ml-auto h-4 w-8" />
                    </TableCell>
                    <TableCell className={NUM_CELL}>
                      <Skeleton className="ml-auto h-4 w-8" />
                    </TableCell>
                    <TableCell className={NUM_CELL}>
                      <Skeleton className="ml-auto h-4 w-8" />
                    </TableCell>
                    <TableCell className={NUM_CELL}>
                      <Skeleton className="ml-auto h-4 w-12" />
                    </TableCell>
                    <TableCell className="px-3 py-2.5">
                      <Skeleton className="h-4 w-16" />
                    </TableCell>
                    <TableCell className="px-3 py-2.5">
                      <Skeleton className="h-2 w-20" />
                    </TableCell>
                    <TableCell className={TXT_CELL}>
                      <Skeleton className="h-3.5 w-16" />
                    </TableCell>
                  </TableRow>
                ))
              ) : filteredCategories.length === 0 ? (
                <TableRow className="border-0 hover:bg-transparent">
                  <TableCell colSpan={COLUMN_COUNT} className="p-8">
                    <Empty
                      title={data ? "No matching pools" : "Awaiting first data"}
                      action={
                        <Button variant="outline" size="sm" onClick={() => void refresh()}>
                          Refresh status
                        </Button>
                      }
                    >
                      {data
                        ? "No pools matched your current search and filter settings."
                        : "No figures yet — the feed has not answered this visit."}
                    </Empty>
                  </TableCell>
                </TableRow>
              ) : (
                filteredCategories.map((cat) => {
                  const health = HEALTH[cat.health]
                  return (
                    <TableRow
                      key={`${cat.service}-${cat.kind}`}
                      className={ROW}
                      onClick={() => setSelectedPool(cat)}
                      title="Click to view category details"
                    >
                      {/* Column 1: Category */}
                      <TableHead
                        scope="row"
                        className="h-auto px-3 py-2.5 text-left font-medium text-foreground whitespace-nowrap"
                      >
                        <div className="flex flex-col">
                          <span className="font-medium text-foreground">{cat.label}</span>
                          <span className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
                            {cat.service} · {cat.kind}
                          </span>
                        </div>
                      </TableHead>

                      {cat.total === 0 ? (
                        <TableCell colSpan={COLUMN_COUNT - 1} className="px-3 py-2">
                          <div className="flex items-center justify-between rounded-md border border-dashed border-border/80 bg-secondary/20 px-3 py-2 text-xs">
                            <span className="text-muted-foreground">No entries in this pool yet.</span>
                            <Link
                              href="/submit"
                              onClick={(e) => e.stopPropagation()}
                              className={cn(buttonVariants({ variant: "outline", size: "xs" }), "h-6 text-[10px]")}
                            >
                              Contribute one
                            </Link>
                          </div>
                        </TableCell>
                      ) : (
                        <>
                          {/* Column 2: Health */}
                          <TableCell className={TXT_CELL}>
                            <Badge tone={health.tone} dot>
                              {health.label}
                            </Badge>
                          </TableCell>

                          {/* Column 3: Total */}
                          <TableCell className={NUM_CELL}>{formatCount(cat.total)}</TableCell>

                          {/* Column 4: Alive */}
                          <TableCell className={cn(NUM_CELL, "font-medium text-foreground")}>
                            {formatCount(cat.alive)}
                          </TableCell>

                          {/* Column 5: Premium */}
                          <TableCell
                            className={cn(NUM_CELL, cat.premium > 0 && TONE_TEXT[toneFor("alive")])}
                          >
                            {formatCount(cat.premium)}
                          </TableCell>

                          {/* Column 6: Pending */}
                          <TableCell
                            className={cn(NUM_CELL, cat.pending > 0 && TONE_TEXT[toneFor("pending")])}
                          >
                            {formatCount(cat.pending)}
                          </TableCell>

                          {/* Column 7: Dead */}
                          <TableCell
                            className={cn(NUM_CELL, cat.dead > 0 && TONE_TEXT[toneFor("dead")])}
                          >
                            {formatCount(cat.dead)}
                          </TableCell>

                          {/* Column 8: Uptime */}
                          <TableCell className={NUM_CELL}>
                            {cat.uptimePct === null ? (
                              <span aria-hidden="true" className="text-muted-foreground">
                                —
                              </span>
                            ) : (
                              `${formatCount(cat.uptimePct)}%`
                            )}
                          </TableCell>

                          {/* Column 9: 14d Sparkline */}
                          <TableCell className="px-3 py-2.5">
                            <Sparkline
                              className="h-5 w-16"
                              max={100}
                              tone={rateTone(cat.uptimePct)}
                              points={asPoints(sparkFor(cat.service, cat.kind))}
                              label={`${cat.label}: daily pass rate over 14 days`}
                            />
                          </TableCell>

                          {/* Column 10: Mix Segment */}
                          <TableCell className="px-3 py-2.5">
                            <SegmentBar segments={mixSegments(cat)} />
                          </TableCell>

                          {/* Column 11: Checked */}
                          <TableCell className={cn(TXT_CELL, "font-mono text-[11px] text-muted-foreground")}>
                            <span title={cat.lastCheckedAt ? formatDateTime(cat.lastCheckedAt) : undefined}>
                              {formatAgo(cat.lastCheckedAt)}
                            </span>
                          </TableCell>
                        </>
                      )}
                    </TableRow>
                  )
                })
              )}
            </TableBody>

            {/* Summary Footer Row */}
            {data && filteredCategories.length > 0 && (
              <TableFooter className="border-t border-border/80 bg-secondary/35 font-medium">
                <TableRow className="hover:bg-transparent">
                  <TableHead
                    scope="row"
                    className="h-auto px-3 py-2.5 font-mono text-[11px] font-semibold uppercase tracking-wider text-muted-foreground"
                  >
                    All Pools Summary
                  </TableHead>
                  <TableCell className="px-3 py-2.5">
                    <Badge tone={HEALTH[overall.health].tone} dot>
                      {HEALTH[overall.health].label}
                    </Badge>
                  </TableCell>
                  <TableCell className={NUM_CELL}>{formatCount(totals.total)}</TableCell>
                  <TableCell className={cn(NUM_CELL, "font-semibold text-foreground")}>
                    {formatCount(totals.alive)}
                  </TableCell>
                  <TableCell className={cn(NUM_CELL, "text-ok")}>
                    {formatCount(totals.premium)}
                  </TableCell>
                  <TableCell className={cn(NUM_CELL, totals.pending > 0 && "text-warn")}>
                    {formatCount(totals.pending)}
                  </TableCell>
                  <TableCell className={cn(NUM_CELL, totals.dead > 0 && "text-destructive")}>
                    {formatCount(totals.dead)}
                  </TableCell>
                  <TableCell className={NUM_CELL}>
                    {windowPct === null ? (
                      "—"
                    ) : (
                      <span className={TONE_TEXT[rateTone(windowPct)]}>{windowPct}%</span>
                    )}
                  </TableCell>
                  <TableCell className="px-3 py-2.5">
                    <Sparkline
                      className="h-5 w-16"
                      max={100}
                      tone={rateTone(windowPct)}
                      points={asPoints(history?.overall)}
                      label="All pools pass rate over 14 days"
                    />
                  </TableCell>
                  <TableCell className="px-3 py-2.5">
                    <SegmentBar segments={mixSegments(totals)} />
                  </TableCell>
                  <TableCell className={cn(TXT_CELL, "font-mono text-[11px] text-muted-foreground")}>
                    {formatAgo(data.generatedAt)}
                  </TableCell>
                </TableRow>
              </TableFooter>
            )}
          </Table>
        </div>
      </section>

      {/* IN-DEPTH POOL DIAGNOSTICS & TELEMETRY DIALOG */}
      {selectedPool && (
        <Dialog
          open={selectedPool !== null}
          onClose={() => setSelectedPool(null)}
          title={`${selectedPool.label} Diagnostics`}
          description={`Telemetry, rotation health, and consumption endpoints for ${selectedPool.service} (${selectedPool.kind}).`}
          footer={
            <div className="flex w-full items-center justify-between gap-2">
              <Link
                href={`/submit?service=${selectedPool.service}&kind=${selectedPool.kind}`}
                className={cn(buttonVariants({ variant: "outline", size: "sm" }), "text-xs font-mono gap-1")}
              >
                <span>Contribute Source</span>
                <ArrowUpRight className="size-3" />
              </Link>
              <Button size="sm" onClick={() => setSelectedPool(null)}>
                Close
              </Button>
            </div>
          }
        >
          <div className="flex flex-col gap-4 font-mono text-xs">
            <div className="grid grid-cols-2 gap-2 rounded-lg border border-border/80 bg-secondary/30 p-3 sm:grid-cols-4">
              <div>
                <span className="block text-[10px] text-muted-foreground uppercase">STATUS</span>
                <Badge tone={HEALTH[selectedPool.health].tone} dot className="mt-1">
                  {HEALTH[selectedPool.health].label}
                </Badge>
              </div>
              <div>
                <span className="block text-[10px] text-muted-foreground uppercase">SERVING</span>
                <span className="text-sm font-semibold tabular-nums text-ok">
                  {formatCount(selectedPool.alive)} / {formatCount(selectedPool.total)}
                </span>
              </div>
              <div>
                <span className="block text-[10px] text-muted-foreground uppercase">PREMIUM</span>
                <span className="text-sm font-semibold tabular-nums text-foreground">
                  {formatCount(selectedPool.premium)}
                </span>
              </div>
              <div>
                <span className="block text-[10px] text-muted-foreground uppercase">14D PASS</span>
                <span className={cn("text-sm font-semibold tabular-nums", TONE_TEXT[rateTone(selectedPool.uptimePct)])}>
                  {selectedPool.uptimePct !== null ? `${selectedPool.uptimePct}%` : "—"}
                </span>
              </div>
            </div>

            <div className="flex flex-col gap-1.5">
              <span className="text-[11px] font-semibold text-foreground uppercase tracking-wider">
                Test Lease Endpoint
              </span>
              <div className="flex items-center justify-between rounded-md border border-border bg-background p-2.5">
                <code className="text-[11px] text-foreground/90 truncate mr-2">
                  curl -H &quot;Authorization: Bearer YOUR_KEY&quot; &quot;{leaseUrl}&quot;
                </code>
                <CopyButton
                  value={`curl -H "Authorization: Bearer YOUR_KEY" "${leaseUrl}"`}
                  className="shrink-0 h-6 px-2 text-[10px]"
                />
              </div>
            </div>

            <div className="flex items-center justify-between text-[11px] text-muted-foreground border-t border-border/60 pt-2">
              <span>Last sweep verification:</span>
              <span className="text-foreground">
                {selectedPool.lastCheckedAt ? formatDateTime(selectedPool.lastCheckedAt) : "Never checked"}
              </span>
            </div>
          </div>
        </Dialog>
      )}
    </div>
  )
}
