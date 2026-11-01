// SPDX-License-Identifier: GPL-3.0-or-later
"use client"

import Link from "next/link"
import { useRouter, useSearchParams } from "next/navigation"
import { useState } from "react"
import { Button } from "@/components/ui/button"
import { Field } from "@/components/ui/field"
import { Notice } from "@/components/ui/notice"

const ERROR_COPY: Record<string, string> = {
  github_state: "The sign-in link expired or was tampered with — start again.",
  github_exchange: "GitHub did not finish the sign-in. Try again in a moment.",
  github_unconfigured: "GitHub sign-in is not configured on this deployment.",
  account_disabled: "That account is disabled.",
  internal: "Something went wrong signing you in. Try again.",
}

/**
 * GitHub sign-in + first-sign-in completion (choose a username or claim a legacy
 * one with an API key). Rendered for every visitor; on deployments where password
 * login is disabled it is the only way in.
 */
export function GitHubAuth() {
  const router = useRouter()
  const params = useSearchParams()
  const step = params.get("github")
  const ghLogin = params.get("login") ?? ""
  const errorParam = params.get("error")

  const [username, setUsername] = useState("")
  const [apiKey, setApiKey] = useState("")
  const [error, setError] = useState<string | null>(errorParam ? (ERROR_COPY[errorParam] ?? ERROR_COPY.internal) : null)
  const [note, setNote] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [taken, setTaken] = useState(false)
  const [claimed, setClaimed] = useState(false)

  function start() {
    window.location.href = "/api/auth/github/start"
  }

  async function choose(e: React.FormEvent) {
    e.preventDefault()
    if (busy) return
    setBusy(true)
    setError(null)
    try {
      const res = await fetch("/api/auth/github/complete", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ username }),
      })
      const data = await res.json().catch(() => ({}))
      if (res.status === 409 && data.claimable) {
        setTaken(true)
        return
      }
      if (!res.ok) {
        setError(data.detail ?? data.error ?? "Could not finish sign-in. Try again.")
        return
      }
      router.push("/dashboard")
      router.refresh()
    } catch {
      setError("Network error — nothing was submitted. Try again.")
    } finally {
      setBusy(false)
    }
  }

  async function claim(withKey: boolean) {
    if (busy) return
    setBusy(true)
    setError(null)
    try {
      const res = await fetch("/api/auth/github/claim", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(withKey ? { username, apiKey } : { username }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) {
        setError(data.detail ?? data.error ?? "Claim failed. Try again.")
        return
      }
      if (data.status === "claimed") {
        router.push("/dashboard")
        router.refresh()
        return
      }
      setClaimed(true)
      setNote(data.detail ?? "Claim filed for admin review.")
    } catch {
      setError("Network error — nothing was submitted. Try again.")
    } finally {
      setBusy(false)
    }
  }

  if (step === "choose") {
    return (
      <div className="mx-auto w-full max-w-sm">
        <div className="rounded-lg border border-border bg-card p-5 edge-lit">
          <h1 className="text-balance text-lg font-semibold tracking-tight">
            {taken ? "Claim your username" : "Choose your username"}
          </h1>
          <p className="mt-1 text-pretty text-sm leading-relaxed text-muted-foreground">
            {taken
              ? `"${username}" is already registered. Prove it is yours with one of that account's existing API keys, or file a claim for admin review.`
              : `Signed in to GitHub as @${ghLogin || "…"}. Pick the username your API keys will belong to.`}
          </p>

          {claimed ? (
            <Notice tone="ok">{note}</Notice>
          ) : (
            <form onSubmit={choose} className="mt-5 flex flex-col gap-4">
              <Field
                label="Username"
                name="username"
                value={username}
                onValueChange={setUsername}
                autoComplete="username"
                required
                hint="3–24 characters: lowercase letters, digits and underscores."
                placeholder="record_collector"
                minLength={3}
                maxLength={24}
              />
              {taken ? (
                <>
                  <Field
                    label="Existing API key"
                    name="apiKey"
                    value={apiKey}
                    onValueChange={setApiKey}
                    placeholder="atp_…"
                    hint="Any key that account already issued proves it is yours — it keeps working afterwards."
                  />
                  {error ? <Notice tone="error">{error}</Notice> : null}
                  <Button type="button" size="lg" disabled={busy || apiKey.trim() === ""} onClick={() => claim(true)}>
                    {busy ? "Working…" : "Verify key & claim"}
                  </Button>
                  <Button type="button" variant="secondary" disabled={busy} onClick={() => claim(false)}>
                    No key handy — request admin review
                  </Button>
                </>
              ) : (
                <>
                  {error ? <Notice tone="error">{error}</Notice> : null}
                  <Button type="submit" size="lg" disabled={busy}>
                    {busy ? "Working…" : "Continue"}
                  </Button>
                </>
              )}
            </form>
          )}
        </div>
      </div>
    )
  }

  return (
    <div className="mx-auto w-full max-w-sm">
      <div className="rounded-lg border border-border bg-card p-5 edge-lit">
        <h1 className="text-balance text-lg font-semibold tracking-tight">Welcome back</h1>
        <p className="mt-1 text-pretty text-sm leading-relaxed text-muted-foreground">
          Sign in to manage your API keys. Legacy accounts can be claimed with an existing API key.
        </p>
        {error ? <Notice tone="error">{error}</Notice> : null}
        <Button type="button" size="lg" className="mt-5 w-full" onClick={start}>
          Sign in with GitHub
        </Button>
        <p className="mt-5 text-center text-sm text-muted-foreground">
          Need a key?{" "}
          <Link href="/dashboard" className="font-medium text-foreground underline underline-offset-4">
            Request one
          </Link>
        </p>
      </div>
    </div>
  )
}
