"use client"

import useSWR from "swr"
import { AnimatePresence, motion } from "motion/react"
import { useEffect, useRef, useState } from "react"
import type { CategoryStatus } from "@/lib/queries"

interface StatusPayload {
  generatedAt: string
  categories: CategoryStatus[]
}

const fetcher = (url: string) => fetch(url).then((r) => r.json() as Promise<StatusPayload>)

const HEALTH: Record<
  CategoryStatus["health"],
  { label: string; dot: string; text: string; bar: string }
> = {
  operational: { label: "Operational", dot: "bg-ok", text: "text-ok", bar: "bg-ok" },
  degraded: { label: "Degraded", dot: "bg-warn", text: "text-warn", bar: "bg-warn" },
  down: { label: "Down", dot: "bg-destructive", text: "text-destructive", bar: "bg-destructive" },
  unknown: { label: "No data", dot: "bg-border", text: "text-muted-foreground", bar: "bg-border" },
}

function overallHealth(cats: CategoryStatus[]) {
  const known = cats.filter((c) => c.health !== "unknown")
  if (known.length === 0) return { label: "Awaiting first submissions", tone: "unknown" as const }
  if (known.every((c) => c.health === "operational"))
    return { label: "All systems operational", tone: "operational" as const }
  if (known.some((c) => c.health === "down")) return { label: "Partial outage", tone: "down" as const }
  return { label: "Degraded performance", tone: "degraded" as const }
}

function timeAgo(iso: string | null): string {
  if (!iso) return "never"
  const diff = Date.now() - new Date(iso).getTime()
  const min = Math.floor(diff / 60000)
  if (min < 1) return "just now"
  if (min < 60) return `${min}m ago`
  const hr = Math.floor(min / 60)
  if (hr < 24) return `${hr}h ago`
  return `${Math.floor(hr / 24)}d ago`
}

/** Smoothly counts from 0 to `value` once the value is known. */
function useCountUp(value: number, duration = 700) {
  const [display, setDisplay] = useState(0)
  const ref = useRef(0)
  useEffect(() => {
    const from = ref.current
    const start = performance.now()
    let raf = 0
    const tick = (now: number) => {
      const t = Math.min(1, (now - start) / duration)
      const eased = 1 - Math.pow(1 - t, 3)
      const next = Math.round(from + (value - from) * eased)
      setDisplay(next)
      if (t < 1) raf = requestAnimationFrame(tick)
      else ref.current = value
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [value, duration])
  return display
}

function SegmentBar({ cat }: { cat: CategoryStatus }) {
  const total = Math.max(cat.total, 1)
  const premium = cat.premium
  const aliveOnly = Math.max(cat.alive - cat.premium, 0)
  const segments = [
    { w: premium / total, cls: "bg-ok" },
    { w: aliveOnly / total, cls: "bg-foreground" },
    { w: cat.pending / total, cls: "bg-muted-foreground/40" },
    { w: cat.dead / total, cls: "bg-destructive/60" },
  ].filter((s) => s.w > 0)

  if (cat.total === 0) {
    return <div className="h-2 w-full rounded-full bg-secondary" />
  }
  return (
    <div className="flex h-2 w-full gap-0.5 overflow-hidden rounded-full">
      {segments.map((s, i) => (
        <motion.div
          key={i}
          className={`h-full ${s.cls}`}
          initial={{ width: 0 }}
          animate={{ width: `${s.w * 100}%` }}
          transition={{ duration: 0.7, delay: 0.1 + i * 0.08, ease: "easeOut" }}
        />
      ))}
    </div>
  )
}

function DetailStat({ label, value, tone }: { label: string; value: string | number; tone?: string }) {
  return (
    <div className="flex flex-col gap-0.5">
      <span className={`font-mono text-xl font-semibold tabular-nums ${tone ?? ""}`}>{value}</span>
      <span className="text-[0.7rem] uppercase tracking-wide text-muted-foreground">{label}</span>
    </div>
  )
}

function StatusCard({ cat, index }: { cat: CategoryStatus; index: number }) {
  const [open, setOpen] = useState(false)
  const cfg = HEALTH[cat.health]
  return (
    <motion.div
      layout
      initial={{ opacity: 0, y: 16 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.4, delay: index * 0.06, ease: "easeOut" }}
      className="overflow-hidden rounded-xl border border-border bg-card"
    >
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex w-full flex-col gap-4 p-5 text-left transition-colors hover:bg-secondary/40"
      >
        <div className="flex items-start justify-between gap-3">
          <div className="flex flex-col gap-1">
            <h3 className="text-base font-semibold tracking-tight">{cat.label}</h3>
            <span className="font-mono text-xs text-muted-foreground">checked {timeAgo(cat.lastCheckedAt)}</span>
          </div>
          <div className="flex items-center gap-3">
            <span className={`inline-flex items-center gap-2 font-mono text-xs uppercase tracking-wider ${cfg.text}`}>
              <span className={`relative flex h-2 w-2`}>
                {cat.health === "operational" && (
                  <span className={`absolute inline-flex h-full w-full animate-ping rounded-full ${cfg.dot} opacity-60`} />
                )}
                <span className={`relative inline-flex h-2 w-2 rounded-full ${cfg.dot}`} />
              </span>
              {cfg.label}
            </span>
            <motion.svg
              animate={{ rotate: open ? 180 : 0 }}
              transition={{ duration: 0.2 }}
              width="16"
              height="16"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              className="text-muted-foreground"
              aria-hidden="true"
            >
              <path d="m6 9 6 6 6-6" />
            </motion.svg>
          </div>
        </div>

        <SegmentBar cat={cat} />

        <div className="flex items-center justify-between font-mono text-xs text-muted-foreground">
          <span>
            <span className="text-foreground">{cat.alive}</span>/{cat.total} alive
          </span>
          <span>{cat.uptimePct === null ? "no checks yet" : `${cat.uptimePct}% uptime`}</span>
        </div>
      </button>

      <AnimatePresence initial={false}>
        {open && (
          <motion.div
            key="detail"
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.25, ease: "easeInOut" }}
            className="overflow-hidden border-t border-border"
          >
            <div className="grid grid-cols-2 gap-4 p-5 sm:grid-cols-4">
              <DetailStat label="Total" value={cat.total} />
              <DetailStat label="Premium" value={cat.premium} tone="text-ok" />
              <DetailStat label="Pending" value={cat.pending} />
              <DetailStat
                label="Dead"
                value={cat.dead}
                tone={cat.dead > 0 ? "text-destructive" : undefined}
              />
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </motion.div>
  )
}

export function StatusBoard({ fallback }: { fallback?: StatusPayload }) {
  const { data, isLoading } = useSWR("/api/status", fetcher, {
    fallbackData: fallback,
    refreshInterval: 60_000,
    revalidateOnFocus: true,
  })

  const categories = data?.categories ?? []
  const overall = overallHealth(categories)
  const totalAlive = categories.reduce((a, c) => a + c.alive, 0)
  const totalPremium = categories.reduce((a, c) => a + c.premium, 0)
  const aliveCount = useCountUp(totalAlive)
  const premiumCount = useCountUp(totalPremium)
  const cfg = HEALTH[overall.tone]

  return (
    <div className="flex flex-col gap-8">
      <motion.div
        initial={{ opacity: 0, y: 12 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.4, ease: "easeOut" }}
        className="flex flex-col gap-4 rounded-xl border border-border bg-card p-6 sm:flex-row sm:items-center sm:justify-between"
      >
        <div className="flex items-center gap-3">
          <span className="relative flex h-3.5 w-3.5">
            {overall.tone === "operational" && (
              <span className={`absolute inline-flex h-full w-full animate-ping rounded-full ${cfg.dot} opacity-60`} />
            )}
            <span className={`relative inline-flex h-3.5 w-3.5 rounded-full ${cfg.dot}`} />
          </span>
          <span className="text-lg font-medium">{overall.label}</span>
        </div>
        <div className="flex items-center gap-6 font-mono text-sm text-muted-foreground">
          <span>
            <span className="text-foreground tabular-nums">{aliveCount}</span> alive
          </span>
          <span>
            <span className="text-ok tabular-nums">{premiumCount}</span> premium
          </span>
        </div>
      </motion.div>

      {isLoading && !data ? (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          {[0, 1, 2, 3].map((i) => (
            <div key={i} className="h-[152px] animate-pulse rounded-xl border border-border bg-card" />
          ))}
        </div>
      ) : (
        <motion.div layout className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          {categories.map((cat, i) => (
            <StatusCard key={`${cat.service}-${cat.kind}`} cat={cat} index={i} />
          ))}
        </motion.div>
      )}
    </div>
  )
}
