"use client"

import { useCallback, useEffect, useState } from "react"
import { AnimatePresence, motion } from "motion/react"

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
  createdAt: string
  reviewedAt: string | null
}

function formatDate(iso: string | null): string {
  if (!iso) return "never"
  return new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" })
}

function statusBadge(status: string) {
  const map: Record<string, string> = {
    pending: "bg-amber-500/15 text-amber-600 border-amber-500/30",
    approved: "bg-emerald-500/15 text-emerald-600 border-emerald-500/30",
    rejected: "bg-red-500/15 text-red-600 border-red-500/30",
  }
  return map[status] ?? "bg-secondary text-muted-foreground"
}

export function Dashboard({ username }: { username: string }) {
  const [keys, setKeys] = useState<KeyRow[] | null>(null)
  const [requests, setRequests] = useState<RequestRow[] | null>(null)
  const [subject, setSubject] = useState("")
  const [reason, setReason] = useState("")
  const [creating, setCreating] = useState(false)
  const [revealed, setRevealed] = useState<{ key: string; prefix: string } | null>(null)
  const [copied, setCopied] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [success, setSuccess] = useState<string | null>(null)

  const load = useCallback(async () => {
    const res = await fetch("/api/keys", { cache: "no-store" })
    if (res.ok) {
      const data = await res.json()
      setKeys(data.keys ?? [])
      setRequests(data.requests ?? [])
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  async function createRequest(e: React.FormEvent) {
    e.preventDefault()
    if (creating) return
    setCreating(true)
    setError(null)
    setSuccess(null)
    try {
      const res = await fetch("/api/keys", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ subject, reason }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) {
        setError(data.detail ?? data.error ?? "Could not submit request.")
        return
      }
      if (data.key) {
        // Old path: immediate key (admin or pre-migration)
        setRevealed({ key: data.key, prefix: data.prefix })
      } else {
        setSuccess("Request submitted — an admin will review it. You’ll see the status below.")
      }
      setSubject("")
      setReason("")
      await load()
    } finally {
      setCreating(false)
    }
  }

  async function revoke(id: number, undo = false) {
    await fetch(`/api/keys/${id}${undo ? "?undo=1" : ""}`, { method: "DELETE" })
    await load()
  }

  async function remove(id: number) {
    await fetch(`/api/keys/${id}?delete=1`, { method: "DELETE" })
    await load()
  }

  async function copyKey() {
    if (!revealed) return
    await navigator.clipboard.writeText(revealed.key)
    setCopied(true)
    setTimeout(() => setCopied(false), 1600)
  }

  const activeCount = keys?.filter((k) => !k.revoked).length ?? 0

  return (
    <div className="flex flex-col gap-8">
      <motion.section
        initial={{ opacity: 0, y: 12 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ type: "spring", stiffness: 240, damping: 26 }}
        className="rounded-[1.75rem] border border-border bg-card p-6"
      >
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight">API keys</h1>
            <p className="mt-1 text-sm text-muted-foreground">
              Signed in as <span className="font-medium text-foreground">{username}</span> ·{" "}
              {activeCount} active {activeCount === 1 ? "key" : "keys"}
            </p>
          </div>
        </div>

        <form onSubmit={createRequest} className="mt-5 flex flex-col gap-3">
          <input
            value={subject}
            onChange={(e) => setSubject(e.target.value)}
            placeholder="Subject (e.g. ArchiveTune dev build)"
            maxLength={64}
            required
            className="w-full rounded-full border border-input bg-input/40 px-4 py-2.5 text-sm outline-none transition-all placeholder:text-muted-foreground/60 focus:border-primary/60 focus:ring-2 focus:ring-primary/25"
          />
          <textarea
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="Reason — why do you need this key? (at least 10 characters)"
            maxLength={500}
            required
            rows={3}
            className="w-full rounded-2xl border border-input bg-input/40 px-4 py-2.5 text-sm outline-none transition-all placeholder:text-muted-foreground/60 focus:border-primary/60 focus:ring-2 focus:ring-primary/25"
          />
          <div className="flex justify-end">
            <motion.button
              whileTap={{ scale: 0.97 }}
              type="submit"
              disabled={creating}
              className="rounded-full bg-primary px-5 py-2.5 text-sm font-semibold text-primary-foreground transition-opacity hover:opacity-90 disabled:opacity-50"
            >
              {creating ? "Submitting…" : "Request API key"}
            </motion.button>
          </div>
        </form>
        {error && (
          <p className="mt-3 rounded-xl bg-destructive/10 px-3.5 py-2.5 text-sm text-destructive" role="alert">
            {error}
          </p>
        )}
        {success && (
          <p className="mt-3 rounded-xl bg-emerald-500/10 px-3.5 py-2.5 text-sm text-emerald-700" role="status">
            {success}
          </p>
        )}

        <AnimatePresence>
          {revealed && (
            <motion.div
              initial={{ opacity: 0, y: -8, scale: 0.98 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, scale: 0.98 }}
              transition={{ type: "spring", stiffness: 320, damping: 28 }}
              className="mt-4 rounded-2xl border border-primary/40 bg-primary/5 p-4"
            >
              <p className="text-sm font-medium">Your new key — copy it now, it is shown only once</p>
              <div className="mt-2.5 flex flex-col gap-2 sm:flex-row">
                <code className="flex-1 overflow-x-auto rounded-xl bg-background/70 px-3.5 py-2.5 font-mono text-xs">
                  {revealed.key}
                </code>
                <motion.button
                  whileTap={{ scale: 0.96 }}
                  onClick={copyKey}
                  className="rounded-full border border-primary/50 px-4 py-2 text-sm font-medium text-primary"
                >
                  {copied ? "Copied ✓" : "Copy"}
                </motion.button>
              </div>
              <p className="mt-2 font-mono text-[0.65rem] uppercase tracking-[0.14em] text-muted-foreground">
                Use it as: Authorization: Bearer &lt;key&gt;
              </p>
            </motion.div>
          )}
        </AnimatePresence>
      </motion.section>

      {requests !== null && requests.length > 0 && (
        <section className="flex flex-col gap-3">
          <h2 className="px-1 text-sm font-semibold tracking-tight">Your requests</h2>
          {requests.map((r) => (
            <motion.div
              key={r.id}
              layout
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-border bg-card px-5 py-4"
            >
              <div className="min-w-0">
                <p className="truncate text-sm font-medium">
                  {r.subject}{" "}
                  <span className={`ml-2 rounded-full border px-2 py-0.5 font-mono text-[0.6rem] uppercase tracking-wider ${statusBadge(r.status)}`}>
                    {r.status}
                  </span>
                </p>
                <p className="mt-1 text-xs text-muted-foreground/80">“{r.reason}”</p>
                <p className="mt-1 font-mono text-xs text-muted-foreground">
                  requested {formatDate(r.createdAt)}
                  {r.reviewedAt ? ` · reviewed ${formatDate(r.reviewedAt)}` : " · awaiting review"}
                </p>
              </div>
            </motion.div>
          ))}
        </section>
      )}

      <section className="flex flex-col gap-3">
        {keys === null ? (
          <div className="h-20 animate-pulse rounded-2xl bg-card" />
        ) : keys.length === 0 ? (
          <p className="rounded-2xl border border-dashed border-border p-6 text-center text-sm text-muted-foreground">
            No keys yet — request one above.
          </p>
        ) : (
          keys.map((k) => (
            <motion.div
              key={k.id}
              layout
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ type: "spring", stiffness: 300, damping: 30 }}
              className={`flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-border bg-card px-5 py-4 ${
                k.revoked ? "opacity-50" : ""
              }`}
            >
              <div className="min-w-0">
                <p className="truncate text-sm font-medium">
                  {k.name}
                  {k.revoked && (
                    <span className="ml-2 rounded-full bg-secondary px-2 py-0.5 font-mono text-[0.6rem] uppercase tracking-wider text-muted-foreground">
                      revoked
                    </span>
                  )}
                </p>
                <p className="mt-0.5 font-mono text-xs text-muted-foreground">
                  {k.prefix}… · used {k.useCount}× · last {formatDate(k.lastUsedAt)}
                </p>
                {k.reason && <p className="mt-1 text-xs text-muted-foreground/80">“{k.reason}”</p>}
              </div>
              <div className="flex items-center gap-2">
                <button
                  onClick={() => revoke(k.id, k.revoked)}
                  className={`rounded-full px-4 py-1.5 text-xs font-medium transition-colors ${
                    k.revoked
                      ? "border border-border text-muted-foreground hover:text-foreground"
                      : "bg-destructive/10 text-destructive hover:bg-destructive/20"
                  }`}
                >
                  {k.revoked ? "Restore" : "Revoke"}
                </button>
                <button
                  onClick={() => remove(k.id)}
                  title="Hide this key. It stops working immediately; the record stays in the database."
                  className="rounded-full border border-border px-4 py-1.5 text-xs font-medium text-muted-foreground transition-colors hover:border-destructive/40 hover:text-destructive"
                >
                  Delete
                </button>
              </div>
            </motion.div>
          ))
        )}
      </section>
    </div>
  )
}
