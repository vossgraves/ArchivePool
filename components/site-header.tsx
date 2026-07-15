import Link from "next/link"

export function SiteHeader({ active }: { active?: "status" | "submit" }) {
  return (
    <header className="border-b border-border">
      <div className="mx-auto flex max-w-5xl items-center justify-between gap-4 px-5 py-4">
        <Link href="/" className="flex items-center gap-2.5">
          <span className="flex h-7 w-7 items-center justify-center rounded-sm border border-foreground font-mono text-xs font-bold">
            AT
          </span>
          <span className="text-sm font-semibold tracking-tight">
            Source Pool
          </span>
        </Link>
        <nav className="flex items-center gap-1 text-sm">
          <Link
            href="/"
            className={`rounded-md px-3 py-1.5 transition-colors ${
              active === "status" ? "bg-secondary text-foreground" : "text-muted-foreground hover:text-foreground"
            }`}
          >
            Status
          </Link>
          <Link
            href="/submit"
            className={`rounded-md px-3 py-1.5 transition-colors ${
              active === "submit" ? "bg-secondary text-foreground" : "text-muted-foreground hover:text-foreground"
            }`}
          >
            Contribute
          </Link>
        </nav>
      </div>
    </header>
  )
}
