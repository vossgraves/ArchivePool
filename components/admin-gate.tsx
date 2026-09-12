"use client"

import { useEffect, useState } from "react"
import { Lock } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Panel } from "@/components/ui/panel"
import { Field } from "@/components/ui/field"
import { AdminKeys } from "@/components/admin-keys"
import { AdminRequests } from "@/components/admin-requests"
import { AdminSources } from "@/components/admin-sources"
import { AdminUsers } from "@/components/admin-users"
import { AdminAudit } from "@/components/admin-audit"

/**
 * Single unlock prompt for the whole admin page.
 *
 * Every panel here reads the same session token, so gating once at the top avoids rendering two
 * identical token forms for one credential (which is what the key and source panels used to do).
 */
export function AdminGate() {
  const [token, setToken] = useState("")
  const [authed, setAuthed] = useState(false)
  const [checking, setChecking] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [ready, setReady] = useState(false)

  useEffect(() => {
    // Read before painting so a refresh does not flash the unlock form.
    if (sessionStorage.getItem("adminToken")) setAuthed(true)
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
        setError("That token was rejected. Check it was copied in full.")
        return
      }
      if (!res.ok) {
        setError(`Server answered ${res.status} — the panel stays locked until the request succeeds.`)
        return
      }
      sessionStorage.setItem("adminToken", token)
      setAuthed(true)
    } catch {
      setError("Network error — could not reach the server.")
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
      <Panel
        label="Admin access"
        description="Everything on this page mutates live pool data. The token is never sent to the browser by the server — it stores only a SHA-256 hash, so it cannot be recovered if you lose it."
        className="max-w-md"
      >
        <form onSubmit={unlock} className="flex flex-col gap-4">
          <Field
            label="Admin token"
            name="admin-token"
            type="password"
            value={token}
            onValueChange={setToken}
            placeholder="Bearer token"
            autoComplete="off"
            error={error}
          />
          <Button type="submit" size="lg" disabled={!token || checking}>
            {checking ? "Checking…" : "Unlock"}
          </Button>
        </form>
      </Panel>
    )
  }

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-center justify-between gap-3">
        <p className="label-mono flex items-center gap-2">
          <Lock className="size-3" aria-hidden="true" />
          Unlocked
        </p>
        <Button variant="outline" size="sm" onClick={lock}>
          Lock
        </Button>
      </div>
      <div id="admin-requests">
        <AdminRequests />
      </div>
      <AdminKeys />
      <AdminUsers />
      <AdminSources />
      <AdminAudit />
    </div>
  )
}
