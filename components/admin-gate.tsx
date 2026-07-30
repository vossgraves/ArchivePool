"use client"

import { useEffect, useState } from "react"
import { Button } from "@/components/ui/button"
import { AdminKeys } from "@/components/admin-keys"
import { AdminSources } from "@/components/admin-sources"

/**
 * Single unlock prompt for the whole admin page. Both panels read the same session token, so
 * gating here avoids rendering two identical token forms for one credential.
 */
export function AdminGate() {
  const [token, setToken] = useState("")
  const [authed, setAuthed] = useState(false)
  const [checking, setChecking] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [ready, setReady] = useState(false)

  useEffect(() => {
    if (sessionStorage.getItem("adminToken")) setAuthed(true)
    // Avoid flashing the unlock form before sessionStorage has been read.
    setReady(true)
  }, [])

  async function unlock(e: React.FormEvent) {
    e.preventDefault()
    setChecking(true)
    setError(null)
    try {
      // Verify before storing, so an invalid token never reaches the child panels.
      const res = await fetch("/api/admin/keys", { headers: { authorization: `Bearer ${token}` } })
      if (res.status === 401) {
        setError("Invalid admin token.")
        return
      }
      if (!res.ok) throw new Error(`request failed (${res.status})`)
      sessionStorage.setItem("adminToken", token)
      setAuthed(true)
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not verify token.")
    } finally {
      setChecking(false)
    }
  }

  function lock() {
    sessionStorage.removeItem("adminToken")
    setToken("")
    setAuthed(false)
  }

  if (!ready) return null

  if (!authed) {
    return (
      <form onSubmit={unlock} className="max-w-md rounded-lg border border-border p-5">
        <label htmlFor="admin-token" className="block text-sm font-medium">
          Admin token
        </label>
        <p className="mb-3 mt-1 text-xs leading-relaxed text-muted-foreground">
          The server stores only its SHA-256 hash (ADMIN_TOKEN_HASH), so keep this value somewhere
          safe &mdash; it cannot be recovered from the environment.
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
        <Button type="submit" className="mt-4" disabled={!token || checking}>
          {checking ? "Checking…" : "Unlock"}
        </Button>
      </form>
    )
  }

  return (
    <div className="flex flex-col gap-8">
      <div className="flex justify-end">
        <Button type="button" variant="outline" size="sm" onClick={lock}>
          Lock
        </Button>
      </div>
      <AdminSources />
      <AdminKeys />
    </div>
  )
}
