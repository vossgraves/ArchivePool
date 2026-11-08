// SPDX-License-Identifier: GPL-3.0-or-later
"use client"

import * as React from "react"
import { ChevronDown } from "lucide-react"
import { cn } from "@/lib/utils"

interface AccordionContextValue {
  openItems: string[]
  toggleItem: (value: string) => void
  type: "single" | "multiple"
  collapsible?: boolean
}

const AccordionContext = React.createContext<AccordionContextValue | null>(null)

export interface AccordionProps extends React.HTMLAttributes<HTMLDivElement> {
  type?: "single" | "multiple"
  defaultValue?: string | string[]
  value?: string | string[]
  onValueChange?: (value: string | string[]) => void
  collapsible?: boolean
}

function Accordion({
  type = "single",
  defaultValue,
  value: controlledValue,
  onValueChange,
  collapsible = true,
  className,
  children,
  ...props
}: AccordionProps) {
  const [internalItems, setInternalItems] = React.useState<string[]>(() => {
    if (defaultValue !== undefined) {
      return Array.isArray(defaultValue) ? defaultValue : [defaultValue]
    }
    return []
  })

  const isControlled = controlledValue !== undefined
  const openItems = isControlled
    ? Array.isArray(controlledValue)
      ? controlledValue
      : controlledValue
      ? [controlledValue]
      : []
    : internalItems

  const toggleItem = React.useCallback(
    (itemVal: string) => {
      let next: string[]
      if (type === "single") {
        if (openItems.includes(itemVal)) {
          next = collapsible ? [] : [itemVal]
        } else {
          next = [itemVal]
        }
      } else {
        if (openItems.includes(itemVal)) {
          next = openItems.filter((i) => i !== itemVal)
        } else {
          next = [...openItems, itemVal]
        }
      }

      if (!isControlled) {
        setInternalItems(next)
      }
      onValueChange?.(type === "single" ? (next[0] ?? "") : next)
    },
    [type, openItems, collapsible, isControlled, onValueChange]
  )

  return (
    <AccordionContext.Provider value={{ openItems, toggleItem, type, collapsible }}>
      <div
        data-slot="accordion"
        className={cn(
          "w-full divide-y divide-border/70 overflow-hidden rounded-lg border border-border/80 bg-card/60 shadow-2xs",
          className
        )}
        {...props}
      >
        {children}
      </div>
    </AccordionContext.Provider>
  )
}

const AccordionItemContext = React.createContext<{ value: string } | null>(null)

export interface AccordionItemProps extends React.HTMLAttributes<HTMLDivElement> {
  value: string
}

function AccordionItem({
  value,
  className,
  children,
  ...props
}: AccordionItemProps) {
  return (
    <AccordionItemContext.Provider value={{ value }}>
      <div
        data-slot="accordion-item"
        className={cn("group/accordion-item transition-colors", className)}
        {...props}
      >
        {children}
      </div>
    </AccordionItemContext.Provider>
  )
}

export interface AccordionTriggerProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  badge?: React.ReactNode
  subtitle?: React.ReactNode
}

function AccordionTrigger({
  badge,
  subtitle,
  className,
  children,
  ...props
}: AccordionTriggerProps) {
  const ctx = React.useContext(AccordionContext)
  const itemCtx = React.useContext(AccordionItemContext)

  if (!ctx || !itemCtx) {
    throw new Error("AccordionTrigger must be used within Accordion and AccordionItem")
  }

  const isOpen = ctx.openItems.includes(itemCtx.value)

  return (
    <button
      type="button"
      data-slot="accordion-trigger"
      aria-expanded={isOpen}
      onClick={() => ctx.toggleItem(itemCtx.value)}
      className={cn(
        "flex w-full items-center justify-between gap-3 px-4 py-3.5 text-left transition-colors hover:bg-secondary/40 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring sm:px-5 cursor-pointer select-none",
        isOpen ? "bg-secondary/20 text-foreground" : "text-foreground",
        className
      )}
      {...props}
    >
      <div className="flex flex-1 flex-col gap-0.5 text-left">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-xs sm:text-sm font-semibold tracking-tight text-foreground">
            {children}
          </span>
          {badge}
        </div>
        {subtitle && (
          <span className="font-mono text-[11px] text-muted-foreground leading-normal">
            {subtitle}
          </span>
        )}
      </div>

      <div className="flex shrink-0 items-center justify-center rounded-md p-1 text-muted-foreground transition-transform duration-200">
        <ChevronDown
          className={cn(
            "size-4 shrink-0 transition-transform duration-200 ease-out",
            isOpen && "rotate-180 text-foreground"
          )}
          aria-hidden="true"
        />
      </div>
    </button>
  )
}

export interface AccordionContentProps extends React.HTMLAttributes<HTMLDivElement> {}

function AccordionContent({
  className,
  children,
  ...props
}: AccordionContentProps) {
  const ctx = React.useContext(AccordionContext)
  const itemCtx = React.useContext(AccordionItemContext)

  if (!ctx || !itemCtx) return null

  const isOpen = ctx.openItems.includes(itemCtx.value)
  if (!isOpen) return null

  return (
    <div
      data-slot="accordion-content"
      role="region"
      className={cn(
        "border-t border-border/60 bg-background/40 px-4 py-4 sm:px-5 text-xs sm:text-sm leading-relaxed text-muted-foreground animate-in fade-in-0 duration-150",
        className
      )}
      {...props}
    >
      {children}
    </div>
  )
}

export { Accordion, AccordionItem, AccordionTrigger, AccordionContent }
