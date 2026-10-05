// SPDX-License-Identifier: GPL-3.0-or-later
"use client"

import { useCallback, useState, type KeyboardEvent } from "react"
import { submitSource } from "@/app/actions/submit"

type Phase = "idle" | "submitting" | "needs_secret" | "success" | "error"

interface NeedsSecretData {
  userAuthToken: string
  appId: string
  userId: string
  countryCode?: string
}

// This component renders inside SubmitForm's <form>, where a nested <form> is invalid and dropped
// by the browser. Enter is handled here instead: left alone it would implicitly submit that outer
// form, half-filled. IME composition keeps its own Enter.
function onEnter(run: () => void) {
  return (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key !== "Enter" || e.nativeEvent.isComposing) return
    e.preventDefault()
    run()
  }
}

export function QobuzConnect() {
  const [phase, setPhase] = useState<Phase>("idle")
  const [email, setEmail] = useState("")
  const [password, setPassword] = useState("")
  const [message, setMessage] = useState("")
  const [secretData, setSecretData] = useState<NeedsSecretData | null>(null)

  // Fallback: manual secret entry when bundle scraping fails.
  const [manualSecret, setManualSecret] = useState("")
  const [manualSubmitting, setManualSubmitting] = useState(false)

  const submit = useCallback(async () => {
    if (phase === "submitting") return
    // The inputs carry no native constraints (they would gate SubmitForm's own submit), so the
    // check lives here.
    if (!email.trim() || !password) {
      setPhase("error")
      setMessage("Enter your Qobuz email and password.")
      return
    }
    setPhase("submitting")
    setMessage("")
    try {
      const res = await fetch("/api/qobuz/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ username: email.trim(), password }),
      })
      const data = await res.json()

      if (data.state === "authorized") {
        setPhase("success")
        setMessage(
          data.ok
            ? data.premium
              ? "Signed in. Your Qobuz account was verified and added to the pool as a premium source. Thank you!"
              : "Signed in and added to the pool. The account works but lossless quality was not confirmed."
            : `Signed in, but the live check failed (${data.detail}). It will be retried automatically.`,
        )
      } else if (data.state === "needs_secret") {
        // Login worked but bundle scrape failed — ask for the secret manually.
        setSecretData({
          userAuthToken: data.userAuthToken,
          appId: data.appId,
          userId: data.userId,
          countryCode: data.countryCode,
        })
        setPhase("needs_secret")
        setMessage(data.detail ?? "")
      } else {
        setPhase("error")
        setMessage(data.detail || "Login failed. Check your email and password.")
      }
    } catch {
      setPhase("error")
      setMessage("Could not reach the server. Try again.")
    }
  }, [phase, email, password])

  const submitWithSecret = useCallback(async () => {
    if (!secretData || !manualSecret.trim() || manualSubmitting) return
    setManualSubmitting(true)
    try {
      const formData = new FormData()
      formData.set("service", "qobuz")
      formData.set("kind", "account")
      formData.set("token", secretData.userAuthToken)
      formData.set("appId", secretData.appId)
      formData.set("appSecret", manualSecret.trim())
      formData.set("username", secretData.userId)
      if (secretData.countryCode) formData.set("countryCode", secretData.countryCode)
      formData.set("note", "Added via Qobuz sign-in (manual secret)")

      // The contribution form's own server action: the one submit path the Next deployment
      // serves (/api/submit exists only on the Go port).
      const data = await submitSource({ ok: false, message: "" }, formData)
      if (data.ok) {
        setPhase("success")
        setMessage(data.message || "Added to the pool.")
      } else {
        setMessage(data.message || "Failed to add. Check the app_secret.")
      }
    } catch {
      setMessage("Could not reach the server. Try again.")
    } finally {
      setManualSubmitting(false)
    }
  }, [secretData, manualSecret, manualSubmitting])

  const reset = useCallback(() => {
    setPhase("idle")
    setMessage("")
    setPassword("")
    setSecretData(null)
    setManualSecret("")
  }, [])

  return (
    <div className="flex flex-col gap-4 rounded-md border border-border bg-card p-4">
      <div className="flex flex-col gap-1">
        <span className="text-sm font-medium">Sign in with Qobuz</span>
        <span className="text-xs text-muted-foreground leading-relaxed">
          We sign in directly with Qobuz&apos;s API. Your email and password are kept encrypted so
          the pool can sign in again and renew this account for you — a Qobuz session token cannot
          refresh itself, so without them the account would die and need re-submitting.
        </span>
      </div>

      {phase === "idle" || phase === "submitting" || phase === "error" ? (
        <div className="flex flex-col gap-3">
          {/* No `required` and no type="email" here: these inputs sit inside SubmitForm's <form>,
              so either constraint joins that form's native validation and blocks "Verify &
              contribute" for someone using the manual-paste path with these left blank.
              submit() checks them itself. */}
          <label className="flex flex-col gap-1.5">
            <span className="text-sm font-medium">Email</span>
            <input
              type="text"
              inputMode="email"
              autoComplete="email"
              autoCapitalize="none"
              spellCheck={false}
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              onKeyDown={onEnter(submit)}
              placeholder="you@example.com"
              className="rounded-md border border-input bg-background px-3 py-2 text-sm outline-none ring-ring focus:ring-2"
            />
          </label>
          <label className="flex flex-col gap-1.5">
            <span className="text-sm font-medium">Password</span>
            <input
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              onKeyDown={onEnter(submit)}
              placeholder="Your Qobuz password"
              className="rounded-md border border-input bg-background px-3 py-2 text-sm outline-none ring-ring focus:ring-2"
            />
          </label>
          <button
            type="button"
            onClick={submit}
            disabled={phase === "submitting"}
            className="self-start rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-opacity hover:opacity-90 disabled:opacity-50"
          >
            {phase === "submitting" ? "Signing in…" : phase === "error" ? "Try again" : "Sign in with Qobuz"}
          </button>
          {message && (
            <p className="text-sm text-destructive leading-relaxed">{message}</p>
          )}
        </div>
      ) : phase === "needs_secret" ? (
        <div className="flex flex-col gap-3">
          <p className="text-xs text-muted-foreground leading-relaxed">{message}</p>
          <label className="flex flex-col gap-1.5">
            <span className="text-sm font-medium">App Secret</span>
            <input
              type="text"
              value={manualSecret}
              onChange={(e) => setManualSecret(e.target.value)}
              onKeyDown={onEnter(submitWithSecret)}
              placeholder="32-char hex string"
              className="rounded-md border border-input bg-background px-3 py-2 font-mono text-sm outline-none ring-ring focus:ring-2"
            />
            <span className="text-xs text-muted-foreground">
              Find it in the Qobuz web player JS bundle (usually a 32-char lowercase hex string).
            </span>
          </label>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={submitWithSecret}
              disabled={manualSubmitting || !manualSecret.trim()}
              className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-opacity hover:opacity-90 disabled:opacity-50"
            >
              {manualSubmitting ? "Adding…" : "Add to pool"}
            </button>
            <button
              type="button"
              onClick={reset}
              className="rounded-md border border-border px-4 py-2 text-sm font-medium text-muted-foreground transition-colors hover:text-foreground"
            >
              Cancel
            </button>
          </div>
        </div>
      ) : (
        /* success */
        <div className="flex flex-col gap-3">
          <div className="flex items-center gap-2">
            <span className="h-2 w-2 rounded-full bg-primary" aria-hidden />
            <span className="text-sm text-muted-foreground">Added to pool</span>
          </div>
          <p className="text-sm leading-relaxed">{message}</p>
          <button
            type="button"
            onClick={reset}
            className="self-start rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-opacity hover:opacity-90"
          >
            Sign in another account
          </button>
        </div>
      )}
    </div>
  )
}
