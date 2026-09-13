"use client"

import Link from "next/link"
import { ArrowUpRight } from "lucide-react"
import type { DashboardSnapshot } from "@/lib/queries"
import { Badge, StatusDot, toneFor, type StatusTone } from "@/components/ui/badge"
import { ChartLegend, SegmentBar, Sparkline } from "@/components/ui/chart"
import { Empty } from "@/components/ui/empty"
import { Panel } from "@/components/ui/panel"
import { StatTile } from "@/components/ui/stat"
import { cn, expiryState, formatAgo, formatCount, formatUntil } from "@/lib/utils"

/** Nothing here is actionable on its own — every item names the one thing to do about it. */
interface ActionItem {
  id: string
  tone: StatusTone
  headline: string
  detail: string
  href?: string
  hrefLabel?: string
}

function isServable(status: string) {
  return status === "alive" || status === "preview"
}

/**
 * What the dashboard puts above everything else. Ordered by cost of ignoring it: a credential the
 * pool has already stopped serving beats one that will stop next week, which beats a key nobody has
 * used. The list is the reason this page is a dashboard rather than a table of keys.
 */
function buildActions(snapshot: DashboardSnapshot): ActionItem[] {
  const items: ActionItem[] = []

  for (const request of snapshot.requests) {
    if (request.status === "approved" && request.resultingKeyId === null) {
      items.push({
        id: `claim-${request.id}`,
        tone: "ok",
        headline: `“${request.subject}” was approved`,
        detail: "Reveal the key below. It is shown once, so nothing happens until you do.",
        href: "#requests",
        hrefLabel: "Go to requests",
      })
    }
  }

  for (const entry of snapshot.contributions) {
    if (entry.removed) continue
    const expiry = expiryState(entry.expiresAt)
    if (expiry === "expired") {
      items.push({
        id: `expired-${entry.id}`,
        tone: "danger",
        headline: `${entry.label} has passed its expiry`,
        detail: "The pool stopped leasing it. Submitting a fresh credential replaces it in place.",
        href: "/submit",
        hrefLabel: "Contribute",
      })
    } else if (expiry === "expiring") {
      items.push({
        id: `expiring-${entry.id}`,
        tone: "warn",
        headline: `${entry.label} expires ${formatUntil(entry.expiresAt)}`,
        detail: "Renew the subscription or submit a replacement before it stops being served.",
        href: "/submit",
        hrefLabel: "Contribute",
      })
    } else if (entry.status === "dead") {
      items.push({
        id: `dead-${entry.id}`,
        tone: "danger",
        headline: `${entry.label} is failing its checks`,
        detail: "It is no longer served. A re-submitted credential updates the same entry.",
        href: "/submit",
        hrefLabel: "Contribute",
      })
    } else if (entry.disabled) {
      items.push({
        id: `disabled-${entry.id}`,
        tone: "warn",
        headline: `${entry.label} is disabled`,
        detail: "Enough apps reported it dead to take it out of rotation. The next sweep re-tests it.",
      })
    }
  }

  for (const category of snapshot.pool) {
    if (category.health === "down") {
      items.push({
        id: `pool-down-${category.service}-${category.kind}`,
        tone: "danger",
        headline: `${category.label} has nothing to serve`,
        detail: `${formatCount(category.total)} ${category.total === 1 ? "entry" : "entries"} in the pool, none of them usable right now.`,
        href: "/submit",
        hrefLabel: "Contribute",
      })
    } else if (category.health === "degraded") {
      items.push({
        id: `pool-degraded-${category.service}-${category.kind}`,
        tone: "warn",
        headline: `${category.label} has no premium entry`,
        detail: "Playback falls back to previews for everyone until a premium credential lands.",
        href: "/submit",
        hrefLabel: "Contribute",
      })
    }
  }

  // Idle keys are a security item, not a health one: a key nobody uses is a key nobody notices
  // leaking. 30 days is well past the app's daily refresh, so it means the holder really has gone.
  for (const key of snapshot.keys) {
    if (key.revoked) continue
    const last = key.lastUsedAt ? new Date(key.lastUsedAt).getTime() : null
    if (last !== null && Date.now() - last > 30 * 86_400_000) {
      items.push({
        id: `idle-${key.id}`,
        tone: "neutral",
        headline: `“${key.name}” has not been used in ${formatAgo(key.lastUsedAt).replace(" ago", "")}`,
        detail: "Revoking it costs nothing if the app is gone, and it is reversible.",
        href: "#keys",
        hrefLabel: "Go to keys",
      })
    }
  }

  // Worst first. The list is read top-down and abandoned part-way, so the ordering is the triage.
  const severity: Record<StatusTone, number> = { danger: 0, warn: 1, ok: 2, neutral: 3 }
  return items.sort((a, b) => severity[a.tone] - severity[b.tone])
}

export function DashboardSummary({ snapshot }: { snapshot: DashboardSnapshot }) {
  const active = snapshot.keys.filter((k) => !k.revoked)
  const revoked = snapshot.keys.length - active.length
  const totalUses = snapshot.keys.reduce((a, k) => a + k.useCount, 0)
  const lastUse = snapshot.keys
    .map((k) => k.lastUsedAt)
    .filter((v): v is string => !!v)
    .sort()
    .pop()

  const live = snapshot.contributions.filter((c) => !c.removed)
  const serving = live.filter((c) => !c.disabled && isServable(c.status))
  const premium = serving.filter((c) => c.premium)
  const pending = live.filter((c) => c.status === "pending")
  const dead = live.filter((c) => c.status === "dead")

  const poolChecks = snapshot.poolHistory.reduce((a, p) => a + p.checks, 0)
  const poolOk = snapshot.poolHistory.reduce((a, p) => a + p.ok, 0)
  const poolPct = poolChecks > 0 ? Math.round((poolOk / poolChecks) * 1000) / 10 : null
  const poolTone: StatusTone =
    poolPct === null ? "neutral" : poolPct >= 95 ? "ok" : poolPct >= 80 ? "warn" : "danger"

  const actions = buildActions(snapshot)
  const held = snapshot.leases.length

  return (
    <div className="flex flex-col gap-6">
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <StatTile
          label="Active keys"
          value={formatCount(active.length)}
          tone={active.length > 0 ? "ok" : "neutral"}
          hint={
            revoked > 0
              ? `${formatCount(revoked)} revoked · ${formatCount(held)} pool ${held === 1 ? "entry" : "entries"} held`
              : `${formatCount(held)} pool ${held === 1 ? "entry" : "entries"} held right now`
          }
          href="#keys"
          linkLabel="Keys"
        >
          <SegmentBar
            className="w-full"
            segments={[
              { value: active.length, tone: "ok" },
              { value: revoked, tone: "danger" },
            ]}
          />
        </StatTile>

        <StatTile
          label="Feed requests"
          value={formatCount(totalUses)}
          hint={
            lastUse
              ? `across ${formatCount(snapshot.keys.length)} ${snapshot.keys.length === 1 ? "key" : "keys"} · last ${formatAgo(lastUse)}`
              : "no app has presented one of your keys yet"
          }
        />

        <StatTile
          label="Your contributions"
          value={`${formatCount(serving.length)}/${formatCount(live.length)}`}
          tone={live.length === 0 ? "neutral" : serving.length > 0 ? "ok" : "danger"}
          hint={
            live.length === 0
              ? "nothing credited to you yet"
              : `${formatCount(premium.length)} premium · ${formatCount(dead.length)} failing`
          }
          href="#contributions"
          linkLabel="Detail"
        >
          {snapshot.contributionHistory.length > 0 ? (
            <Sparkline
              className="h-6 w-full"
              tone="ok"
              max={100}
              points={snapshot.contributionHistory.map((p) => ({
                label: p.label,
                value: p.pct,
                partial: p.partial,
              }))}
              label={`Pass rate of your contributions over the last ${snapshot.contributionHistory.length} days`}
            />
          ) : null}
        </StatTile>

        <StatTile
          label="Pool uptime · 14d"
          value={poolPct === null ? "—" : `${formatCount(poolPct)}%`}
          tone={poolTone}
          hint={
            poolChecks > 0
              ? `${formatCount(poolChecks)} scheduled checks across every pool`
              : "no checks recorded in the window"
          }
          href="/"
          linkLabel="Board"
        />
      </div>

      <Panel
        label="Needs your attention"
        description={
          actions.length > 0
            ? "Everything here is something you can fix from this account. Pool-wide items affect every app, not just yours."
            : undefined
        }
        bodyClassName={actions.length > 0 ? "flex flex-col gap-2" : undefined}
      >
        {actions.length === 0 ? (
          <Empty>
            Nothing needs you right now — your keys are in use, your contributions are passing their
            checks, and every pool has something premium to serve.
          </Empty>
        ) : (
          actions.map((item) => (
            <div
              key={item.id}
              className="flex flex-wrap items-start justify-between gap-3 rounded-md border border-border bg-background/40 p-3.5"
            >
              <div className="flex min-w-0 flex-1 items-start gap-3">
                <StatusDot tone={item.tone} className="mt-1.5 size-2" />
                <div className="min-w-0">
                  <p className="text-sm font-medium text-pretty">{item.headline}</p>
                  <p className="mt-1 max-w-[70ch] text-xs leading-relaxed text-muted-foreground text-pretty">
                    {item.detail}
                  </p>
                </div>
              </div>
              {item.href ? (
                <Link
                  href={item.href}
                  className={cn(
                    "inline-flex shrink-0 items-center gap-1 font-mono text-[0.625rem] uppercase tracking-[0.1em]",
                    "text-muted-foreground transition-colors hover:text-foreground",
                  )}
                >
                  {item.hrefLabel}
                  <ArrowUpRight className="size-3" aria-hidden="true" />
                </Link>
              ) : null}
            </div>
          ))
        )}
      </Panel>

      {live.length > 0 ? (
        <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-3 rounded-lg border border-border bg-card px-4 py-3 edge-lit">
          <h2 className="label-mono">Your entries</h2>
          <ChartLegend
            items={[
              { label: "Premium", tone: "ok", value: formatCount(premium.length) },
              { label: "Serving", tone: "neutral", muted: true, value: formatCount(serving.length - premium.length) },
              { label: "Pending", tone: "warn", value: formatCount(pending.length) },
              { label: "Dead", tone: "danger", value: formatCount(dead.length) },
            ]}
          />
          <span className="flex items-center gap-2">
            <SegmentBar
              segments={[
                { value: premium.length, tone: "ok" },
                { value: serving.length - premium.length, tone: "neutral", muted: true },
                { value: pending.length, tone: "warn" },
                { value: dead.length, tone: "danger" },
              ]}
            />
            <Badge tone={toneFor(serving.length > 0 ? "alive" : "dead")}>
              {serving.length > 0 ? "serving" : "nothing serving"}
            </Badge>
          </span>
        </div>
      ) : null}
    </div>
  )
}
