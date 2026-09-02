import { cn } from "@/lib/utils"

/**
 * One page header for every screen.
 *
 * Each page used to compose its own (mono eyebrow on the home page, plain h1 on /admin, a spring
 * card on /login, sizes from text-2xl to text-[2rem]), which is a large part of why the app
 * looked like four unrelated sites. `eyebrow` is the mono label; the h1 stays the page's only
 * level-one heading.
 */
export function PageHeader({
  eyebrow,
  title,
  description,
  actions,
  className,
}: {
  eyebrow?: string
  title: string
  description?: string
  actions?: React.ReactNode
  className?: string
}) {
  return (
    <header
      className={cn("mb-8 flex flex-wrap items-end justify-between gap-4", className)}
    >
      <div className="min-w-0 max-w-[70ch]">
        {eyebrow ? <p className="label-mono">{eyebrow}</p> : null}
        <h1
          className={cn(
            "mt-2 text-2xl font-semibold tracking-tight text-balance",
            eyebrow && "mt-0",
          )}
        >
          {title}
        </h1>
        {description ? (
          <p className="mt-1.5 text-sm leading-relaxed text-muted-foreground text-pretty">
            {description}
          </p>
        ) : null}
      </div>
      {actions ? <div className="flex shrink-0 items-center gap-2">{actions}</div> : null}
    </header>
  )
}
