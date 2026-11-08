// SPDX-License-Identifier: GPL-3.0-or-later
import { ImageResponse } from "next/og"
import { BRAND_MARK } from "@/components/brand-mark"

export const alt = "ArchivePool · Streaming Source Infrastructure & Live Health Pool"
export const size = { width: 1200, height: 630 }
export const contentType = "image/png"

/*
 * Rendered at build/request time by Satori, which supports only a subset of CSS: no CSS
 * variables, no Tailwind classes, and every element needs an explicit display. Hence the
 * hardcoded hex values — they mirror the tokens in globals.css.
 */
export default function OpengraphImage() {
  return new ImageResponse(
    <div
      style={{
        width: "100%",
        height: "100%",
        display: "flex",
        flexDirection: "column",
        justifyContent: "space-between",
        backgroundColor: "#09090b",
        padding: "72px",
        fontFamily: "sans-serif",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: "16px" }}>
        {/* The real app mark, sharing its geometry with components/brand-mark.tsx and
            app/icon.svg. Satori cannot import an SVG file or read CSS variables, so the paths and
            colours come through the exported BRAND_MARK constants instead of being retyped. */}
        <svg width="46" height="46" viewBox="0 0 185 185">
          <circle cx="92.5" cy="92.5" r="92.5" fill={BRAND_MARK.disc} />
          {/* Ring is invisible on this dark card, but kept so the mark is identical everywhere. */}
          <circle
            cx="92.5"
            cy="92.5"
            r="90.5"
            fill="none"
            stroke={BRAND_MARK.navy}
            strokeOpacity="0.16"
            strokeWidth="4"
          />
          <g fill={BRAND_MARK.navy} transform={BRAND_MARK.recentre}>
            <path d={BRAND_MARK.PATH_BAR} />
            <path d={BRAND_MARK.PATH_STEM} />
          </g>
        </svg>
        <div
          style={{
            display: "flex",
            color: "#a1a1aa",
            fontSize: "24px",
            letterSpacing: "0.1em",
            textTransform: "uppercase",
          }}
        >
          ArchivePool · Streaming Infrastructure
        </div>
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: "20px" }}>
        <div
          style={{
            display: "flex",
            color: "#fafafa",
            fontSize: "68px",
            fontWeight: 800,
            letterSpacing: "-0.03em",
            lineHeight: 1.05,
          }}
        >
          Source Pool & Health Telemetry
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: "14px" }}>
          <div
            style={{
              display: "flex",
              width: "12px",
              height: "12px",
              borderRadius: "999px",
              backgroundColor: "#10b981",
            }}
          />
          <div style={{ display: "flex", color: "#a1a1aa", fontSize: "28px" }}>
            E2E Encrypted · Continuous Synthetic Sweeps · Scoped API Keys
          </div>
        </div>
      </div>
    </div>,
    size,
  )
}
