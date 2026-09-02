import type { Metadata } from "next"
import Link from "next/link"
import { ArrowLeft } from "lucide-react"
import { db } from "@/lib/db"
import { users } from "@/lib/db/schema"
import { eq } from "drizzle-orm"
import { getSessionUserId } from "@/lib/sessions"
import { SiteHeader } from "@/components/site-header"
import { SubmitForm } from "@/components/submit-form"

export const metadata: Metadata = {
  // The suffix comes from the title template in app/layout.tsx.
  title: "Contribute a source",
}

export default async function SubmitPage() {
  // The session only decides whether the "credit me" option is offered, so a failed lookup must
  // not take the form down: fall through to the anonymous presentation instead.
  let username: string | null = null
  try {
    const userId = await getSessionUserId()
    if (userId) {
      const [account] = await db
        .select({ username: users.username })
        .from(users)
        .where(eq(users.id, userId))
        .limit(1)
      username = account?.username ?? null
    }
  } catch (err) {
    console.error("[submit] session lookup failed:", err)
  }

  return (
    <div className="min-h-dvh">
      <SiteHeader active="submit" />

      <main id="content" className="mx-auto max-w-2xl px-4 pb-16 pt-8">
        <div className="mb-8 flex flex-col gap-3">
          <Link
            href="/"
            className="label-mono inline-flex w-fit items-center gap-1.5 transition-colors hover:text-foreground"
          >
            <ArrowLeft className="size-3.5" aria-hidden="true" />
            Status
          </Link>
          <h1 className="text-2xl font-semibold tracking-tight text-balance sm:text-3xl">
            Contribute a source
          </h1>
          <p className="max-w-[62ch] text-sm leading-relaxed text-muted-foreground text-pretty">
            Your entry is checked live before it is stored, then re-checked on a schedule. Only
            working, premium sources are accepted; dead ones are auto-disabled and eventually
            removed. {username ? `Signed in as @${username}.` : ""}
          </p>
        </div>

        <SubmitForm username={username} />

        {/* A genuine warning earns the warn signal colour — a left rule rather than a dashed box,
            which reads as an empty placeholder. */}
        <aside className="mt-8 rounded-r-md border-l-2 border-warn bg-card py-3 pl-4 pr-4 text-sm leading-relaxed">
          <p className="font-medium text-warn">A note on sharing accounts</p>
          <p className="mt-1 max-w-[62ch] text-muted-foreground text-pretty">
            Shared credentials are pooled and used by many people, so they may be rate-limited or
            expire. Never submit an account you rely on personally.
          </p>
        </aside>
      </main>
    </div>
  )
}
