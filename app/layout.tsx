import { Analytics } from "@vercel/analytics/next"
import type { Metadata, Viewport } from "next"
import { Geist, Geist_Mono } from "next/font/google"
import type React from "react"
import { ClickRipple } from "@/components/click-ripple"
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
  colorScheme: "dark",
  width: "device-width",
  initialScale: 1,
  maximumScale: 5,
  viewportFit: "cover",
  // Matches --background (oklch(0.1 0 0)) so mobile browser chrome blends into the page instead
  // of banding. Re-sample if the token changes: this is a build-time string, not a CSS read.
  themeColor: "#030303",
}

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode
}>) {
  return (
    <html lang="en" className={`dark ${geistSans.variable} ${geistMono.variable}`}>
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
        {process.env.NODE_ENV === "production" && <Analytics />}
      </body>
    </html>
  )
}
