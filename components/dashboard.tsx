// SPDX-License-Identifier: GPL-3.0-or-later
"use client"

import { useState } from "react"
import { useRouter } from "next/navigation"
import { AnimatePresence, motion, useReducedMotion } from "motion/react"
import { ChevronRight, KeyRound } from "lucide-react"
import { toast } from "sonner"
import type { DashboardSnapshot, DashboardKey, DashboardLease, DashboardRequest } from "@/lib/queries"
import { Badge, toneFor } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { BarList } from "@/components/ui/chart"
import { CopyButton } from "@/components/ui/copy-button"
import { Dialog } from "@/components/ui/dialog"
import { Empty } from "@/components/ui/empty"
import { Field } from "@/components/ui/field"
import { Notice } from "@/components/ui/notice"
import { Panel } from "@/components/ui/panel"
import { DashboardContributions } from "@/components/dashboard-contributions"
import { DashboardPool } from "@/components/dashboard-pool"
import { DashboardSummary } from "@/components/dashboard-summary"
import { cn, expiryState, formatAgo, formatCount, formatDateTime, formatDay, formatUntil } from "@/lib/utils"
import { SERVICES, SERVICE_LABELS, type Service } from "@/lib/sources"

/**
 * A key the user is entitled to but has not seen yet: approved by an admin, no key minted so far.
 * Approval deliberately does not generate the key, so the plaintext can be handed to exactly one
 * audience — the requester — at exactly one moment.
 */
function isClaimable(r: DashboardRequest) {
  return r.status === "approved" && r.resultingKeyId === null
}

/**
 * The signed-in view of the pool. Every figure here is server-rendered from getDashboard(), and
 * mutations go through the same REST routes as before and then `router.refresh()` — so the panel
 * that changed and the tiles above it can never disagree, which they did while the list was fetched
 * client-side and the summary was computed from a second copy of it.
 */
export function Dashboard({
  username,
  snapshot,
}: {
  username: string
  snapshot: DashboardSnapshot
}) {
  const router = useRouter()
  const reduce = useReducedMotion()
  const [subject, setSubject] = useState("")
  const [reason, setReason] = useState("")
  // "any" is the absence of a scope: it is sent as null and stored as NULL.
  const [requestService, setRequestService] = useState<Service | "any">("any")
  const [discord, setDiscord] = useState("")
  const [telegram, setTelegram] = useState("")
  const [contactNote, setContactNote] = useState("")
  const [formError, setFormError] = useState<string | null>(null)
  const [formOpen, setFormOpen] = useState(snapshot.keys.length === 0)
  const [creating, setCreating] = useState(false)
  const [revealed, setRevealed] = useState<{ key: string; prefix: string } | null>(null)
  const [claimingId, setClaimingId] = useState<number | null>(null)
  const [confirmDelete, setConfirmDelete] = useState<DashboardKey | null>(null)
  const [deleteBusy, setDeleteBusy] = useState(false)

  const { keys, requests, leases } = snapshot
  const activeCount = keys.filter((k) => !k.revoked).length
  const motionProps = reduce
    ? {}
    : {
        initial: { opacity: 0, y: 8 },
        animate: { opacity: 1, y: 0 },
        transition: { type: "spring" as const, stiffness: 260, damping: 28 },
      }

  /*
   * Where results go, throughout this component: anything the server says about the fields still
   * on screen stays inline next to them (formError), and the outcome of an action goes to a toast.
   * The dashboard runs long, so a message anchored to the top of it is off-screen from the Revoke
   * button that produced it.
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
        body: JSON.stringify({
          subject,
          reason,
          requestedService: requestService === "any" ? null : requestService,
          discordId: discord,
          telegramId: telegram,
          contactNote,
        }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) {
        setFormError(data.detail ?? data.error ?? "Could not submit the request.")
        return
      }
      toast.success("Request sent", {
        description:
          "An admin reviews requests by hand. It appears below, and your key appears here once it is accepted.",
      })
      setSubject("")
      setReason("")
      setRequestService("any")
      setDiscord("")
      setTelegram("")
      setContactNote("")
      router.refresh()
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
      router.refresh()
    } catch {
      toast.error("Network error — no key was created.")
    } finally {
      setClaimingId(null)
    }
  }

  async function toggleRevoke(key: DashboardKey) {
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
    router.refresh()
  }

  async function permanentlyDelete(key: DashboardKey) {
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
      router.refresh()
    } catch {
      toast.error("Network error — the key was not deleted.")
    } finally {
      setDeleteBusy(false)
      setConfirmDelete(null)
    }
  }

  return (
    <div className="flex flex-col gap-6">
      {snapshot.failed.length > 0 ? (
        <Notice tone="error">
          Could not load {snapshot.failed.join(", ")} — those panels are showing nothing rather than
          a figure that might be wrong. Everything else on this page is current.
        </Notice>
      ) : null}

      <DashboardSummary snapshot={snapshot} />

      <AnimatePresence initial={false}>
        {revealed
          ? reduce ? (
              <RevealedKey revealed={revealed} />
            ) : (
              <motion.div
                initial={{ opacity: 0, height: 0 }}
                animate={{ opacity: 1, height: "auto" }}
                exit={{ opacity: 0, height: 0 }}
                className="overflow-hidden"
              >
                <RevealedKey revealed={revealed} />
              </motion.div>
            )
          : null}
      </AnimatePresence>

      <Panel
        label="Your keys"
        description={`Signed in as @${username} · ${formatCount(activeCount)} active ${activeCount === 1 ? "key" : "keys"}. Revoking stops a key authenticating and can be undone; deleting removes it for good — only its hash was stored, so there is nothing to recover.`}
        bodyClassName="flex flex-col gap-3"
        className="scroll-mt-20"
      >
        <span id="keys" className="sr-only" />
        {keys.length === 0 ? (
          <Empty>
            No keys yet. Request one below — an admin reviews requests by hand, and your key appears
            here the moment one is approved.
          </Empty>
        ) : (
          <>
            {keys.map((key) => (
              <motion.div
                key={key.id}
                {...motionProps}
                className="flex flex-col gap-3 rounded-md border border-border bg-background/40 p-3.5"
              >
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="min-w-0 truncate text-sm font-medium">{key.name}</span>
                      <Badge tone={toneFor(key.revoked ? "revoked" : "active")}>
                        {key.revoked ? "revoked" : "active"}
                      </Badge>
                      {key.heldEntries > 0 ? (
                        <Badge tone={toneFor("held")}>
                          {formatCount(key.heldEntries)} held
                        </Badge>
                      ) : null}
                    </div>
                    <p className="mt-1 font-mono text-xs text-muted-foreground">
                      {key.prefix}… · {formatCount(key.useCount)} {key.useCount === 1 ? "request" : "requests"} ·
                      last used {key.lastUsedAt ? formatAgo(key.lastUsedAt) : "never"} · created{" "}
                      {formatDay(key.createdAt)}
                    </p>
                    {key.reason ? (
                      <p className="mt-1 max-w-[70ch] text-xs leading-relaxed text-muted-foreground text-pretty">
                        “{key.reason}”
                      </p>
                    ) : null}
                  </div>
                  <div className="flex shrink-0 items-center gap-2">
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => void toggleRevoke(key)}
                      aria-label={`${key.revoked ? "Restore" : "Revoke"} key ${key.name}`}
                    >
                      {key.revoked ? "Restore" : "Revoke"}
                    </Button>
                    <Button
                      size="sm"
                      variant="destructive"
                      onClick={() => setConfirmDelete(key)}
                      aria-label={`Delete key ${key.name} permanently`}
                    >
                      Delete
                    </Button>
                  </div>
                </div>
                <KeyLeases leases={leases.filter((l) => l.keyId === key.id)} keyName={key.name} />
              </motion.div>
            ))}

            {keys.some((k) => k.useCount > 0) ? (
              <div className="mt-1 flex flex-col gap-3 border-t border-border pt-4">
                <h3 className="label-mono">Traffic by key</h3>
                <BarList
                  format={(n) => `${formatCount(n)} req`}
                  items={keys.map((key) => ({
                    label: key.name,
                    value: key.useCount,
                    tone: key.revoked ? "danger" : key.useCount > 0 ? "ok" : "neutral",
                    hint: `${key.prefix}… · last used ${key.lastUsedAt ? formatAgo(key.lastUsedAt) : "never"}`,
                    badge: key.revoked ? <Badge tone={toneFor("revoked")}>revoked</Badge> : undefined,
                  }))}
                />
              </div>
            ) : null}
          </>
        )}
      </Panel>

      <Panel
        label="Key requests"
        description="Requests are reviewed by hand. An approved one mints nothing until you reveal it here."
        bodyClassName="flex flex-col gap-3"
        className="scroll-mt-20"
      >
        <span id="requests" className="sr-only" />
        {requests.length === 0 ? (
          <Empty>No requests yet. The form below is the only way to get a read key.</Empty>
        ) : (
          requests.map((r) => (
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
          ))
        )}

        <details
          open={formOpen}
          onToggle={(e) => setFormOpen((e.currentTarget as HTMLDetailsElement).open)}
          className="rounded-md border border-border bg-background/40"
        >
          <summary className="flex cursor-pointer list-none items-center gap-2 px-3.5 py-3 text-sm font-medium [&::-webkit-details-marker]:hidden">
            <ChevronRight
              className={cn("size-3.5 transition-transform", formOpen && "rotate-90")}
              aria-hidden="true"
            />
            Request {keys.length > 0 || requests.length > 0 ? "another" : "a"} key
          </summary>
          {/* The text controls go through the shared Field, which is where the label/
              `aria-describedby` wiring lives. `mono` is off: these are prose, not credentials. */}
          <form onSubmit={createRequest} className="flex flex-col gap-3 border-t border-border p-3.5">
            <div className="flex flex-col gap-1.5">
              <span className="text-sm font-medium">Source</span>
              <div className="inline-flex w-full flex-wrap rounded-md border border-border p-1">
                {(["any", ...SERVICES] as const).map((opt) => (
                  <button
                    key={opt}
                    type="button"
                    onClick={() => setRequestService(opt)}
                    className={`flex-1 whitespace-nowrap rounded px-3 py-1.5 text-sm font-medium transition-colors ${
                      requestService === opt
                        ? "bg-primary text-primary-foreground"
                        : "text-muted-foreground hover:text-foreground"
                    }`}
                  >
                    {opt === "any" ? "Any" : SERVICE_LABELS[opt]}
                  </button>
                ))}
              </div>
              <p className="text-xs leading-relaxed text-muted-foreground text-pretty">
                A key scoped to one source never receives another's credentials.
              </p>
            </div>
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
            <div className="grid gap-3 sm:grid-cols-2">
              <Field
                label="Discord ID"
                name="discordId"
                mono={false}
                maxLength={64}
                placeholder="Optional"
                value={discord}
                onValueChange={setDiscord}
              />
              <Field
                label="Telegram ID"
                name="telegramId"
                mono={false}
                maxLength={64}
                placeholder="Optional"
                value={telegram}
                onValueChange={setTelegram}
              />
            </div>
            <Field
              label="Note"
              name="contactNote"
              mono={false}
              rows={2}
              maxLength={500}
              placeholder="Optional — anything else the reviewer should know"
              value={contactNote}
              onValueChange={setContactNote}
            />
            <div className="flex justify-end">
              <Button type="submit" disabled={creating}>
                {creating ? "Sending…" : "Send request"}
              </Button>
            </div>
            {formError ? <Notice tone="error">{formError}</Notice> : null}
          </form>
        </details>
      </Panel>

      <div id="contributions" className="scroll-mt-20">
        <DashboardContributions
          contributions={snapshot.contributions}
          history={snapshot.contributionHistory}
        />
      </div>

      <DashboardPool pool={snapshot.pool} history={snapshot.poolHistory} />

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

/**
 * Which pool entries this key is sticky on. Collapsed by default and native `<details>` rather than
 * state: it is detail for the one reader debugging "why does my app keep getting this token", and
 * the summary line above already carries the count.
 */
function KeyLeases({ leases, keyName }: { leases: DashboardLease[]; keyName: string }) {
  if (leases.length === 0) {
    return (
      <p className="font-mono text-[0.6875rem] text-muted-foreground">
        holding no entries — the pool assigns them on the next feed fetch
      </p>
    )
  }
  return (
    <details className="rounded-md border border-border bg-card/60">
      <summary className="flex cursor-pointer list-none items-center gap-2 px-3 py-2 font-mono text-[0.6875rem] uppercase tracking-[0.1em] text-muted-foreground [&::-webkit-details-marker]:hidden">
        <ChevronRight className="size-3" aria-hidden="true" />
        Entries {keyName} currently holds ({formatCount(leases.length)})
      </summary>
      <ul className="flex flex-col gap-2 border-t border-border p-3">
        {leases.map((lease) => {
          const expiry = expiryState(lease.expiresAt)
          return (
            <li
              key={lease.entryId}
              className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1.5"
            >
              <span className="flex min-w-0 items-center gap-2">
                <span className="min-w-0 truncate text-xs">{lease.label}</span>
                <Badge tone={toneFor(lease.status)}>{lease.status}</Badge>
                {lease.premium ? <Badge tone={toneFor("premium")}>premium</Badge> : null}
                {expiry === "expiring" || expiry === "expired" ? (
                  <Badge tone={toneFor(expiry)}>{formatUntil(lease.expiresAt)}</Badge>
                ) : null}
              </span>
              <span className="font-mono text-[0.625rem] text-muted-foreground">
                leased {formatAgo(lease.leasedAt)} · checked {formatAgo(lease.lastCheckedAt)}
              </span>
            </li>
          )
        })}
      </ul>
    </details>
  )
}

function RevealedKey({ revealed }: { revealed: { key: string; prefix: string } }) {
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
            <CopyButton value={revealed.key} />
          </div>
          <p className="mt-2 font-mono text-[0.6875rem] text-muted-foreground">
            Send it as: <span className="text-foreground" translate="no">Authorization: Bearer &lt;key&gt;</span>
          </p>
        </div>
      </div>
    </Panel>
  )
}
