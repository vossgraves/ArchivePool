"use client"

import { useCallback, useEffect, useState } from "react"
import { AnimatePresence, motion, useReducedMotion } from "motion/react"
import { Check, KeyRound } from "lucide-react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { Panel } from "@/components/ui/panel"
import { Badge, toneFor } from "@/components/ui/badge"
import { Dialog } from "@/components/ui/dialog"
import { Field } from "@/components/ui/field"
import { Notice } from "@/components/ui/notice"
import { Skeleton } from "@/components/ui/skeleton"
import { formatCount, formatDateTime, formatDay } from "@/lib/utils"

interface KeyRow {
  id: number
  name: string
  reason: string
  prefix: string
  revoked: boolean
  useCount: number
  lastUsedAt: string | null
  createdAt: string
}

interface RequestRow {
  id: number
  subject: string
  reason: string
  status: "pending" | "approved" | "rejected"
  reviewNote: string
  resultingKeyId: number | null
  createdAt: string
  reviewedAt: string | null
}

/**
 * A key the user is entitled to but has not seen yet: approved by an admin, no key minted so far.
 * Approval deliberately does not generate the key, so the plaintext can be handed to exactly one
 * audience — the requester — at exactly one moment.
 */
function isClaimable(r: RequestRow) {
  return r.status === "approved" && r.resultingKeyId === null
}

export function Dashboard({ username }: { username: string }) {
  const reduce = useReducedMotion()
  const [keys, setKeys] = useState<KeyRow[] | null>(null)
  const [requests, setRequests] = useState<RequestRow[] | null>(null)
  const [subject, setSubject] = useState("")
  const [reason, setReason] = useState("")
  const [formError, setFormError] = useState<string | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)
  const [revealed, setRevealed] = useState<{ key: string; prefix: string } | null>(null)
  const [copied, setCopied] = useState(false)
  const [claimingId, setClaimingId] = useState<number | null>(null)
  const [confirmDelete, setConfirmDelete] = useState<KeyRow | null>(null)
  const [deleteBusy, setDeleteBusy] = useState(false)

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/keys", { cache: "no-store" })
      if (!res.ok) {
        // Bailing out silently left `keys` at null forever, which the panel below renders as a
        // skeleton — a page that looks like it is still loading is the one failure mode a user
        // will wait through instead of reporting.
        const body = await res.json().catch(() => ({}))
        setLoadError(body.detail ?? `Could not load your keys (HTTP ${res.status}).`)
        return
      }
      const data = await res.json()
      setLoadError(null)
      setKeys(data.keys ?? [])
      setRequests(data.requests ?? [])
    } catch {
      setLoadError("Network error — your keys and requests could not be loaded.")
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  /*
   * Where results go, throughout this component: anything the server says about the fields still
   * on screen stays inline next to them (formError, loadError), and the outcome of an action goes
   * to a toast. The dashboard runs long — request form, request list, key list — so a message
   * anchored to the top of it is off-screen from the Revoke button that produced it.
   */
  async function createRequest(e: React.FormEvent) {
    e.preventDefault()
    if (creating) return
    setCreating(true)
    setFormError(null)
    try {
      const res = await fetch("/api/keys", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ subject, reason }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) {
        // Stays inline: this is the server rejecting what is typed in the two fields above it.
        setFormError(data.detail ?? data.error ?? "Could not submit the request.")
        return
      }
      toast.success("Request sent", {
        description:
          "An admin reviews requests by hand. It appears below, and your key appears here once it is accepted.",
      })
      setSubject("")
      setReason("")
      await load()
    } finally {
      setCreating(false)
    }
  }

  async function claim(requestId: number) {
    if (claimingId !== null) return
    setClaimingId(requestId)
    try {
      const res = await fetch(`/api/requests/${requestId}/claim`, { method: "POST" })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) {
        toast.error(data.detail ?? "Could not issue your key.")
        return
      }
      setRevealed({ key: data.key, prefix: data.prefix })
      toast.success("Your key is ready — copy it now", {
        description: "The value is shown once and cannot be retrieved later.",
      })
      await load()
    } catch {
      toast.error("Network error — no key was created.")
    } finally {
      setClaimingId(null)
    }
  }

  async function toggleRevoke(key: KeyRow) {
    const res = await fetch(`/api/keys/${key.id}${key.revoked ? "?undo=1" : ""}`, {
      method: "DELETE",
    })
    if (!res.ok) {
      const body = await res.json().catch(() => ({}))
      toast.error(body.detail ?? `Could not ${key.revoked ? "restore" : "revoke"} “${key.name}”.`)
      return
    }
    toast.success(key.revoked ? `Restored “${key.name}”` : `Revoked “${key.name}”`, {
      description: key.revoked
        ? undefined
        : "Any app using it stops working. You can undo this from here.",
    })
    await load()
  }

  async function permanentlyDelete(key: KeyRow) {
    setDeleteBusy(true)
    try {
      const res = await fetch(`/api/keys/${key.id}?delete=1`, { method: "DELETE" })
      const body = await res.json().catch(() => ({}))
      if (!res.ok) {
        toast.error(body.detail ?? `Could not delete “${key.name}”.`)
        return
      }
      toast.success(`Deleted “${key.name}”`, {
        description: "It is gone from the database and cannot be recovered.",
      })
      await load()
    } catch {
      toast.error("Network error — the key was not deleted.")
    } finally {
      setDeleteBusy(false)
      setConfirmDelete(null)
    }
  }

  async function copyKey() {
    if (!revealed) return
    await navigator.clipboard.writeText(revealed.key)
    setCopied(true)
    setTimeout(() => setCopied(false), 1600)
  }

  const activeCount = keys?.filter((k) => !k.revoked).length ?? 0
  const motionProps = reduce
    ? {}
    : {
        initial: { opacity: 0, y: 8 },
        animate: { opacity: 1, y: 0 },
        transition: { type: "spring" as const, stiffness: 260, damping: 28 },
      }

  return (
    <div className="flex flex-col gap-6">
      <Panel
        label="Request a key"
        description={`Signed in as @${username} · ${formatCount(activeCount)} active ${activeCount === 1 ? "key" : "keys"}`}
      >
        {/* Both controls go through the shared Field, which is where the label/`aria-describedby`
            wiring lives. Hand-rolling them here is how the two fields ended up describing their
            hint to nobody. `mono` is off: these are prose, not credentials. */}
        <form onSubmit={createRequest} className="flex flex-col gap-3">
          <Field
            label="Subject"
            name="subject"
            required
            mono={false}
            maxLength={64}
            placeholder="Which app or device is this for?"
            value={subject}
            onValueChange={setSubject}
          />
          <Field
            label="Reason"
            name="reason"
            required
            mono={false}
            rows={3}
            maxLength={500}
            placeholder="What will you use the pool for? At least 10 characters — a real sentence gets approved faster."
            hint={`${formatCount(reason.trim().length)}/10 minimum`}
            value={reason}
            onValueChange={setReason}
          />
          <div className="flex justify-end">
            <Button type="submit" disabled={creating}>
              {creating ? "Sending…" : "Send request"}
            </Button>
          </div>
        </form>
        {formError ? (
          <div className="mt-3">
            <Notice tone="error">{formError}</Notice>
          </div>
        ) : null}
      </Panel>

      {loadError ? <Notice tone="error">{loadError}</Notice> : null}

      <AnimatePresence initial={false}>
        {revealed
          ? reduce ? (
              <RevealedKey revealed={revealed} copied={copied} onCopy={copyKey} />
            ) : (
              <motion.div
                initial={{ opacity: 0, height: 0 }}
                animate={{ opacity: 1, height: "auto" }}
                exit={{ opacity: 0, height: 0 }}
                className="overflow-hidden"
              >
                <RevealedKey revealed={revealed} copied={copied} onCopy={copyKey} />
              </motion.div>
            )
          : null}
      </AnimatePresence>

      {requests && requests.length > 0 ? (
        <Panel label="Your requests" bodyClassName="flex flex-col gap-2">
          {requests.map((r) => (
            <motion.div
              key={r.id}
              {...motionProps}
              className="flex flex-wrap items-start justify-between gap-3 rounded-md border border-border bg-background/40 p-3.5"
            >
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="min-w-0 truncate text-sm font-medium">{r.subject}</span>
                  <Badge tone={toneFor(r.status)}>{r.status}</Badge>
                </div>
                <p className="mt-1 max-w-[70ch] text-xs leading-relaxed text-muted-foreground text-pretty">
                  “{r.reason}”
                </p>
                <p className="mt-1 font-mono text-[0.6875rem] text-muted-foreground">
                  requested {formatDay(r.createdAt)}
                  {r.reviewedAt ? ` · reviewed ${formatDateTime(r.reviewedAt)}` : " · awaiting review"}
                </p>
                {r.status === "rejected" && r.reviewNote ? (
                  <p className="mt-2 max-w-[70ch] rounded-md border-l-2 border-destructive/50 bg-destructive/5 py-1.5 pl-3 pr-2 text-xs leading-relaxed text-foreground/80">
                    <span className="label-mono">Admin’s reason</span>
                    <span className="mt-1 block text-pretty">“{r.reviewNote}”</span>
                    <span className="mt-1 block text-muted-foreground">
                      Fix what they asked for and send a new request.
                    </span>
                  </p>
                ) : null}
              </div>
              {isClaimable(r) ? (
                <Button
                  size="sm"
                  onClick={() => void claim(r.id)}
                  disabled={claimingId !== null}
                  className="shrink-0"
                >
                  {claimingId === r.id ? "Issuing…" : "Reveal my key"}
                </Button>
              ) : null}
            </motion.div>
          ))}
        </Panel>
      ) : null}

      <Panel
        label="Your keys"
        description={
          keys === null
            ? "Loading…"
            : "Revoking stops a key authenticating and can be undone. Deleting removes it for good — only its hash was stored, so there is nothing to recover."
        }
        bodyClassName="flex flex-col gap-2"
      >
        {keys === null ? (
          <>
            <Skeleton className="h-16" />
            <Skeleton className="h-16" />
          </>
        ) : keys.length === 0 ? (
          <p className="rounded-md border border-dashed border-border px-4 py-8 text-center text-sm text-muted-foreground">
            No keys yet. Send a request above — an admin reviews them by hand.
          </p>
        ) : (
          keys.map((k) => (
            <motion.div
              key={k.id}
              {...motionProps}
              className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-border bg-background/40 p-3.5"
            >
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="min-w-0 truncate text-sm font-medium">{k.name}</span>
                  <Badge tone={toneFor(k.revoked ? "revoked" : "active")}>
                    {k.revoked ? "revoked" : "active"}
                  </Badge>
                </div>
                <p className="mt-1 font-mono text-xs text-muted-foreground">
                  {k.prefix}… · used {formatCount(k.useCount)}× · last {formatDay(k.lastUsedAt)}
                </p>
                {k.reason ? (
                  <p className="mt-1 max-w-[70ch] text-xs leading-relaxed text-muted-foreground text-pretty">
                    “{k.reason}”
                  </p>
                ) : null}
              </div>
              <div className="flex shrink-0 items-center gap-2">
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => void toggleRevoke(k)}
                  aria-label={`${k.revoked ? "Restore" : "Revoke"} key ${k.name}`}
                >
                  {k.revoked ? "Restore" : "Revoke"}
                </Button>
                <Button
                  size="sm"
                  variant="destructive"
                  onClick={() => setConfirmDelete(k)}
                  aria-label={`Delete key ${k.name} permanently`}
                >
                  Delete
                </Button>
              </div>
            </motion.div>
          ))
        )}
      </Panel>

      <Dialog
        open={confirmDelete !== null}
        onClose={() => setConfirmDelete(null)}
        title="Delete this key?"
        description={
          confirmDelete
            ? `“${confirmDelete.name}” (${confirmDelete.prefix}…) is removed from the database permanently. Apps still using it start failing, and the value cannot be shown again — you would need a new request.`
            : undefined
        }
        footer={
          <>
            <Button variant="outline" onClick={() => setConfirmDelete(null)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              disabled={deleteBusy}
              onClick={() => confirmDelete && void permanentlyDelete(confirmDelete)}
            >
              {deleteBusy ? "Deleting…" : "Delete key"}
            </Button>
          </>
        }
      >
        <p className="text-xs text-muted-foreground">
          Just want to stop it for now? Close this and use Revoke instead — that is reversible.
        </p>
      </Dialog>
    </div>
  )
}

function RevealedKey({
  revealed,
  copied,
  onCopy,
}: {
  revealed: { key: string; prefix: string }
  copied: boolean
  onCopy: () => void
}) {
  return (
    <Panel className="border-primary/40 bg-primary/5">
      <div className="flex items-start gap-3">
        <KeyRound className="mt-0.5 size-4 shrink-0 text-primary" aria-hidden="true" />
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium">Your new key</p>
          <p className="mt-0.5 text-xs text-muted-foreground">
            Shown once. Store it now — reloading this page will not bring it back.
          </p>
          <div className="mt-3 flex flex-col gap-2 sm:flex-row">
            <code className="min-w-0 flex-1 overflow-x-auto whitespace-nowrap rounded-md bg-background/70 px-3 py-2 font-mono text-xs">
              {revealed.key}
            </code>
            <Button type="button" variant="outline" onClick={onCopy}>
              {copied ? <Check className="size-4" aria-hidden="true" /> : null}
              {copied ? "Copied" : "Copy"}
            </Button>
          </div>
          <p className="mt-2 font-mono text-[0.6875rem] text-muted-foreground">
            Send it as: <span className="text-foreground" translate="no">Authorization: Bearer &lt;key&gt;</span>
          </p>
        </div>
      </div>
    </Panel>
  )
}
