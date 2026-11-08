// SPDX-License-Identifier: GPL-3.0-or-later
import { Analytics } from "@vercel/analytics/next"
import type { Metadata, Viewport } from "next"
import { Geist, Geist_Mono } from "next/font/google"
import type React from "react"
import { ClickRipple } from "@/components/click-ripple"
import { RailwayGridBg } from "@/components/railway-grid-bg"
import { Toaster } from "@/components/ui/sonner"
import "./globals.css"

const geistSans = Geist({ subsets: ["latin"], variable: "--font-geist-sans" })
const geistMono = Geist_Mono({ subsets: ["latin"], variable: "--font-geist-mono" })

export const metadata: Metadata = {
  title: {
    default: "ArchivePool · Source Pool",
    template: "%s · ArchivePool",
  },
  description:
    "Live health and credential pool for community-contributed streaming sources.",
  applicationName: "ArchivePool",
  metadataBase: new URL(
    process.env.NEXT_PUBLIC_SITE_URL ??
      (process.env.VERCEL_PROJECT_PRODUCTION_URL
        ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}`
        : process.env.RAILWAY_PUBLIC_DOMAIN
          ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}`
          : "http://localhost:3000"),
  ),
  openGraph: {
    title: "ArchivePool · Source Pool",
    description:
      "Live health and credential pool for community-contributed streaming sources.",
    type: "website",
    siteName: "ArchivePool",
  },
  twitter: {
    card: "summary_large_image",
    title: "ArchivePool · Source Pool",
    description:
      "Live health and credential pool for community-contributed streaming sources.",
  },
  robots: { index: false, follow: false },
}

export const viewport: Viewport = {
  colorScheme: "dark light",
  width: "device-width",
  initialScale: 1,
  maximumScale: 5,
  viewportFit: "cover",
  themeColor: [
    { media: "(prefers-color-scheme: dark)", color: "#030303" },
    { media: "(prefers-color-scheme: light)", color: "#f5f5f5" },
  ],
}

/**
 * Applies the stored theme before first paint. Inline and blocking on purpose: a theme resolved
 * after hydration renders one theme and then swaps, which is the flash every toggle exists to
 * avoid. `dark` is on <html> already, so with JavaScript off the site stays dark as it always was.
 */
const THEME_SCRIPT = `try{var c=localStorage.getItem("archivepool-theme");var d=c==="dark"||(c!=="light"&&window.matchMedia("(prefers-color-scheme: dark)").matches);document.documentElement.classList.toggle("dark",d)}catch(e){}`

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode
}>) {
  return (
    // suppressHydrationWarning: THEME_SCRIPT edits this element's class list before React
    // hydrates, which is a mismatch React would otherwise report on every load.
    <html
      lang="en"
      className={`dark ${geistSans.variable} ${geistMono.variable}`}
      suppressHydrationWarning
    >
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_SCRIPT }} />
      </head>
      <body className="grain bg-background text-foreground font-sans antialiased relative">
        {/* Railway-inspired perspective wireframe grid background with glowing pulses and mouse spotlight */}
        <RailwayGridBg />

        {/* Keyboard and screen-reader users can jump past the header straight to content. */}
        <a
          href="#content"
          className="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-[60] focus:rounded-md focus:bg-foreground focus:px-4 focus:py-2 focus:text-sm focus:font-medium focus:text-background"
        >
          Skip to content
        </a>
        <div className="relative z-10 flex min-h-dvh flex-col">
          {children}
        </div>
        {/* Pure-DOM pointer feedback: a ring at every click point. No state, no re-renders,
            and hidden entirely under prefers-reduced-motion (see globals.css). */}
        <ClickRipple />
        {/* Mutations (key create/revoke/delete, request approve/reject/claim, source removal)
            report through here. Bottom-right keeps it clear of the header and of the dialogs,
            which anchor centre; richColors maps the ok/destructive tones onto the same palette
            the status badges use, so a toast reads as the same system rather than a browser
            alert bolted on. */}
        <Toaster position="bottom-right" richColors closeButton />
        {process.env.NODE_ENV === "production" && <Analytics />}
      </body>
    </html>
  )
}
