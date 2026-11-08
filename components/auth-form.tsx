// SPDX-License-Identifier: GPL-3.0-or-later
"use client"

import Link from "next/link"
import { useRouter } from "next/navigation"
import { useState } from "react"
import { motion, useReducedMotion } from "motion/react"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card"
import { Field } from "@/components/ui/field"
import { Notice } from "@/components/ui/notice"

/**
 * Shared auth form for /login and /signup.
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
      <Card className="border-border bg-card shadow-2xs">
        <CardHeader className="p-5 pb-2">
          <CardTitle className="text-balance text-lg font-semibold tracking-tight text-foreground">
            {isSignup ? "Create your account" : "Welcome back"}
          </CardTitle>
          <CardDescription className="text-pretty text-xs leading-relaxed text-muted-foreground">
            {isSignup
              ? "An account lets you request and manage API keys for the streaming source pool."
              : "Sign in to manage your active API keys and view pool leases."}
          </CardDescription>
        </CardHeader>

        <CardContent className="p-5 pt-3">
          <form onSubmit={submit} className="flex flex-col gap-4">
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

            <Button type="submit" size="lg" disabled={busy} className="mt-1 font-mono text-xs">
              {busy ? "Authenticating…" : isSignup ? "Create Account" : "Sign In"}
            </Button>
          </form>
        </CardContent>

        <CardFooter className="justify-center border-t border-border/70 p-4 bg-secondary/10">
          <p className="text-center text-xs text-muted-foreground">
            {isSignup ? (
              <>
                Already have an account?{" "}
                <Link href="/login" className="font-semibold text-foreground underline underline-offset-4">
                  Sign in
                </Link>
              </>
            ) : (
              <>
                Need a key?{" "}
                <Link href="/signup" className="font-semibold text-foreground underline underline-offset-4">
                  Create an account
                </Link>
              </>
            )}
          </p>
        </CardFooter>
      </Card>
    </motion.div>
  )
}
