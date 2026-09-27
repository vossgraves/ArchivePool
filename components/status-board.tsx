"use client"

import { useEffect, useState } from "react"
import Link from "next/link"
import useSWR from "swr"
import { motion, useReducedMotion } from "motion/react"
import type { CategoryStatus, UptimePoint } from "@/lib/queries"
import { Badge, StatusDot, TONE_TEXT, toneFor, type StatusTone } from "@/components/ui/badge"
import { Button, buttonVariants } from "@/components/ui/button"
import { BarSeries, SegmentBar, Sparkline, TrendChart } from "@/components/ui/chart"
import { Empty } from "@/components/ui/empty"
import { Notice } from "@/components/ui/notice"
import { Panel } from "@/components/ui/panel"
import { Stat, useCountUp } from "@/components/ui/stat"
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
  /** Added after the original payload, so an older cached response simply has no trend to draw. */
  history?: {
    days: number
    overall: UptimePoint[]
    categories: { service: string; kind: string; points: UptimePoint[] }[]
  }
}

/** The per-category figures the board draws, as returned by getStatus(). */
type Stats = Pick<CategoryStatus, "total" | "alive" | "premium" | "dead" | "pending">

/*
 * A non-2xx has to surface as an error. Parsing the body as JSON whatever the status made a failed
 * poll resolve to `undefined`, which the board then rendered as "there are no pools" instead of
 * "the feed is unreachable" — identical on screen, opposite in meaning.
 */
async function fetcher(url: string): Promise<StatusPayload> {
  const res = await fetch(url)
  if (!res.ok) {
    // The route reports *why* it failed — a suspended database, a rejected connection — so carry
    // that through rather than a bare status code. "Not responding" and "the database is
    // suspended" look identical on screen otherwise, and only one of them is actionable.
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

/*
 * Number of skeleton rows to show before the first payload arrives. Mirrors CATEGORIES.length in
 * lib/sources.ts — inlined rather than imported because that module pulls in node:crypto, which
 * has no business in a client bundle. If a category is added there, bump this. (It was left at 5
 * when Apple Music landed. The table renders one row per category, so a stale number here is a
 * visible jump on first paint rather than a cosmetic detail.)
 */
const SKELETON_COUNT = 6

/** Only the wording lives here. Colour comes from the shared tone map, which now answers for the
 *  health words too, so the board and the admin chips cannot disagree about what green means. */
const HEALTH: Record<CategoryStatus["health"], { label: string; tone: StatusTone }> = {
  operational: { label: "Operational", tone: toneFor("operational") },
  degraded: { label: "Degraded", tone: toneFor("degraded") },
  down: { label: "Down", tone: toneFor("down") },
  unknown: { label: "No data", tone: toneFor("unknown") },
}

/** The skeleton and zero-entry rows span COLUMN_COUNT, so adding one here cannot break them. */
const COLUMNS: { label: string; head: string }[] = [
  { label: "Category", head: "text-left" },
  { label: "Health", head: "text-left" },
  { label: "Total", head: "text-right" },
  // "Alive" already means servable: getStatus() counts alive OR preview and drops disabled.
  { label: "Alive", head: "text-right" },
  { label: "Premium", head: "text-right" },
  { label: "Pending", head: "text-right" },
  { label: "Dead", head: "text-right" },
  { label: "Uptime", head: "text-right" },
  // Lifetime uptime cannot show a recovery or a slide; the sparkline beside it is the same figure
  // per day for the window health_log keeps.
  { label: "14d", head: "text-left" },
  { label: "Mix", head: "text-left" },
  { label: "Checked", head: "text-left" },
]
const COLUMN_COUNT = COLUMNS.length

const NUM_CELL = "px-3 py-3 text-right font-mono whitespace-nowrap"
const TXT_CELL = "px-3 py-3 whitespace-nowrap"
// Softer than the primitive's default divider: ten columns of figures already carry enough
// structure, and a full-strength rule between every row turns the board into a grid.
const ROW = "border-border/60 last:border-0"

function overallHealth(cats: CategoryStatus[]) {
  const known = cats.filter((c) => c.health !== "unknown")
  if (known.length === 0) return { label: "Awaiting first submissions", health: "unknown" as const }
  if (known.every((c) => c.health === "operational"))
    return { label: "All systems operational", health: "operational" as const }
  if (known.some((c) => c.health === "down"))
    return { label: "Partial outage", health: "down" as const }
  return { label: "Degraded performance", health: "degraded" as const }
}

/** Uptime is deliberately not averaged — the payload carries no denominators to weight it by. */
function sumStats(cats: CategoryStatus[]): Stats {
  return cats.reduce<Stats>(
    (a, c) => ({
      total: a.total + c.total,
      alive: a.alive + c.alive,
      premium: a.premium + c.premium,
      dead: a.dead + c.dead,
      pending: a.pending + c.pending,
    }),
    { total: 0, alive: 0, premium: 0, dead: 0, pending: 0 },
  )
}

/** A pass rate is only good news above ~95%: the sweep runs every 6 hours, so 90% is a daily failure. */
function rateTone(pct: number | null): StatusTone {
  if (pct === null) return "neutral"
  return pct >= 95 ? "ok" : pct >= 80 ? "warn" : "danger"
}

function asPoints(points: UptimePoint[] | undefined) {
  return (points ?? []).map((p) => ({ label: p.label, value: p.pct, partial: p.partial }))
}

/** Segments for the shared meter: one category's composition, premium first. */
function mixSegments(stats: Stats) {
  return [
    { value: stats.premium, tone: "ok" as const },
    { value: Math.max(stats.alive - stats.premium, 0), tone: "neutral" as const, muted: true },
    { value: stats.pending, tone: "warn" as const },
    { value: stats.dead, tone: "danger" as const },
  ]
}

/**
 * Public status board. Tabular data, so a real <table>.
 *
 * `fallback` pre-seeds a server-side payload. Row times render relative ("4m ago"), so a seeded
 * payload can differ between the server and client pass by one bucket.
 */
export function StatusBoard({ fallback }: { fallback?: StatusPayload }) {
  const reduce = useReducedMotion()
  const animate = !reduce
  const { data, error, isLoading, mutate } = useSWR("/api/status", fetcher, {
    fallbackData: fallback,
    // Five hours, not a minute. The figures only change when the health sweep runs (every 6 hours
    // from the cron workflow), so a 60s poll was 1,440 requests a day for a board that changes
    // four times — and every one of those requests touches the database, which is what spends the
    // free tier's compute budget. The manual refresh button and the focus revalidation still give
    // an impatient reader a fresh read on demand.
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

  /*
   * Spoken status of the board. `aria-live` belongs on the updated line and nowhere else, and that
   * region is only ever filled by a refresh the person asked for: SWR revalidates every 60s, and a
   * live region whose text changes on every tick reads the header aloud once a minute forever. The
   * region therefore stays mounted and empty between refreshes (a region that appears already
   * populated is often ignored), and the quiet ticking "Nm ago" string is rendered beside it, not
   * inside it.
   */
  const [announcement, setAnnouncement] = useState<string | null>(null)
  const [refreshing, setRefreshing] = useState(false)

  async function refresh() {
    if (refreshing) return
    setRefreshing(true)
    setAnnouncement("Refreshing…")
    try {
      await mutate()
      setAnnouncement("Refreshed")
    } catch {
      // The Notice underneath says the same thing in print; this is the spoken half of it. Not a
      // second Notice — a failed manual refresh must not stack two messages.
      setAnnouncement("Refresh failed — showing the last good figures")
    } finally {
      setRefreshing(false)
    }
  }

  // The message replaces the "Updated …" text, so it has to leave on its own or the line freezes on
  // "Refreshed" while the board quietly carries on polling.
  useEffect(() => {
    if (!announcement) return
    const t = setTimeout(() => setAnnouncement(null), 6000)
    return () => clearTimeout(t)
  }, [announcement])

  // No payload has ever arrived. The table renders its header either way, and the figures render as
  // gaps rather than zeroes: "0" is a number a reader can believe.
  const skeleton = isLoading && !data

  return (
    <div className="flex flex-col gap-5">
      <Panel
        label="Overall health"
        actions={
          <>
            <p className="font-mono text-xs text-muted-foreground">
              <span role="status" aria-live="polite">
                {announcement}
              </span>
              {announcement
                ? null
                : data?.generatedAt
                  ? `Updated ${formatAgo(data.generatedAt)}`
                  : "Awaiting first data"}
            </p>
            <Button
              variant="outline"
              size="sm"
              onClick={() => void refresh()}
              disabled={refreshing}
            >
              {refreshing ? "Refreshing…" : "Refresh"}
            </Button>
          </>
        }
        bodyClassName="flex flex-col gap-3"
      >
        <motion.div
          {...(animate
            ? {
                initial: { opacity: 0, y: 8 },
                animate: { opacity: 1, y: 0 },
                transition: { duration: 0.35, ease: "easeOut" as const },
              }
            : {})}
          className="flex flex-wrap items-center justify-between gap-x-8 gap-y-4 rounded-md border border-border bg-background/40 px-4 py-3.5"
        >
          <div className="flex min-w-0 items-center gap-3">
            <StatusDot
              tone={HEALTH[overall.health].tone}
              pulse={animate && overall.health === "operational"}
              className="size-3"
            />
            <div className="min-w-0">
              <h3 className="truncate text-sm font-medium">{overall.label}</h3>
              <p className="mt-1 truncate text-xs text-muted-foreground">
                {data
                  ? `${formatCount(categories.length)} ${
                      categories.length === 1 ? "pool" : "pools"
                    } · ${
                      trouble.length === 0
                        ? "none reporting a problem"
                        : `${formatCount(trouble.length)} reporting a problem`
                    }`
                  : "No figures yet — the feed has not answered this visit."}
              </p>
            </div>
          </div>
          <div className="flex flex-wrap items-end gap-x-7 gap-y-3">
            {data ? (
              <>
                <Stat label="Entries" value={formatCount(totals.total)} />
                <Stat label="Alive" value={formatCount(aliveCount)} />
                <Stat
                  label="Premium"
                  value={formatCount(premiumCount)}
                  tone={totals.premium > 0 ? toneFor("alive") : undefined}
                />
                <Stat
                  label="Unreachable"
                  value={formatCount(totals.dead)}
                  tone={totals.dead > 0 ? toneFor("dead") : undefined}
                />
              </>
            ) : (
              <div className="flex gap-7" aria-hidden="true">
                {Array.from({ length: 4 }).map((_, i) => (
                  <div key={i} className="flex flex-col gap-1.5">
                    <div className="h-5 w-11 animate-pulse rounded-md bg-secondary/60" />
                    <div className="h-2.5 w-16 animate-pulse rounded-md bg-secondary/60" />
                  </div>
                ))}
              </div>
            )}
          </div>
        </motion.div>

        {/* Stale-while-revalidate: one failed poll must never blank a board that still has good
            figures on screen, so the failure is reported above the data instead of replacing it. */}
        {error ? (
          <Notice tone="error">
            {data
              ? `The board could not be refreshed. These are the last good figures, from ${formatDateTime(
                  data.generatedAt,
                )}.`
              : "The board could not be loaded."}{" "}
            <span className="font-mono text-xs opacity-80">
              {error instanceof Error ? error.message : "status feed unavailable"}
            </span>{" "}
            It retries every five hours, or hit Refresh now.
          </Notice>
        ) : null}

        {data && trouble.length > 0 ? (
          <ul className="flex flex-col gap-1.5 border-t border-border pt-3">
            {trouble.map((c) => (
              <li key={`${c.service}-${c.kind}`} className="flex items-center gap-2 text-xs">
                <Badge tone={HEALTH[c.health].tone}>{HEALTH[c.health].label}</Badge>
                <span className="min-w-0 truncate text-muted-foreground">
                  {c.label} — {formatCount(c.alive)} of {formatCount(c.total)}{" "}
                  {c.alive === 1 ? "entry" : "entries"} serving
                </span>
              </li>
            ))}
          </ul>
        ) : null}
      </Panel>

      {history && windowChecks > 0 ? (
        <Panel
          label={`Uptime · last ${history.days} days`}
          description="Scheduled checks only. A day with no bar was a day the sweep did not run, which is not the same as a day everything failed."
          bodyClassName="grid gap-5 md:grid-cols-2"
        >
          <div className="flex flex-col gap-2">
            <div className="flex items-baseline justify-between gap-3">
              <h3 className="label-mono">Pass rate</h3>
              <span className="font-mono text-sm">
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
              <h3 className="label-mono">Checks per day</h3>
              <span className="font-mono text-sm">{formatCount(windowChecks)}</span>
            </div>
            <BarSeries
              format={(n) => formatCount(n)}
              columns={history.overall.map((p) => ({
                label: p.label,
                partial: p.partial,
                // Failures on top: a stack reads from the baseline up, so the anomaly has to cap
                // the column or a bad day looks like a short one.
                segments: [
                  { label: "failed", value: p.checks - p.ok, tone: "danger" as const },
                  { label: "passed", value: p.ok, tone: "ok" as const },
                ],
              }))}
            />
          </div>
        </Panel>
      ) : null}

      <Panel
        label="Pools"
        description="One row per category the public feed exposes. Total is everything the pool holds; Alive is only what it may hand to an app. Aggregate health is all that is public — entries never are."
        bodyClassName="p-0"
      >
        {/*
         * One table for every state, including the two with no rows in them yet: the header stays on
         * screen while the rows are placeholders, so nothing reflows when a payload lands, and an
         * empty board still shows which figures are missing.
         */}
        {/* The primitive's row hover is kept: at ten columns and a 56rem minimum the reader is
            tracking a figure back to its category across a horizontal scroll, and a highlight
            that follows the pointer is what makes that possible. It is --muted, so it stays
            achromatic and cannot be mistaken for a status. */}
        <Table className="min-w-[62rem] text-left text-xs">
          <TableCaption className="sr-only">
            Pool status by category: entry counts, uptime and the time of the last health check
          </TableCaption>
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              {COLUMNS.map((col) => (
                <TableHead
                  key={col.label}
                  scope="col"
                  // label-mono owns the colour; TableHead's own text-foreground has to be
                  // displaced or every column heading outshouts the figures beneath it.
                  className={cn(
                    "label-mono h-auto px-3 py-2.5 font-medium text-muted-foreground",
                    col.head,
                  )}
                >
                  {col.label}
                </TableHead>
              ))}
            </TableRow>
          </TableHeader>
          <TableBody>
            {skeleton ? (
              // Rows sized to match a real row, at the real count, so the panel does not grow.
              Array.from({ length: SKELETON_COUNT }).map((_, i) => (
                <TableRow key={i} className={cn(ROW, "hover:bg-transparent")}>
                  <TableCell colSpan={COLUMN_COUNT} className="px-4 py-3">
                    <div className="h-8 animate-pulse rounded-md bg-secondary/60" />
                  </TableCell>
                </TableRow>
              ))
            ) : categories.length === 0 ? (
              <TableRow className="border-0 hover:bg-transparent">
                <TableCell colSpan={COLUMN_COUNT} className="px-4 py-3">
                  <Empty>
                    {error
                      ? "Nothing to show yet — the status feed has never answered."
                      : "No pools are being tracked yet."}
                  </Empty>
                </TableCell>
              </TableRow>
            ) : (
              categories.map((cat) => {
                const health = HEALTH[cat.health]
                return (
                  <TableRow key={`${cat.service}-${cat.kind}`} className={cn(ROW, "align-middle")}>
                    <TableHead
                      scope="row"
                      className="h-auto px-4 py-3 text-left font-medium text-foreground"
                    >
                      <span className="block max-w-56 truncate">{cat.label}</span>
                      <span className="label-mono mt-1 block truncate">
                        {cat.service} · {cat.kind}
                      </span>
                    </TableHead>
                    {cat.total === 0 ? (
                      // An empty category keeps its row, with the reason in words rather than
                      // a line of zeroes. Apple Music is account-only.
                      <TableCell colSpan={COLUMN_COUNT - 1} className="px-3 py-2">
                        <Empty
                          className="gap-2 px-3 py-3 sm:flex-row sm:justify-center"
                          action={
                            <Link
                              href="/submit"
                              className={cn(buttonVariants({ variant: "outline", size: "xs" }))}
                            >
                              Contribute one
                            </Link>
                          }
                        >
                          No entries in this pool yet.
                        </Empty>
                      </TableCell>
                    ) : (
                      <>
                        <TableCell className={TXT_CELL}>
                          <span className="flex items-center gap-2">
                            <StatusDot
                              tone={HEALTH[cat.health].tone}
                              pulse={animate && cat.health === "operational"}
                            />
                            {/* The word, not the colour: the dot repeats it, it never replaces it. */}
                            <Badge tone={health.tone}>{health.label}</Badge>
                          </span>
                        </TableCell>
                        <TableCell className={NUM_CELL}>{formatCount(cat.total)}</TableCell>
                        <TableCell className={NUM_CELL}>{formatCount(cat.alive)}</TableCell>
                        <TableCell
                          className={cn(NUM_CELL, cat.premium > 0 && TONE_TEXT[toneFor("alive")])}
                        >
                          {formatCount(cat.premium)}
                        </TableCell>
                        <TableCell
                          className={cn(NUM_CELL, cat.pending > 0 && TONE_TEXT[toneFor("pending")])}
                        >
                          {formatCount(cat.pending)}
                        </TableCell>
                        <TableCell
                          className={cn(NUM_CELL, cat.dead > 0 && TONE_TEXT[toneFor("dead")])}
                        >
                          {formatCount(cat.dead)}
                        </TableCell>
                        <TableCell className={NUM_CELL}>
                          {cat.uptimePct === null ? (
                            /* Uptime is only defined once the sweep has checked something. A bare
                               "0%" would read as an outage and a "—" alone as a missing column, so
                               the dash is visual and the words go to assistive tech. */
                            <>
                              <span aria-hidden="true">—</span>
                              <span className="sr-only">No checks yet</span>
                            </>
                          ) : (
                            `${formatCount(cat.uptimePct)}%`
                          )}
                        </TableCell>
                        <TableCell className="px-3 py-3">
                          {/* Deliberately no figure of its own: the Uptime cell to its left is the
                              number, and this is only its shape over the retained window. */}
                          <Sparkline
                            className="h-6 w-16"
                            max={100}
                            tone={rateTone(cat.uptimePct)}
                            points={asPoints(sparkFor(cat.service, cat.kind))}
                            label={`${cat.label}: daily pass rate over the retained window`}
                          />
                        </TableCell>
                        <TableCell className="px-3 py-3">
                          <SegmentBar segments={mixSegments(cat)} />
                        </TableCell>
                        <TableCell className={cn(TXT_CELL, "text-muted-foreground")}>
                          <span
                            title={cat.lastCheckedAt ? formatDateTime(cat.lastCheckedAt) : undefined}
                          >
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
          {data ? (
            <TableFooter className="border-border bg-secondary/40 font-normal">
              <TableRow className="hover:bg-transparent">
                <TableHead
                  scope="row"
                  className="label-mono h-auto px-4 py-2.5 text-left font-medium text-muted-foreground"
                >
                  All pools
                </TableHead>
                <TableCell className="px-3 py-2.5" />
                <TableCell className={cn(NUM_CELL, "py-2.5")}>{formatCount(totals.total)}</TableCell>
                <TableCell className={cn(NUM_CELL, "py-2.5")}>{formatCount(totals.alive)}</TableCell>
                <TableCell className={cn(NUM_CELL, "py-2.5")}>
                  {formatCount(totals.premium)}
                </TableCell>
                <TableCell className={cn(NUM_CELL, "py-2.5")}>
                  {formatCount(totals.pending)}
                </TableCell>
                <TableCell className={cn(NUM_CELL, "py-2.5")}>{formatCount(totals.dead)}</TableCell>
                <TableCell className={cn(NUM_CELL, "py-2.5")}>
                  {/* No pooled figure — see sumStats(). */}
                  <span aria-hidden="true">—</span>
                  <span className="sr-only">Not pooled</span>
                </TableCell>
                <TableCell className="px-3 py-2.5">
                  <Sparkline
                    className="h-6 w-16"
                    max={100}
                    tone={rateTone(windowPct)}
                    points={asPoints(history?.overall)}
                    label="All pools: daily pass rate over the retained window"
                  />
                </TableCell>
                <TableCell className="px-3 py-2.5">
                  <SegmentBar segments={mixSegments(totals)} />
                </TableCell>
                <TableCell className={cn(TXT_CELL, "py-2.5 text-muted-foreground")}>
                  {formatAgo(data.generatedAt)}
                </TableCell>
              </TableRow>
            </TableFooter>
          ) : null}
        </Table>
      </Panel>
    </div>
  )
}
