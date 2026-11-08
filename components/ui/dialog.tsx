// SPDX-License-Identifier: GPL-3.0-or-later
"use client"

import * as React from "react"
import { createPortal } from "react-dom"
import { X } from "lucide-react"
import { cn } from "@/lib/utils"

/**
 * Dialog context for compositional subcomponents
 */
interface DialogContextValue {
  open: boolean
  setOpen: (open: boolean) => void
}

const DialogContext = React.createContext<DialogContextValue | null>(null)

export function useDialogContext() {
  const ctx = React.useContext(DialogContext)
  if (!ctx) {
    throw new Error("Dialog subcomponents must be used within DialogRoot or Dialog")
  }
  return ctx
}

export function DialogRoot({
  open: controlledOpen,
  onOpenChange,
  defaultOpen = false,
  children,
}: {
  open?: boolean
  onOpenChange?: (open: boolean) => void
  defaultOpen?: boolean
  children: React.ReactNode
}) {
  const [internalOpen, setInternalOpen] = React.useState(defaultOpen)
  const isControlled = controlledOpen !== undefined
  const open = isControlled ? controlledOpen : internalOpen

  const setOpen = React.useCallback(
    (next: boolean) => {
      if (!isControlled) setInternalOpen(next)
      onOpenChange?.(next)
    },
    [isControlled, onOpenChange]
  )

  return (
    <DialogContext.Provider value={{ open, setOpen }}>
      {children}
    </DialogContext.Provider>
  )
}

export function DialogTrigger({
  asChild,
  children,
  onClick,
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement> & { asChild?: boolean }) {
  const { setOpen } = useDialogContext()

  return (
    <button
      type="button"
      data-slot="dialog-trigger"
      onClick={(e) => {
        onClick?.(e)
        setOpen(true)
      }}
      {...props}
    >
      {children}
    </button>
  )
}

export function DialogClose({
  className,
  onClick,
  children,
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement>) {
  const { setOpen } = useDialogContext()

  return (
    <button
      type="button"
      data-slot="dialog-close"
      onClick={(e) => {
        onClick?.(e)
        setOpen(false)
      }}
      className={cn(
        "inline-flex items-center justify-center rounded-md p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground",
        className
      )}
      {...props}
    >
      {children ?? <X className="size-4" />}
    </button>
  )
}

export function DialogPortal({ children }: { children: React.ReactNode }) {
  const [mounted, setMounted] = React.useState(false)

  React.useEffect(() => {
    setMounted(true)
  }, [])

  if (!mounted) return null
  return createPortal(children, document.body)
}

export function DialogOverlay({
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement>) {
  const { setOpen } = useDialogContext()

  return (
    <div
      aria-hidden="true"
      data-slot="dialog-overlay"
      onPointerDown={() => setOpen(false)}
      className={cn(
        "fixed inset-0 z-50 bg-black/70 backdrop-blur-xs transition-opacity animate-in fade-in-0",
        className
      )}
      {...props}
    />
  )
}

export function DialogContent({
  className,
  children,
  ...props
}: React.HTMLAttributes<HTMLDivElement>) {
  const { open, setOpen } = useDialogContext()
  const panelRef = React.useRef<HTMLDivElement>(null)

  React.useEffect(() => {
    if (!open) return
    const prev = document.body.style.overflow
    document.body.style.overflow = "hidden"

    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault()
        setOpen(false)
      }
    }
    document.addEventListener("keydown", onKey)
    return () => {
      document.removeEventListener("keydown", onKey)
      document.body.style.overflow = prev
    }
  }, [open, setOpen])

  if (!open) return null

  return (
    <DialogPortal>
      <DialogOverlay />
      <div className="fixed inset-0 z-50 flex items-end justify-center p-4 sm:items-center">
        <div
          ref={panelRef}
          role="dialog"
          aria-modal="true"
          data-slot="dialog-content"
          tabIndex={-1}
          className={cn(
            "relative w-full max-w-lg overflow-y-auto rounded-lg border border-border bg-card p-5 shadow-2xl transition-all",
            "max-h-[85dvh] overscroll-contain outline-none animate-in fade-in-0 zoom-in-95",
            className
          )}
          {...props}
        >
          {children}
          <DialogClose
            aria-label="Close"
            className="absolute top-4 right-4 text-muted-foreground hover:text-foreground"
          />
        </div>
      </div>
    </DialogPortal>
  )
}

export function DialogHeader({
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      data-slot="dialog-header"
      className={cn("flex flex-col gap-1.5 text-left pr-6", className)}
      {...props}
    />
  )
}

export function DialogFooter({
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      data-slot="dialog-footer"
      className={cn("mt-5 flex flex-wrap justify-end gap-2", className)}
      {...props}
    />
  )
}

export function DialogTitle({
  className,
  ...props
}: React.HTMLAttributes<HTMLHeadingElement>) {
  return (
    <h2
      data-slot="dialog-title"
      className={cn("text-sm font-semibold tracking-tight text-foreground", className)}
      {...props}
    />
  )
}

export function DialogDescription({
  className,
  ...props
}: React.HTMLAttributes<HTMLParagraphElement>) {
  return (
    <p
      data-slot="dialog-description"
      className={cn("text-xs leading-relaxed text-muted-foreground text-pretty", className)}
      {...props}
    />
  )
}

/**
 * Convenience monolithic Dialog export for straightforward prompt/modal use cases
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
  const panelRef = React.useRef<HTMLDivElement>(null)
  const restoreTo = React.useRef<HTMLElement | null>(null)
  const titleId = React.useRef(`dialog-${Math.random().toString(36).slice(2, 9)}`).current

  React.useEffect(() => {
    if (!open) return
    restoreTo.current = document.activeElement as HTMLElement | null

    const panel = panelRef.current
    const preferred = panel?.querySelector<HTMLElement>(
      "input:not([type='hidden']), textarea, select, [data-autofocus]"
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
          "button:not(:disabled), [href], input:not(:disabled), select, textarea, [tabindex]:not([tabindex='-1'])"
        )
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
      <div
        aria-hidden="true"
        onPointerDown={onClose}
        className="absolute inset-0 bg-black/70 backdrop-blur-xs transition-opacity animate-in fade-in-0"
      />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        className={cn(
          "relative w-full max-w-md overflow-y-auto rounded-lg border border-border bg-card p-5 shadow-2xl",
          "max-h-[85dvh] overscroll-contain outline-none animate-in fade-in-0 zoom-in-95",
          className
        )}
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
    document.body
  )
}
