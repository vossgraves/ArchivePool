import { redirect } from "next/navigation"
import { SiteHeader } from "@/components/site-header"
import { AuthForm } from "@/components/auth-form"
import { getSessionUserId } from "@/lib/sessions"

export const metadata = { title: "Sign in" }

export default async function LoginPage() {
  if (await getSessionUserId()) redirect("/dashboard")

  return (
    <div className="min-h-dvh">
      <SiteHeader />
      <main className="mx-auto flex max-w-5xl flex-col px-5 pb-16 pt-14 sm:pt-20">
        <AuthForm mode="login" />
      </main>
    </div>
  )
}
