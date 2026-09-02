"use client"

import { useEffect, useRef, useState } from "react"
import Link from "next/link"
import useSWR from "swr"
import { motion, useReducedMotion } from "motion/react"
import type { CategoryStatus } from "@/lib/queries"
import { Badge, toneFor, type StatusTone } from "@/components/ui/badge"
import { Button, buttonVariants } from "@/components/ui/button"
import { Notice } from "@/components/ui/notice"
import { Panel } from "@/components/ui/panel"
import { cn, formatAgo, formatCount, formatDateTime } from "@/lib/utils"

interface StatusPayload {
  generatedAt: string
  categories: CategoryStatus[]
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
  if (!res.ok) throw new Error(`status feed responded ${res.status}`)
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

/**
 * Health is board-level vocabulary, not an entry status, so this map cannot be `toneFor` alone:
 * toneFor() knows "degraded" (that reading is used verbatim, so the board can never disagree with
 * the admin chips) but answers "neutral" for operational/down/unknown, which would render a
 * working pool and an empty one the same way.
 */
const HEALTH: Record<CategoryStatus["health"], { label: string; tone: StatusTone; dot: string }> = {
  operational: { label: "Operational", tone: "ok", dot: "bg-ok" },
  degraded: { label: "Degraded", tone: toneFor("degraded"), dot: "bg-warn" },
  down: { label: "Down", tone: "danger", dot: "bg-destructive" },
  unknown: { label: "No data", tone: "neutral", dot: "bg-border" },
}

/** Turns a tone back into a text colour, for cells with no Badge to borrow one from. */
const TONE_TEXT: Record<StatusTone, string> = {
  ok: "text-ok",
  warn: "text-warn",
  danger: "text-destructive",
  neutral: "text-muted-foreground",
}

/**
 * The columns, in order. The skeleton row and the zero-entry row span COLUMN_COUNT, so adding a
 * column here cannot silently break them.
 */
const COLUMNS: { label: string; head: string }[] = [
  { label: "Category", head: "text-left" },
  { label: "Health", head: "text-left" },
  { label: "Total", head: "text-right" },
  // "Alive" is the field name in CategoryStatus and what the feed exposes, and it already means
  // servable: getStatus() counts status alive OR preview and drops disabled entries, because a
  // disabled entry is never handed to an app and must not be shown as serving on the public page.
  { label: "Alive", head: "text-right" },
  { label: "Premium", head: "text-right" },
  { label: "Pending", head: "text-right" },
  { label: "Dead", head: "text-right" },
  { label: "Uptime", head: "text-right" },
  { label: "Mix", head: "text-left" },
  { label: "Checked", head: "text-left" },
]
const COLUMN_COUNT = COLUMNS.length

const NUM_CELL = "px-3 py-3 text-right font-mono whitespace-nowrap"
const TXT_CELL = "px-3 py-3 whitespace-nowrap"

function overallHealth(cats: CategoryStatus[]) {
  const known = cats.filter((c) => c.health !== "unknown")
  if (known.length === 0) return { label: "Awaiting first submissions", health: "unknown" as const }
  if (known.every((c) => c.health === "operational"))
    return { label: "All systems operational", health: "operational" as const }
  if (known.some((c) => c.health === "down"))
    return { label: "Partial outage", health: "down" as const }
  return { label: "Degraded performance", health: "degraded" as const }
}

/**
 * Sums the columns the mix bar and the totals row read. Uptime is deliberately NOT averaged: a
 * pool with three checks would weigh the same as one with three thousand, and the payload does not
 * carry the denominators that would make the average honest.
 */
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

/**
 * Smoothly counts from the number last drawn on screen up to `value`.
 *
 * `animate` is false when the user asked for reduced motion: the figure is still returned, it just
 * never moves — a faster ramp is not the same thing as no ramp, and a counter is decoration over a
 * number that is already in the DOM. Every queued frame is cancelled on unmount and when the target
 * changes mid-ramp, which is what keeps a 60s poll from stacking ramps that fight over state.
 */
function useCountUp(value: number, animate: boolean, duration = 700) {
  const [display, setDisplay] = useState(value)
  // What is on screen right now. Held in a ref rather than as "the last target" so an interrupted
  // ramp hands the next one the number the user was actually shown.
  const drawn = useRef(value)

  useEffect(() => {
    if (!animate) {
      drawn.current = value
      setDisplay(value)
      return
    }
    const from = drawn.current
    if (from === value) return
    const start = performance.now()
    let raf = 0
    const tick = (now: number) => {
      const t = Math.min(1, (now - start) / duration)
      const eased = 1 - Math.pow(1 - t, 3)
      const next = Math.round(from + (value - from) * eased)
      drawn.current = next
      setDisplay(next)
      if (t < 1) raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [value, animate, duration])

  return display
}

/**
 * The status dot. The pulse ring is motion, so `animate` is what turns it off; the dot itself
 * always stays, because the word beside it carries the status and never relies on this. Decorative
 * by construction — every surface that uses it states the same health in text — hence aria-hidden
 * rather than a colour-only label.
 */
function HealthDot({
  health,
  animate,
  className,
}: {
  health: CategoryStatus["health"]
  animate: boolean
  className?: string
}) {
  return (
    <span className={cn("relative flex shrink-0", className ?? "size-2")} aria-hidden="true">
      {animate && health === "operational" ? (
        <span
          className={cn(
            "absolute inline-flex h-full w-full animate-ping rounded-full opacity-60",
            HEALTH[health].dot,
          )}
        />
      ) : null}
      <span className={cn("relative inline-flex h-full w-full rounded-full", HEALTH[health].dot)} />
    </span>
  )
}

/**
 * The pool's composition as one stacked bar: premium, then the rest of the live entries, then
 * pending, then dead. It is aria-hidden on purpose — the same four figures stand as text in their
 * own columns, so the bar is emphasis and never the only place a number exists.
 *
 * Emphasis descends premium > alive > pending > dead. `aliveOnly` deliberately does NOT use a
 * full-strength `bg-foreground`: white is the brightest token on the page, so a category of
 * non-premium entries outshouted the green premium ones and an all-white bar on a DEGRADED row
 * read as "all good". Dimming it puts the signal colours back on top.
 */
function SegmentBar({ stats, animate }: { stats: Stats; animate: boolean }) {
  if (stats.total === 0) {
    return <div className="h-1.5 w-32 rounded-full bg-secondary" aria-hidden="true" />
  }
  const aliveOnly = Math.max(stats.alive - stats.premium, 0)
  const segments = [
    { w: stats.premium / stats.total, cls: "bg-ok" },
    { w: aliveOnly / stats.total, cls: "bg-foreground/40" },
    { w: stats.pending / stats.total, cls: "bg-muted-foreground/30" },
    { w: stats.dead / stats.total, cls: "bg-destructive/60" },
  ].filter((s) => s.w > 0)

  return (
    <div
      className="flex h-1.5 w-32 gap-px overflow-hidden rounded-full bg-secondary"
      aria-hidden="true"
    >
      {segments.map((s, i) => {
        const width = `${s.w * 100}%`
        return (
          <motion.div
            key={i}
            className={cn("h-full", s.cls)}
            {...(animate
              ? {
                  initial: { width: 0 },
                  animate: { width },
                  transition: { duration: 0.6, delay: i * 0.06, ease: "easeOut" as const },
                }
              : { style: { width } })}
          />
        )
      })}
    </div>
  )
}

function Stat({ label, value, tone }: { label: string; value: string; tone?: string }) {
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <span className={cn("font-mono text-lg leading-none", tone)}>{value}</span>
      <span className="label-mono">{label}</span>
    </div>
  )
}

/**
 * Public status board: the aggregate health of every pool, then one table row per category.
 *
 * This is tabular data, so it is a real <table> — one <th scope="row"> per category and one
 * numeric column per figure — rather than the grid of expandable cards it used to be. Expanding
 * existed only to hide four numbers; here they are columns.
 *
 * `fallback` pre-seeds the payload for a caller that already has it server-side. Nothing does that
 * today, and anything that starts should know the row times are rendered relative ("4m ago"), so a
 * seeded payload can differ between the server and the client pass by one bucket.
 */
export function StatusBoard({ fallback }: { fallback?: StatusPayload }) {
  const reduce = useReducedMotion()
  const animate = !reduce
  const { data, error, isLoading, mutate } = useSWR("/api/status", fetcher, {
    fallbackData: fallback,
    refreshInterval: 60_000,
    revalidateOnFocus: true,
  })

  const categories = data?.categories ?? []
  const overall = overallHealth(categories)
  const totals = sumStats(categories)
  const aliveCount = useCountUp(totals.alive, animate)
  const premiumCount = useCountUp(totals.premium, animate)
  const trouble = categories.filter((c) => c.health === "degraded" || c.health === "down")

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
            <HealthDot health={overall.health} animate={animate} className="size-3" />
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
                  tone={totals.premium > 0 ? TONE_TEXT[toneFor("alive")] : undefined}
                />
                <Stat
                  label="Unreachable"
                  value={formatCount(totals.dead)}
                  tone={totals.dead > 0 ? TONE_TEXT[toneFor("dead")] : undefined}
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
              : "The board could not be loaded — /api/status is not responding. It is retried every minute."}
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
        <div className="overflow-x-auto">
          <table className="w-full min-w-[56rem] text-left text-xs">
            <caption className="sr-only">
              Pool status by category: entry counts, uptime and the time of the last health check
            </caption>
            <thead>
              <tr className="border-b border-border">
                {COLUMNS.map((col) => (
                  <th
                    key={col.label}
                    scope="col"
                    className={cn("label-mono px-3 py-2.5 font-medium", col.head)}
                  >
                    {col.label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {skeleton ? (
                // Rows sized to match a real row, at the real count, so the panel does not grow.
                Array.from({ length: SKELETON_COUNT }).map((_, i) => (
                  <tr key={i} className="border-b border-border/60 last:border-0">
                    <td colSpan={COLUMN_COUNT} className="px-4 py-3">
                      <div className="h-8 animate-pulse rounded-md bg-secondary/60" />
                    </td>
                  </tr>
                ))
              ) : categories.length === 0 ? (
                <tr>
                  <td colSpan={COLUMN_COUNT} className="px-4 py-3">
                    <p className="rounded-md border border-dashed border-border px-4 py-8 text-center text-xs text-muted-foreground">
                      {error
                        ? "Nothing to show yet — the status feed has never answered."
                        : "No pools are being tracked yet."}
                    </p>
                  </td>
                </tr>
              ) : (
                categories.map((cat) => {
                  const health = HEALTH[cat.health]
                  return (
                    <tr
                      key={`${cat.service}-${cat.kind}`}
                      className="border-b border-border/60 align-middle last:border-0"
                    >
                      <th scope="row" className="px-4 py-3 text-left font-medium">
                        <span className="block max-w-56 truncate">{cat.label}</span>
                        <span className="label-mono mt-1 block truncate">
                          {cat.service} · {cat.kind}
                        </span>
                      </th>
                      {cat.total === 0 ? (
                        // A category with nothing in it keeps its row, so the table can never
                        // quietly lose one, and the reason it is empty is stated in words rather
                        // than implied by a line of zeroes. Deezer and Apple Music are account-only
                        // in lib/sources.ts, so an api row added for either lands here.
                        <td colSpan={COLUMN_COUNT - 1} className="px-3 py-2">
                          <p className="rounded-md border border-dashed border-border px-3 py-2 text-xs text-muted-foreground">
                            No entries in this pool yet.{" "}
                            <Link
                              href="/submit"
                              className={cn(
                                buttonVariants({ variant: "outline", size: "xs" }),
                                "mb-px inline-flex",
                              )}
                            >
                              Contribute one
                            </Link>
                          </p>
                        </td>
                      ) : (
                        <>
                          <td className={TXT_CELL}>
                            <span className="flex items-center gap-2">
                              <HealthDot health={cat.health} animate={animate} />
                              {/* The word, not the colour: the dot repeats it, it never replaces it. */}
                              <Badge tone={health.tone}>{health.label}</Badge>
                            </span>
                          </td>
                          <td className={NUM_CELL}>{formatCount(cat.total)}</td>
                          <td className={NUM_CELL}>{formatCount(cat.alive)}</td>
                          <td
                            className={cn(NUM_CELL, cat.premium > 0 && TONE_TEXT[toneFor("alive")])}
                          >
                            {formatCount(cat.premium)}
                          </td>
                          <td
                            className={cn(
                              NUM_CELL,
                              cat.pending > 0 && TONE_TEXT[toneFor("pending")],
                            )}
                          >
                            {formatCount(cat.pending)}
                          </td>
                          <td
                            className={cn(NUM_CELL, cat.dead > 0 && TONE_TEXT[toneFor("dead")])}
                          >
                            {formatCount(cat.dead)}
                          </td>
                          <td className={NUM_CELL}>
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
                          </td>
                          <td className="px-3 py-3">
                            <SegmentBar stats={cat} animate={animate} />
                          </td>
                          <td className={cn(TXT_CELL, "text-muted-foreground")}>
                            <span
                              title={cat.lastCheckedAt ? formatDateTime(cat.lastCheckedAt) : undefined}
                            >
                              {formatAgo(cat.lastCheckedAt)}
                            </span>
                          </td>
                        </>
                      )}
                    </tr>
                  )
                })
              )}
            </tbody>
            {data ? (
              <tfoot>
                <tr className="border-t border-border bg-secondary/40">
                  <th scope="row" className="label-mono px-4 py-2.5 text-left font-medium">
                    All pools
                  </th>
                  <td className="px-3 py-2.5" />
                  <td className={cn(NUM_CELL, "py-2.5")}>{formatCount(totals.total)}</td>
                  <td className={cn(NUM_CELL, "py-2.5")}>{formatCount(totals.alive)}</td>
                  <td className={cn(NUM_CELL, "py-2.5")}>{formatCount(totals.premium)}</td>
                  <td className={cn(NUM_CELL, "py-2.5")}>{formatCount(totals.pending)}</td>
                  <td className={cn(NUM_CELL, "py-2.5")}>{formatCount(totals.dead)}</td>
                  <td className={cn(NUM_CELL, "py-2.5")}>
                    {/* No pooled figure — see sumStats(). */}
                    <span aria-hidden="true">—</span>
                    <span className="sr-only">Not pooled</span>
                  </td>
                  <td className="px-3 py-2.5">
                    <SegmentBar stats={totals} animate={animate} />
                  </td>
                  <td className={cn(TXT_CELL, "py-2.5 text-muted-foreground")}>
                    {formatAgo(data.generatedAt)}
                  </td>
                </tr>
              </tfoot>
            ) : null}
          </table>
        </div>
      </Panel>
    </div>
  )
}
