// SPDX-License-Identifier: GPL-3.0-or-later
"use client"

import * as React from "react"
import { AlertTriangle, X } from "lucide-react"
import { buttonVariants } from "@/components/ui/button"
import { cn } from "@/lib/utils"

interface AlertDialogContextValue {
  open: boolean
  setOpen: (open: boolean) => void
}

const AlertDialogContext = React.createContext<AlertDialogContextValue | null>(null)

function AlertDialog({
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
    (nextOpen: boolean) => {
      if (!isControlled) setInternalOpen(nextOpen)
      onOpenChange?.(nextOpen)
    },
    [isControlled, onOpenChange]
  )

  return (
    <AlertDialogContext.Provider value={{ open, setOpen }}>
      {children}
    </AlertDialogContext.Provider>
  )
}

function AlertDialogTrigger({
  asChild,
  children,
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement> & { asChild?: boolean }) {
  const ctx = React.useContext(AlertDialogContext)
  if (!ctx) throw new Error("AlertDialogTrigger must be used within AlertDialog")

  return (
    <button
      type="button"
      data-slot="alert-dialog-trigger"
      onClick={() => ctx.setOpen(true)}
      {...props}
    >
      {children}
    </button>
  )
}

function AlertDialogContent({
  className,
  children,
  ...props
}: React.HTMLAttributes<HTMLDivElement>) {
  const ctx = React.useContext(AlertDialogContext)
  if (!ctx) throw new Error("AlertDialogContent must be used within AlertDialog")

  React.useEffect(() => {
    if (!ctx.open) return
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") ctx.setOpen(false)
    }
    document.addEventListener("keydown", handleKeyDown)
    return () => document.removeEventListener("keydown", handleKeyDown)
  }, [ctx])

  if (!ctx.open) return null

  return (
    <div
      role="alertdialog"
      aria-modal="true"
      data-slot="alert-dialog"
      className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-background/80 backdrop-blur-xs animate-in fade-in-0 duration-150"
      onClick={(e) => {
        if (e.target === e.currentTarget) ctx.setOpen(false)
      }}
    >
      <div
        className={cn(
          "relative w-full max-w-md rounded-lg border border-border bg-card p-5 shadow-lg sm:p-6 animate-in zoom-in-95 duration-150",
          className
        )}
        {...props}
      >
        {children}
      </div>
    </div>
  )
}

function AlertDialogHeader({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      data-slot="alert-dialog-header"
      className={cn("flex flex-col gap-2 text-left", className)}
      {...props}
    />
  )
}

function AlertDialogFooter({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      data-slot="alert-dialog-footer"
      className={cn("mt-5 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end", className)}
      {...props}
    />
  )
}

function AlertDialogTitle({ className, ...props }: React.HTMLAttributes<HTMLHeadingElement>) {
  return (
    <h2
      data-slot="alert-dialog-title"
      className={cn("text-base font-semibold tracking-tight text-foreground", className)}
      {...props}
    />
  )
}

function AlertDialogDescription({ className, ...props }: React.HTMLAttributes<HTMLParagraphElement>) {
  return (
    <p
      data-slot="alert-dialog-description"
      className={cn("text-xs sm:text-sm leading-relaxed text-muted-foreground", className)}
      {...props}
    />
  )
}

function AlertDialogAction({
  className,
  onClick,
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement>) {
  const ctx = React.useContext(AlertDialogContext)
  return (
    <button
      type="button"
      data-slot="alert-dialog-action"
      className={cn(buttonVariants({ variant: "destructive", size: "sm" }), className)}
      onClick={(e) => {
        onClick?.(e)
        ctx?.setOpen(false)
      }}
      {...props}
    />
  )
}

function AlertDialogCancel({
  className,
  onClick,
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement>) {
  const ctx = React.useContext(AlertDialogContext)
  return (
    <button
      type="button"
      data-slot="alert-dialog-cancel"
      className={cn(buttonVariants({ variant: "outline", size: "sm" }), className)}
      onClick={(e) => {
        onClick?.(e)
        ctx?.setOpen(false)
      }}
      {...props}
    />
  )
}

export {
  AlertDialog,
  AlertDialogTrigger,
  AlertDialogContent,
  AlertDialogHeader,
  AlertDialogFooter,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogAction,
  AlertDialogCancel,
}
