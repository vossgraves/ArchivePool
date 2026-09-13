"use client"

import Link from "next/link"
import { useRouter } from "next/navigation"
import { useCallback, useEffect, useRef, useState } from "react"
import { AnimatePresence, motion, useReducedMotion } from "motion/react"
import { ChevronDown, Menu, X } from "lucide-react"
import { BrandMark } from "@/components/brand-mark"
import { ThemeToggle } from "@/components/theme-toggle"
import { Button, buttonVariants } from "@/components/ui/button"
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
  const menuRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    fetch("/api/auth/me", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => setUser(d?.username ?? null))
      .catch(() => {})
      .finally(() => setLoaded(true))
  }, [])

  // The account popover used to close only when its own button was clicked again: clicking
  // anywhere else on the page, or pressing Escape, left it hanging over the content.
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

  return (
    // Sticky so nav stays reachable while scrolling a long board. The translucent surface needs
    // its own background fallback: backdrop-filter is a no-op in some browsers, and without it
    // the header would render transparent over scrolling content.
    <header className="sticky top-0 z-40 border-b border-border bg-background/85 backdrop-blur-md">
      <div className="mx-auto flex max-w-5xl items-center justify-between gap-3 px-4 py-2.5">
        <Link
          href="/"
          className="flex shrink-0 items-center gap-2.5 rounded-md transition-opacity hover:opacity-80"
        >
          <BrandMark size={24} />
          <span className="flex flex-col leading-none">
            <span className="text-sm font-semibold tracking-tight">Source Pool</span>
            <span className="label-mono mt-1 hidden sm:flex">ArchiveTune</span>
          </span>
        </Link>

        <div className="flex items-center gap-1">
          {/* Desktop nav */}
          <nav aria-label="Primary" className="hidden items-center gap-1 text-sm md:flex">
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
                      ? "bg-secondary font-medium text-foreground"
                      : "text-muted-foreground hover:bg-secondary/60 hover:text-foreground",
                  )}
                >
                  {item.label}
                </Link>
              )
            })}
          </nav>

          <button
            type="button"
            aria-label={mobileNavOpen ? "Close menu" : "Open menu"}
            aria-expanded={mobileNavOpen}
            onClick={() => setMobileNavOpen((v) => !v)}
            className="inline-flex size-8 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground md:hidden"
          >
            {mobileNavOpen ? (
              <X className="size-4.5" aria-hidden="true" />
            ) : (
              <Menu className="size-4.5" aria-hidden="true" />
            )}
          </button>

          <ThemeToggle className="ml-1 hidden sm:flex" />

          {!loaded ? (
            <div className="ml-1 h-8 w-20 animate-pulse rounded-md bg-secondary/60" />
          ) : user ? (
            <div className="relative ml-1" ref={menuRef}>
              <Button
                variant="outline"
                size="sm"
                onClick={() => setMenuOpen((v) => !v)}
                aria-haspopup="dialog"
                aria-expanded={menuOpen}
                aria-label={`Account menu for ${user}`}
              >
                <span
                  className="flex size-5 shrink-0 items-center justify-center rounded-full bg-primary font-mono text-[0.625rem] font-bold uppercase text-primary-foreground"
                  aria-hidden="true"
                >
                  {user.slice(0, 1)}
                </span>
                <span className="hidden max-w-[10ch] truncate sm:inline">{user}</span>
                <ChevronDown className="size-3.5 opacity-60" aria-hidden="true" />
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
                      className="block px-3 py-2 text-sm transition-colors hover:bg-secondary"
                    >
                      Dashboard
                    </Link>
                    <button
                      type="button"
                      onClick={() => void logout()}
                      className="block w-full border-t border-border px-3 py-2 text-left text-sm text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground"
                    >
                      Sign out
                    </button>
                  </motion.div>
                )}
              </AnimatePresence>
            </div>
          ) : (
            <Link
              href="/login"
              className={cn(buttonVariants({ variant: "outline", size: "sm" }), "ml-1")}
            >
              Sign in
            </Link>
          )}
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
            <div className="mx-auto flex max-w-5xl flex-col gap-1 px-4 py-3">
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
                <span className="label-mono">Theme</span>
                <ThemeToggle />
              </div>
            </div>
          </motion.nav>
        )}
      </AnimatePresence>
    </header>
  )
}
