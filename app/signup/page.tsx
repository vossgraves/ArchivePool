// SPDX-License-Identifier: GPL-3.0-or-later
import { Suspense } from "react"
import { redirect } from "next/navigation"
import { SiteHeader } from "@/components/site-header"
import { AuthForm } from "@/components/auth-form"
import { GitHubAuth } from "@/components/github-auth"
import { webLoginDisabled } from "@/lib/cf-env"
import { getSessionUserId } from "@/lib/sessions"

export const metadata = { title: "Create account" }

// Session-dependent — never let a prerendered/cached copy serve signed-out state.
export const dynamic = "force-dynamic"

export default async function SignupPage() {
  if (await getSessionUserId()) redirect("/dashboard")

  const passwordsDisabled = webLoginDisabled()
  return (
    <div className="min-h-dvh">
      <SiteHeader />
      <main className="flex w-full flex-col px-3 pb-16 pt-10 sm:px-4 md:px-6">
        <Suspense>
          <GitHubAuth />
        </Suspense>
        {!passwordsDisabled ? (
          <div className="mx-auto w-full max-w-sm">
            <p className="text-center text-sm text-muted-foreground">or create a password account</p>
            <AuthForm mode="signup" />
          </div>
        ) : null}
      </main>
    </div>
  )
}
