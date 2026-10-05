// SPDX-License-Identifier: GPL-3.0-or-later
import { cn } from "@/lib/utils"

/**
 * The "nothing here yet" box. Five panels drew their own version of this with different padding,
 * text sizes and borders; an empty list is a state of the design system, not of each panel.
 *
 * Dashed rather than solid on purpose: a solid-bordered box reads as a real surface holding
 * nothing, which is how an empty pool got mistaken for a failed fetch.
 */
export function Empty({
  children,
  action,
  className,
}: {
  children: React.ReactNode
  action?: React.ReactNode
  className?: string
}) {
  return (
    <div
      className={cn(
        "flex flex-col items-center gap-3 rounded-md border border-dashed border-border px-4 py-8 text-center",
        className,
      )}
    >
      <p className="max-w-[52ch] text-sm leading-relaxed text-muted-foreground text-pretty">
        {children}
      </p>
      {action}
    </div>
  )
}
