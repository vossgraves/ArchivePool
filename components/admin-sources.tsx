"use client"

import { useCallback, useEffect, useMemo, useState } from "react"
import { Button } from "@/components/ui/button"

// Mirrors CATEGORIES in lib/sources.ts. Declared locally on purpose: that module imports
// node's `crypto` for fingerprinting, which cannot be pulled into a client bundle.
const CATEGORIES: { service: string; kind: string; label: string }[] = [
  { service: "tidal", kind: "api", label: "Tidal API" },
  { service: "tidal", kind: "account", label: "Tidal Account" },
  { service: "qobuz", kind: "api", label: "Qobuz API" },
  { service: "qobuz", kind: "account", label: "Qobuz Account" },
  { service: "deezer", kind: "account", label: "Deezer Account" },
]

type EntryRow = {
  id: number
  service: string
  kind: string
  label: string
  status: string
  premium: boolean
  disabled: boolean
  removed: boolean
  consecutiveFailures: number
  lastCheckedAt: string | null
  detail: string | null
  latencyMs: number | null
  checkCount: number
  okCount: number
  createdAt: string | null
}

type CheckResult = {
  id: number
  ok: boolean
  status: string
  premium: boolean
  detail: string | null
  latencyMs: number | null
}

type StatusFilter = "active" | "alive" | "problem" | "removed" | "all"

const FILTERS: { value: StatusFilter; label: string }[] = [
  { value: "active", label: "Active" },
  // "Serving" rather than "Alive": this includes preview-status entries and excludes disabled
  // ones, matching what /api/sources actually hands out.
  { value: "alive", label: "Serving" },
  { value: "problem", label: "Needs attention" },
  { value: "removed", label: "Removed" },
  { value: "all", label: "All" },
]

/**
 * Mirrors the getAlivePool() filter in lib/queries.ts, which is what /api/sources actually
 * hands to the app: not removed, not disabled, status in ('alive','preview'). Tidal API keys
 * commonly sit at "preview" while serving fine, and a disabled entry is never handed out even
 * though its status may still read "alive" — so both cases must be honoured here or the counts
 * and the last-entry warning disagree with what the pool really serves.
 */
function isServable(e: EntryRow): boolean {
  return !e.removed && !e.disabled && (e.status === "alive" || e.status === "preview")
}

function relativeTime(iso: string | null): string {
  if (!iso) return "never"
  const diff = Date.now() - new Date(iso).getTime()
  if (!Number.isFinite(diff)) return "unknown"
  const mins = Math.round(diff / 60000)
  if (mins < 1) return "just now"
  if (mins < 60) return `${mins}m ago`
  const hours = Math.round(mins / 60)
  if (hours < 24) return `${hours}h ago`
  return `${Math.round(hours / 24)}d ago`
}

/**
 * Status is rendered with weight and a leading glyph rather than hue, so the panel stays
 * monochrome and remains legible to colour-blind users. Only `destructive` is allowed colour,
 * reserved for states that need action.
 */
function statusPresentation(row: EntryRow): { glyph: string; label: string; className: string } {
  if (row.removed) return { glyph: "—", label: "removed", className: "text-muted-foreground" }
  if (row.disabled) return { glyph: "!", label: "disabled", className: "text-destructive" }
  if (row.status === "dead") return { glyph: "!", label: "dead", className: "text-destructive" }
  if (row.status === "alive") return { glyph: "•", label: "alive", className: "text-foreground" }
  if (row.status === "preview") return { glyph: "◦", label: "preview", className: "text-muted-foreground" }
  return { glyph: "◦", label: row.status, className: "text-muted-foreground" }
}

export function AdminSources() {
  const [token, setToken] = useState("")
  const [authed, setAuthed] = useState(false)
  const [entries, setEntries] = useState<EntryRow[]>([])
  const [activeTab, setActiveTab] = useState(0)
  const [filter, setFilter] = useState<StatusFilter>("active")
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [busyId, setBusyId] = useState<number | null>(null)
  const [checked, setChecked] = useState<Record<number, CheckResult>>({})

  // Restore the session token and trust it, matching AdminKeys. Without this the page would
  // render two separate unlock prompts for the same credential.
  useEffect(() => {
    const saved = sessionStorage.getItem("adminToken")
    if (saved) {
      setToken(saved)
      setAuthed(true)
    }
  }, [])

  const authHeaders = useCallback(
    (extra: Record<string, string> = {}) => ({ authorization: `Bearer ${token}`, ...extra }),
    [token],
  )

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const res = await fetch("/api/admin/remove", { headers: authHeaders() })
      if (res.status === 401) {
        setAuthed(false)
        sessionStorage.removeItem("adminToken")
        setError("Invalid admin token.")
        return
      }
      if (!res.ok) throw new Error(`request failed (${res.status})`)
      const data = (await res.json()) as { entries: EntryRow[] }
      setEntries(data.entries)
      setAuthed(true)
      sessionStorage.setItem("adminToken", token)
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load entries.")
    } finally {
      setLoading(false)
    }
  }, [authHeaders, token])

  // Fetch once the token is available (either typed and verified, or restored from the
  // session). `entries.length` guards against refetching on every render.
  useEffect(() => {
    if (token && authed && entries.length === 0) void load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token, authed])

  async function checkOne(id: number) {
    setBusyId(id)
    setError(null)
    try {
      const res = await fetch("/api/admin/check-entry", {
        method: "POST",
        headers: authHeaders({ "content-type": "application/json" }),
        body: JSON.stringify({ id }),
      })
      const data = (await res.json()) as { result?: CheckResult; error?: string }
      if (!res.ok) throw new Error(data.error ?? `check failed (${res.status})`)
      if (data.result) setChecked((prev) => ({ ...prev, [id]: data.result as CheckResult }))
      await load()
    } catch (err) {
      setError(err instanceof Error ? err.message : "Check failed.")
    } finally {
      setBusyId(null)
    }
  }

  async function setRemoved(id: number, remove: boolean) {
    setBusyId(id)
    setError(null)
    try {
      const res = await fetch("/api/admin/remove", {
        method: "POST",
        headers: authHeaders({ "content-type": "application/json" }),
        body: JSON.stringify({ id, action: remove ? "remove" : "restore" }),
      })
      if (!res.ok) throw new Error(`request failed (${res.status})`)
      await load()
    } catch (err) {
      setError(err instanceof Error ? err.message : "Update failed.")
    } finally {
      setBusyId(null)
    }
  }

  const category = CATEGORIES[activeTab]

  // Counts what the app would actually be served, so the number matches reality rather than a
  // looser "not removed" tally. See isServable: `preview` counts, `disabled` does not.
  const perTabCounts = useMemo(
    () =>
      CATEGORIES.map(
        (c) => entries.filter((e) => e.service === c.service && e.kind === c.kind && isServable(e)).length,
      ),
    [entries],
  )

  const rows = useMemo(() => {
    const inCategory = entries.filter((e) => e.service === category.service && e.kind === category.kind)
    const filtered = inCategory.filter((e) => {
      if (filter === "all") return true
      if (filter === "removed") return e.removed
      if (filter === "active") return !e.removed
      if (filter === "alive") return isServable(e)
      return !e.removed && (e.disabled || e.status === "dead" || e.consecutiveFailures > 0)
    })
    // Surface the entries that need attention first, then the healthy ones.
    return filtered.sort((a, b) => {
      const rank = (e: EntryRow) => (e.removed ? 3 : e.disabled || e.status === "dead" ? 0 : e.status === "alive" ? 2 : 1)
      return rank(a) - rank(b) || a.id - b.id
    })
  }, [entries, category, filter])

  // The last servable entry in a category is called out, because removing it takes the whole
  // source offline for every app until a replacement is contributed.
  const aliveInCategory = entries.filter(
    (e) => e.service === category.service && e.kind === category.kind && isServable(e),
  ).length

  if (!authed) {
    return (
      <form
        onSubmit={(e) => {
          e.preventDefault()
          void load()
        }}
        className="max-w-md rounded-lg border border-border p-5"
      >
        <label htmlFor="sources-token" className="block text-sm font-medium">
          Admin token
        </label>
        <p className="mb-3 mt-1 text-xs leading-relaxed text-muted-foreground">
          Unlock to review and moderate individual pool entries.
        </p>
        <input
          id="sources-token"
          type="password"
          value={token}
          onChange={(e) => setToken(e.target.value)}
          placeholder="Bearer token"
          className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
        />
        {error ? <p className="mt-2 text-xs text-destructive">{error}</p> : null}
        <Button type="submit" className="mt-4" disabled={!token || loading}>
          {loading ? "Checking…" : "Unlock"}
        </Button>
      </form>
    )
  }

  return (
    <section className="rounded-lg border border-border">
      <header className="flex flex-wrap items-baseline justify-between gap-3 border-b border-border px-5 py-4">
        <div>
          <h2 className="text-sm font-semibold">Pool entries</h2>
          <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
            Review, re-check and remove individual accounts per source.
          </p>
        </div>
        <Button type="button" variant="outline" size="sm" disabled={loading} onClick={() => void load()}>
          {loading ? "Refreshing…" : "Refresh"}
        </Button>
      </header>

      {/* Source tabs */}
      <div role="tablist" aria-label="Source" className="flex flex-wrap gap-1 border-b border-border px-3 py-3">
        {CATEGORIES.map((c, i) => {
          const selected = i === activeTab
          return (
            <button
              key={c.label}
              role="tab"
              type="button"
              aria-selected={selected}
              onClick={() => setActiveTab(i)}
              className={`rounded-md px-3 py-1.5 text-xs font-medium transition-colors ${
                selected
                  ? "bg-primary text-primary-foreground"
                  : "text-muted-foreground hover:bg-secondary hover:text-foreground"
              }`}
            >
              {c.label}
              <span className={`ml-2 font-mono ${selected ? "opacity-70" : "opacity-60"}`}>{perTabCounts[i]}</span>
            </button>
          )
        })}
      </div>

      {/* Status filter */}
      <div className="flex flex-wrap items-center gap-1 px-3 py-3">
        {FILTERS.map((f) => (
          <button
            key={f.value}
            type="button"
            aria-pressed={filter === f.value}
            onClick={() => setFilter(f.value)}
            className={`rounded-md px-2.5 py-1 text-xs transition-colors ${
              filter === f.value
                ? "bg-secondary font-medium text-foreground"
                : "text-muted-foreground hover:text-foreground"
            }`}
          >
            {f.label}
          </button>
        ))}
      </div>

      {error ? <p className="px-5 pb-3 text-xs text-destructive">{error}</p> : null}

      {aliveInCategory === 1 && filter !== "removed" ? (
        <p className="mx-5 mb-3 rounded-md border border-border bg-secondary px-3 py-2 text-xs leading-relaxed">
          Only one serving entry remains in {category.label}. Removing it takes this source offline for
          every app until a replacement is contributed.
        </p>
      ) : null}

      {rows.length === 0 ? (
        <p className="px-5 py-8 text-center text-xs text-muted-foreground">
          No entries match this filter in {category.label}.
        </p>
      ) : (
        <>
        {/* Narrow screens: stacked cards. A 7-column table would push the Check/Remove
            actions off-screen, making the primary controls unreachable on a phone. */}
        <ul className="flex flex-col gap-3 px-3 pb-3 md:hidden">
          {rows.map((row) => {
            const presentation = statusPresentation(row)
            const result = checked[row.id]
            const rate = row.checkCount > 0 ? Math.round((row.okCount / row.checkCount) * 100) : null
            const isBusy = busyId === row.id
            const isLastAlive = aliveInCategory === 1 && isServable(row)
            return (
              <li key={row.id} className="rounded-md border border-border p-3 text-xs">
                <div className="flex items-baseline justify-between gap-2">
                  <span className="min-w-0 break-all font-mono">{row.label}</span>
                  <span className="shrink-0 font-mono text-muted-foreground">#{row.id}</span>
                </div>
                <p className={`mt-2 ${presentation.className}`}>
                  <span aria-hidden="true" className="mr-1.5 font-mono">
                    {presentation.glyph}
                  </span>
                  {presentation.label}
                  {row.consecutiveFailures > 0 && !row.removed ? (
                    <span className="ml-1.5 text-muted-foreground">
                      ({row.consecutiveFailures} fail{row.consecutiveFailures === 1 ? "" : "s"})
                    </span>
                  ) : null}
                </p>
                <dl className="mt-2 grid grid-cols-2 gap-x-3 gap-y-1 text-muted-foreground">
                  <div className="flex gap-1.5">
                    <dt>Premium</dt>
                    <dd className="text-foreground">{row.premium ? "yes" : "no"}</dd>
                  </div>
                  <div className="flex gap-1.5">
                    <dt>Success</dt>
                    <dd className="font-mono text-foreground">
                      {rate === null ? "—" : `${rate}% (${row.okCount}/${row.checkCount})`}
                    </dd>
                  </div>
                  <div className="flex gap-1.5">
                    <dt>Latency</dt>
                    <dd className="font-mono text-foreground">
                      {row.latencyMs === null ? "—" : `${row.latencyMs}ms`}
                    </dd>
                  </div>
                  <div className="flex gap-1.5">
                    <dt>Checked</dt>
                    <dd className="text-foreground">{relativeTime(row.lastCheckedAt)}</dd>
                  </div>
                </dl>
                {row.detail ? (
                  <p className="mt-2 text-pretty leading-relaxed text-muted-foreground">{row.detail}</p>
                ) : null}
                {result ? (
                  <p className="mt-1 leading-relaxed">
                    Last check: {result.ok ? "passed" : "failed"}
                    {result.detail ? ` — ${result.detail}` : ""}
                  </p>
                ) : null}
                <div className="mt-3 flex gap-1.5">
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    disabled={isBusy}
                    onClick={() => void checkOne(row.id)}
                  >
                    {isBusy ? "…" : "Check"}
                  </Button>
                  <Button
                    type="button"
                    variant={row.removed ? "outline" : "destructive"}
                    size="sm"
                    disabled={isBusy}
                    onClick={() => {
                      if (
                        !row.removed &&
                        isLastAlive &&
                        !confirm(
                          `#${row.id} is the last alive entry in ${category.label}. Removing it takes this source offline for every app. Continue?`,
                        )
                      ) {
                        return
                      }
                      void setRemoved(row.id, !row.removed)
                    }}
                  >
                    {row.removed ? "Restore" : "Remove"}
                  </Button>
                </div>
              </li>
            )
          })}
        </ul>

        <div className="hidden overflow-x-auto md:block">
          <table className="w-full text-left text-xs">
            <caption className="sr-only">
              {category.label} pool entries with health metrics and per-entry actions
            </caption>
            <thead>
              <tr className="border-b border-border text-muted-foreground">
                <th scope="col" className="px-5 py-2 font-medium">
                  Entry
                </th>
                <th scope="col" className="px-3 py-2 font-medium">
                  Status
                </th>
                <th scope="col" className="px-3 py-2 font-medium">
                  Premium
                </th>
                <th scope="col" className="px-3 py-2 text-right font-medium">
                  Success
                </th>
                <th scope="col" className="px-3 py-2 text-right font-medium">
                  Latency
                </th>
                <th scope="col" className="px-3 py-2 font-medium">
                  Checked
                </th>
                <th scope="col" className="px-5 py-2 text-right font-medium">
                  Actions
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => {
                const presentation = statusPresentation(row)
                const result = checked[row.id]
                const rate = row.checkCount > 0 ? Math.round((row.okCount / row.checkCount) * 100) : null
                const isBusy = busyId === row.id
                const isLastAlive = aliveInCategory === 1 && isServable(row)
                return (
                  <tr key={row.id} className="border-b border-border/60 last:border-0 align-top">
                    <td className="px-5 py-3">
                      <span className="font-mono">{row.label}</span>
                      <span className="ml-2 text-muted-foreground">#{row.id}</span>
                      {row.detail ? (
                        <p className="mt-1 max-w-xs text-pretty leading-relaxed text-muted-foreground">
                          {row.detail}
                        </p>
                      ) : null}
                      {result ? (
                        <p className="mt-1 leading-relaxed">
                          Last check: {result.ok ? "passed" : "failed"}
                          {result.detail ? ` — ${result.detail}` : ""}
                        </p>
                      ) : null}
                    </td>
                    <td className={`px-3 py-3 whitespace-nowrap ${presentation.className}`}>
                      <span aria-hidden="true" className="mr-1.5 font-mono">
                        {presentation.glyph}
                      </span>
                      {presentation.label}
                      {row.consecutiveFailures > 0 && !row.removed ? (
                        <span className="ml-1.5 text-muted-foreground">
                          ({row.consecutiveFailures} fail
                          {row.consecutiveFailures === 1 ? "" : "s"})
                        </span>
                      ) : null}
                    </td>
                    <td className="px-3 py-3 whitespace-nowrap">
                      {row.premium ? "yes" : <span className="text-muted-foreground">no</span>}
                    </td>
                    <td className="px-3 py-3 text-right font-mono whitespace-nowrap">
                      {rate === null ? (
                        <span className="text-muted-foreground">—</span>
                      ) : (
                        <>
                          {rate}%
                          <span className="ml-1 text-muted-foreground">
                            ({row.okCount}/{row.checkCount})
                          </span>
                        </>
                      )}
                    </td>
                    <td className="px-3 py-3 text-right font-mono whitespace-nowrap">
                      {row.latencyMs === null ? (
                        <span className="text-muted-foreground">—</span>
                      ) : (
                        `${row.latencyMs}ms`
                      )}
                    </td>
                    <td className="px-3 py-3 whitespace-nowrap text-muted-foreground">
                      {relativeTime(row.lastCheckedAt)}
                    </td>
                    <td className="px-5 py-3">
                      <div className="flex justify-end gap-1.5">
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          disabled={isBusy}
                          onClick={() => void checkOne(row.id)}
                        >
                          {isBusy ? "…" : "Check"}
                        </Button>
                        <Button
                          type="button"
                          variant={row.removed ? "outline" : "destructive"}
                          size="sm"
                          disabled={isBusy}
                          onClick={() => {
                            if (
                              !row.removed &&
                              isLastAlive &&
                              !confirm(
                                `#${row.id} is the last alive entry in ${category.label}. Removing it takes this source offline for every app. Continue?`,
                              )
                            ) {
                              return
                            }
                            void setRemoved(row.id, !row.removed)
                          }}
                        >
                          {row.removed ? "Restore" : "Remove"}
                        </Button>
                      </div>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
        </>
      )}
    </section>
  )
}
