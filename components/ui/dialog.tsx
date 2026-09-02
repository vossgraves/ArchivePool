"use client"

import { useEffect, useRef } from "react"
import { createPortal } from "react-dom"
import { X } from "lucide-react"
import { cn } from "@/lib/utils"

/**
 * Minimal accessible modal: focus moves in, Escape and backdrop close it, focus returns to the
 * trigger, and the dialog is labelled by its own title.
 *
 * Hand-rolled rather than pulled from a component registry on purpose — the app has exactly one
 * dependency for primitives (`@base-ui/react`) and every confirmation and reason prompt in here
 * needs the same three behaviours: block-scroll, trap focus, restore focus. Anything more is
 * unused weight.
 */
export function Dialog({
  open,
  onClose,
  title,
  description,
  children,
  footer,
  className,
}: {
  open: boolean
  onClose: () => void
  title: string
  description?: string
  children?: React.ReactNode
  footer?: React.ReactNode
  className?: string
}) {
  const panelRef = useRef<HTMLDivElement>(null)
  const restoreTo = useRef<HTMLElement | null>(null)
  const titleId = useRef(`dialog-${Math.random().toString(36).slice(2, 9)}`).current

  useEffect(() => {
    if (!open) return
    restoreTo.current = document.activeElement as HTMLElement | null

    // Move focus to the first thing the user is expected to fill in. Falling back to the panel
    // itself (never to a button) is deliberate: auto-focusing a destructive confirm is how
    // dialog bugs turn into deleted rows when someone presses Enter or Space out of habit.
    const panel = panelRef.current
    const preferred = panel?.querySelector<HTMLElement>(
      "input:not([type='hidden']), textarea, select, [data-autofocus]",
    )
    if (preferred) preferred.focus()
    else panel?.focus()

    const previousOverflow = document.body.style.overflow
    document.body.style.overflow = "hidden"

    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        event.preventDefault()
        onClose()
        return
      }
      if (event.key !== "Tab" || !panel) return
      const items = Array.from(
        panel.querySelectorAll<HTMLElement>(
          "button:not(:disabled), [href], input:not(:disabled), select, textarea, [tabindex]:not([tabindex='-1'])",
        ),
      ).filter((el) => el.offsetParent !== null)
      if (items.length === 0) return
      const first = items[0]
      const last = items[items.length - 1]
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault()
        first.focus()
      }
    }

    document.addEventListener("keydown", onKeyDown)
    return () => {
      document.removeEventListener("keydown", onKeyDown)
      document.body.style.overflow = previousOverflow
      restoreTo.current?.focus()
    }
  }, [open, onClose])

  if (!open) return null

  return createPortal(
    <div className="fixed inset-0 z-100 flex items-end justify-center p-4 sm:items-center">
      {/* Backdrop. A plain button-free div: pointer-down on it closes, and it is aria-hidden so
          assistive tech never sees a second interactive surface. */}
      <div
        aria-hidden="true"
        onPointerDown={onClose}
        className="absolute inset-0 bg-black/70 backdrop-blur-sm"
      />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        className={cn(
          "relative w-full max-w-md overflow-y-auto rounded-lg border border-border bg-card p-5 shadow-2xl",
          "max-h-[85dvh] overscroll-contain outline-none",
          className,
        )}
        style={{ overscrollBehavior: "contain" }}
      >
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            <h2 id={titleId} className="text-sm font-semibold tracking-tight text-foreground">
              {title}
            </h2>
            {description ? (
              <p className="mt-1 text-xs leading-relaxed text-muted-foreground text-pretty">
                {description}
              </p>
            ) : null}
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close dialog"
            className="-m-1 shrink-0 rounded-md p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
          >
            <X className="size-4" aria-hidden="true" />
          </button>
        </div>

        {children ? <div className="mt-4">{children}</div> : null}

        {footer ? <div className="mt-5 flex flex-wrap justify-end gap-2">{footer}</div> : null}
      </div>
    </div>,
    document.body,
  )
}
