// SPDX-License-Identifier: GPL-3.0-or-later
import { redirect } from "next/navigation"
import { SiteHeader } from "@/components/site-header"
import { AuthForm } from "@/components/auth-form"
import { getSessionUserId } from "@/lib/sessions"

export const metadata = { title: "Create account" }

export default async function SignupPage() {
  if (await getSessionUserId()) redirect("/dashboard")

  // Opt-out, matching the API route.
  const signupEnabled = process.env.ALLOW_PUBLIC_SIGNUP !== "false"

  return (
    <div className="min-h-dvh">
      <SiteHeader />
      <main className="mx-auto flex max-w-5xl flex-col px-5 pb-16 pt-14 sm:pt-20">
        {signupEnabled ? (
          <AuthForm mode="signup" />
        ) : (
          <div className="mx-auto w-full max-w-sm">
            <div className="rounded-lg border border-border bg-card p-5 edge-lit">
              <h1 className="text-balance text-lg font-semibold tracking-tight">
                Registration Disabled
              </h1>
              <p className="mt-1 text-pretty text-sm leading-relaxed text-muted-foreground">
                Public account creation is currently disabled. Please contact the administrator if you need access.
              </p>
            </div>
          </div>
        )}
      </main>
    </div>
  )
}
