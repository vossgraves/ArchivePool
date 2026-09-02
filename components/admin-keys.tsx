"use client"

import { useCallback, useEffect, useState } from "react"
import { Button } from "@/components/ui/button"
import { Panel } from "@/components/ui/panel"
import { Badge, toneFor } from "@/components/ui/badge"
import { Dialog } from "@/components/ui/dialog"
import { Notice } from "@/components/ui/notice"
import { formatCount, formatDateTime, formatDay } from "@/lib/utils"

type KeyRow = {
  id: number
  name: string
  reason: string
  prefix: string
  revoked: boolean
  deleted: boolean
  useCount: number
  lastUsedAt: string | null
  createdAt: string
  owner: string | null
}

/** Mirrors the payload of POST /api/admin/force-check. */
type ForceCheckResult = {
  sweep: { checked: number; skipped: number; disabled: number; reenabled: number }
  monochrome: { fetched: number; checked: number; added: number; updated: number; failed: number }
  ranAt: string
}

/**
 * Admin key management.
 *
 * Three levels of "stop this key working", and the panel shows all three because they mean
 * different things:
 *   Revoke   — reversible; the row and its hash stay, an honest key holder can be restored.
 *   Hidden   — what the owner did from their own dashboard: soft delete. Row kept, key dead.
 *   Delete   — the row and its hash are gone. Admin-only, and it asks first.
 */
/**
 * Posts a known key value to /api/admin/keys/custom. The value is never echoed back — a
 * successful restore only reports the prefix, since the caller is the one who typed the secret.
 */
function RestoreKeyForm({ onDone }: { onDone: () => void }) {
  const [value, setValue] = useState("")
  const [name, setName] = useState("restored")
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null)

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    setBusy(true)
    setResult(null)
    try {
      const res = await fetch("/api/admin/keys/custom", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${sessionStorage.getItem("adminToken") ?? ""}`,
        },
        body: JSON.stringify({ name: name.trim() || "restored", value: value.trim() }),
      })
      const body = await res.json().catch(() => ({}))
      if (!res.ok) {
        setResult({
          ok: false,
          text: body.detail ?? body.error ?? `Could not restore the key (HTTP ${res.status}).`,
        })
        return
      }
      setResult({ ok: true, text: `Restored as key #${body.id} (${body.prefix}…).` })
      setValue("")
      onDone()
    } catch {
      setResult({ ok: false, text: "Network error — nothing was restored." })
    } finally {
      setBusy(false)
    }
  }

  return (
    <form onSubmit={submit} className="mt-3 flex flex-col gap-2 sm:flex-row sm:items-start">
      <label htmlFor="restore-name" className="sr-only">
        Key name
      </label>
      <input
        id="restore-name"
        value={name}
        onChange={(e) => setName(e.target.value)}
        maxLength={64}
        autoComplete="off"
        className="w-full rounded-md border border-input bg-input/30 px-3 py-2 text-sm outline-none focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/40 sm:w-40"
      />
      <label htmlFor="restore-value" className="sr-only">
        Key value
      </label>
      <input
        id="restore-value"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        placeholder="atp_… full key value"
        spellCheck={false}
        autoComplete="off"
        className="min-w-0 flex-1 rounded-md border border-input bg-input/30 px-3 py-2 font-mono text-xs outline-none placeholder:text-muted-foreground/60 focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/40"
      />
      <Button type="submit" variant="outline" disabled={busy || value.trim().length < 28}>
        {busy ? "Restoring…" : "Restore"}
      </Button>
      {result ? (
        <div className="basis-full">
          <Notice tone={result.ok ? "ok" : "error"}>{result.text}</Notice>
        </div>
      ) : null}
    </form>
  )
}

export function AdminKeys() {
  const [keys, setKeys] = useState<KeyRow[] | null>(null)
  const [newName, setNewName] = useState("")
  const [createdKey, setCreatedKey] = useState<{ name: string; key: string } | null>(null)
  const [copied, setCopied] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [feedback, setFeedback] = useState<{ tone: "ok" | "error"; text: string } | null>(null)
  const [loading, setLoading] = useState(false)
  const [purging, setPurging] = useState(false)
  const [purgeResult, setPurgeResult] = useState<{ removed: number } | null>(null)
  const [confirmPurge, setConfirmPurge] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState<KeyRow | null>(null)
  const [deleteBusy, setDeleteBusy] = useState(false)
  const [forceChecking, setForceChecking] = useState(false)
  const [forceResult, setForceResult] = useState<ForceCheckResult | null>(null)

  const headers = useCallback(
    (extra?: Record<string, string>) => ({
      authorization: `Bearer ${sessionStorage.getItem("adminToken") ?? ""}`,
      ...extra,
    }),
    [],
  )

  const loadKeys = useCallback(async () => {
    setError(null)
    setLoading(true)
    try {
      const res = await fetch("/api/admin/keys", { headers: headers() })
      if (res.status === 401) {
        setError("Admin token rejected. Unlock again from the top of the page.")
        sessionStorage.removeItem("adminToken")
        return
      }
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        setError(body.detail ?? body.error ?? `Could not load keys (HTTP ${res.status}).`)
        return
      }
      const data = await res.json()
      setKeys(data.keys ?? [])
    } catch {
      setError("Network error — keys could not be loaded.")
    } finally {
      setLoading(false)
    }
  }, [headers])

  // AdminGate only mounts this panel once a token is verified, so the list loads immediately.
  useEffect(() => {
    void loadKeys()
  }, [loadKeys])

  async function createKey(e: React.FormEvent) {
    e.preventDefault()
    if (!newName.trim()) return
    setError(null)
    setFeedback(null)
    const res = await fetch("/api/admin/keys", {
      method: "POST",
      headers: headers({ "content-type": "application/json" }),
      body: JSON.stringify({ name: newName.trim() }),
    })
    if (!res.ok) {
      const body = await res.json().catch(() => ({}))
      setFeedback({
        tone: "error",
        text: body.detail ?? body.error ?? `Could not create the key (HTTP ${res.status}).`,
      })
      return
    }
    const data = await res.json()
    setCreatedKey({ name: newName.trim(), key: data.key })
    setNewName("")
    void loadKeys()
  }

  async function toggleRevoke(row: KeyRow) {
    setFeedback(null)
    const res = await fetch("/api/admin/keys", {
      method: "PATCH",
      headers: headers({ "content-type": "application/json" }),
      body: JSON.stringify({ id: row.id, revoked: !row.revoked }),
    })
    if (!res.ok) {
      setFeedback({
        tone: "error",
        text: `Could not ${row.revoked ? "restore" : "revoke"} “${row.name}”.`,
      })
      return
    }
    setFeedback({
      tone: "ok",
      text: row.revoked
        ? `Restored “${row.name}” — it authenticates again.`
        : `Revoked “${row.name}” — reversible, the row is kept.`,
    })
    void loadKeys()
  }

  async function purgeDead() {
    setPurging(true)
    setPurgeResult(null)
    setFeedback(null)
    try {
      const res = await fetch("/api/admin/purge-dead", { method: "POST", headers: headers() })
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        setFeedback({
          tone: "error",
          text: body.detail ?? body.error ?? `Purge failed (HTTP ${res.status}).`,
        })
        return
      }
      setPurgeResult(await res.json())
    } catch {
      setFeedback({ tone: "error", text: "Network error — purge failed." })
    } finally {
      setPurging(false)
      setConfirmPurge(false)
    }
  }

  /** Re-runs the health sweep and the monochrome.tf sync immediately, ignoring the 6h cooldown. */
  async function forceCheck() {
    setForceChecking(true)
    setForceResult(null)
    setFeedback(null)
    try {
      const res = await fetch("/api/admin/force-check", { method: "POST", headers: headers() })
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        setFeedback({
          tone: "error",
          text: body.detail ?? body.error ?? `Force check failed (HTTP ${res.status}).`,
        })
        return
      }
      setForceResult(await res.json())
      void loadKeys()
    } catch {
      setFeedback({ tone: "error", text: "Network error — force check failed." })
    } finally {
      setForceChecking(false)
    }
  }

  async function permanentlyDelete(row: KeyRow) {
    setDeleteBusy(true)
    setFeedback(null)
    try {
      const res = await fetch(`/api/admin/keys/${row.id}`, { method: "DELETE", headers: headers() })
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        setFeedback({
          tone: "error",
          text: body.detail ?? body.error ?? `Could not delete “${row.name}”.`,
        })
        return
      }
      setFeedback({
        tone: "ok",
        text: `Deleted “${row.name}” permanently. Its hash is gone, so the key can never authenticate again.`,
      })
      void loadKeys()
    } catch {
      setFeedback({ tone: "error", text: "Network error — the key was not deleted." })
    } finally {
      setDeleteBusy(false)
      setConfirmDelete(null)
    }
  }

  const hiddenCount = keys?.filter((k) => k.deleted).length ?? 0

  return (
    <div className="flex flex-col gap-6" id="admin-keys">
      {error ? <Notice tone="error">{error}</Notice> : null}
      {feedback ? <Notice tone={feedback.tone}>{feedback.text}</Notice> : null}

      <Panel
        label="Create a key"
        description="For your own apps. The value is shown once — only its SHA-256 hash is stored."
      >
        <form onSubmit={createKey} className="flex flex-col gap-3 sm:flex-row">
          <label htmlFor="new-key-name" className="sr-only">
            Key name
          </label>
          <input
            id="new-key-name"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            placeholder="e.g. ArchiveTune Android"
            maxLength={64}
            autoComplete="off"
            className="min-w-0 flex-1 rounded-md border border-input bg-input/30 px-3 py-2 text-sm outline-none placeholder:text-muted-foreground/60 focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/40"
          />
          <Button type="submit" disabled={!newName.trim()}>
            Generate key
          </Button>
        </form>

        {createdKey ? (
          <div className="mt-4 rounded-md border border-primary/40 bg-primary/5 p-3">
            <p className="text-xs font-medium text-foreground">
              New key for{" "}
              <span className="font-semibold">{createdKey.name}</span> — copy it now, it will not be
              shown again.
            </p>
            <div className="mt-2 flex flex-col gap-2 sm:flex-row">
              <code className="min-w-0 flex-1 break-all rounded-md bg-background/70 px-3 py-2 font-mono text-xs">
                {createdKey.key}
              </code>
              <Button
                type="button"
                variant="outline"
                onClick={() => {
                  void navigator.clipboard?.writeText(createdKey.key)
                  setCopied(true)
                  setTimeout(() => setCopied(false), 1600)
                }}
              >
                {copied ? "Copied" : "Copy"}
              </Button>
            </div>
          </div>
        ) : null}
      </Panel>

      <Panel
        label="Keys"
        description={
          keys
            ? `${formatCount(keys.length)} total${hiddenCount ? ` · ${hiddenCount} hidden by their owner` : ""}`
            : "Loading…"
        }
        actions={
          <Button size="sm" variant="ghost" onClick={() => void loadKeys()} disabled={loading}>
            {loading ? "Refreshing…" : "Refresh"}
          </Button>
        }
        bodyClassName="p-0"
      >
        {!keys ? (
          <div className="p-4">
            <div className="h-16 animate-pulse rounded-md bg-secondary/60" />
          </div>
        ) : keys.length === 0 ? (
          <p className="px-4 py-8 text-center text-sm text-muted-foreground">
            No keys yet. Create one above, or wait for a request to be approved.
          </p>
        ) : (
          <ul className="divide-y divide-border">
            {keys.map((row) => (
              <li
                key={row.id}
                className="flex flex-wrap items-center justify-between gap-3 px-4 py-3"
              >
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="min-w-0 truncate text-sm font-medium">{row.name}</span>
                    {row.deleted ? <Badge tone="neutral">hidden</Badge> : null}
                    <Badge tone={toneFor(row.revoked ? "revoked" : "active")}>
                      {row.revoked ? "revoked" : "active"}
                    </Badge>
                  </div>
                  <p className="mt-1 min-w-0 truncate font-mono text-xs text-muted-foreground">
                    {row.prefix}… · {formatCount(row.useCount)} uses · last{" "}
                    {formatDay(row.lastUsedAt)} · added {formatDay(row.createdAt)}
                    {row.owner ? ` · @${row.owner}` : " · no owner"}
                  </p>
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => void toggleRevoke(row)}
                    aria-label={`${row.revoked ? "Restore" : "Revoke"} key ${row.name}`}
                  >
                    {row.revoked ? "Restore" : "Revoke"}
                  </Button>
                  <Button
                    size="sm"
                    variant="destructive"
                    onClick={() => setConfirmDelete(row)}
                    aria-label={`Delete key ${row.name} permanently`}
                  >
                    Delete
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </Panel>

      <Panel
        label="Housekeeping"
        description="Re-check the pool, drop dead entries, or restore a lost key. Each of these changes live data."
      >
        <div className="flex flex-col gap-3">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <p className="min-w-0 max-w-[62ch] text-xs leading-relaxed text-muted-foreground">
              <span className="font-medium text-foreground">Force check everything.</span> Re-checks
              every account and instance now, bypassing the 6-hour cooldown, and pulls a fresh
              monochrome.tf sync.
            </p>
            <Button
              variant="outline"
              size="sm"
              disabled={forceChecking}
              onClick={() => void forceCheck()}
            >
              {forceChecking ? "Checking…" : "Force check"}
            </Button>
          </div>

          {forceResult ? (
            <div className="rounded-md border border-border bg-secondary/50 px-3 py-2 font-mono text-xs leading-relaxed">
              <p className="mb-1 text-muted-foreground">Done · {formatDateTime(forceResult.ranAt)}</p>
              <p>Sweep — {forceResult.sweep.checked} checked, {forceResult.sweep.skipped} skipped, {forceResult.sweep.disabled} disabled, {forceResult.sweep.reenabled} re-enabled</p>
              <p>
                Monochrome — {forceResult.monochrome.fetched} fetched, {forceResult.monochrome.checked} checked,{" "}
                {forceResult.monochrome.added} added, {forceResult.monochrome.updated} updated,{" "}
                {forceResult.monochrome.failed} failed
              </p>
            </div>
          ) : null}

          <div className="h-px bg-border" />

          <div className="flex flex-wrap items-center justify-between gap-3">
            <p className="min-w-0 max-w-[62ch] text-xs leading-relaxed text-muted-foreground">
              <span className="font-medium text-foreground">Remove all dead.</span> Deletes every
              entry whose status is <code className="font-mono">dead</code>. Force check first, or
              entries that merely have not been re-checked yet linger.
            </p>
            <Button
              variant="destructive"
              size="sm"
              disabled={purging}
              onClick={() => setConfirmPurge(true)}
            >
              {purging ? "Purging…" : "Remove all dead"}
            </Button>
          </div>
          {purgeResult ? (
            <p className="text-xs text-muted-foreground" role="status" aria-live="polite">
              Removed <span className="font-semibold text-foreground">{formatCount(purgeResult.removed)}</span>{" "}
              dead {purgeResult.removed === 1 ? "entry" : "entries"}.
            </p>
          ) : null}

          <div className="h-px bg-border" />

          <details className="group">
            <summary className="cursor-pointer text-xs font-medium text-muted-foreground transition-colors hover:text-foreground">
              Restore a known key value
            </summary>
            <p className="mt-2 max-w-[70ch] text-xs leading-relaxed text-muted-foreground text-pretty">
              After a database loss every stored hash is gone while apps keep presenting the key
              baked into their builds. This re-seeds a key whose value matches{" "}
              <code className="font-mono">SOURCE_PROVIDER_KEY</code> so those clients keep working
              without a rebuild. Only use it for a value you already published — anyone who learns
              it can read the pool.
            </p>
            <RestoreKeyForm onDone={() => void loadKeys()} />
          </details>
        </div>
      </Panel>
      <Dialog
        open={confirmPurge}
        onClose={() => setConfirmPurge(false)}
        title="Remove every dead entry?"
        description="This deletes pool entries whose last checks failed. It cannot be undone, and it takes their health history with them."
        footer={
          <>
            <Button variant="outline" onClick={() => setConfirmPurge(false)}>
              Cancel
            </Button>
            <Button variant="destructive" disabled={purging} onClick={() => void purgeDead()}>
              {purging ? "Purging…" : "Remove dead entries"}
            </Button>
          </>
        }
      />

      <Dialog
        open={confirmDelete !== null}
        onClose={() => setConfirmDelete(null)}
        title="Delete this key permanently?"
        description={
          confirmDelete
            ? `“${confirmDelete.name}” (${confirmDelete.prefix}…) leaves the database entirely. Any app still using it starts failing immediately, and the key cannot be restored — only a brand-new one can be issued.`
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
        {confirmDelete?.owner ? (
          <p className="text-xs text-muted-foreground">
            Owned by <span className="font-medium text-foreground">@{confirmDelete.owner}</span>. They
            will need to request a new key from their dashboard.
          </p>
        ) : null}
      </Dialog>
    </div>
  )
}
