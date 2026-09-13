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
    case "operational":
    case "premium":
    case "held":
      return "ok"
    case "pending":
    case "preview":
    case "degraded":
    case "expiring":
    case "disabled":
      return "warn"
    case "rejected":
    case "dead":
    case "revoked":
    case "down":
    case "expired":
      return "danger"
    default:
      return "neutral"
  }
}

/** Text colour for a tone, where there is no Badge in the cell to borrow one from. */
export const TONE_TEXT: Record<StatusTone, string> = {
  ok: "text-ok",
  warn: "text-warn",
  danger: "text-destructive",
  neutral: "text-muted-foreground",
}

/** Fill for a dot, bar segment or meter. */
export const TONE_BG: Record<StatusTone, string> = {
  ok: "bg-ok",
  warn: "bg-warn",
  danger: "bg-destructive",
  neutral: "bg-muted-foreground",
}

/**
 * The same four signals as a raw colour value, for SVG `fill`/`stroke` and CSS gradients, which
 * cannot take a Tailwind class. Charts resolve their colour through here rather than naming a
 * token directly, so a series and the badge beside it cannot disagree.
 */
export const TONE_VAR: Record<StatusTone, string> = {
  ok: "var(--ok)",
  warn: "var(--warn)",
  danger: "var(--destructive)",
  neutral: "var(--muted-foreground)",
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

/** Decorative: whatever names the status in words sits beside it, never replaced by the colour. */
export function StatusDot({
  tone,
  pulse = false,
  className,
}: {
  tone: StatusTone
  pulse?: boolean
  className?: string
}) {
  return (
    <span className={cn("relative flex shrink-0", className ?? "size-2")} aria-hidden="true">
      {pulse ? (
        <span
          className={cn(
            "absolute inline-flex h-full w-full animate-ping rounded-full opacity-60",
            TONE_BG[tone],
          )}
        />
      ) : null}
      <span className={cn("relative inline-flex h-full w-full rounded-full", TONE_BG[tone])} />
    </span>
  )
}
