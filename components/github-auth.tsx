// SPDX-License-Identifier: GPL-3.0-or-later
"use client"

import { useSearchParams } from "next/navigation"
import { useState } from "react"
import { Button } from "@/components/ui/button"
import { Notice } from "@/components/ui/notice"

const ERROR_COPY: Record<string, string> = {
  github_state: "The sign-in link expired or was tampered with — start again.",
  github_exchange: "GitHub did not finish the sign-in. Try again in a moment.",
  github_unconfigured: "GitHub sign-in is not configured on this deployment.",
  account_disabled: "That account is disabled.",
  internal: "Something went wrong signing you in. Try again.",
}

/**
 * GitHub sign-in — rendered for every visitor; on deployments where password
 * login is disabled it is the only way in. A first sign-in creates the account
 * from the GitHub login automatically; there is no username prompt anywhere.
 * Legacy (pre-GitHub) accounts are recovered from the dashboard afterwards.
 */
export function GitHubAuth() {
  const params = useSearchParams()
  const errorParam = params.get("error")
  const [error] = useState<string | null>(errorParam ? (ERROR_COPY[errorParam] ?? ERROR_COPY.internal) : null)

  function start() {
    window.location.href = "/api/auth/github/start"
  }

  return (
    <div className="mx-auto w-full max-w-sm">
      <div className="rounded-lg border border-border bg-card p-5 edge-lit">
        <h1 className="text-balance text-lg font-semibold tracking-tight">Welcome back</h1>
        <p className="mt-1 text-pretty text-sm leading-relaxed text-muted-foreground">
          Sign in to manage your API keys. Your GitHub username becomes your account name, and a
          legacy account can be recovered from the dashboard once you are in.
        </p>
        {error ? <Notice tone="error">{error}</Notice> : null}
        <Button type="button" size="lg" className="mt-5 w-full" onClick={start}>
          Sign in with GitHub
        </Button>
      </div>
    </div>
  )
}
