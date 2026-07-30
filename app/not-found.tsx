import Link from "next/link"
import { SiteHeader } from "@/components/site-header"

export const metadata = {
  title: "Page not found",
}

export default function NotFound() {
  return (
    <div className="min-h-dvh">
      <SiteHeader />

      <main id="content" className="mx-auto flex max-w-5xl flex-col gap-6 px-5 pb-16 pt-16 sm:pt-24">
        <span className="font-mono text-xs uppercase tracking-[0.16em] text-muted-foreground">
          Error 404
        </span>
        <h1 className="max-w-2xl text-pretty text-[2rem] font-semibold leading-[1.1] tracking-[-0.03em] sm:text-4xl">
          That page doesn&apos;t exist
        </h1>
        <p className="max-w-[56ch] text-pretty leading-relaxed text-muted-foreground">
          The link may be out of date, or the page may have moved. The status board has everything
          public about the pool.
        </p>
        {/* Every dead end needs a way back, and the two routes below are the only public ones. */}
        <div className="mt-2 flex flex-wrap gap-2.5">
          <Link
            href="/"
            className="rounded-md bg-primary px-4 py-2.5 text-sm font-medium text-primary-foreground transition-all duration-200 hover:opacity-90 active:scale-[0.98]"
          >
            View status
          </Link>
          <Link
            href="/submit"
            className="rounded-md border border-border bg-card px-4 py-2.5 text-sm font-medium transition-colors duration-200 hover:bg-secondary"
          >
            Contribute a source
          </Link>
        </div>
      </main>
    </div>
  )
}
