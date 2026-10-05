// SPDX-License-Identifier: GPL-3.0-or-later
"use client"

import { CircleAlert, CircleCheck } from "lucide-react"
import { cn } from "@/lib/utils"

/**
 * One-line result of an action, announced to assistive tech.
 *
 * Every admin panel previously reported failure by doing nothing at all — the fetch resolved, the
 * error was dropped, the list reloaded unchanged. A user could not tell a rejected request from a
 * database outage, which is exactly how "I clicked Accept and nothing happened" gets reported.
 */
export function Notice({
  tone,
  children,
}: {
  tone: "ok" | "error"
  children: React.ReactNode
}) {
  return (
    <p
      role={tone === "error" ? "alert" : "status"}
      aria-live="polite"
      className={cn(
        "flex items-start gap-2 rounded-md border px-3 py-2 text-xs leading-relaxed",
        tone === "ok"
          ? "border-ok/30 bg-ok/5 text-ok"
          : "border-destructive/30 bg-destructive/5 text-destructive",
      )}
    >
      {tone === "ok" ? (
        <CircleCheck className="mt-px size-3.5 shrink-0" aria-hidden="true" />
      ) : (
        <CircleAlert className="mt-px size-3.5 shrink-0" aria-hidden="true" />
      )}
      <span className="min-w-0">{children}</span>
    </p>
  )
}
