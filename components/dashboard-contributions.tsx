// SPDX-License-Identifier: GPL-3.0-or-later
"use client"

import Link from "next/link"
import type { DashboardContribution, UptimePoint } from "@/lib/queries"
import { Badge, toneFor } from "@/components/ui/badge"
import { buttonVariants } from "@/components/ui/button"
import { BarSeries, TrendChart } from "@/components/ui/chart"
import { Empty } from "@/components/ui/empty"
import { Panel } from "@/components/ui/panel"
import {
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { cn, expiryState, formatAgo, formatCount, formatDateTime, formatUntil } from "@/lib/utils"

const KIND_LABEL: Record<string, string> = { account: "account", api: "instance" }

/**
 * Mirrors displayStatus() in the admin sources panel: the moderation flags win over the health
 * status, because a disabled entry usually still reads "alive" and calling that alive is a lie.
 * Expiry is layered on top of both — a lapsed subscription authenticates fine right up until it
 * silently stops being lossless, which is the whole reason expires_at exists.
 */
function displayStatus(entry: DashboardContribution): string {
  if (entry.removed) return "removed"
  if (expiryState(entry.expiresAt) === "expired") return "expired"
  if (entry.disabled) return "disabled"
  return entry.status
}

const HEAD = "label-mono h-auto px-3 py-2.5 font-medium text-muted-foreground"
const CELL = "px-3 py-3 whitespace-nowrap"
const NUM = "px-3 py-3 text-right font-mono whitespace-nowrap"

export function DashboardContributions({
  contributions,
  history,
}: {
  contributions: DashboardContribution[]
  history: UptimePoint[]
}) {
  const live = contributions.filter((c) => !c.removed)
  const checks = history.reduce((a, p) => a + p.checks, 0)
  const passed = history.reduce((a, p) => a + p.ok, 0)
  const pct = checks > 0 ? Math.round((passed / checks) * 1000) / 10 : null

  return (
    <Panel
      label="Your contributions"
      description="Entries credited to this account. A submission made without ticking “credit me” stays anonymous by design, so it cannot appear here."
      actions={
        <Link href="/submit" className={cn(buttonVariants({ variant: "outline", size: "sm" }))}>
          Contribute another
        </Link>
      }
      bodyClassName={contributions.length === 0 ? "p-4" : "flex flex-col gap-5 p-0"}
    >
      {contributions.length === 0 ? (
        <Empty
          action={
            <Link href="/submit" className={cn(buttonVariants({ size: "sm" }))}>
              Contribute a source
            </Link>
          }
        >
          Nothing is credited to you yet. Contributed accounts and instances appear here with their
          live status, uptime and expiry once you submit one with credit turned on.
        </Empty>
      ) : (
        <>
          {checks > 0 ? (
            <div className="grid gap-5 border-b border-border p-4 md:grid-cols-2">
              <div className="flex flex-col gap-2">
                <div className="flex items-baseline justify-between gap-3">
                  <h3 className="label-mono">Pass rate · {history.length}d</h3>
                  <span className="font-mono text-sm">
                    {pct === null ? "—" : `${formatCount(pct)}%`}
                  </span>
                </div>
                <TrendChart
                  max={100}
                  maxLabel="100%"
                  tone={pct !== null && pct >= 95 ? "ok" : pct !== null && pct >= 80 ? "warn" : "danger"}
                  format={(n) => `${formatCount(n)}%`}
                  points={history.map((p) => ({ label: p.label, value: p.pct, partial: p.partial }))}
                />
              </div>
              <div className="flex flex-col gap-2">
                <div className="flex items-baseline justify-between gap-3">
                  <h3 className="label-mono">Checks per day</h3>
                  <span className="font-mono text-sm">{formatCount(checks)}</span>
                </div>
                {/* The denominator, beside the ratio: a 100% day off two checks and off two hundred
                    are not the same day, and the percentage alone hides which one this was. */}
                <BarSeries
                  format={(n) => formatCount(n)}
                  columns={history.map((p) => ({
                    label: p.label,
                    partial: p.partial,
                    segments: [
                      { label: "failed", value: p.checks - p.ok, tone: "danger" },
                      { label: "passed", value: p.ok, tone: "ok" },
                    ],
                  }))}
                />
              </div>
            </div>
          ) : null}

          <Table className="min-w-[46rem] text-left text-xs">
            <TableCaption className="sr-only">
              Your contributed entries with status, uptime, latency, declared expiry and last check
            </TableCaption>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead scope="col" className={cn(HEAD, "pl-4 text-left")}>
                  Entry
                </TableHead>
                <TableHead scope="col" className={cn(HEAD, "text-left")}>
                  Status
                </TableHead>
                <TableHead scope="col" className={cn(HEAD, "text-right")}>
                  Uptime
                </TableHead>
                <TableHead scope="col" className={cn(HEAD, "text-right")}>
                  Latency
                </TableHead>
                <TableHead scope="col" className={cn(HEAD, "text-left")}>
                  Expires
                </TableHead>
                <TableHead scope="col" className={cn(HEAD, "text-left")}>
                  Checked
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {contributions.map((entry) => {
                const status = displayStatus(entry)
                const expiry = expiryState(entry.expiresAt)
                return (
                  <TableRow key={`${entry.kind}-${entry.id}`} className="border-border/60 last:border-0">
                    <TableHead
                      scope="row"
                      className="h-auto px-4 py-3 text-left font-medium text-foreground"
                    >
                      <span className="block max-w-64 truncate">{entry.label}</span>
                      <span className="label-mono mt-1 block truncate">
                        {entry.service} · {KIND_LABEL[entry.kind] ?? entry.kind}
                      </span>
                    </TableHead>
                    <TableCell className={CELL}>
                      <span className="flex flex-wrap items-center gap-1.5">
                        <Badge tone={toneFor(status)}>{status}</Badge>
                        {entry.premium ? <Badge tone={toneFor("premium")}>premium</Badge> : null}
                      </span>
                    </TableCell>
                    <TableCell className={NUM}>
                      {entry.uptimePct === null ? (
                        <>
                          <span aria-hidden="true">—</span>
                          <span className="sr-only">No checks yet</span>
                        </>
                      ) : (
                        `${formatCount(entry.uptimePct)}%`
                      )}
                    </TableCell>
                    <TableCell className={NUM}>
                      {entry.latencyMs === null ? (
                        <>
                          <span aria-hidden="true">—</span>
                          <span className="sr-only">Not measured</span>
                        </>
                      ) : (
                        `${formatCount(entry.latencyMs)}ms`
                      )}
                    </TableCell>
                    <TableCell
                      className={cn(
                        CELL,
                        "font-mono",
                        expiry === "expired" && "text-destructive",
                        expiry === "expiring" && "text-warn",
                        (expiry === "none" || expiry === "ok") && "text-muted-foreground",
                      )}
                    >
                      <span title={entry.expiresAt ? formatDateTime(entry.expiresAt) : undefined}>
                        {formatUntil(entry.expiresAt)}
                      </span>
                    </TableCell>
                    <TableCell className={cn(CELL, "font-mono text-muted-foreground")}>
                      <span
                        title={entry.lastCheckedAt ? formatDateTime(entry.lastCheckedAt) : undefined}
                      >
                        {formatAgo(entry.lastCheckedAt)}
                      </span>
                    </TableCell>
                  </TableRow>
                )
              })}
            </TableBody>
          </Table>

          <p className="px-4 pb-4 text-xs leading-relaxed text-muted-foreground text-pretty">
            {formatCount(live.length)} {live.length === 1 ? "entry" : "entries"} in the pool.
            Credentials are stored encrypted and are never shown back to anyone, including you —
            these rows are the masked labels the pool itself uses.
          </p>
        </>
      )}
    </Panel>
  )
}
