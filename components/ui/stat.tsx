// SPDX-License-Identifier: GPL-3.0-or-later
"use client"

import * as React from "react"
import Link from "next/link"
import { ArrowUpRight } from "lucide-react"
import { TONE_TEXT, type StatusTone } from "@/components/ui/badge"
import { cn } from "@/lib/utils"

/**
 * Counts up to `value`. With reduced motion the figure still returns, it just never moves.
 * Frames are cancelled on unmount and on a mid-ramp target change, so a 60s poll cannot stack
 * ramps that fight over state.
 */
export function useCountUp(value: number, animate: boolean, duration = 700) {
  const [display, setDisplay] = React.useState(value)
  const drawn = React.useRef(value)

  React.useEffect(() => {
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

interface StatProps extends React.HTMLAttributes<HTMLDivElement> {
  label?: string
  value?: string | number
  subvalue?: string
  tone?: StatusTone
}

/**
 * Stat Root. Supports both compositional children (<StatLabel>, <StatValue>)
 * and direct props (label, value, subvalue, tone).
 */
export function Stat({
  label,
  value,
  subvalue,
  tone,
  className,
  children,
  ...props
}: StatProps) {
  if (children) {
    return (
      <div
        data-slot="stat"
        className={cn("flex min-w-0 flex-col gap-1.5", className)}
        {...props}
      >
        {children}
      </div>
    )
  }

  return (
    <div
      data-slot="stat"
      className={cn("flex min-w-0 flex-col gap-1.5", className)}
      {...props}
    >
      <div className="flex items-baseline gap-2">
        <span
          className={cn(
            "font-mono text-xl font-semibold leading-none tabular-nums tracking-tight text-foreground",
            tone ? TONE_TEXT[tone] : undefined
          )}
        >
          {value}
        </span>
        {subvalue ? (
          <span className="font-mono text-xs text-muted-foreground tabular-nums">
            {subvalue}
          </span>
        ) : null}
      </div>
      {label ? (
        <span className="font-mono text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
          {label}
        </span>
      ) : null}
    </div>
  )
}

export function StatLabel({
  className,
  ...props
}: React.HTMLAttributes<HTMLParagraphElement>) {
  return (
    <p
      data-slot="stat-label"
      className={cn(
        "font-mono text-[11px] font-medium uppercase tracking-wider text-muted-foreground",
        className
      )}
      {...props}
    />
  )
}

export function StatValue({
  className,
  tone,
  ...props
}: React.HTMLAttributes<HTMLHeadingElement> & { tone?: StatusTone }) {
  return (
    <div
      data-slot="stat-value"
      className={cn(
        "font-mono text-2xl font-semibold leading-none tracking-tight tabular-nums text-foreground",
        tone ? TONE_TEXT[tone] : undefined,
        className
      )}
      {...props}
    />
  )
}

export function StatDescription({
  className,
  ...props
}: React.HTMLAttributes<HTMLParagraphElement>) {
  return (
    <p
      data-slot="stat-description"
      className={cn("text-xs leading-relaxed text-muted-foreground text-pretty", className)}
      {...props}
    />
  )
}

export function StatIndicator({
  tone = "neutral",
  className,
  ...props
}: React.HTMLAttributes<HTMLSpanElement> & { tone?: StatusTone }) {
  return (
    <span
      data-slot="stat-indicator"
      className={cn(
        "inline-flex items-center gap-1 font-mono text-xs tabular-nums",
        TONE_TEXT[tone],
        className
      )}
      {...props}
    />
  )
}

/**
 * StatTile / KPI Card: one figure, one sentence of context, and an optional visual in the footer slot.
 */
export function StatTile({
  label,
  value,
  hint,
  tone,
  href,
  linkLabel,
  children,
  className,
}: {
  label: string
  value: string | number
  hint?: string
  tone?: StatusTone
  href?: string
  linkLabel?: string
  children?: React.ReactNode
  className?: string
}) {
  return (
    <div
      data-slot="stat-tile"
      className={cn(
        "flex min-w-0 flex-col gap-3 rounded-lg border border-border bg-card p-4 shadow-2xs transition-colors",
        className
      )}
    >
      <div className="flex items-start justify-between gap-2">
        <p className="font-mono text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
          {label}
        </p>
        {href ? (
          <Link
            href={href}
            className="inline-flex items-center gap-1 font-mono text-[11px] text-muted-foreground transition-colors hover:text-foreground"
          >
            {linkLabel ?? "View"}
            <ArrowUpRight className="size-3" aria-hidden="true" />
          </Link>
        ) : null}
      </div>
      <p
        className={cn(
          "font-mono text-2xl font-semibold leading-none tracking-tight tabular-nums text-foreground",
          tone ? TONE_TEXT[tone] : undefined
        )}
      >
        {value}
      </p>
      {hint ? (
        <p className="text-xs leading-relaxed text-muted-foreground text-pretty">{hint}</p>
      ) : null}
      {children ? <div className="mt-auto pt-1">{children}</div> : null}
    </div>
  )
}
