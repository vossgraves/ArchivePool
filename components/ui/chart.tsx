"use client"

import { useId, useState } from "react"
import { motion, useReducedMotion } from "motion/react"
import { TONE_BG, TONE_TEXT, TONE_VAR, type StatusTone } from "@/components/ui/badge"
import { cn } from "@/lib/utils"

/**
 * The app's data visuals. Ported from Evil Charts (evilcharts.com) — its scoped `<defs>`, vertical
 * gradient fills, Gaussian glow, `3 3` dashed grid, rounded bar tops, left-to-right reveal mask and
 * dashed trailing "buffer" segment — but hand-drawn in SVG and CSS instead of pulling in Recharts.
 * See docs/DASHBOARD.md for why, and for what each chart is allowed to claim.
 *
 * Two rules hold across every chart here:
 * colour comes from TONE_VAR/TONE_BG only, so a series and the badge beside it cannot disagree;
 * and the drawing is `aria-hidden` with the same figures repeated in an adjacent sr-only list,
 * because a chart is emphasis and never the only place a number exists.
 */

export interface ChartPoint {
  label: string
  /** null is "no data for this period", which is not the same as zero and must not plot as zero. */
  value: number | null
  /** The period is still open — drawn dashed, so a half-height today does not read as a fall. */
  partial?: boolean
}

export interface BarSegment {
  label: string
  value: number
  tone: StatusTone
}

export interface BarColumn {
  label: string
  segments: BarSegment[]
  partial?: boolean
}

const TONE_BAR: Record<StatusTone, string> = {
  ok: "from-ok/20 to-ok/70",
  warn: "from-warn/20 to-warn/70",
  danger: "from-destructive/20 to-destructive/70",
  neutral: "from-muted-foreground/15 to-muted-foreground/50",
}

const VIEW_W = 300
const VIEW_H = 100
/** Room for the stroke and the end dot, which would otherwise clip at 0% and 100%. */
const PAD_Y = 8

function scale(points: ChartPoint[], max: number) {
  const span = Math.max(points.length - 1, 1)
  return points.map((p, i) => ({
    ...p,
    x: (i / span) * VIEW_W,
    y: p.value == null ? null : PAD_Y + (1 - Math.min(p.value, max) / max) * (VIEW_H - PAD_Y * 2),
  }))
}

/**
 * Monotone cubic through the points (Catmull-Rom control points), which is what Evil Charts'
 * default `curveType` draws. A polyline of 14 daily figures reads as noise; the curve keeps the
 * shape without inventing peaks between samples.
 */
function curve(pts: { x: number; y: number }[]): string {
  if (pts.length === 0) return ""
  if (pts.length === 1) return `M ${pts[0].x} ${pts[0].y}`
  let d = `M ${pts[0].x} ${pts[0].y}`
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[i - 1] ?? pts[i]
    const p1 = pts[i]
    const p2 = pts[i + 1]
    const p3 = pts[i + 2] ?? p2
    const c1x = p1.x + (p2.x - p0.x) / 6
    const c1y = p1.y + (p2.y - p0.y) / 6
    const c2x = p2.x - (p3.x - p1.x) / 6
    const c2y = p2.y - (p3.y - p1.y) / 6
    d += ` C ${c1x} ${c1y} ${c2x} ${c2y} ${p2.x} ${p2.y}`
  }
  return d
}

/** Consecutive runs of plotted points, so a gap in the data becomes a gap in the line. */
function runs(pts: ReturnType<typeof scale>) {
  const out: { x: number; y: number }[][] = []
  let current: { x: number; y: number }[] = []
  for (const p of pts) {
    if (p.y == null) {
      if (current.length) out.push(current)
      current = []
    } else {
      current.push({ x: p.x, y: p.y })
    }
  }
  if (current.length) out.push(current)
  return out
}

function ChartValues({ points, format }: { points: ChartPoint[]; format: (n: number) => string }) {
  return (
    <ul className="sr-only">
      {points.map((p) => (
        <li key={p.label}>
          {p.label}: {p.value == null ? "no data" : format(p.value)}
          {p.partial ? " (period still open)" : ""}
        </li>
      ))}
    </ul>
  )
}

function Tooltip({
  x,
  title,
  value,
  tone,
}: {
  x: number
  title: string
  value: string
  tone: StatusTone
}) {
  return (
    <div
      className="pointer-events-none absolute bottom-full z-10 mb-1 -translate-x-1/2 whitespace-nowrap rounded-md border border-border/50 bg-background/80 px-2.5 py-1.5 text-xs shadow-xl backdrop-blur-sm"
      style={{ left: `${x}%` }}
    >
      <span className="flex items-center gap-1.5">
        <span className={cn("size-1.5 rounded-full", TONE_BG[tone])} aria-hidden="true" />
        <span className="text-muted-foreground">{title}</span>
        <span className="font-mono text-foreground">{value}</span>
      </span>
    </div>
  )
}

/**
 * Gradient-filled area under a glowing line. `max` defaults to the series maximum; pass it for a
 * fixed axis (100 for a percentage), because a percentage chart that rescales to its own peak
 * makes 40% look like a good day.
 */
export function TrendChart({
  points,
  tone = "ok",
  max,
  format = (n) => String(n),
  height = 112,
  maxLabel,
  className,
}: {
  points: ChartPoint[]
  tone?: StatusTone
  max?: number
  format?: (n: number) => string
  height?: number
  maxLabel?: string
  className?: string
}) {
  const reduce = useReducedMotion()
  const uid = useId().replace(/[^a-zA-Z0-9]/g, "")
  const [active, setActive] = useState<number | null>(null)

  const known = points.filter((p) => p.value != null) as { value: number }[]
  const ceiling = max ?? Math.max(...known.map((p) => p.value), 1)
  const plotted = scale(points, ceiling)
  const segments = runs(plotted)
  const last = plotted[plotted.length - 1]
  const partialTail = last?.partial && segments.length > 0 && segments[segments.length - 1].length > 1

  if (known.length === 0) {
    return (
      <div
        className={cn(
          "flex items-center justify-center rounded-md border border-dashed border-border text-xs text-muted-foreground",
          className,
        )}
        style={{ height }}
      >
        No checks recorded yet
      </div>
    )
  }

  const tail = partialTail ? segments[segments.length - 1].slice(-2) : []
  const head = partialTail
    ? segments.slice(0, -1).concat([segments[segments.length - 1].slice(0, -1)])
    : segments

  return (
    <div className={cn("flex flex-col gap-2", className)}>
      <div className="relative" style={{ height }}>
        {maxLabel ? (
          <span className="absolute right-0 top-0 z-10 font-mono text-[0.625rem] text-muted-foreground">
            {maxLabel}
          </span>
        ) : null}
        <svg
          viewBox={`0 0 ${VIEW_W} ${VIEW_H}`}
          preserveAspectRatio="none"
          className="h-full w-full overflow-visible"
          aria-hidden="true"
        >
          <defs>
            <linearGradient id={`${uid}-fill`} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={TONE_VAR[tone]} stopOpacity="0.3" />
              <stop offset="100%" stopColor={TONE_VAR[tone]} stopOpacity="0" />
            </linearGradient>
            <filter id={`${uid}-glow`} x="-20%" y="-40%" width="140%" height="180%">
              <feGaussianBlur in="SourceGraphic" stdDeviation="2.5" result="blur" />
              <feMerge>
                <feMergeNode in="blur" />
                <feMergeNode in="SourceGraphic" />
              </feMerge>
            </filter>
            {/* Left-to-right reveal. The rect's width is animated rather than its scaleX: a
                transform origin inside an SVG mask resolves differently across engines, and one
                of them wiped the chart to nothing. */}
            <mask id={`${uid}-reveal`}>
              <motion.rect
                x="0"
                y="0"
                height={VIEW_H}
                fill="#fff"
                initial={{ width: reduce ? VIEW_W : 0 }}
                animate={{ width: VIEW_W }}
                transition={{ duration: 0.7, ease: "easeOut" }}
              />
            </mask>
          </defs>

          {[0.25, 0.5, 0.75].map((t) => (
            <line
              key={t}
              x1="0"
              x2={VIEW_W}
              y1={PAD_Y + t * (VIEW_H - PAD_Y * 2)}
              y2={PAD_Y + t * (VIEW_H - PAD_Y * 2)}
              stroke="var(--border)"
              strokeWidth="1"
              strokeDasharray="3 3"
              vectorEffect="non-scaling-stroke"
            />
          ))}

          <g mask={`url(#${uid}-reveal)`}>
            {segments.map((run, i) => (
              <path
                key={`area-${i}`}
                d={`${curve(run)} L ${run[run.length - 1].x} ${VIEW_H} L ${run[0].x} ${VIEW_H} Z`}
                fill={`url(#${uid}-fill)`}
              />
            ))}
            {head.map((run, i) =>
              run.length > 1 ? (
                <path
                  key={`line-${i}`}
                  d={curve(run)}
                  fill="none"
                  stroke={TONE_VAR[tone]}
                  strokeWidth="1.5"
                  strokeLinecap="round"
                  vectorEffect="non-scaling-stroke"
                  filter={`url(#${uid}-glow)`}
                />
              ) : null,
            )}
            {tail.length === 2 ? (
              <path
                d={curve(tail)}
                fill="none"
                stroke={TONE_VAR[tone]}
                strokeWidth="1.5"
                strokeDasharray="4 3"
                strokeLinecap="round"
                vectorEffect="non-scaling-stroke"
              />
            ) : null}
          </g>
        </svg>

        {/* The end dot and the crosshair live in HTML: the SVG is stretched non-uniformly, which
            would turn a circle into an ellipse and a round cap into a smear. */}
        {last?.y != null ? (
          <span
            className={cn(
              "pointer-events-none absolute size-2 -translate-x-1/2 -translate-y-1/2 rounded-full ring-2 ring-card",
              TONE_BG[tone],
            )}
            style={{ left: "100%", top: `${(last.y / VIEW_H) * 100}%` }}
            aria-hidden="true"
          />
        ) : null}

        {active != null && plotted[active] ? (
          <>
            <span
              className="pointer-events-none absolute inset-y-0 border-l border-dashed border-border"
              style={{ left: `${(plotted[active].x / VIEW_W) * 100}%` }}
              aria-hidden="true"
            />
            <Tooltip
              x={(plotted[active].x / VIEW_W) * 100}
              title={plotted[active].label}
              value={plotted[active].value == null ? "no data" : format(plotted[active].value!)}
              tone={tone}
            />
          </>
        ) : null}

        <div className="absolute inset-0 flex" onPointerLeave={() => setActive(null)}>
          {points.map((p, i) => (
            <span
              key={p.label}
              className="h-full flex-1"
              onPointerEnter={() => setActive(i)}
              aria-hidden="true"
            />
          ))}
        </div>
      </div>

      <div className="flex justify-between font-mono text-[0.625rem] text-muted-foreground">
        <span>{points[0]?.label}</span>
        <span className="hidden sm:inline">{points[Math.floor((points.length - 1) / 2)]?.label}</span>
        <span>{points[points.length - 1]?.label}</span>
      </div>
      <ChartValues points={points} format={format} />
    </div>
  )
}

/** The same line with everything explanatory stripped, for inside a table cell or a stat tile. */
export function Sparkline({
  points,
  tone = "ok",
  max,
  className,
  label,
}: {
  points: ChartPoint[]
  tone?: StatusTone
  max?: number
  className?: string
  label: string
}) {
  const uid = useId().replace(/[^a-zA-Z0-9]/g, "")
  const known = points.filter((p) => p.value != null) as { value: number }[]
  if (known.length < 2) {
    return (
      <span className={cn("inline-block h-6 w-20 rounded-sm bg-secondary", className)} aria-hidden="true" />
    )
  }
  const ceiling = max ?? Math.max(...known.map((p) => p.value), 1)
  const segments = runs(scale(points, ceiling))

  return (
    <span className={cn("relative inline-block h-6 w-20", className)}>
      <svg
        viewBox={`0 0 ${VIEW_W} ${VIEW_H}`}
        preserveAspectRatio="none"
        className="h-full w-full"
        aria-hidden="true"
      >
        <defs>
          <linearGradient id={`${uid}-spark`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={TONE_VAR[tone]} stopOpacity="0.28" />
            <stop offset="100%" stopColor={TONE_VAR[tone]} stopOpacity="0" />
          </linearGradient>
        </defs>
        {segments.map((run, i) => (
          <g key={i}>
            <path
              d={`${curve(run)} L ${run[run.length - 1].x} ${VIEW_H} L ${run[0].x} ${VIEW_H} Z`}
              fill={`url(#${uid}-spark)`}
            />
            <path
              d={curve(run)}
              fill="none"
              stroke={TONE_VAR[tone]}
              strokeWidth="1.25"
              vectorEffect="non-scaling-stroke"
            />
          </g>
        ))}
      </svg>
      <span className="sr-only">{label}</span>
    </span>
  )
}

/**
 * Stacked columns with gradient fills and rounded tops. Used where the denominator matters as much
 * as the ratio — a 100% day off two checks and off two hundred are not the same day.
 */
export function BarSeries({
  columns,
  height = 112,
  format = (n) => String(n),
  className,
}: {
  columns: BarColumn[]
  height?: number
  format?: (n: number) => string
  className?: string
}) {
  const [active, setActive] = useState<number | null>(null)
  const totals = columns.map((c) => c.segments.reduce((a, s) => a + s.value, 0))
  const ceiling = Math.max(...totals, 1)

  if (columns.length === 0 || totals.every((t) => t === 0)) {
    return (
      <div
        className={cn(
          "flex items-center justify-center rounded-md border border-dashed border-border text-xs text-muted-foreground",
          className,
        )}
        style={{ height }}
      >
        No checks recorded yet
      </div>
    )
  }

  return (
    <div className={cn("flex flex-col gap-2", className)}>
      <div className="relative" style={{ height }}>
        {[0, 0.25, 0.5, 0.75].map((t) => (
          <span
            key={t}
            className="absolute inset-x-0 border-t border-dashed border-border"
            style={{ top: `${t * 100}%` }}
            aria-hidden="true"
          />
        ))}
        <div
          className="absolute inset-0 flex items-end gap-px"
          onPointerLeave={() => setActive(null)}
          aria-hidden="true"
        >
          {columns.map((col, i) => {
            const stack = [...col.segments].filter((s) => s.value > 0)
            return (
              <span
                key={col.label}
                onPointerEnter={() => setActive(i)}
                className={cn(
                  "relative flex h-full flex-1 flex-col justify-end transition-opacity",
                  active != null && active !== i && "opacity-40",
                )}
              >
                {stack.map((s, si) => (
                  <span
                    key={s.label}
                    className={cn(
                      "relative block min-h-px w-full bg-gradient-to-t",
                      TONE_BAR[s.tone],
                      si === 0 && "rounded-t-[3px]",
                      col.partial && "hatched",
                    )}
                    style={{ height: `${(s.value / ceiling) * 100}%` }}
                  />
                ))}
              </span>
            )
          })}
        </div>
        {active != null ? (
          <Tooltip
            x={((active + 0.5) / columns.length) * 100}
            title={columns[active].label}
            value={columns[active].segments
              .filter((s) => s.value > 0)
              .map((s) => `${format(s.value)} ${s.label}`)
              .join(" · ")}
            tone={columns[active].segments.find((s) => s.value > 0)?.tone ?? "neutral"}
          />
        ) : null}
      </div>
      <div className="flex justify-between font-mono text-[0.625rem] text-muted-foreground">
        <span>{columns[0]?.label}</span>
        <span>{columns[columns.length - 1]?.label}</span>
      </div>
      <ul className="sr-only">
        {columns.map((col) => (
          <li key={col.label}>
            {col.label}:{" "}
            {col.segments.map((s) => `${format(s.value)} ${s.label}`).join(", ") || "no checks"}
            {col.partial ? " (day still open)" : ""}
          </li>
        ))}
      </ul>
    </div>
  )
}

/**
 * Composition as one stacked bar. aria-hidden: the same figures stand as text beside it, so this is
 * emphasis, never the only place a number exists.
 *
 * Non-premium alive entries are `foreground/40` rather than full strength — white is the brightest
 * token on the page, so at full opacity they outshouted the green premium ones and an all-white
 * degraded row read as "all good".
 */
export function SegmentBar({
  segments,
  className,
}: {
  segments: { value: number; tone: StatusTone; muted?: boolean }[]
  className?: string
}) {
  const reduce = useReducedMotion()
  const total = segments.reduce((a, s) => a + s.value, 0)
  if (total === 0) {
    return <div className={cn("h-1.5 w-32 rounded-full bg-secondary", className)} aria-hidden="true" />
  }
  return (
    <div
      className={cn("flex h-1.5 w-32 gap-px overflow-hidden rounded-full bg-secondary", className)}
      aria-hidden="true"
    >
      {segments
        .filter((s) => s.value > 0)
        .map((s, i) => (
          <motion.div
            key={i}
            className={cn("h-full", s.muted ? "bg-foreground/40" : TONE_BG[s.tone])}
            initial={{ width: reduce ? `${(s.value / total) * 100}%` : 0 }}
            animate={{ width: `${(s.value / total) * 100}%` }}
            transition={{ duration: 0.6, delay: i * 0.06, ease: "easeOut" }}
          />
        ))}
    </div>
  )
}

/** Horizontal bars for comparing a handful of named figures (per-key traffic, entries per pool). */
export function BarList({
  items,
  format = (n) => String(n),
  className,
}: {
  items: { label: string; value: number; hint?: string; tone?: StatusTone; badge?: React.ReactNode }[]
  format?: (n: number) => string
  className?: string
}) {
  const reduce = useReducedMotion()
  const ceiling = Math.max(...items.map((i) => i.value), 1)
  return (
    <ul className={cn("flex flex-col gap-3", className)}>
      {items.map((item) => {
        const tone = item.tone ?? "neutral"
        return (
          <li key={item.label} className="flex flex-col gap-1.5">
            <div className="flex items-baseline justify-between gap-3">
              <span className="flex min-w-0 items-center gap-2">
                <span className="min-w-0 truncate text-sm">{item.label}</span>
                {item.badge}
              </span>
              <span className={cn("shrink-0 font-mono text-xs", TONE_TEXT[tone])}>
                {format(item.value)}
              </span>
            </div>
            <div className="h-1.5 overflow-hidden rounded-full bg-secondary" aria-hidden="true">
              <motion.div
                className={cn("h-full rounded-full bg-gradient-to-r", TONE_BAR[tone])}
                initial={{ width: reduce ? `${(item.value / ceiling) * 100}%` : 0 }}
                animate={{ width: `${(item.value / ceiling) * 100}%` }}
                transition={{ duration: 0.6, ease: "easeOut" }}
              />
            </div>
            {item.hint ? (
              <span className="font-mono text-[0.625rem] text-muted-foreground">{item.hint}</span>
            ) : null}
          </li>
        )
      })}
    </ul>
  )
}

/** Names the colours a stacked bar uses. Without it the bar is decoration. */
export function ChartLegend({
  items,
  className,
}: {
  items: { label: string; tone: StatusTone; muted?: boolean; value?: string }[]
  className?: string
}) {
  return (
    <ul className={cn("flex flex-wrap items-center gap-x-4 gap-y-1.5", className)}>
      {items.map((item) => (
        <li key={item.label} className="flex items-center gap-1.5 font-mono text-[0.625rem] uppercase tracking-[0.1em] text-muted-foreground">
          <span
            className={cn("size-1.5 rounded-full", item.muted ? "bg-foreground/40" : TONE_BG[item.tone])}
            aria-hidden="true"
          />
          {item.label}
          {item.value ? <span className="text-foreground">{item.value}</span> : null}
        </li>
      ))}
    </ul>
  )
}
