// SPDX-License-Identifier: GPL-3.0-or-later
import { cn } from "@/lib/utils"
import { DatabaseZap } from "lucide-react"

/**
 * Empty state component.
 * Features a refined technical icon enclosure, clear typographic hierarchy,
 * and high-intent action slot.
 */
export function Empty({
  title,
  children,
  action,
  icon,
  className,
}: {
  title?: string
  children: React.ReactNode
  action?: React.ReactNode
  icon?: React.ReactNode
  className?: string
}) {
  return (
    <div
      className={cn(
        "flex flex-col items-center justify-center gap-3.5 rounded-lg border border-border/80 bg-secondary/20 px-6 py-10 text-center transition-all",
        className,
      )}
    >
      <div className="flex size-10 shrink-0 items-center justify-center rounded-md border border-border bg-background/80 shadow-2xs text-muted-foreground">
        {icon ?? <DatabaseZap className="size-4.5 stroke-[1.75]" aria-hidden="true" />}
      </div>
      <div className="flex flex-col items-center gap-1">
        {title && (
          <h4 className="text-sm font-semibold tracking-tight text-foreground">
            {title}
          </h4>
        )}
        <p className="max-w-[48ch] text-xs leading-relaxed text-muted-foreground text-pretty">
          {children}
        </p>
      </div>
      {action && <div className="mt-1">{action}</div>}
    </div>
  )
}
