// SPDX-License-Identifier: GPL-3.0-or-later
"use client"

import { useEffect } from "react"

/**
 * Spawns a short-lived expanding ring at every pointer-down position.
 * Pure DOM: no React state, no re-renders, nodes self-clean after animating.
 * The ring itself lives in globals.css and is hidden under prefers-reduced-motion.
 */
export function ClickRipple() {
  useEffect(() => {
    const onPointerDown = (e: PointerEvent) => {
      // Skip synthetic/keyboard-triggered clicks with no real coordinates.
      if (e.clientX === 0 && e.clientY === 0) return
      const ring = document.createElement("span")
      ring.className = "click-ping"
      ring.style.left = `${e.clientX}px`
      ring.style.top = `${e.clientY}px`
      ring.setAttribute("aria-hidden", "true")
      document.body.appendChild(ring)
      ring.addEventListener("animationend", () => ring.remove(), { once: true })
      // Fallback cleanup in case animationend never fires.
      setTimeout(() => ring.remove(), 800)
    }
    window.addEventListener("pointerdown", onPointerDown, { passive: true })
    return () => window.removeEventListener("pointerdown", onPointerDown)
  }, [])

  return null
}
