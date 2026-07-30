import Link from "next/link"

const NAV = [
  { href: "/", label: "Status", key: "status" as const },
  { href: "/submit", label: "Contribute", key: "submit" as const },
]

export function SiteHeader({ active }: { active?: "status" | "submit" }) {
  return (
    // Sticky so the nav stays reachable while scrolling a long board. The translucent surface
    // needs its own background fallback: backdrop-filter silently does nothing in some browsers,
    // and without it the header would render transparent over scrolling content.
    <header className="sticky top-0 z-40 border-b border-border bg-background/80 backdrop-blur-md">
      <div className="mx-auto flex max-w-5xl items-center justify-between gap-4 px-5 py-3.5">
        <Link
          href="/"
          className="group flex items-center gap-2.5 rounded-md transition-opacity hover:opacity-80"
        >
          <span className="flex h-7 w-7 items-center justify-center rounded-[7px] border border-border bg-secondary font-mono text-[0.7rem] font-semibold tracking-tight edge-lit">
            AT
          </span>
          <span className="flex flex-col leading-none">
            <span className="text-sm font-semibold tracking-tight">Source Pool</span>
            <span className="mt-0.5 font-mono text-[0.65rem] uppercase tracking-[0.14em] text-muted-foreground">
              ArchiveTune
            </span>
          </span>
        </Link>

        <nav aria-label="Primary" className="flex items-center gap-1 text-sm">
          {NAV.map((item) => {
            const isActive = active === item.key
            return (
              <Link
                key={item.href}
                href={item.href}
                // aria-current tells assistive tech which page is open; the colour change alone
                // does not convey that.
                aria-current={isActive ? "page" : undefined}
                className={`rounded-md px-3 py-1.5 transition-colors duration-200 ${
                  isActive
                    ? "bg-secondary font-medium text-foreground"
                    : "text-muted-foreground hover:bg-secondary/50 hover:text-foreground"
                }`}
              >
                {item.label}
              </Link>
            )
          })}
        </nav>
      </div>
    </header>
  )
}
