// SPDX-License-Identifier: GPL-3.0-or-later
import * as React from "react"
import { cn } from "@/lib/utils"

function Frame({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="frame"
      className={cn(
        "relative flex flex-col overflow-hidden rounded-lg border border-border bg-card text-card-foreground shadow-2xs",
        className
      )}
      {...props}
    />
  )
}

function FrameHeader({
  className,
  children,
  dots = true,
  ...props
}: React.ComponentProps<"div"> & { dots?: boolean }) {
  return (
    <div
      data-slot="frame-header"
      className={cn(
        "flex items-center justify-between border-b border-border/80 bg-secondary/40 px-3.5 py-2.5",
        className
      )}
      {...props}
    >
      <div className="flex items-center gap-2.5">
        {dots && (
          <div className="flex items-center gap-1.5" aria-hidden="true">
            <span className="size-2 rounded-full bg-border" />
            <span className="size-2 rounded-full bg-border" />
            <span className="size-2 rounded-full bg-border" />
          </div>
        )}
        {children}
      </div>
    </div>
  )
}

function FrameTitle({ className, ...props }: React.ComponentProps<"span">) {
  return (
    <span
      data-slot="frame-title"
      className={cn("font-mono text-xs font-semibold tracking-tight text-foreground", className)}
      {...props}
    />
  )
}

function FrameDescription({ className, ...props }: React.ComponentProps<"span">) {
  return (
    <span
      data-slot="frame-description"
      className={cn("font-mono text-[11px] text-muted-foreground", className)}
      {...props}
    />
  )
}

function FramePanel({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="frame-panel"
      className={cn("p-4 sm:p-5 text-xs font-mono", className)}
      {...props}
    />
  )
}

function FrameFooter({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="frame-footer"
      className={cn("flex items-center justify-between border-t border-border/80 bg-secondary/20 px-3.5 py-2 text-[11px] font-mono text-muted-foreground", className)}
      {...props}
    />
  )
}

export { Frame, FrameHeader, FrameTitle, FrameDescription, FramePanel, FrameFooter }
