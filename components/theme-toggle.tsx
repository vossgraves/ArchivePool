// SPDX-License-Identifier: GPL-3.0-or-later
"use client"

import { useEffect, useState } from "react"
import { Monitor, Moon, Sun } from "lucide-react"
import { cn } from "@/lib/utils"

type Choice = "light" | "dark" | "system"

/** Read by the blocking script in app/layout.tsx, which must agree with this key. */
const STORAGE_KEY = "archivepool-theme"

const OPTIONS: { value: Choice; label: string; Icon: typeof Sun }[] = [
  { value: "light", label: "Light", Icon: Sun },
  { value: "dark", label: "Dark", Icon: Moon },
  { value: "system", label: "System", Icon: Monitor },
]

function prefersDark() {
  return window.matchMedia("(prefers-color-scheme: dark)").matches
}

function paint(choice: Choice) {
  const dark = choice === "dark" || (choice === "system" && prefersDark())
  document.documentElement.classList.toggle("dark", dark)
}

/**
 * Three explicit buttons rather than one cycling icon: with a cycle, the control's meaning depends
 * on state the reader cannot see, and "system" is invisible in it entirely.
 *
 * `choice` starts null and is filled after mount. Rendering a pressed button from localStorage on
 * the server is impossible, and guessing one produces a hydration mismatch on the only element
 * whose job is to show the truth.
 */
export function ThemeToggle({ className }: { className?: string }) {
  const [choice, setChoice] = useState<Choice | null>(null)

  useEffect(() => {
    let stored: Choice | null = null
    try {
      const raw = localStorage.getItem(STORAGE_KEY)
      if (raw === "light" || raw === "dark" || raw === "system") stored = raw
    } catch {
      // Private-mode storage throws on read; the site still has to render in a theme.
    }
    setChoice(stored ?? "system")
  }, [])

  useEffect(() => {
    if (choice !== "system") return
    const query = window.matchMedia("(prefers-color-scheme: dark)")
    const sync = () => paint("system")
    query.addEventListener("change", sync)
    return () => query.removeEventListener("change", sync)
  }, [choice])

  function pick(next: Choice) {
    setChoice(next)
    paint(next)
    try {
      localStorage.setItem(STORAGE_KEY, next)
    } catch {
      // A theme that cannot be remembered is still worth applying for this visit.
    }
  }

  return (
    <div
      role="group"
      aria-label="Colour theme"
      className={cn("flex items-center gap-0.5 rounded-md border border-border p-0.5", className)}
    >
      {OPTIONS.map(({ value, label, Icon }) => (
        <button
          key={value}
          type="button"
          onClick={() => pick(value)}
          aria-pressed={choice === value}
          title={`${label} theme`}
          className={cn(
            "inline-flex size-6 items-center justify-center rounded-sm text-muted-foreground transition-colors hover:text-foreground",
            choice === value && "bg-secondary text-foreground",
          )}
        >
          <Icon className="size-3.5" aria-hidden="true" />
          <span className="sr-only">{label} theme</span>
        </button>
      ))}
    </div>
  )
}
