// SPDX-License-Identifier: GPL-3.0-or-later
import { Suspense } from "react"
import { redirect } from "next/navigation"
import { SiteHeader } from "@/components/site-header"
import { AuthForm } from "@/components/auth-form"
import { GitHubAuth } from "@/components/github-auth"
import { webLoginDisabled } from "@/lib/cf-env"
import { getSessionUserId } from "@/lib/sessions"

export const metadata = { title: "Sign in" }

// Session-dependent — never let a prerendered/cached copy serve signed-out state.
export const dynamic = "force-dynamic"

export default async function LoginPage() {
  if (await getSessionUserId()) redirect("/dashboard")

  const passwordsDisabled = webLoginDisabled()
  return (
    <div className="min-h-dvh">
      <SiteHeader />
      <main className="mx-auto flex max-w-5xl flex-col gap-6 px-5 pb-16 pt-14 sm:pt-20">
        <Suspense>
          <GitHubAuth />
        </Suspense>
        {!passwordsDisabled ? (
          <div className="mx-auto w-full max-w-sm">
            <p className="text-center text-sm text-muted-foreground">or sign in with your password</p>
            <AuthForm mode="login" />
          </div>
        ) : null}
      </main>
    </div>
  )
}
