import { ImageResponse } from "next/og"

export const alt = "ArchiveTune Source Pool — live status for Tidal, Qobuz and Deezer sources"
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
        backgroundColor: "#0a0b0d",
        padding: "72px",
        fontFamily: "sans-serif",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: "16px" }}>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            width: "44px",
            height: "44px",
            borderRadius: "10px",
            backgroundColor: "#22242a",
            border: "1px solid rgba(255,255,255,0.14)",
            color: "#f5f6f7",
            fontSize: "18px",
            fontWeight: 600,
          }}
        >
          AT
        </div>
        <div
          style={{
            display: "flex",
            color: "#a2a6ad",
            fontSize: "22px",
            letterSpacing: "0.14em",
            textTransform: "uppercase",
          }}
        >
          ArchiveTune · Source Pool
        </div>
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: "24px" }}>
        <div
          style={{
            display: "flex",
            color: "#f5f6f7",
            fontSize: "76px",
            fontWeight: 600,
            letterSpacing: "-0.03em",
            lineHeight: 1.05,
          }}
        >
          Live status for every source in the pool
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: "14px" }}>
          <div
            style={{
              display: "flex",
              width: "12px",
              height: "12px",
              borderRadius: "999px",
              backgroundColor: "#37c98a",
            }}
          />
          <div style={{ display: "flex", color: "#a2a6ad", fontSize: "28px" }}>
            Tidal · Qobuz · Deezer — health-checked every 30 minutes
          </div>
        </div>
      </div>
    </div>,
    size,
  )
}
