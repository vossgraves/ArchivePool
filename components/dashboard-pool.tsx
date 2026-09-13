"use client"

import Link from "next/link"
import type { CategoryStatus, UptimePoint } from "@/lib/queries"
import { Badge, StatusDot, toneFor } from "@/components/ui/badge"
import { buttonVariants } from "@/components/ui/button"
import { ChartLegend, SegmentBar, TrendChart } from "@/components/ui/chart"
import { Panel } from "@/components/ui/panel"
import { cn, formatAgo, formatCount } from "@/lib/utils"

const HEALTH_LABEL: Record<CategoryStatus["health"], string> = {
  operational: "Operational",
  degraded: "Degraded",
  down: "Down",
  unknown: "No data",
}

/**
 * The pool as it affects this account: every key here leases from these categories, so a category
 * with nothing premium in it is the reader's problem even when none of the entries are theirs.
 * Aggregate only — an individual entry is never identified outside /admin.
 */
export function DashboardPool({
  pool,
  history,
}: {
  pool: CategoryStatus[]
  history: UptimePoint[]
}) {
  const checks = history.reduce((a, p) => a + p.checks, 0)
  const passed = history.reduce((a, p) => a + p.ok, 0)
  const pct = checks > 0 ? Math.round((passed / checks) * 1000) / 10 : null
  const stocked = pool.filter((c) => c.total > 0)

  return (
    <Panel
      label="Pool health"
      description="What your keys can actually be served, by category. Alive counts only entries the pool may hand out; premium is the subset apps prefer."
      actions={
        <Link href="/" className={cn(buttonVariants({ variant: "outline", size: "sm" }))}>
          Full status board
        </Link>
      }
      bodyClassName="flex flex-col gap-5"
    >
      {checks > 0 ? (
        <div className="flex flex-col gap-2">
          <div className="flex items-baseline justify-between gap-3">
            <h3 className="label-mono">Pool pass rate · {history.length}d</h3>
            <span className="font-mono text-sm">{pct === null ? "—" : `${formatCount(pct)}%`}</span>
          </div>
          <TrendChart
            max={100}
            maxLabel="100%"
            tone={pct !== null && pct >= 95 ? "ok" : pct !== null && pct >= 80 ? "warn" : "danger"}
            format={(n) => `${formatCount(n)}%`}
            points={history.map((p) => ({ label: p.label, value: p.pct, partial: p.partial }))}
          />
        </div>
      ) : null}

      <ChartLegend
        items={[
          { label: "Premium", tone: "ok" },
          { label: "Serving", tone: "neutral", muted: true },
          { label: "Pending", tone: "warn" },
          { label: "Dead", tone: "danger" },
        ]}
      />

      <ul className="flex flex-col gap-2">
        {(stocked.length > 0 ? stocked : pool).map((category) => (
          <li
            key={`${category.service}-${category.kind}`}
            className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 rounded-md border border-border bg-background/40 px-3.5 py-3"
          >
            <span className="flex min-w-0 items-center gap-2.5">
              <StatusDot tone={toneFor(category.health)} />
              <span className="min-w-0">
                <span className="block truncate text-sm font-medium">{category.label}</span>
                <span className="label-mono mt-1 block">
                  {formatCount(category.alive)} of {formatCount(category.total)} serving ·{" "}
                  {category.uptimePct === null ? "no checks" : `${formatCount(category.uptimePct)}% uptime`}
                </span>
              </span>
            </span>
            <span className="flex items-center gap-3">
              <SegmentBar
                className="w-20 sm:w-32"
                segments={[
                  { value: category.premium, tone: "ok" },
                  { value: Math.max(category.alive - category.premium, 0), tone: "neutral", muted: true },
                  { value: category.pending, tone: "warn" },
                  { value: category.dead, tone: "danger" },
                ]}
              />
              <Badge tone={toneFor(category.health)}>{HEALTH_LABEL[category.health]}</Badge>
              <span className="hidden font-mono text-[0.625rem] text-muted-foreground sm:inline">
                {formatAgo(category.lastCheckedAt)}
              </span>
            </span>
          </li>
        ))}
      </ul>
    </Panel>
  )
}
