// SPDX-License-Identifier: GPL-3.0-or-later
"use client"

import * as React from "react"
import { Search, X } from "lucide-react"
import { cn } from "@/lib/utils"

interface CommandContextValue {
  search: string
  setSearch: (s: string) => void
  itemMatches: Record<string, boolean>
  registerItem: (id: string, matches: boolean) => void
  unregisterItem: (id: string) => void
  hasVisibleItems: boolean
  activeIndex: number
  setActiveIndex: React.Dispatch<React.SetStateAction<number>>
}

const CommandContext = React.createContext<CommandContextValue | null>(null)

export function useCommand() {
  const ctx = React.useContext(CommandContext)
  if (!ctx) throw new Error("useCommand must be used within a Command component")
  return ctx
}

function extractText(node: React.ReactNode): string {
  if (!node) return ""
  if (typeof node === "string" || typeof node === "number") return String(node)
  if (Array.isArray(node)) return node.map(extractText).join(" ")
  if (React.isValidElement(node)) {
    const props = node.props as { children?: React.ReactNode }
    if (props && props.children) {
      return extractText(props.children)
    }
  }
  return ""
}

export function Command({
  className,
  children,
  ...props
}: React.HTMLAttributes<HTMLDivElement>) {
  const [search, setSearch] = React.useState("")
  const [itemMatches, setItemMatches] = React.useState<Record<string, boolean>>({})
  const [activeIndex, setActiveIndex] = React.useState(-1)

  const registerItem = React.useCallback((id: string, matches: boolean) => {
    setItemMatches((prev) => {
      if (prev[id] === matches) return prev
      return { ...prev, [id]: matches }
    })
  }, [])

  const unregisterItem = React.useCallback((id: string) => {
    setItemMatches((prev) => {
      if (!(id in prev)) return prev
      const next = { ...prev }
      delete next[id]
      return next
    })
  }, [])

  const hasVisibleItems = React.useMemo(() => {
    if (!search.trim()) return true
    return Object.values(itemMatches).some(Boolean)
  }, [search, itemMatches])

  // Reset active selection index when search query changes
  React.useEffect(() => {
    setActiveIndex(-1)
  }, [search])

  return (
    <CommandContext.Provider
      value={{
        search,
        setSearch,
        itemMatches,
        registerItem,
        unregisterItem,
        hasVisibleItems,
        activeIndex,
        setActiveIndex,
      }}
    >
      <div
        data-slot="command"
        className={cn(
          "flex h-full w-full flex-col overflow-hidden rounded-lg border border-border bg-card text-card-foreground shadow-xl",
          className
        )}
        {...props}
      >
        {children}
      </div>
    </CommandContext.Provider>
  )
}

export function CommandDialog({
  open,
  onOpenChange,
  children,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  children: React.ReactNode
}) {
  React.useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "k" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault()
        onOpenChange(!open)
      } else if (e.key === "Escape" && open) {
        e.preventDefault()
        onOpenChange(false)
      }
    }
    document.addEventListener("keydown", handleKeyDown)
    return () => document.removeEventListener("keydown", handleKeyDown)
  }, [open, onOpenChange])

  if (!open) return null

  return (
    <div
      role="dialog"
      aria-modal="true"
      className="fixed inset-0 z-50 flex items-start justify-center p-3 pt-12 sm:pt-20 bg-background/80 backdrop-blur-sm animate-in fade-in-0 duration-150"
      onClick={(e) => {
        if (e.target === e.currentTarget) onOpenChange(false)
      }}
    >
      <div className="w-full max-w-xl overflow-hidden rounded-xl border border-border bg-card shadow-2xl animate-in zoom-in-95 duration-150">
        <Command>{children}</Command>
      </div>
    </div>
  )
}

export function CommandInput({
  className,
  placeholder = "Type a command or search…",
  value,
  onValueChange,
  ...props
}: Omit<React.InputHTMLAttributes<HTMLInputElement>, "value" | "onChange"> & {
  value?: string
  onValueChange?: (value: string) => void
}) {
  const { search, setSearch } = useCommand()
  const currentVal = value !== undefined ? value : search

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const val = e.target.value
    setSearch(val)
    onValueChange?.(val)
  }

  return (
    <div
      className="flex items-center border-b border-border/80 px-3.5 bg-secondary/15"
      data-slot="command-input-wrapper"
    >
      <Search className="mr-2.5 size-4 shrink-0 text-muted-foreground opacity-70" />
      <input
        type="text"
        value={currentVal}
        onChange={handleChange}
        placeholder={placeholder}
        autoFocus
        data-slot="command-input"
        className={cn(
          "flex h-11 w-full bg-transparent py-3 font-mono text-xs sm:text-sm text-foreground placeholder:text-muted-foreground focus:outline-none disabled:cursor-not-allowed disabled:opacity-50",
          className
        )}
        {...props}
      />
      {currentVal ? (
        <button
          type="button"
          onClick={() => {
            setSearch("")
            onValueChange?.("")
          }}
          className="rounded p-1 text-muted-foreground hover:bg-secondary hover:text-foreground transition-colors"
          aria-label="Clear search input"
        >
          <X className="size-3.5" />
        </button>
      ) : (
        <kbd className="hidden sm:inline-flex items-center gap-0.5 rounded border border-border/80 bg-background/80 px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">
          ESC
        </kbd>
      )}
    </div>
  )
}

export function CommandList({
  className,
  children,
  ...props
}: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      data-slot="command-list"
      className={cn("max-h-96 overflow-y-auto overflow-x-hidden p-2 divide-y divide-border/40", className)}
      {...props}
    >
      {children}
    </div>
  )
}

export function CommandEmpty({
  className,
  children = "No results found.",
  ...props
}: React.HTMLAttributes<HTMLDivElement>) {
  const { search, hasVisibleItems } = useCommand()

  // Only render when search has been typed and no items matched
  if (!search.trim() || hasVisibleItems) return null

  return (
    <div
      data-slot="command-empty"
      className={cn("py-10 text-center font-mono text-xs text-muted-foreground", className)}
      {...props}
    >
      <p className="text-foreground font-semibold">No matching resources</p>
      <p className="mt-1 text-muted-foreground">
        {typeof children === "string" ? children : `No matches found for "${search}". Try searching for endpoints, providers, or docs.`}
      </p>
    </div>
  )
}

export function CommandGroup({
  className,
  heading,
  children,
  ...props
}: React.HTMLAttributes<HTMLDivElement> & { heading?: React.ReactNode }) {
  const { search, itemMatches } = useCommand()
  const id = React.useId()

  // Determine if group has any visible child items
  const childrenArray = React.Children.toArray(children)
  const isFiltering = Boolean(search.trim())

  let hasVisibleChild = true
  if (isFiltering) {
    hasVisibleChild = childrenArray.some((child) => {
      if (!React.isValidElement(child)) return false
      const childProps = child.props as { value?: string; children?: React.ReactNode }
      const text = (childProps.value || extractText(childProps.children)).toLowerCase()
      return text.includes(search.trim().toLowerCase())
    })
  }

  if (isFiltering && !hasVisibleChild) {
    return null
  }

  return (
    <div
      data-slot="command-group"
      className={cn("overflow-hidden py-1.5 text-foreground first:pt-0 last:pb-0", className)}
      {...props}
    >
      {heading && (
        <div className="px-2.5 py-1.5 font-mono text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
          {heading}
        </div>
      )}
      <div className="flex flex-col gap-0.5">{children}</div>
    </div>
  )
}

export function CommandSeparator({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  const { search } = useCommand()
  if (search.trim()) return null

  return (
    <div
      data-slot="command-separator"
      className={cn("-mx-2 my-1 h-px bg-border/60", className)}
      {...props}
    />
  )
}

export function CommandItem({
  className,
  onSelect,
  value,
  children,
  ...props
}: React.HTMLAttributes<HTMLDivElement> & {
  onSelect?: () => void
  value?: string
}) {
  const { search, registerItem, unregisterItem } = useCommand()
  const id = React.useId()

  const textContent = React.useMemo(() => {
    return (value || extractText(children)).toLowerCase()
  }, [value, children])

  const matches = React.useMemo(() => {
    if (!search.trim()) return true
    return textContent.includes(search.trim().toLowerCase())
  }, [search, textContent])

  React.useEffect(() => {
    registerItem(id, matches)
    return () => unregisterItem(id)
  }, [id, matches, registerItem, unregisterItem])

  if (!matches) return null

  return (
    <div
      role="option"
      tabIndex={0}
      data-slot="command-item"
      onClick={onSelect}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault()
          onSelect?.()
        }
      }}
      className={cn(
        "relative flex cursor-pointer select-none items-center gap-2.5 rounded-md px-2.5 py-2 text-xs text-foreground outline-none transition-colors hover:bg-secondary/80 focus:bg-secondary/80 active:bg-secondary",
        className
      )}
      {...props}
    >
      {children}
    </div>
  )
}

export function CommandShortcut({
  className,
  ...props
}: React.HTMLAttributes<HTMLSpanElement>) {
  return (
    <span
      data-slot="command-shortcut"
      className={cn(
        "ml-auto font-mono text-[10px] tracking-widest text-muted-foreground rounded border border-border/80 bg-secondary/50 px-1.5 py-0.5",
        className
      )}
      {...props}
    />
  )
}
