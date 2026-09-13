"use client"

import { useCallback, useEffect, useState } from "react"
import { Button } from "@/components/ui/button"
import { Panel } from "@/components/ui/panel"
import { Badge, toneFor } from "@/components/ui/badge"
import { Dialog } from "@/components/ui/dialog"
import { Empty } from "@/components/ui/empty"
import { Notice } from "@/components/ui/notice"
import { formatDateTime } from "@/lib/utils"

interface RequestRow {
  id: number
  subject: string
  reason: string
  status: string
  ipAddress: string
  userAgent: string
  reviewNote: string
  createdAt: string
  reviewedAt: string | null
  username: string | null
}

const MIN_NOTE = 10

/** Maps the API's machine errors to something that says what to do next. */
const ERROR_COPY: Record<string, string> = {
  not_found_or_not_pending: "That request was already decided, or it no longer exists.",
  note_required: "A rejection needs a reason — the requester sees it.",
  unauthorized: "Admin token rejected. Unlock again from the top of the page.",
}

/**
 * Key request queue.
 *
 * Approving marks a request approved; it does not generate a key. The requester reveals the key
 * themselves from their dashboard, so the one-time plaintext never passes through this panel
 * (previously the key was minted here, returned to a client that discarded the response body, and
 * lost — the approved user got a key row they could never read).
 *
 * Rejecting requires a written reason, because a silent denial is indistinguishable from the
 * request being ignored.
 */
export function AdminRequests() {
  const [rows, setRows] = useState<RequestRow[] | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [feedback, setFeedback] = useState<{ tone: "ok" | "error"; text: string } | null>(null)
  const [busyId, setBusyId] = useState<number | null>(null)
  const [filter, setFilter] = useState<"pending" | "all">("pending")
  const [rejecting, setRejecting] = useState<RequestRow | null>(null)
  const [note, setNote] = useState("")
  const [noteError, setNoteError] = useState<string | null>(null)

  // Reflect the queue filter in the URL so a reviewed queue survives a refresh or a shared link.
  // Read in an effect, not in useState: this component is also server-rendered, and reading
  // location during render would make server and client markup disagree.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search)
    if (params.get("requests") === "all") setFilter("all")
  }, [])

  useEffect(() => {
    const params = new URLSearchParams(window.location.search)
    params.set("requests", filter)
    window.history.replaceState(null, "", `?${params.toString()}#admin-requests`)
  }, [filter])

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/admin/requests", {
        headers: { authorization: `Bearer ${sessionStorage.getItem("adminToken") ?? ""}` },
        cache: "no-store",
      })
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        setLoadError(body.detail ?? body.error ?? `Could not load requests (HTTP ${res.status})`)
        return
      }
      setLoadError(null)
      setRows(await res.json())
    } catch {
      setLoadError("Network error — the queue could not be loaded.")
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  async function decide(row: RequestRow, action: "approve" | "reject", rejectionNote?: string) {
    if (busyId !== null) return
    setBusyId(row.id)
    setFeedback(null)
    try {
      const res = await fetch(`/api/admin/requests/${row.id}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${sessionStorage.getItem("adminToken") ?? ""}`,
        },
        body: JSON.stringify(action === "approve" ? { action } : { action, note: rejectionNote }),
      })
      const body = await res.json().catch(() => ({}))
      if (!res.ok) {
        setFeedback({
          tone: "error",
          text:
            body.detail ??
            ERROR_COPY[body.error ?? ""] ??
            `Could not ${action} this request (HTTP ${res.status}).`,
        })
        return
      }
      setFeedback({
        tone: "ok",
        text:
          action === "approve"
            ? `Approved. @${row.username ?? "requester"} can now reveal the key from their dashboard — it is shown to them once and never appears here.`
            : `Rejected with your note. @${row.username ?? "requester"} sees it on the request.`,
      })
      await load()
    } catch {
      setFeedback({ tone: "error", text: "Network error — that decision was not saved." })
    } finally {
      setBusyId(null)
    }
  }

  function openReject(row: RequestRow) {
    setRejecting(row)
    setNote("")
    setNoteError(null)
  }

  async function confirmReject() {
    const trimmed = note.trim()
    if (trimmed.length < MIN_NOTE) {
      setNoteError(`Give them a real reason — at least ${MIN_NOTE} characters.`)
      return
    }
    const row = rejecting
    setRejecting(null)
    if (row) await decide(row, "reject", trimmed)
  }

  const pendingCount = rows?.filter((r) => r.status === "pending").length ?? 0
  const visible = rows?.filter((r) => (filter === "pending" ? r.status === "pending" : true)) ?? []

  return (
    <Panel
      label="Key requests"
      description="Approve to let someone claim a key; reject to close with a reason they can read."
      actions={
        <div className="flex items-center gap-1.5">
          <Button
            size="sm"
            variant={filter === "pending" ? "default" : "outline"}
            onClick={() => setFilter("pending")}
            aria-pressed={filter === "pending"}
          >
            Pending {rows ? `(${pendingCount})` : ""}
          </Button>
          <Button
            size="sm"
            variant={filter === "all" ? "default" : "outline"}
            onClick={() => setFilter("all")}
            aria-pressed={filter === "all"}
          >
            All {rows ? `(${rows.length})` : ""}
          </Button>
          <Button size="sm" variant="ghost" onClick={() => void load()}>
            Refresh
          </Button>
        </div>
      }
      bodyClassName="flex flex-col gap-3"
    >
      {loadError ? <Notice tone="error">{loadError}</Notice> : null}
      {feedback ? <Notice tone={feedback.tone}>{feedback.text}</Notice> : null}

      {rows === null ? (
        <>
          <div className="h-24 animate-pulse rounded-md bg-secondary/60" />
          <div className="h-24 animate-pulse rounded-md bg-secondary/60" />
        </>
      ) : visible.length === 0 ? (
        <Empty>{filter === "pending" ? "Nothing waiting for review." : "No requests yet."}</Empty>
      ) : (
        visible.map((r) => {
          const busy = busyId === r.id
          return (
            <article
              key={r.id}
              className="rounded-md border border-border bg-background/40 p-4 transition-colors hover:border-input"
            >
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <h3 className="min-w-0 truncate text-sm font-medium text-foreground">
                      {r.subject}
                    </h3>
                    <Badge tone={toneFor(r.status)}>{r.status}</Badge>
                  </div>
                  <p className="mt-1 min-w-0 truncate font-mono text-xs text-muted-foreground">
                    {r.username ? `@${r.username}` : "unknown user"} · {formatDateTime(r.createdAt)}
                    {r.ipAddress ? ` · ${r.ipAddress}` : ""}
                    {r.userAgent ? ` · ${r.userAgent.slice(0, 48)}` : ""}
                  </p>
                  <p className="mt-2 max-w-[70ch] text-sm leading-relaxed text-foreground/80 text-pretty">
                    “{r.reason}”
                  </p>
                  {r.status === "rejected" && r.reviewNote ? (
                    <p className="mt-2 max-w-[70ch] rounded-md border-l-2 border-destructive/50 bg-destructive/5 py-1.5 pl-3 pr-2 text-xs leading-relaxed text-muted-foreground">
                      <span className="label-mono">Your reason</span>
                      <span className="mt-1 block text-pretty">“{r.reviewNote}”</span>
                    </p>
                  ) : null}
                  {r.status === "approved" ? (
                    <p className="mt-2 text-xs text-muted-foreground">
                      Approved {formatDateTime(r.reviewedAt)} — waiting for the requester to reveal
                      their key.
                    </p>
                  ) : null}
                </div>

                {r.status === "pending" ? (
                  <div className="flex shrink-0 items-center gap-2">
                    <Button
                      size="sm"
                      onClick={() => void decide(r, "approve")}
                      disabled={busy !== false && busyId !== null}
                      aria-label={`Approve request from ${r.username ?? "this user"}: ${r.subject}`}
                    >
                      {busy ? "Approving…" : "Accept"}
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => openReject(r)}
                      disabled={busy !== false && busyId !== null}
                      aria-label={`Reject request from ${r.username ?? "this user"}: ${r.subject}`}
                    >
                      Deny
                    </Button>
                  </div>
                ) : (
                  <p className="shrink-0 font-mono text-[0.625rem] uppercase tracking-[0.1em] text-muted-foreground">
                    reviewed {formatDateTime(r.reviewedAt)}
                  </p>
                )}
              </div>
            </article>
          )
        })
      )}

      <Dialog
        open={rejecting !== null}
        onClose={() => setRejecting(null)}
        title="Deny this request?"
        description={
          rejecting
            ? `Your reason goes to @${rejecting.username ?? "the requester"} and is shown on their dashboard. Say what they should fix or provide.`
            : undefined
        }
        footer={
          <>
            <Button variant="outline" onClick={() => setRejecting(null)}>
              Cancel
            </Button>
            <Button variant="destructive" onClick={() => void confirmReject()}>
              Deny with reason
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-1.5">
          <label htmlFor="reject-note" className="text-sm font-medium text-foreground">
            Reason <span className="text-muted-foreground">*</span>
          </label>
          <textarea
            id="reject-note"
            rows={4}
            autoFocus
            value={note}
            onChange={(e) => {
              setNote(e.target.value)
              if (noteError) setNoteError(null)
            }}
            onKeyDown={(e) => {
              if ((e.metaKey || e.ctrlKey) && e.key === "Enter") void confirmReject()
            }}
            aria-invalid={noteError ? true : undefined}
            aria-describedby="reject-note-desc"
            placeholder="e.g. This reads like a shared account — tell us which app and what it does, then re-request…"
            className="w-full resize-y rounded-md border border-input bg-input/30 px-3 py-2 text-sm leading-relaxed outline-none placeholder:text-muted-foreground/60 focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/40 aria-invalid:border-destructive"
          />
          <p
            id="reject-note-desc"
            className={noteError ? "text-xs text-destructive" : "text-xs text-muted-foreground"}
            role={noteError ? "alert" : undefined}
          >
            {noteError ?? `${note.trim().length}/${MIN_NOTE} characters minimum · ⌘↵ to send`}
          </p>
        </div>
      </Dialog>
    </Panel>
  )
}
