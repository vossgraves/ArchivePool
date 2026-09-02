import { cn } from "@/lib/utils"

/**
 * Status pill. `tone` is the only place colour is decided, so a status can never be rendered
 * green in one panel and amber in another the way it did when every component wrote its own
 * className map (and wrote it with raw `bg-amber-500/15` values that ignored the theme tokens).
 *
 * `neutral` is deliberately colourless: on a status board, saturated colour means "this needs
 * your attention", and anything that is merely informational must not compete with that.
 */
const TONES = {
  ok: "border-ok/30 text-ok",
  warn: "border-warn/30 text-warn",
  danger: "border-destructive/30 text-destructive",
  neutral: "border-border text-muted-foreground",
} as const

export type StatusTone = keyof typeof TONES

/** Canonical tone for a domain status string, shared by keys, requests and pool entries. */
export function toneFor(status: string): StatusTone {
  switch (status) {
    case "alive":
    case "approved":
    case "active":
      return "ok"
    case "pending":
    case "preview":
    case "degraded":
      return "warn"
    case "rejected":
    case "dead":
    case "revoked":
      return "danger"
    default:
      return "neutral"
  }
}

export function Badge({
  children,
  tone = "neutral",
  className,
}: {
  children: React.ReactNode
  tone?: StatusTone
  className?: string
}) {
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center gap-1 rounded-sm border px-1.5 py-0.5 font-mono text-[0.625rem] uppercase tracking-[0.1em]",
        TONES[tone],
        className,
      )}
    >
      {children}
    </span>
  )
}
