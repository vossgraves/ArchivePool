// SPDX-License-Identifier: GPL-3.0-or-later
"use client"

import { useRouter } from "next/navigation"
import { useState } from "react"
import { Button } from "@/components/ui/button"
import { Field } from "@/components/ui/field"
import { Notice } from "@/components/ui/notice"
import { Panel } from "@/components/ui/panel"

/**
 * "Recover a legacy account" — for accounts created before GitHub sign-in. The
 * user proves ownership of the legacy username by pasting one of that account's
 * ACTIVE API keys (its SHA-256 is matched server-side; nothing is revealed or
 * stored). On proof every per-user row — api_keys (same hashes, so apps keep
 * working) and api_key_requests — moves to the signed-in account and the legacy
 * row is marked claimed. Without a key, GitHub-linked accounts can file the
 * claim for admin review instead.
 */
export function DashboardLegacyRecovery() {
  const router = useRouter()
  const [username, setUsername] = useState("")
  const [apiKey, setApiKey] = useState("")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [note, setNote] = useState<string | null>(null)

  async function submit(withKey: boolean) {
    if (busy) return
    setBusy(true)
    setError(null)
    setNote(null)
    try {
      const res = await fetch("/api/auth/claim-legacy", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(withKey ? { username, apiKey } : { username }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) {
        setError(data.detail ?? data.error ?? "Could not recover that account.")
        return
      }
      setNote(data.detail ?? "Done.")
      setUsername("")
      setApiKey("")
      if (data.status === "claimed") router.refresh()
    } catch {
      setError("Network error — nothing was submitted. Try again.")
    } finally {
      setBusy(false)
    }
  }

  function onSubmit(e: React.FormEvent) {
    e.preventDefault()
    void submit(apiKey.trim().length > 0)
  }

  return (
    <Panel
      label="Recover a legacy account"
      description="Made an account before GitHub sign-in existed? Prove the old username is yours with one of its API keys — every key and request it held moves to this account and keeps working unchanged. No key handy: GitHub-linked accounts can file for admin review."
      bodyClassName="flex flex-col gap-3"
      className="scroll-mt-20"
    >
      <form onSubmit={onSubmit} className="flex flex-col gap-3">
        <div className="grid gap-3 sm:grid-cols-2">
          <Field
            label="Legacy username"
            name="legacyUsername"
            value={username}
            onValueChange={setUsername}
            autoComplete="off"
            required
            placeholder="record_collector"
            minLength={3}
            maxLength={24}
          />
          <Field
            label="API key from that account"
            name="legacyApiKey"
            value={apiKey}
            onValueChange={setApiKey}
            autoComplete="off"
            placeholder="atp_…"
            hint="Any active key the old account issued proves it is yours — the key itself keeps working afterwards."
          />
        </div>
        {error ? <Notice tone="error">{error}</Notice> : null}
        {note ? <Notice tone="ok">{note}</Notice> : null}
        <div className="flex flex-wrap justify-end gap-2">
          <Button
            type="button"
            variant="secondary"
            disabled={busy || username.trim() === ""}
            onClick={() => void submit(false)}
          >
            {busy ? "Working…" : "No key — request admin review"}
          </Button>
          <Button type="submit" disabled={busy || username.trim() === "" || apiKey.trim() === ""}>
            {busy ? "Working…" : "Verify key & recover"}
          </Button>
        </div>
      </form>
    </Panel>
  )
}
