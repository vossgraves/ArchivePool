// SPDX-License-Identifier: GPL-3.0-or-later
import { cn } from "@/lib/utils"

/**
 * One section of a page: hairline-bordered surface, mono eyebrow label, optional right-aligned
 * actions, and a body that owns its own spacing.
 *
 * Every panel in the app used to re-derive this (rounded-xl vs rounded-[1.75rem], heading sizes
 * from text-sm to text-lg, borders on or off), which is most of why the pages looked unrelated.
 * Title goes in `label` as a short mono eyebrow; a longer sentence belongs in `description`.
 */
export function Panel({
  label,
  description,
  actions,
  children,
  className,
  bodyClassName,
  as: Tag = "section",
}: {
  label?: string
  description?: string
  actions?: React.ReactNode
  children: React.ReactNode
  className?: string
  bodyClassName?: string
  as?: "section" | "div"
}) {
  return (
    <Tag className={cn("rounded-lg border border-border bg-card", className)}>
      {label || actions ? (
        <header className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-4 py-3">
          <div className="min-w-0">
            {label ? <h2 className="label-mono">{label}</h2> : null}
            {description ? (
              <p className="mt-1.5 max-w-[70ch] text-xs leading-relaxed text-muted-foreground text-pretty">
                {description}
              </p>
            ) : null}
          </div>
          {actions ? <div className="flex shrink-0 items-center gap-2">{actions}</div> : null}
        </header>
      ) : null}
      <div className={cn("p-4", bodyClassName)}>{children}</div>
    </Tag>
  )
}
