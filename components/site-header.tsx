"use client"

import Link from "next/link"
import { useRouter } from "next/navigation"
import { useEffect, useState } from "react"
import { AnimatePresence, motion } from "motion/react"
import { BrandMark } from "@/components/brand-mark"

const NAV = [
  { href: "/", label: "Status", key: "status" as const },
  { href: "/docs", label: "API", key: "docs" as const },
  { href: "/submit", label: "Contribute", key: "submit" as const },
]

export function SiteHeader({ active }: { active?: "status" | "docs" | "submit" }) {
  const router = useRouter()
  const [user, setUser] = useState<string | null>(null)
  const [loaded, setLoaded] = useState(false)
  const [menuOpen, setMenuOpen] = useState(false)
  const [mobileNavOpen, setMobileNavOpen] = useState(false)

  useEffect(() => {
    fetch("/api/auth/me", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => setUser(d?.username ?? null))
      .catch(() => {})
      .finally(() => setLoaded(true))
  }, [])

  async function logout() {
    await fetch("/api/auth/logout", { method: "POST" })
    setUser(null)
    setMenuOpen(false)
    router.refresh()
  }

  return (
    // Sticky so the nav stays reachable while scrolling a long board. The translucent surface
    // needs its own background fallback: backdrop-filter silently does nothing in some browsers,
    // and without it the header would render transparent over scrolling content.
    <header className="sticky top-0 z-40 border-b border-border bg-background/80 backdrop-blur-md">
      <div className="mx-auto flex max-w-5xl items-center justify-between gap-3 px-4 py-3.5 sm:gap-4 sm:px-5">
        <Link
          href="/"
          className="group flex shrink-0 items-center gap-2.5 rounded-md transition-opacity hover:opacity-80"
        >
          <BrandMark size={28} />
          <span className="hidden flex-col leading-none sm:flex">
            <span className="text-sm font-semibold tracking-tight">Source Pool</span>
            <span className="mt-0.5 font-mono text-[0.65rem] uppercase tracking-[0.14em] text-muted-foreground">
              ArchiveTune
            </span>
          </span>
          <span className="flex flex-col leading-none sm:hidden">
            <span className="text-[0.95rem] font-semibold tracking-tight">Pool</span>
          </span>
        </Link>

        <div className="flex items-center gap-1 sm:gap-1">
          {/* Desktop nav */}
          <nav aria-label="Primary" className="hidden items-center gap-1 text-sm md:flex">
            {NAV.map((item) => {
              const isActive = active === item.key
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  aria-current={isActive ? "page" : undefined}
                  className={`rounded-md px-3 py-1.5 transition-colors duration-200 ${
                    isActive
                      ? "bg-secondary font-medium text-foreground"
                      : "text-muted-foreground hover:bg-secondary/50 hover:text-foreground"
                  }`}
                >
                  {item.label}
                </Link>
              )
            })}
          </nav>
          {/* Mobile hamburger */}
          <button
            type="button"
            aria-label={mobileNavOpen ? "Close menu" : "Open menu"}
            aria-expanded={mobileNavOpen}
            onClick={() => setMobileNavOpen((v) => !v)}
            className="inline-flex h-8 w-8 items-center justify-center rounded-md border border-transparent text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground md:hidden"
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
              {mobileNavOpen ? <path d="M18 6 6 18M6 6l12 12" /> : <path d="M4 6h16M4 12h16M4 18h16" />}
            </svg>
          </button>

          {/* Top-right account button: Login when signed out, username menu when signed in. */}
          {!loaded ? (
            <div className="ml-1 h-8 w-20 animate-pulse rounded-full bg-secondary/60" />
          ) : user ? (
            <div className="relative ml-1">
              <motion.button
                whileTap={{ scale: 0.96 }}
                onClick={() => setMenuOpen((v) => !v)}
                aria-haspopup="menu"
                aria-expanded={menuOpen}
                className="flex items-center gap-2 rounded-full border border-border bg-card py-1 pl-1 pr-3 text-sm font-medium transition-colors hover:border-primary/40"
              >
                <span className="flex h-6 w-6 items-center justify-center rounded-full bg-primary font-mono text-xs font-bold uppercase text-primary-foreground">
                  {user.slice(0, 1)}
                </span>
                {user}
              </motion.button>
              <AnimatePresence>
                {menuOpen && (
                  <motion.div
                    initial={{ opacity: 0, y: -6, scale: 0.97 }}
                    animate={{ opacity: 1, y: 0, scale: 1 }}
                    exit={{ opacity: 0, y: -6, scale: 0.97 }}
                    transition={{ type: "spring", stiffness: 420, damping: 32 }}
                    role="menu"
                    className="absolute right-0 top-full z-50 mt-2 w-44 overflow-hidden rounded-xl border border-border bg-card shadow-lg"
                  >
                    <Link
                      href="/dashboard"
                      role="menuitem"
                      className="block px-4 py-2.5 text-sm transition-colors hover:bg-secondary"
                      onClick={() => setMenuOpen(false)}
                    >
                      Dashboard
                    </Link>
                    <button
                      role="menuitem"
                      onClick={logout}
                      className="block w-full px-4 py-2.5 text-left text-sm text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground"
                    >
                      Sign out
                    </button>
                  </motion.div>
                )}
              </AnimatePresence>
            </div>
          ) : (
            <motion.div whileTap={{ scale: 0.96 }} className="ml-1">
              <Link
                href="/login"
                className="inline-flex items-center rounded-full bg-primary px-4 py-1.5 text-sm font-medium text-primary-foreground transition-opacity hover:opacity-90"
              >
                Sign in
              </Link>
            </motion.div>
          )}
        </div>
      </div>
      {/* Mobile nav drawer */}
      <AnimatePresence>
        {mobileNavOpen && (
          <motion.nav
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.22, ease: "easeInOut" }}
            aria-label="Mobile navigation"
            className="overflow-hidden border-t border-border bg-background/95 backdrop-blur-md md:hidden"
          >
            <div className="mx-auto flex max-w-5xl flex-col gap-1 px-4 py-3">
              {NAV.map((item) => {
                const isActive = active === item.key
                return (
                  <Link
                    key={item.href}
                    href={item.href}
                    aria-current={isActive ? "page" : undefined}
                    onClick={() => setMobileNavOpen(false)}
                    className={`rounded-lg px-3 py-2.5 text-sm font-medium transition-colors ${
                      isActive ? "bg-secondary text-foreground" : "text-muted-foreground hover:bg-secondary/60 hover:text-foreground"
                    }`}
                  >
                    {item.label}
                  </Link>
                )
              })}
            </div>
          </motion.nav>
        )}
      </AnimatePresence>
    </header>
  )
}
