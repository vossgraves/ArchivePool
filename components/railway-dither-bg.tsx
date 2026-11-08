// SPDX-License-Identifier: GPL-3.0-or-later
"use client"

import { useEffect, useRef, useState } from "react"
import { cn } from "@/lib/utils"

// 8x8 Bayer threshold matrix normalized to (0..1)
const BAYER_8X8 = [
  0, 32, 8, 40, 2, 34, 10, 42,
  48, 16, 56, 24, 50, 18, 58, 26,
  12, 44, 4, 36, 14, 46, 6, 38,
  60, 28, 52, 20, 62, 30, 54, 22,
  3, 35, 11, 43, 1, 33, 9, 41,
  51, 19, 59, 27, 49, 17, 57, 25,
  15, 47, 7, 39, 13, 45, 5, 37,
  63, 31, 55, 23, 61, 29, 53, 21,
].map((v) => (v + 0.5) / 64)

const PALETTES = {
  dark: {
    dim: "rgba(139, 122, 230, 0.45)",
    bright: "rgba(189, 175, 255, 0.85)",
  },
  light: {
    dim: "rgba(93, 72, 125, 0.22)",
    bright: "rgba(93, 72, 125, 0.55)",
  },
}

function calculateShape(
  shape: "band" | "rise" | "fall" | "glow",
  uNorm: number,
  pNorm: number,
  center: number,
  timeSec: number,
): number {
  switch (shape) {
    case "band": {
      const e = (pNorm - (center + Math.sin(timeSec * 0.35) * 0.03)) / 0.22
      return Math.exp(-e * e)
    }
    case "rise":
      return pNorm ** 2.2
    case "fall":
      return (1 - pNorm) ** 2.2
    case "glow": {
      const e = (uNorm - 0.5) / 0.45
      const r = (pNorm - 0.55) / 0.5
      return Math.max(0, 1 - Math.sqrt(e * e + r * r))
    }
    default:
      return 0.5
  }
}

export interface RailwayDitherBgProps {
  shape?: "band" | "rise" | "fall" | "glow"
  cell?: number
  strength?: number
  center?: number
  interactive?: boolean
  className?: string
}

export function RailwayDitherBg({
  shape = "band",
  cell = 6,
  strength = 0.92,
  center = 0.28,
  interactive = true,
  className,
}: RailwayDitherBgProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const [isDark, setIsDark] = useState(true)

  // Listen to dark mode changes on document.documentElement
  useEffect(() => {
    const checkDark = () => {
      setIsDark(document.documentElement.classList.contains("dark"))
    }
    checkDark()

    const observer = new MutationObserver((mutations) => {
      for (const m of mutations) {
        if (m.type === "attributes" && m.attributeName === "class") {
          checkDark()
        }
      }
    })
    observer.observe(document.documentElement, { attributes: true })
    return () => observer.disconnect()
  }, [])

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext("2d")
    if (!ctx) return

    const reducedMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches
    const cursor = { x: -1, y: -1, heat: 0 }
    let isVisible = true
    let animId = 0
    let lastRenderTime = 0
    let width = 0
    let height = 0

    const resize = () => {
      const rect = canvas.getBoundingClientRect()
      const dpr = Math.min(window.devicePixelRatio || 1, 2)
      width = rect.width
      height = rect.height
      canvas.width = Math.round(width * dpr)
      canvas.height = Math.round(height * dpr)
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    }

    const palette = isDark ? PALETTES.dark : PALETTES.light

    const render = (timeMs: number) => {
      const timeSec = timeMs / 1000
      ctx.clearRect(0, 0, width, height)

      const cols = Math.ceil(width / cell)
      const rows = Math.ceil(height / cell)
      const dotSize = Math.max(1.5, cell * 0.38)

      // Heat transitions towards active cursor or cools down
      cursor.heat += ((cursor.x >= 0 ? 1 : 0) - cursor.heat) * 0.08

      for (let r = 0; r < rows; r++) {
        const p = rows > 1 ? r / (rows - 1) : 0
        for (let c = 0; c < cols; c++) {
          const u = cols > 1 ? c / (cols - 1) : 0
          let val = calculateShape(shape, u, p, center, timeSec) * strength

          // Undulating wave pattern (exact Railway formula)
          val += 0.07 * Math.sin(c * 0.13 + timeSec * 0.9) * Math.sin(r * 0.19 - timeSec * 0.6)

          // Interactive pointer glow
          if (interactive && cursor.heat > 0.01) {
            const dx = c * cell - cursor.x
            const dy = r * cell - cursor.y
            val += 0.55 * cursor.heat * Math.exp(-(dx * dx + dy * dy) / 16000)
          }

          const threshold = BAYER_8X8[(r % 8) * 8 + (c % 8)]
          if (val > threshold) {
            ctx.fillStyle = val - threshold > 0.3 ? palette.bright : palette.dim
            ctx.fillRect(c * cell, r * cell, dotSize, dotSize)
          }
        }
      }
    }

    const loop = (now: number) => {
      animId = requestAnimationFrame(loop)
      if (!isVisible || now - lastRenderTime < 33) return // cap at ~30-40fps for high efficiency
      lastRenderTime = now
      render(now)
    }

    resize()

    if (reducedMotion) {
      render(0)
    } else {
      animId = requestAnimationFrame(loop)
    }

    const resizeObserver = new ResizeObserver(() => {
      resize()
      if (reducedMotion) render(0)
    })
    resizeObserver.observe(canvas)

    const intersectionObserver = new IntersectionObserver(([entry]) => {
      isVisible = entry.isIntersecting
    })
    intersectionObserver.observe(canvas)

    // Interactive pointer movement across the whole viewport/parent
    const onPointerMove = (e: PointerEvent) => {
      const rect = canvas.getBoundingClientRect()
      cursor.x = e.clientX - rect.left
      cursor.y = e.clientY - rect.top
    }
    const onPointerLeave = () => {
      cursor.x = -1
      cursor.y = -1
    }

    if (interactive && !reducedMotion) {
      window.addEventListener("pointermove", onPointerMove, { passive: true })
      document.addEventListener("pointerleave", onPointerLeave)
    }

    return () => {
      cancelAnimationFrame(animId)
      resizeObserver.disconnect()
      intersectionObserver.disconnect()
      if (interactive && !reducedMotion) {
        window.removeEventListener("pointermove", onPointerMove)
        document.removeEventListener("pointerleave", onPointerLeave)
      }
    }
  }, [shape, cell, strength, center, interactive, isDark])

  return (
    <div
      aria-hidden="true"
      className={cn(
        "pointer-events-none absolute inset-x-0 top-0 h-[1050px] md:h-[1250px] overflow-hidden -z-10",
        className,
      )}
    >
      <canvas
        ref={canvasRef}
        aria-hidden="true"
        style={{
          ["--dither-mask" as any]:
            "linear-gradient(to bottom, transparent 0%, #000 14%, #000 42%, transparent 78%), radial-gradient(ellipse 36% 17% at 50% 28%, rgba(0,0,0,0.08) 55%, #000 100%)",
          ["--dither-mask-mobile" as any]:
            "linear-gradient(to bottom, transparent 0%, #000 12%, #000 40%, transparent 72%), radial-gradient(ellipse 110% 15% at 50% 25%, rgba(0,0,0,0.06) 60%, #000 100%)",
        }}
        className="pointer-events-none absolute inset-0 h-full w-full [mask-image:var(--dither-mask-mobile)] sm:[mask-image:var(--dither-mask)] [-webkit-mask-image:var(--dither-mask-mobile)] sm:[-webkit-mask-image:var(--dither-mask)] [mask-composite:intersect] [-webkit-mask-composite:source-in]"
      />
    </div>
  )
}
