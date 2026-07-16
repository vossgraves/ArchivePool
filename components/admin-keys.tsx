"use client"

import { useCallback, useEffect, useState } from "react"
import { Button } from "@/components/ui/button"

type KeyRow = {
  id: number
  name: string
  prefix: string
  revoked: boolean
  useCount: number
  lastUsedAt: string | null
  createdAt: string
}

export function AdminKeys() {
  const [token, setToken] = useState("")
  const [authed, setAuthed] = useState(false)
  const [keys, setKeys] = useState<KeyRow[]>([])
  const [newName, setNewName] = useState("")
  const [createdKey, setCreatedKey] = useState<{ name: string; key: string } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [forceChecking, setForceChecking] = useState(false)
  const [forceResult, setForceResult] = useState<{
    sweep: { checked: number; skipped: number; disabled: number; reenabled: number }
    monochrome: { fetched: number; checked: number; added: number; updated: number; failed: number }
    ranAt: string
  } | null>(null)

  // Restore the token for the session so a refresh doesn't force re-entry.
  useEffect(() => {
    const saved = sessionStorage.getItem("adminToken")
    if (saved) {
      setToken(saved)
      setAuthed(true)
    }
  }, [])

  const authHeaders = useCallback(
    (extra?: Record<string, string>) => ({
      authorization: `Bearer ${token}`,
      ...extra,
    }),
    [token],
  )

  const loadKeys = useCallback(async () => {
    setError(null)
    setLoading(true)
    try {
      const res = await fetch("/api/admin/keys", { headers: authHeaders() })
      if (res.status === 401) {
        setError("Invalid admin token.")
        setAuthed(false)
        sessionStorage.removeItem("adminToken")
        return
      }
      const data = await res.json()
      setKeys(data.keys ?? [])
      setAuthed(true)
      sessionStorage.setItem("adminToken", token)
    } catch {
      setError("Failed to load keys.")
    } finally {
      setLoading(false)
    }
  }, [authHeaders, token])

  useEffect(() => {
    if (authed) void loadKeys()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [authed])

  async function createKey(e: React.FormEvent) {
    e.preventDefault()
    if (!newName.trim()) return
    setError(null)
    const res = await fetch("/api/admin/keys", {
      method: "POST",
      headers: authHeaders({ "content-type": "application/json" }),
      body: JSON.stringify({ name: newName.trim() }),
    })
    if (!res.ok) {
      setError("Could not create key.")
      return
    }
    const data = await res.json()
    setCreatedKey({ name: newName.trim(), key: data.key })
    setNewName("")
    void loadKeys()
  }

  async function forceCheck() {
    setForceChecking(true)
    setForceResult(null)
    try {
      const res = await fetch("/api/admin/force-check", {
        method: "POST",
        headers: authHeaders(),
      })
      if (!res.ok) {
        setError("Force check failed.")
        return
      }
      const data = await res.json()
      setForceResult(data)
    } catch {
      setError("Force check failed.")
    } finally {
      setForceChecking(false)
    }
  }

  async function toggleRevoke(row: KeyRow) {
    await fetch("/api/admin/keys", {
      method: "PATCH",
      headers: authHeaders({ "content-type": "application/json" }),
      body: JSON.stringify({ id: row.id, revoked: !row.revoked }),
    })
    void loadKeys()
  }

  if (!authed) {
    return (
      <form
        onSubmit={(e) => {
          e.preventDefault()
          void loadKeys()
        }}
        className="max-w-md rounded-lg border border-border p-5"
      >
        <label htmlFor="admin-token" className="block text-sm font-medium">
          Admin token
        </label>
        <p className="mb-3 mt-1 text-xs leading-relaxed text-muted-foreground">
          The value of your ADMIN_TOKEN environment variable.
        </p>
        <input
          id="admin-token"
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
    <div className="flex flex-col gap-8">
      <section className="rounded-lg border border-border p-5">
        <h2 className="text-sm font-semibold">Force check</h2>
        <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
          Immediately re-checks every token and instance in the pool, bypassing the normal 6h
          cooldown. Also triggers a fresh monochrome.tf sync to pick up new instances.
        </p>
        <Button
          type="button"
          className="mt-4"
          disabled={forceChecking}
          onClick={() => void forceCheck()}
        >
          {forceChecking ? "Checking…" : "Force check everything"}
        </Button>
        {forceResult ? (
          <div className="mt-4 rounded-md border border-border bg-secondary px-4 py-3 font-mono text-xs leading-relaxed">
            <p className="font-sans text-xs font-medium mb-2">
              Done · {new Date(forceResult.ranAt).toLocaleString()}
            </p>
            <p>
              <span className="text-muted-foreground">Sweep — </span>
              checked {forceResult.sweep.checked}, skipped {forceResult.sweep.skipped}, disabled{" "}
              {forceResult.sweep.disabled}, re-enabled {forceResult.sweep.reenabled}
            </p>
            <p>
              <span className="text-muted-foreground">Monochrome — </span>
              fetched {forceResult.monochrome.fetched}, checked {forceResult.monochrome.checked},
              added {forceResult.monochrome.added}, updated {forceResult.monochrome.updated}, failed{" "}
              {forceResult.monochrome.failed}
            </p>
          </div>
        ) : null}
      </section>

      <section className="rounded-lg border border-border p-5">
        <h2 className="text-sm font-semibold">Create a key</h2>
        <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
          Give the app or person a descriptive name. The key is shown only once.
        </p>
        <form onSubmit={createKey} className="mt-4 flex flex-col gap-3 sm:flex-row">
          <input
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            placeholder="e.g. ArchiveTune Android"
            className="flex-1 rounded-md border border-input bg-background px-3 py-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
          />
          <Button type="submit" disabled={!newName.trim()}>
            Generate key
          </Button>
        </form>

        {createdKey ? (
          <div className="mt-4 rounded-md border border-foreground/40 bg-secondary p-4">
            <p className="text-xs font-medium">
              New key for <span className="font-semibold">{createdKey.name}</span> — copy it now, it
              won&apos;t be shown again:
            </p>
            <div className="mt-2 flex items-center gap-2">
              <code className="flex-1 break-all rounded bg-background px-3 py-2 font-mono text-xs">
                {createdKey.key}
              </code>
              <Button
                type="button"
                variant="outline"
                onClick={() => navigator.clipboard?.writeText(createdKey.key)}
              >
                Copy
              </Button>
            </div>
          </div>
        ) : null}
      </section>

      <section className="rounded-lg border border-border">
        <div className="flex items-center justify-between border-b border-border px-5 py-3">
          <h2 className="text-sm font-semibold">Keys</h2>
          <Button type="button" variant="ghost" onClick={() => void loadKeys()} disabled={loading}>
            {loading ? "Refreshing…" : "Refresh"}
          </Button>
        </div>
        {error ? <p className="px-5 py-3 text-xs text-destructive">{error}</p> : null}
        {keys.length === 0 ? (
          <p className="px-5 py-6 text-sm text-muted-foreground">No keys yet.</p>
        ) : (
          <ul className="divide-y divide-border">
            {keys.map((row) => (
              <li key={row.id} className="flex flex-wrap items-center justify-between gap-3 px-5 py-4">
                <div className="min-w-0">
                  <p className="flex items-center gap-2 text-sm font-medium">
                    <span className="truncate">{row.name}</span>
                    {row.revoked ? (
                      <span className="rounded-sm border border-destructive px-1.5 py-0.5 text-[10px] font-semibold uppercase text-destructive">
                        Revoked
                      </span>
                    ) : (
                      <span className="rounded-sm border border-foreground/30 px-1.5 py-0.5 text-[10px] font-semibold uppercase text-muted-foreground">
                        Active
                      </span>
                    )}
                  </p>
                  <p className="mt-1 font-mono text-xs text-muted-foreground">
                    {row.prefix}…&nbsp;·&nbsp;{row.useCount} uses
                    {row.lastUsedAt ? ` · last ${new Date(row.lastUsedAt).toLocaleDateString()}` : ""}
                  </p>
                </div>
                <Button
                  type="button"
                  variant={row.revoked ? "outline" : "destructive"}
                  onClick={() => void toggleRevoke(row)}
                >
                  {row.revoked ? "Restore" : "Revoke"}
                </Button>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  )
}
