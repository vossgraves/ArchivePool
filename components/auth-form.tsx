"use client"

import Link from "next/link"
import { useRouter } from "next/navigation"
import { useState } from "react"
import { motion } from "motion/react"

/**
 * Shared M3-expressive auth form for /login and /signup. Spring enter, pill
 * primary button, inline error line. On success the header picks the session
 * up on its next /api/auth/me fetch (or immediately via router.refresh()).
 */
export function AuthForm({ mode }: { mode: "login" | "signup" }) {
  const router = useRouter()
  const [username, setUsername] = useState("")
  const [password, setPassword] = useState("")
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const isSignup = mode === "signup"

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    if (busy) return
    setBusy(true)
    setError(null)
    try {
      const res = await fetch(`/api/auth/${mode}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ username, password }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) {
        setError(data.detail ?? data.error ?? "Something went wrong.")
        return
      }
      router.push("/dashboard")
      router.refresh()
    } catch {
      setError("Network error — try again.")
    } finally {
      setBusy(false)
    }
  }

  const inputClass =
    "w-full rounded-2xl border border-input bg-input/40 px-4 py-3 text-sm outline-none transition-all placeholder:text-muted-foreground/60 focus:border-primary/60 focus:ring-2 focus:ring-primary/25"

  return (
    <motion.div
      initial={{ opacity: 0, y: 14 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ type: "spring", stiffness: 260, damping: 26 }}
      className="mx-auto w-full max-w-sm"
    >
      <div className="rounded-[1.75rem] border border-border bg-card p-7">
        <h1 className="text-balance text-2xl font-semibold tracking-tight">
          {isSignup ? "Create your account" : "Welcome back"}
        </h1>
        <p className="mt-1.5 text-pretty text-sm leading-relaxed text-muted-foreground">
          {isSignup
            ? "An account lets you request and manage API keys for the source pool."
            : "Sign in to manage your API keys."}
        </p>

        <form onSubmit={submit} className="mt-6 flex flex-col gap-4">
          <label className="flex flex-col gap-1.5">
            <span className="text-xs font-medium uppercase tracking-[0.12em] text-muted-foreground">
              Username
            </span>
            <input
              className={inputClass}
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              autoComplete="username"
              autoCapitalize="none"
              spellCheck={false}
              placeholder="e.g. record_collector"
              required
              minLength={3}
              maxLength={24}
            />
          </label>
          <label className="flex flex-col gap-1.5">
            <span className="text-xs font-medium uppercase tracking-[0.12em] text-muted-foreground">
              Password
            </span>
            <input
              className={inputClass}
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete={isSignup ? "new-password" : "current-password"}
              placeholder={isSignup ? "At least 8 characters" : "Your password"}
              required
              minLength={8}
              maxLength={128}
            />
          </label>

          {error && (
            <motion.p
              initial={{ opacity: 0, y: -4 }}
              animate={{ opacity: 1, y: 0 }}
              className="rounded-xl bg-destructive/10 px-3.5 py-2.5 text-sm text-destructive"
              role="alert"
            >
              {error}
            </motion.p>
          )}

          <motion.button
            whileTap={{ scale: 0.97 }}
            type="submit"
            disabled={busy}
            className="mt-1 w-full rounded-full bg-primary py-3 text-sm font-semibold text-primary-foreground transition-opacity hover:opacity-90 disabled:opacity-50"
          >
            {busy ? "…" : isSignup ? "Create account" : "Sign in"}
          </motion.button>
        </form>

        <p className="mt-5 text-center text-sm text-muted-foreground">
          {isSignup ? (
            <>
              Already have an account?{" "}
              <Link href="/login" className="font-medium text-primary hover:underline">
                Sign in
              </Link>
            </>
          ) : (
            <>
              Need a key?{" "}
              <Link href="/signup" className="font-medium text-primary hover:underline">
                Create an account
              </Link>
            </>
          )}
        </p>
      </div>
    </motion.div>
  )
}
