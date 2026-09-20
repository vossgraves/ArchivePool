"use client"

import { useCallback, useEffect, useState } from "react"
import { Button } from "@/components/ui/button"
import { Panel } from "@/components/ui/panel"
import { Badge, toneFor } from "@/components/ui/badge"
import { CopyButton } from "@/components/ui/copy-button"
import { Dialog } from "@/components/ui/dialog"
import { Empty } from "@/components/ui/empty"
import { Notice } from "@/components/ui/notice"
import { isService, SERVICE_LABELS } from "@/lib/sources"
import { cn, formatDateTime } from "@/lib/utils"

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
  // The scoped-key request columns landed after this panel, and the list route may not serialise
  // them yet. Both spellings stay optional so the dialog simply omits the lines — rather than
  // failing to compile — against either API build.
  requestedService?: string | null
  requested_service?: string | null
  discordId?: string | null
  discord_id?: string | null
  telegramId?: string | null
  telegram_id?: string | null
  contactNote?: string | null
  contact_note?: string | null
}

const MIN_NOTE = 10

/** Maps the API's machine errors to something that says what to do next. */
const ERROR_COPY: Record<string, string> = {
  not_found_or_not_pending: "That request was already decided, or it no longer exists.",
  note_required: "A rejection needs a reason — the requester sees it.",
  unauthorized: "Admin token rejected. Unlock again from the top of the page.",
}

/** First non-blank value, so a free-text field that is present but empty reads as absent. */
function firstFilled(...values: (string | null | undefined)[]): string | null {
  for (const value of values) {
    if (typeof value === "string" && value.trim() !== "") return value
  }
  return null
}

/**
 * One labelled line of the request dialog. Opaque values — ids, user agents — render as a
 * monospace block that breaks anywhere so they cannot widen the dialog or hide behind an ellipsis,
 * and `copy` puts the exact value on the clipboard without a text-selection dance.
 *
 * `null` renders nothing: the contact columns are newer than most rows, and an empty label beside
 * a blank value is noise, not information.
 */
function Detail({
  label,
  value,
  mono = false,
  block = false,
  copy = false,
}: {
  label: string
  value: string | null
  mono?: boolean
  block?: boolean
  copy?: boolean
}) {
  if (value === null) return null
  return (
    <div>
      <dt className="label-mono">{label}</dt>
      <dd className="mt-1 flex items-start gap-2">
        <span
          className={cn(
            "min-w-0 flex-1 text-sm leading-relaxed text-foreground",
            block && "whitespace-pre-wrap break-words",
            mono && "break-all font-mono text-xs",
          )}
        >
          {value}
        </span>
        {copy ? <CopyButton value={value} size="xs" variant="ghost" className="shrink-0" /> : null}
      </dd>
    </div>
  )
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
  const [openRow, setOpenRow] = useState<RequestRow | null>(null)
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

  // NULL `requested_service` means "any service", but the line is only shown once the column is
  // actually in the payload — an older API must not imply a request had no preference.
  const requestedSpecified =
    openRow !== null &&
    (openRow.requestedService !== undefined || openRow.requested_service !== undefined)
  const requestedRaw = firstFilled(openRow?.requestedService, openRow?.requested_service)
  const requestedLabel =
    requestedRaw === null
      ? "Any service"
      : isService(requestedRaw)
        ? SERVICE_LABELS[requestedRaw]
        : requestedRaw

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
              className="relative rounded-md border border-border bg-background/40 p-4 transition-colors hover:border-input focus-within:border-input"
            >
              {/* Covers the card so the whole row opens the record. A sibling of the content, not
                  a wrapper: the row already holds Accept/Deny buttons, and a button cannot legally
                  contain another. */}
              <button
                type="button"
                onClick={() => setOpenRow(r)}
                aria-label={`Read the full request from ${r.username ?? "this user"}: ${r.subject}`}
                className="absolute inset-0 rounded-md outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
              />
              <div className="pointer-events-none flex flex-wrap items-start justify-between gap-3">
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
                  <div className="pointer-events-auto relative z-10 flex shrink-0 items-center gap-2">
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

      <Dialog
        open={openRow !== null}
        onClose={() => setOpenRow(null)}
        title="Request details"
        description={openRow ? `#${openRow.id} · ${openRow.subject}` : undefined}
        className="max-w-lg"
        footer={
          <Button variant="outline" onClick={() => setOpenRow(null)}>
            Close
          </Button>
        }
      >
        {openRow ? (
          <dl className="flex flex-col gap-3.5">
            <div>
              <dt className="label-mono">Status</dt>
              <dd className="mt-1">
                <Badge tone={toneFor(openRow.status)}>{openRow.status}</Badge>
              </dd>
            </div>
            <Detail label="Subject" value={firstFilled(openRow.subject)} block />
            <Detail
              label="Requester"
              value={openRow.username ? `@${openRow.username}` : "unknown user"}
            />
            {requestedSpecified ? (
              <Detail label="Requested service" value={requestedLabel} />
            ) : null}
            <Detail label="Reason" value={firstFilled(openRow.reason)} block />
            <Detail
              label="Discord ID"
              value={firstFilled(openRow.discordId, openRow.discord_id)}
              mono
              copy
            />
            <Detail
              label="Telegram ID"
              value={firstFilled(openRow.telegramId, openRow.telegram_id)}
              mono
              copy
            />
            <Detail
              label="Contact note"
              value={firstFilled(openRow.contactNote, openRow.contact_note)}
              block
              copy
            />
            <Detail label="IP address" value={firstFilled(openRow.ipAddress)} mono copy />
            <Detail label="User agent" value={firstFilled(openRow.userAgent)} mono copy />
            <Detail label="Submitted" value={formatDateTime(openRow.createdAt)} />
            <Detail
              label="Reviewed"
              value={openRow.reviewedAt ? formatDateTime(openRow.reviewedAt) : null}
            />
            {openRow.status === "rejected" && openRow.reviewNote ? (
              <Detail label="Review note" value={firstFilled(openRow.reviewNote)} block />
            ) : null}
          </dl>
        ) : null}
      </Dialog>
    </Panel>
  )
}
