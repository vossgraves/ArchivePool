// SPDX-License-Identifier: GPL-3.0-or-later
"use client"

import Link from "next/link"
import { useRouter } from "next/navigation"
import { useCallback, useEffect, useRef, useState } from "react"
import { AnimatePresence, motion, useReducedMotion } from "motion/react"
import {
  Activity,
  ArrowUpRight,
  BookOpen,
  ChevronDown,
  Key,
  Layers,
  Lock,
  Menu,
  Plus,
  Search,
  ShieldCheck,
  Terminal,
  X,
} from "lucide-react"
import { BrandMark } from "@/components/brand-mark"
import { ThemeToggle } from "@/components/theme-toggle"
import { Avatar, AvatarFallback } from "@/components/ui/avatar"
import { Button, buttonVariants } from "@/components/ui/button"
import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
  CommandShortcut,
} from "@/components/ui/command"
import { cn } from "@/lib/utils"

const NAV = [
  { href: "/", label: "Status", key: "status" as const },
  { href: "/docs", label: "API", key: "docs" as const },
  { href: "/submit", label: "Contribute", key: "submit" as const },
]

/** Only reachable with an account, so it joins the nav once one is known rather than 401ing. */
const SIGNED_IN_NAV = { href: "/dashboard", label: "Dashboard", key: "dashboard" as const }

type NavKey = "status" | "docs" | "submit" | "dashboard"

export function SiteHeader({ active }: { active?: NavKey }) {
  const router = useRouter()
  const reduce = useReducedMotion()
  const [user, setUser] = useState<string | null>(null)
  const [loaded, setLoaded] = useState(false)
  const [menuOpen, setMenuOpen] = useState(false)
  const [mobileNavOpen, setMobileNavOpen] = useState(false)
  const [commandOpen, setCommandOpen] = useState(false)
  const menuRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    fetch("/api/auth/me", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => setUser(d?.username ?? null))
      .catch(() => {})
      .finally(() => setLoaded(true))
  }, [])

  // Global keyboard shortcut for search / command palette
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if ((e.key === "k" || e.key === "K") && (e.metaKey || e.ctrlKey)) {
        e.preventDefault()
        setCommandOpen((prev) => !prev)
      }
    }
    window.addEventListener("keydown", onKeyDown)
    return () => window.removeEventListener("keydown", onKeyDown)
  }, [])

  const closeMenu = useCallback(() => setMenuOpen(false), [])

  useEffect(() => {
    if (!menuOpen) return
    function onPointerDown(event: PointerEvent) {
      if (!menuRef.current?.contains(event.target as Node)) setMenuOpen(false)
    }
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") setMenuOpen(false)
    }
    document.addEventListener("pointerdown", onPointerDown)
    document.addEventListener("keydown", onKeyDown)
    return () => {
      document.removeEventListener("pointerdown", onPointerDown)
      document.removeEventListener("keydown", onKeyDown)
    }
  }, [menuOpen])

  const items = user ? [...NAV, SIGNED_IN_NAV] : NAV

  async function logout() {
    await fetch("/api/auth/logout", { method: "POST" })
    setUser(null)
    setMenuOpen(false)
    router.refresh()
  }

  const runCommand = (action: () => void) => {
    setCommandOpen(false)
    action()
  }

  return (
    <>
      <header className="sticky top-0 z-40 border-b border-border/80 bg-background/90 backdrop-blur-md">
        <div className="flex w-full items-center justify-between gap-3 px-3 py-2 sm:px-4 md:px-6">
          {/* Left: Branding + Checked hourly indicator */}
          <div className="flex items-center gap-3.5">
            <Link
              href="/"
              className="flex shrink-0 items-center gap-2.5 rounded-md transition-opacity hover:opacity-90 focus-visible:ring-2 focus-visible:ring-ring"
            >
              <BrandMark size={22} />
              <div className="flex flex-col leading-none">
                <span className="font-semibold text-sm tracking-tight text-foreground">ArchivePool</span>
                <span className="font-mono text-[10px] tracking-wide text-muted-foreground uppercase hidden sm:inline">
                  Infra Monitor
                </span>
              </div>
            </Link>

            {/* Small 'Checked hourly' status indicator */}
            <div className="hidden items-center gap-1.5 rounded-full border border-border/70 bg-secondary/50 px-2 py-0.5 text-[11px] font-mono font-medium text-muted-foreground sm:inline-flex">
              <span className="relative flex size-1.5" aria-hidden="true">
                <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-ok opacity-75" />
                <span className="relative inline-flex size-1.5 rounded-full bg-ok" />
              </span>
              <span className="text-foreground/80">Checked hourly</span>
            </div>
          </div>

          {/* Center: Search trigger & Clean desktop navigation */}
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => setCommandOpen(true)}
              className="flex items-center gap-2 rounded-md border border-border/80 bg-secondary/40 px-2.5 py-1 text-xs text-muted-foreground hover:bg-secondary/70 hover:text-foreground transition-colors cursor-pointer"
              title="Search endpoints, pool categories, actions (⌘K)"
            >
              <Search className="size-3.5 opacity-60" aria-hidden="true" />
              <span className="hidden sm:inline font-mono text-[11px]">Search pool or docs…</span>
              <span className="sm:hidden font-mono text-[11px]">Search</span>
              <kbd className="hidden sm:inline-flex items-center gap-0.5 rounded border border-border/80 bg-background/80 px-1 py-0.2 font-mono text-[10px] text-muted-foreground">
                <span className="text-[11px]">⌘</span>K
              </kbd>
            </button>

            <nav aria-label="Primary" className="hidden items-center gap-1 text-xs font-medium md:flex">
              {items.map((item) => {
                const isActive = active === item.key
                return (
                  <Link
                    key={item.href}
                    href={item.href}
                    aria-current={isActive ? "page" : undefined}
                    className={cn(
                      "rounded-md px-3 py-1.5 transition-colors",
                      isActive
                        ? "bg-secondary font-semibold text-foreground shadow-2xs border border-border/60"
                        : "text-muted-foreground hover:bg-secondary/60 hover:text-foreground",
                    )}
                  >
                    {item.label}
                  </Link>
                )
              })}
            </nav>
          </div>

          {/* Right: Actions (API Docs, Get API Key / User, Theme, Mobile toggle) */}
          <div className="flex items-center gap-2">
            {/* Quick API Docs action */}
            <Link
              href="/docs"
              className="hidden items-center gap-1 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground sm:inline-flex px-2 py-1 rounded-md hover:bg-secondary/60"
            >
              API Docs
            </Link>

            <ThemeToggle className="hidden sm:flex" />

            {!loaded ? (
              <div className="h-7 w-20 animate-pulse rounded-md bg-secondary/60" />
            ) : user ? (
              <div className="relative" ref={menuRef}>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setMenuOpen((v) => !v)}
                  aria-haspopup="dialog"
                  aria-expanded={menuOpen}
                  aria-label={`Account menu for ${user}`}
                  className="h-7.5 px-2.5 text-xs font-mono"
                >
                  <Avatar size="xs" className="mr-1">
                    <AvatarFallback>{user.slice(0, 1).toUpperCase()}</AvatarFallback>
                  </Avatar>
                  <span className="max-w-[12ch] truncate">{user}</span>
                  <ChevronDown className="size-3 opacity-60 ml-1" aria-hidden="true" />
                </Button>
                <AnimatePresence>
                  {menuOpen && (
                    <motion.div
                      {...(reduce
                        ? {}
                        : {
                            initial: { opacity: 0, y: -4 },
                            animate: { opacity: 1, y: 0 },
                            exit: { opacity: 0, y: -4 },
                          })}
                      transition={{ duration: 0.12 }}
                      className="absolute right-0 top-full z-50 mt-1.5 w-44 overflow-hidden rounded-md border border-border bg-popover shadow-lg"
                    >
                      <Link
                        href="/dashboard"
                        onClick={closeMenu}
                        className="block px-3 py-2 text-xs font-medium transition-colors hover:bg-secondary"
                      >
                        Dashboard
                      </Link>
                      <button
                        type="button"
                        onClick={() => void logout()}
                        className="block w-full border-t border-border px-3 py-2 text-left text-xs text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground"
                      >
                        Sign out
                      </button>
                    </motion.div>
                  )}
                </AnimatePresence>
              </div>
            ) : (
              <div className="flex items-center gap-1.5">
                <Link
                  href="/login"
                  className={cn(
                    buttonVariants({ variant: "ghost", size: "sm" }),
                    "h-7.5 px-2.5 text-xs hidden sm:inline-flex",
                  )}
                >
                  Sign in
                </Link>
                <Link
                  href="/signup"
                  className={cn(
                    buttonVariants({ variant: "default", size: "sm" }),
                    "h-7.5 px-2.5 text-xs font-medium",
                  )}
                >
                  Get API Key
                </Link>
              </div>
            )}

            {/* Mobile hamburger */}
            <button
              type="button"
              aria-label={mobileNavOpen ? "Close menu" : "Open menu"}
              aria-expanded={mobileNavOpen}
              onClick={() => setMobileNavOpen((v) => !v)}
              className="inline-flex size-7.5 items-center justify-center rounded-md border border-border/60 text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground md:hidden cursor-pointer"
            >
              {mobileNavOpen ? (
                <X className="size-4" aria-hidden="true" />
              ) : (
                <Menu className="size-4" aria-hidden="true" />
              )}
            </button>
          </div>
        </div>

        {/* Mobile nav drawer */}
        <AnimatePresence initial={false}>
          {mobileNavOpen && (
            <motion.nav
              {...(reduce
                ? {}
                : {
                    initial: { height: 0, opacity: 0 },
                    animate: { height: "auto", opacity: 1 },
                    exit: { height: 0, opacity: 0 },
                  })}
              transition={{ duration: 0.18 }}
              aria-label="Mobile navigation"
              className="overflow-hidden border-t border-border bg-background/95 backdrop-blur-md md:hidden"
            >
              <div className="flex flex-col gap-1 px-4 py-3">
                {items.map((item) => {
                  const isActive = active === item.key
                  return (
                    <Link
                      key={item.href}
                      href={item.href}
                      aria-current={isActive ? "page" : undefined}
                      onClick={() => setMobileNavOpen(false)}
                      className={cn(
                        "rounded-md px-3 py-2 text-sm transition-colors",
                        isActive
                          ? "bg-secondary font-medium text-foreground"
                          : "text-muted-foreground hover:bg-secondary/60 hover:text-foreground",
                      )}
                    >
                      {item.label}
                    </Link>
                  )
                })}
                <div className="mt-1 flex items-center justify-between gap-3 border-t border-border px-3 pt-3 sm:hidden">
                  <span className="font-mono text-xs text-muted-foreground">Theme</span>
                  <ThemeToggle />
                </div>
              </div>
            </motion.nav>
          )}
        </AnimatePresence>
      </header>

      {/* Global Command Palette */}
      <CommandDialog open={commandOpen} onOpenChange={setCommandOpen}>
        <CommandInput placeholder="Type a command, endpoint, or service…" />
        <CommandList>
          <CommandEmpty>No matching resources or commands found.</CommandEmpty>
          
          <CommandGroup heading="Navigation">
            <CommandItem
              value="source pool status board live health telemetry monitor uptime home"
              onSelect={() => runCommand(() => router.push("/"))}
            >
              <Activity className="size-4 text-muted-foreground" />
              <span>Source Pool Status</span>
              <CommandShortcut>G S</CommandShortcut>
            </CommandItem>
            <CommandItem
              value="api documentation specs endpoints curl authentication bearer rest"
              onSelect={() => runCommand(() => router.push("/docs"))}
            >
              <BookOpen className="size-4 text-muted-foreground" />
              <span>API Documentation & Specs</span>
              <CommandShortcut>G D</CommandShortcut>
            </CommandItem>
            <CommandItem
              value="contribute a working source submit credentials add pool tidal qobuz deezer apple amazon"
              onSelect={() => runCommand(() => router.push("/submit"))}
            >
              <Plus className="size-4 text-muted-foreground" />
              <span>Contribute a Working Source</span>
              <CommandShortcut>G C</CommandShortcut>
            </CommandItem>
            <CommandItem
              value="api keys developer dashboard leases tokens account profile"
              onSelect={() => runCommand(() => router.push(user ? "/dashboard" : "/signup"))}
            >
              <Key className="size-4 text-muted-foreground" />
              <span>{user ? "Your API Keys & Dashboard" : "Generate Free API Key"}</span>
              <CommandShortcut>G K</CommandShortcut>
            </CommandItem>
          </CommandGroup>

          <CommandSeparator />

          <CommandGroup heading="Live Endpoints">
            <CommandItem
              value="get api status public health telemetry uptime check history 200 ok"
              onSelect={() => runCommand(() => window.open("/api/status", "_blank"))}
            >
              <Terminal className="size-4 text-emerald-500" />
              <div className="flex flex-col">
                <span className="font-mono text-xs font-semibold">GET /api/status</span>
                <span className="text-[10px] text-muted-foreground">Public health telemetry & sweep history</span>
              </div>
              <CommandShortcut>200 OK</CommandShortcut>
            </CommandItem>
            <CommandItem
              value="get api sources key-gated decrypted credential leases bearer token rotate pool"
              onSelect={() => runCommand(() => router.push("/docs"))}
            >
              <Terminal className="size-4 text-amber-500" />
              <div className="flex flex-col">
                <span className="font-mono text-xs font-semibold">GET /api/sources</span>
                <span className="text-[10px] text-muted-foreground">Key-gated decrypted credential leases</span>
              </div>
              <CommandShortcut>BEARER</CommandShortcut>
            </CommandItem>
            <CommandItem
              value="get api discovery tidal public instance stream endpoints"
              onSelect={() => runCommand(() => window.open("/api/discovery/tidal", "_blank"))}
            >
              <Layers className="size-4 text-muted-foreground" />
              <div className="flex flex-col">
                <span className="font-mono text-xs font-semibold">GET /api/discovery/tidal</span>
                <span className="text-[10px] text-muted-foreground">Public Tidal instance endpoints</span>
              </div>
            </CommandItem>
            <CommandItem
              value="get api discovery qobuz public instance endpoints"
              onSelect={() => runCommand(() => window.open("/api/discovery/qobuz", "_blank"))}
            >
              <Layers className="size-4 text-muted-foreground" />
              <div className="flex flex-col">
                <span className="font-mono text-xs font-semibold">GET /api/discovery/qobuz</span>
                <span className="text-[10px] text-muted-foreground">Public Qobuz instance endpoints</span>
              </div>
            </CommandItem>
          </CommandGroup>

          <CommandSeparator />

          <CommandGroup heading="Streaming Providers">
            <CommandItem
              value="tidal hi-res max hifi flac 24-bit 192khz oauth device flow"
              onSelect={() => runCommand(() => router.push("/"))}
            >
              <ShieldCheck className="size-4 text-muted-foreground" />
              <span>Tidal Hi-Res (FLAC 24-bit/192kHz)</span>
            </CommandItem>
            <CommandItem
              value="qobuz studio master hi-res 192khz 24-bit user auth token app secret"
              onSelect={() => runCommand(() => router.push("/"))}
            >
              <ShieldCheck className="size-4 text-muted-foreground" />
              <span>Qobuz Studio (24-bit Studio Master)</span>
            </CommandItem>
            <CommandItem
              value="deezer hifi flac 1411kbps 16-bit arl cookie reverse proxy"
              onSelect={() => runCommand(() => router.push("/"))}
            >
              <ShieldCheck className="size-4 text-muted-foreground" />
              <span>Deezer HiFi (16-bit FLAC / ARL)</span>
            </CommandItem>
            <CommandItem
              value="apple music alac lossless 256k aac media-user-token 0.ap"
              onSelect={() => runCommand(() => router.push("/submit"))}
            >
              <ShieldCheck className="size-4 text-muted-foreground" />
              <span>Apple Music (Media-User-Token)</span>
            </CommandItem>
            <CommandItem
              value="amazon music ultra hd lossless session turnstile bypass"
              onSelect={() => runCommand(() => router.push("/submit"))}
            >
              <ShieldCheck className="size-4 text-muted-foreground" />
              <span>Amazon Music (Web Session & Turnstile)</span>
            </CommandItem>
          </CommandGroup>

          <CommandSeparator />

          <CommandGroup heading="Documentation & Security">
            <CommandItem
              value="docs bearer token authorization authentication headers security"
              onSelect={() => runCommand(() => router.push("/docs"))}
            >
              <BookOpen className="size-4 text-muted-foreground" />
              <span>Authentication & Scoped Bearer Tokens</span>
            </CommandItem>
            <CommandItem
              value="docs aes-256-gcm envelope encryption client side decryption iv auth tag"
              onSelect={() => runCommand(() => router.push("/docs"))}
            >
              <Lock className="size-4 text-muted-foreground" />
              <span>AES-256-GCM Payload Decryption Guide</span>
            </CommandItem>
            <CommandItem
              value="docs rate limits 429 quota rotation retry-after backoff"
              onSelect={() => runCommand(() => router.push("/docs"))}
            >
              <Activity className="size-4 text-muted-foreground" />
              <span>Rate Limits & Backoff Policies</span>
            </CommandItem>
            <CommandItem
              value="docs error codes 401 403 404 429 503 diagnostics"
              onSelect={() => runCommand(() => router.push("/docs"))}
            >
              <Terminal className="size-4 text-muted-foreground" />
              <span>HTTP Error Codes & Responses</span>
            </CommandItem>
          </CommandGroup>
        </CommandList>
      </CommandDialog>
    </>
  )
}
