// SPDX-License-Identifier: GPL-3.0-or-later
"use client"

import Link from "next/link"
import { useRouter } from "next/navigation"
import { useState } from "react"
import { motion, useReducedMotion } from "motion/react"
import { Button } from "@/components/ui/button"
import { Field } from "@/components/ui/field"
import { Notice } from "@/components/ui/notice"

/**
 * Shared auth form for /login and /signup.
 *
 * On success the header picks the session up on its next /api/auth/me fetch (or immediately via
 * router.refresh()). Failures come back from the route as `detail`/`error` and are rendered
 * against the form rather than as a generic "something went wrong", because the common causes
 * (taken username, weak password, wrong credentials) need different fixes.
 */
export function AuthForm({ mode }: { mode: "login" | "signup" }) {
  const router = useRouter()
  const reduce = useReducedMotion()
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
        setError(data.detail ?? data.error ?? "Could not sign you in. Check the details and retry.")
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

  return (
    <motion.div
      {...(reduce
        ? {}
        : {
            initial: { opacity: 0, y: 10 },
            animate: { opacity: 1, y: 0 },
            transition: { type: "spring" as const, stiffness: 260, damping: 26 },
          })}
      className="mx-auto w-full max-w-sm"
    >
      <div className="rounded-lg border border-border bg-card p-5 edge-lit">
        <h1 className="text-balance text-lg font-semibold tracking-tight">
          {isSignup ? "Create your account" : "Welcome back"}
        </h1>
        <p className="mt-1 text-pretty text-sm leading-relaxed text-muted-foreground">
          {isSignup
            ? "An account lets you request and manage API keys for the source pool."
            : "Sign in to manage your API keys."}
        </p>

        <form onSubmit={submit} className="mt-5 flex flex-col gap-4">
          <Field
            label="Username"
            name="username"
            value={username}
            onValueChange={setUsername}
            autoComplete="username"
            required
            hint={isSignup ? "3–24 characters: lowercase letters, digits and underscores." : undefined}
            placeholder="record_collector"
            minLength={3}
            maxLength={24}
          />
          <Field
            label="Password"
            name="password"
            type="password"
            value={password}
            onValueChange={setPassword}
            autoComplete={isSignup ? "new-password" : "current-password"}
            required
            placeholder={isSignup ? "At least 8 characters" : "Your password"}
            mono={false}
            minLength={8}
            maxLength={128}
          />

          {error ? <Notice tone="error">{error}</Notice> : null}

          <Button type="submit" size="lg" disabled={busy}>
            {busy ? "Working…" : isSignup ? "Create account" : "Sign in"}
          </Button>
        </form>

        <p className="mt-5 text-center text-sm text-muted-foreground">
          {isSignup ? (
            <>
              Already have an account?{" "}
              <Link href="/login" className="font-medium text-foreground underline underline-offset-4">
                Sign in
              </Link>
            </>
          ) : (
            <>
              Need a key?{" "}
              <Link href="/signup" className="font-medium text-foreground underline underline-offset-4">
                Create an account
              </Link>
            </>
          )}
        </p>
      </div>
    </motion.div>
  )
}
