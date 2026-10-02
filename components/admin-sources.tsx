"use client"

import { useCallback, useEffect, useMemo, useState } from "react"
import { TriangleAlert } from "lucide-react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { Panel } from "@/components/ui/panel"
import { Badge, toneFor } from "@/components/ui/badge"
import { Dialog } from "@/components/ui/dialog"
import { Field } from "@/components/ui/field"
import { Empty } from "@/components/ui/empty"
import { Notice } from "@/components/ui/notice"
import { Skeleton } from "@/components/ui/skeleton"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { formatAgo, formatCount, formatDateTime, formatDay } from "@/lib/utils"

// Mirrors CATEGORIES in lib/sources.ts. Declared locally on purpose: that module imports
// node's `crypto` for fingerprinting, which cannot be pulled into a client bundle.
const CATEGORIES: { service: string; kind: string; label: string }[] = [
  { service: "tidal", kind: "api", label: "Tidal API" },
  { service: "tidal", kind: "account", label: "Tidal Account" },
  { service: "qobuz", kind: "api", label: "Qobuz API" },
  { service: "qobuz", kind: "account", label: "Qobuz Account" },
  { service: "deezer", kind: "api", label: "Deezer API" },
  { service: "deezer", kind: "account", label: "Deezer Account" },
  { service: "apple-music", kind: "account", label: "Apple Music Account" },
  { service: "amazon-music", kind: "api", label: "Amazon Music API" },
  { service: "amazon-music", kind: "account", label: "Amazon Music Account" },
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
  /** Opt-in credit chosen at contribution time; null means the donor stayed anonymous. */
  contributor: string | null
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

/**
 * What the row's status chip says. `removed` and `disabled` are moderation flags layered on top of
 * the health status and win over it — a removed entry usually still reads "alive" in the status
 * column, and calling that alive would be a lie. Colour is decided only by the shared `toneFor`
 * map, so an entry cannot be green here and amber in the keys panel; everything achromatic.
 */
function displayStatus(row: EntryRow): string {
  if (row.removed) return "removed"
  if (row.disabled) return "disabled"
  return row.status
}

/** The API reports machine codes for its own rejections; these say what to do next. */
const ERROR_COPY: Record<string, string> = {
  unauthorized: "Admin token rejected. Unlock again.",
  "not found": "That entry no longer exists. Refresh the list.",
  "id required": "The server never received the entry id.",
  "invalid body": "The server rejected the request body.",
}

/**
 * Reads a failure body's own explanation first — the API answers with `detail` (a sentence) or
 * `error` (a machine code), never both — so the admin sees the reason rather than a bare status.
 */
async function failureMessage(res: Response, fallback: string): Promise<string> {
  const body = (await res.json().catch(() => ({}))) as { detail?: string; error?: string }
  const mapped = body.error ? ERROR_COPY[body.error] : undefined
  return body.detail ?? mapped ?? body.error ?? `${fallback} (HTTP ${res.status})`
}

export function AdminSources() {
  const [token, setToken] = useState("")
  const [authed, setAuthed] = useState(false)
  // null = never loaded, [] = loaded and genuinely empty. Collapsing the two would make the
  // skeleton and the "nothing contributed yet" message indistinguishable from each other.
  const [entries, setEntries] = useState<EntryRow[] | null>(null)
  const [activeTab, setActiveTab] = useState(0)
  const [filter, setFilter] = useState<StatusFilter>("active")
  const [loading, setLoading] = useState(false)
  const [loadError, setLoadError] = useState<string | null>(null)
  // The entry and action currently in flight; that row's buttons are disabled while it is set, so
  // a double-click cannot fire the same removal twice. One field rather than an id plus a flag,
  // because the two could disagree about which action is running.
  const [busy, setBusy] = useState<{ id: number; action: "check" | "remove" | "restore" } | null>(
    null,
  )
  const [confirmRemove, setConfirmRemove] = useState<EntryRow | null>(null)
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

  // A token rejected mid-session must drop the panel back to its unlock form; otherwise every
  // later action fails the same way with nothing on screen to fix it.
  const invalidateToken = useCallback(() => {
    setAuthed(false)
    setEntries(null)
    sessionStorage.removeItem("adminToken")
  }, [])

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const res = await fetch("/api/admin/remove", { headers: authHeaders() })
      if (res.status === 401) {
        invalidateToken()
        setLoadError("Invalid admin token.")
        return
      }
      if (!res.ok) {
        setLoadError(await failureMessage(res, "Could not load entries"))
        return
      }
      const data = (await res.json().catch(() => null)) as { entries?: EntryRow[] | null } | null
      // A response that carries no array is not an empty pool: say which, instead of telling the
      // admin nobody has contributed anything.
      if (!Array.isArray(data?.entries)) {
        setLoadError("The server returned no entries — nothing was changed.")
        return
      }
      setEntries(data.entries)
      setLoadError(null)
      setAuthed(true)
      sessionStorage.setItem("adminToken", token)
    } catch {
      setLoadError("Network error — the pool entries could not be loaded.")
    } finally {
      setLoading(false)
    }
  }, [authHeaders, invalidateToken, token])

  // Fetch once the token is available (either typed and verified, or restored from the
  // session). `entries === null` guards against refetching on every render.
  useEffect(() => {
    if (token && authed && entries === null) void load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token, authed])

  async function checkOne(row: EntryRow) {
    if (busy?.id === row.id) return
    setBusy({ id: row.id, action: "check" })
    try {
      const res = await fetch("/api/admin/check-entry", {
        method: "POST",
        headers: authHeaders({ "content-type": "application/json" }),
        body: JSON.stringify({ id: row.id }),
      })
      if (res.status === 401) invalidateToken()
      if (!res.ok) {
        toast.error(await failureMessage(res, `Check failed for “${row.label}”`))
        return
      }
      const data = (await res.json().catch(() => ({}))) as { result?: CheckResult | null }
      const result = data.result ?? null
      if (!result) {
        // HTTP 200 with no verdict in it: report it as a failure rather than letting silence read
        // as a pass.
        toast.error(`The server returned no result for “${row.label}”.`)
        return
      }
      setChecked((prev) => ({ ...prev, [row.id]: result }))
      if (result.ok) {
        toast.success(`“${row.label}” passed`, {
          description: `Status ${result.status}${
            result.latencyMs === null ? "" : ` in ${formatCount(result.latencyMs)}ms`
          }.`,
        })
      } else {
        toast.error(`“${row.label}” failed the check`, {
          description: `${result.status}${result.detail ? ` — ${result.detail}` : ""}`,
        })
      }
      await load()
    } catch {
      toast.error("Network error — that check never reached the server.")
    } finally {
      setBusy(null)
    }
  }

  async function setRemoved(row: EntryRow, remove: boolean) {
    if (busy?.id === row.id) return
    setBusy({ id: row.id, action: remove ? "remove" : "restore" })
    try {
      const res = await fetch("/api/admin/remove", {
        method: "POST",
        headers: authHeaders({ "content-type": "application/json" }),
        body: JSON.stringify({ id: row.id, action: remove ? "remove" : "restore" }),
      })
      if (res.status === 401) invalidateToken()
      if (!res.ok) {
        toast.error(
          await failureMessage(res, `Could not ${remove ? "remove" : "restore"} “${row.label}”`),
        )
        return
      }
      toast.success(remove ? `Removed “${row.label}”` : `Restored “${row.label}”`, {
        description: remove
          ? "It is no longer handed out by /api/sources. The entry is kept, so this can be undone."
          : "It is served again as soon as a check says it is healthy.",
      })
      await load()
    } catch {
      toast.error(
        `Network error — “${row.label}” was ${remove ? "not removed" : "not restored"}.`,
      )
    } finally {
      setBusy(null)
      setConfirmRemove(null)
    }
  }

  const all = useMemo(() => entries ?? [], [entries])
  const category = CATEGORIES[activeTab]

  // Counts what the app would actually be served, so the number matches reality rather than a
  // looser "not removed" tally. See isServable: `preview` counts, `disabled` does not.
  const perTabCounts = useMemo(
    () =>
      CATEGORIES.map(
        (c) => all.filter((e) => e.service === c.service && e.kind === c.kind && isServable(e)).length,
      ),
    [all],
  )

  const rows = useMemo(() => {
    const inCategory = all.filter((e) => e.service === category.service && e.kind === category.kind)
    const filtered = inCategory.filter((e) => {
      if (filter === "all") return true
      if (filter === "removed") return e.removed
      // Dead and disabled rows would otherwise read as live pool state.
      if (filter === "active") return !e.removed && !e.disabled && e.status !== "dead"
      if (filter === "alive") return isServable(e)
      return !e.removed && (e.disabled || e.status === "dead" || e.consecutiveFailures > 0)
    })
    // Surface the entries that need attention first, then the healthy ones.
    return filtered.sort((a, b) => {
      const rank = (e: EntryRow) =>
        e.removed ? 3 : e.disabled || e.status === "dead" ? 0 : e.status === "alive" ? 2 : 1
      return rank(a) - rank(b) || a.id - b.id
    })
  }, [all, category, filter])

  // Entries in this category before the status filter is applied, so "no entries here at all" can
  // be told apart from "nothing matches this filter".
  const inCategoryCount = useMemo(
    () => all.filter((e) => e.service === category.service && e.kind === category.kind).length,
    [all, category],
  )

  // The last servable entry in a category is called out, because removing it takes the whole
  // source offline for every app until a replacement is contributed.
  const aliveInCategory = all.filter(
    (e) => e.service === category.service && e.kind === category.kind && isServable(e),
  ).length

  if (!authed) {
    return (
      <form
        onSubmit={(e) => {
          e.preventDefault()
          void load()
        }}
        className="flex max-w-md flex-col gap-3 rounded-lg border border-border bg-card p-4"
      >
        <div>
          <h2 className="label-mono">Pool entries</h2>
          <p className="mt-1.5 text-xs leading-relaxed text-muted-foreground text-pretty">
            Unlock to review and moderate individual pool entries.
          </p>
        </div>
        <Field
          label="Admin token"
          name="sources-token"
          type="password"
          placeholder="Bearer token"
          value={token}
          onValueChange={setToken}
          error={loadError}
        />
        <Button type="submit" disabled={!token || loading}>
          {loading ? "Checking…" : "Unlock"}
        </Button>
      </form>
    )
  }

  const confirmIsLastAlive =
    confirmRemove !== null &&
    aliveInCategory === 1 &&
    confirmRemove.service === category.service &&
    confirmRemove.kind === category.kind &&
    isServable(confirmRemove)

  // The confirm button's busy state, tied to the entry actually named by the dialog.
  const removing =
    confirmRemove !== null && busy !== null && busy.id === confirmRemove.id && busy.action === "remove"

  // Built once and handed to whichever TabsContent is mounted: only the active panel renders
  // (Base UI unmounts the rest), so this is the body of exactly one of them at a time.
  const panelBody = entries === null ? (
    <>
      <Skeleton className="h-20" />
      <Skeleton className="h-20" />
      <Skeleton className="h-20" />
    </>
  ) : inCategoryCount === 0 ? (
    <Empty>Nothing has been contributed for {category.label} yet.</Empty>
  ) : rows.length === 0 ? (
    <Empty>No entries match this filter in {category.label}.</Empty>
  ) : (
    <ul className="flex flex-col gap-2">
      {rows.map((row) => {
        const status = displayStatus(row)
        const result = checked[row.id]
        const rate =
          row.checkCount > 0 ? Math.round((row.okCount / row.checkCount) * 100) : null
        // Which action this row has in flight, or null. Nothing else on the row can fire
        // while it is set, so a double-click cannot queue a second removal.
        const busyAction = busy !== null && busy.id === row.id ? busy.action : null
        const isLastAlive = aliveInCategory === 1 && isServable(row)
        return (
          // One row layout at every width: the action group wraps below the content on a
          // narrow screen, which is what used to justify a separate mobile card list — a
          // 7-column table pushed Check/Remove off-screen on a phone.
          <li
            key={row.id}
            className="rounded-md border border-border bg-background/40 p-3.5"
          >
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <h3
                    className="min-w-0 max-w-full truncate font-mono text-sm text-foreground"
                    title={row.label}
                  >
                    {row.label}
                  </h3>
                  <span className="shrink-0 font-mono text-xs text-muted-foreground">
                    #{row.id}
                  </span>
                  <Badge tone={toneFor(status)}>{status}</Badge>
                  {row.premium ? <Badge tone="neutral">premium</Badge> : null}
                  {row.consecutiveFailures > 0 && !row.removed ? (
                    <Badge tone="warn">
                      {formatCount(row.consecutiveFailures)} fail
                      {row.consecutiveFailures === 1 ? "" : "s"}
                    </Badge>
                  ) : null}
                </div>

                {/* Meta: flex-wrap rather than one truncated line, because the contributor
                    credit must never be the thing that gets cut off. */}
                <p className="mt-1.5 flex flex-wrap gap-x-2 font-mono text-xs text-muted-foreground">
                  {row.contributor ? (
                    <span className="text-foreground/80">@{row.contributor}</span>
                  ) : null}
                  <span>
                    {rate === null
                      ? "no checks yet"
                      : `${rate}% ok (${formatCount(row.okCount)}/${formatCount(row.checkCount)})`}
                  </span>
                  <span>
                    {row.latencyMs === null ? "no latency" : `${formatCount(row.latencyMs)}ms`}
                  </span>
                  <span title={formatDateTime(row.lastCheckedAt)}>
                    checked {formatAgo(row.lastCheckedAt)}
                  </span>
                  <span>added {formatDay(row.createdAt)}</span>
                  {isLastAlive ? <span className="text-warn">last serving entry</span> : null}
                </p>

                {row.detail ? (
                  <p
                    className="mt-2 line-clamp-2 max-w-[80ch] text-xs leading-relaxed text-muted-foreground text-pretty"
                    title={row.detail}
                  >
                    {row.detail}
                  </p>
                ) : null}

                {result ? (
                  <p className="mt-2 max-w-[80ch] truncate font-mono text-xs text-muted-foreground">
                    Last check: {result.ok ? "passed" : "failed"}
                    {result.detail ? ` — ${result.detail}` : ""}
                  </p>
                ) : null}
              </div>

              <div className="flex shrink-0 items-center gap-2">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={busyAction !== null}
                  aria-label={`Check entry ${row.label}`}
                  onClick={() => void checkOne(row)}
                >
                  {busyAction === "check" ? "Checking…" : "Check"}
                </Button>
                {row.removed ? (
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    disabled={busyAction !== null}
                    aria-label={`Restore entry ${row.label}`}
                    onClick={() => void setRemoved(row, false)}
                  >
                    {busyAction === "restore" ? "Restoring…" : "Restore"}
                  </Button>
                ) : (
                  <Button
                    type="button"
                    variant="destructive"
                    size="sm"
                    disabled={busyAction !== null}
                    aria-label={`Remove entry ${row.label}`}
                    onClick={() => setConfirmRemove(row)}
                  >
                    Remove
                  </Button>
                )}
              </div>
            </div>
          </li>
        )
      })}
    </ul>
  )

  return (
    <>
      <Panel
        label="Pool entries"
        description="Review, re-check and remove individual accounts per source."
        actions={
          <Button
            type="button"
            size="sm"
            variant="ghost"
            disabled={loading}
            onClick={() => void load()}
          >
            {loading ? "Refreshing…" : "Refresh"}
          </Button>
        }
      >
        {/* One Tabs root over the whole body: the filter row, the warning and the entry list all
            belong to the selected source, so they sit between the tablist and the panels rather
            than above the root. Base UI owns the roving tabindex and arrow keys that this panel
            used to hand-roll. */}
        <Tabs
          value={activeTab}
          onValueChange={(next) => setActiveTab(next as number)}
          className="gap-3"
        >
          <TabsList
            aria-label="Source"
            className="w-full flex-wrap rounded-md border border-border bg-background/40 group-data-horizontal/tabs:h-auto"
          >
            {CATEGORIES.map((c, i) => (
              <TabsTrigger
                key={c.label}
                value={i}
                // The shipped trigger paints its active state from --input in dark mode; every
                // other selected control on this page uses --secondary, and layout.tsx pins dark,
                // so the dark variant has to be restated or the tabs alone look different.
                className="h-7 flex-none gap-2 px-3 text-xs data-active:bg-secondary dark:data-active:border-transparent dark:data-active:bg-secondary"
              >
                <span className="min-w-0 truncate">{c.label}</span>
                <span className="shrink-0 font-mono text-[0.625rem] opacity-70">
                  {formatCount(perTabCounts[i])}
                </span>
              </TabsTrigger>
            ))}
          </TabsList>

          {/* Status filter. Deliberately not a second tablist: it narrows the rows already on
              screen rather than switching between panels. */}
          <div className="flex flex-wrap items-center gap-1 rounded-md border border-border bg-background/40 p-1">
            {FILTERS.map((f) => (
              <Button
                key={f.value}
                type="button"
                size="xs"
                variant={filter === f.value ? "secondary" : "ghost"}
                aria-pressed={filter === f.value}
                className="font-mono"
                onClick={() => setFilter(f.value)}
              >
                {f.label}
              </Button>
            ))}
          </div>

          {/* Mutations report through toasts — this panel is taller than the viewport, so a
              message pinned up here is off-screen by the time you click a row's Remove. A failed
              *load* still belongs inline: it explains why the list below is empty. */}
          {loadError ? <Notice tone="error">{loadError}</Notice> : null}

          {aliveInCategory === 1 && filter !== "removed" ? (
            <p className="flex items-start gap-2 rounded-md border border-warn/30 bg-warn/5 px-3 py-2 text-xs leading-relaxed text-warn">
              <TriangleAlert className="mt-px size-3.5 shrink-0" aria-hidden="true" />
              <span className="min-w-0">
                Only one serving entry remains in {category.label}. Removing it takes this source
                offline for every app until a replacement is contributed.
              </span>
            </p>
          ) : null}

          {CATEGORIES.map((c, i) => (
            <TabsContent key={c.label} value={i} className="flex flex-col gap-2">
              {panelBody}
            </TabsContent>
          ))}
        </Tabs>
      </Panel>

      <Dialog
        open={confirmRemove !== null}
        onClose={() => {
          if (!removing) setConfirmRemove(null)
        }}
        title={`Remove “${confirmRemove?.label ?? ""}” from the pool?`}
        description={
          confirmRemove
            ? `#${confirmRemove.id} stops being handed out by /api/sources immediately${
                confirmIsLastAlive
                  ? ` and it is the last serving entry in ${category.label}, so this source goes offline for every app until a replacement is contributed`
                  : ""
              }. The entry itself is kept, so this can be undone.`
            : undefined
        }
        footer={
          <>
            <Button variant="outline" disabled={removing} onClick={() => setConfirmRemove(null)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              disabled={removing}
              onClick={() => confirmRemove && void setRemoved(confirmRemove, true)}
            >
              {removing ? "Removing…" : "Remove entry"}
            </Button>
          </>
        }
      >
        {confirmRemove?.contributor ? (
          <p className="text-xs leading-relaxed text-muted-foreground">
            Contributed by{" "}
            <span className="font-mono text-foreground">@{confirmRemove.contributor}</span>. They
            keep their entry and can re-check it from their own dashboard.
          </p>
        ) : null}
      </Dialog>
    </>
  )
}
