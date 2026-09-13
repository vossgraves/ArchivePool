import { Analytics } from "@vercel/analytics/next"
import type { Metadata, Viewport } from "next"
import { Geist, Geist_Mono } from "next/font/google"
import type React from "react"
import { ClickRipple } from "@/components/click-ripple"
import { Toaster } from "@/components/ui/sonner"
import "./globals.css"

const geistSans = Geist({ subsets: ["latin"], variable: "--font-geist-sans" })
const geistMono = Geist_Mono({ subsets: ["latin"], variable: "--font-geist-mono" })

export const metadata: Metadata = {
  title: {
    default: "ArchiveTune Source Pool",
    template: "%s · ArchiveTune Source Pool",
  },
  // Deezer is a live category in lib/sources.ts, so it belongs in the description too.
  description:
    "Live health for the community-contributed Tidal, Qobuz and Deezer sources behind ArchiveTune. Every entry is checked on a schedule; only passing entries are served.",
  applicationName: "ArchiveTune Source Pool",
  // Without this, Next resolves the opengraph-image to http://localhost:3000 in production and
  // the social preview silently breaks. Prefers an explicit site URL, then the deploy URL the
  // host injects (VERCEL_URL on Vercel, RAILWAY_PUBLIC_DOMAIN on Railway, neither of which
  // includes a scheme), and only falls back to localhost for local dev.
  metadataBase: new URL(
    process.env.NEXT_PUBLIC_SITE_URL ??
      (process.env.VERCEL_PROJECT_PRODUCTION_URL
        ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}`
        : process.env.RAILWAY_PUBLIC_DOMAIN
          ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}`
          : "http://localhost:3000"),
  ),
  openGraph: {
    title: "ArchiveTune Source Pool",
    description:
      "Live health for the community-contributed Tidal, Qobuz and Deezer sources behind ArchiveTune.",
    type: "website",
    siteName: "ArchiveTune Source Pool",
  },
  twitter: {
    card: "summary_large_image",
    title: "ArchiveTune Source Pool",
    description:
      "Live health for the community-contributed Tidal, Qobuz and Deezer sources behind ArchiveTune.",
  },
  // A status page has nothing to gain from search traffic and the submit form is not a landing
  // page, so keep it out of indexes.
  robots: { index: false, follow: false },
  generator: "v0.app",
}

export const viewport: Viewport = {
  colorScheme: "dark light",
  width: "device-width",
  initialScale: 1,
  maximumScale: 5,
  viewportFit: "cover",
  // Matches --background in each theme so mobile browser chrome blends into the page instead of
  // banding. Re-sample if a token changes: these are build-time strings, not CSS reads.
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
      <body className="grain bg-background text-foreground font-sans antialiased">
        {/* Keyboard and screen-reader users can jump past the header straight to content. */}
        <a
          href="#content"
          className="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-[60] focus:rounded-md focus:bg-foreground focus:px-4 focus:py-2 focus:text-sm focus:font-medium focus:text-background"
        >
          Skip to content
        </a>
        {children}
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
