"use client"

import { useCallback, useState } from "react"

type Phase = "idle" | "submitting" | "needs_secret" | "success" | "error"

interface NeedsSecretData {
  userAuthToken: string
  appId: string
  userId: string
  countryCode?: string
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

  const submit = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault()
      setPhase("submitting")
      setMessage("")
      try {
        const res = await fetch("/api/qobuz/login", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ username: email, password }),
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
    },
    [email, password],
  )

  const submitWithSecret = useCallback(async () => {
    if (!secretData || !manualSecret.trim()) return
    setManualSubmitting(true)
    try {
      const res = await fetch("/app/actions/submit", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          service: "qobuz",
          kind: "account",
          token: secretData.userAuthToken,
          appId: secretData.appId,
          appSecret: manualSecret.trim(),
          username: secretData.userId,
          countryCode: secretData.countryCode,
          note: "Added via Qobuz sign-in (manual secret)",
        }),
      })
      const data = await res.json()
      if (data.ok || data.saved) {
        setPhase("success")
        setMessage("Account added to the pool. Thank you!")
      } else {
        setMessage(data.detail || "Could not save. Try again.")
      }
    } catch {
      setMessage("Could not reach the server. Try again.")
    } finally {
      setManualSubmitting(false)
    }
  }, [secretData, manualSecret])

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
          We sign in directly with Qobuz&apos;s API — your password is sent only to Qobuz, never
          stored here. The session token is what gets added to the pool.
        </span>
      </div>

      {phase === "idle" || phase === "submitting" || phase === "error" ? (
        <form onSubmit={submit} className="flex flex-col gap-3">
          <label className="flex flex-col gap-1.5">
            <span className="text-sm font-medium">Email</span>
            <input
              type="email"
              autoComplete="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="you@example.com"
              className="rounded-md border border-input bg-background px-3 py-2 text-sm outline-none ring-ring focus:ring-2"
            />
          </label>
          <label className="flex flex-col gap-1.5">
            <span className="text-sm font-medium">Password</span>
            <input
              type="password"
              autoComplete="current-password"
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="Your Qobuz password"
              className="rounded-md border border-input bg-background px-3 py-2 text-sm outline-none ring-ring focus:ring-2"
            />
          </label>
          <button
            type="submit"
            disabled={phase === "submitting"}
            className="self-start rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-opacity hover:opacity-90 disabled:opacity-50"
          >
            {phase === "submitting" ? "Signing in…" : phase === "error" ? "Try again" : "Sign in with Qobuz"}
          </button>
          {message && (
            <p className="text-sm text-destructive leading-relaxed">{message}</p>
          )}
        </form>
      ) : phase === "needs_secret" ? (
        <div className="flex flex-col gap-3">
          <p className="text-xs text-muted-foreground leading-relaxed">{message}</p>
          <label className="flex flex-col gap-1.5">
            <span className="text-sm font-medium">App Secret</span>
            <input
              type="text"
              value={manualSecret}
              onChange={(e) => setManualSecret(e.target.value)}
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
