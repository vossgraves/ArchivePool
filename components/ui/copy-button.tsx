// SPDX-License-Identifier: GPL-3.0-or-later
"use client"

import { useEffect, useRef, useState } from "react"
import { Check, Copy } from "lucide-react"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"

/**
 * Copy-to-clipboard with the result stated, not just drawn: the icon swap is mirrored by a live
 * region, because "did that copy?" is unanswerable from a tick a screen reader never sees.
 * A failed write (insecure context, denied permission) says so instead of silently showing Copied.
 */
export function CopyButton({
  value,
  label = "Copy",
  size = "default",
  variant = "outline",
  className,
}: {
  value: string
  label?: string
  size?: "xs" | "sm" | "default"
  variant?: "outline" | "ghost" | "secondary"
  className?: string
}) {
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle")
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => () => { if (timer.current) clearTimeout(timer.current) }, [])

  async function copy() {
    try {
      await navigator.clipboard.writeText(value)
      setState("copied")
    } catch {
      setState("failed")
    }
    if (timer.current) clearTimeout(timer.current)
    timer.current = setTimeout(() => setState("idle"), 1800)
  }

  return (
    <>
      <Button
        type="button"
        variant={variant}
        size={size}
        onClick={() => void copy()}
        className={cn(className)}
      >
        {state === "copied" ? (
          <Check className="size-3.5" aria-hidden="true" />
        ) : (
          <Copy className="size-3.5" aria-hidden="true" />
        )}
        {state === "copied" ? "Copied" : state === "failed" ? "Press ⌘C" : label}
      </Button>
      <span role="status" aria-live="polite" className="sr-only">
        {state === "copied" ? "Copied to clipboard" : state === "failed" ? "Copying failed — select the value and copy it manually" : ""}
      </span>
    </>
  )
}
