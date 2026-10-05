// SPDX-License-Identifier: GPL-3.0-or-later
"use client"

import { useEffect, useRef, useState } from "react"
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

/** Figure over mono label, for a row of numbers inside a panel that already has a heading. */
export function Stat({
  label,
  value,
  tone,
  className,
}: {
  label: string
  value: string
  tone?: StatusTone
  className?: string
}) {
  return (
    <div className={cn("flex min-w-0 flex-col gap-1", className)}>
      <span className={cn("font-mono text-lg leading-none", tone ? TONE_TEXT[tone] : undefined)}>
        {value}
      </span>
      <span className="label-mono">{label}</span>
    </div>
  )
}

/**
 * A standalone KPI card: one figure, one sentence of context, and an optional visual in the
 * footer slot. Tiles are the same height in a row whatever they hold, so a row of them reads as
 * one instrument panel rather than four boxes — hence the flex column with the slot pinned to the
 * bottom rather than each tile sizing to its content.
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
  value: string
  hint?: string
  tone?: StatusTone
  href?: string
  linkLabel?: string
  children?: React.ReactNode
  className?: string
}) {
  return (
    <div
      className={cn(
        "flex min-w-0 flex-col gap-3 rounded-lg border border-border bg-card p-4 edge-lit",
        className,
      )}
    >
      <div className="flex items-start justify-between gap-2">
        <p className="label-mono">{label}</p>
        {href ? (
          <Link
            href={href}
            className="inline-flex items-center gap-1 font-mono text-[0.625rem] uppercase tracking-[0.1em] text-muted-foreground transition-colors hover:text-foreground"
          >
            {linkLabel ?? "Open"}
            <ArrowUpRight className="size-3" aria-hidden="true" />
          </Link>
        ) : null}
      </div>
      <p
        className={cn(
          "font-mono text-2xl leading-none tracking-tight",
          tone ? TONE_TEXT[tone] : undefined,
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
