// SPDX-License-Identifier: GPL-3.0-or-later
"use client"

import { useEffect, useRef, useState } from "react"
import { cn } from "@/lib/utils"

interface Pulse {
  rayAngle: number
  z: number // 1 (far/horizon) to 0.05 (near camera)
  speed: number
  length: number
  hue: number // 265 (violet), 160 (emerald), 195 (cyan)
  size: number
}

export interface RailwayGridBgProps {
  className?: string
  horizonY?: number // Normalized position of horizon (0.25 to 0.40)
  speed?: number // Flight speed multiplier
  interactive?: boolean
}

export function RailwayGridBg({
  className,
  horizonY = 0.28,
  speed = 1.0,
  interactive = true,
}: RailwayGridBgProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const [isDark, setIsDark] = useState(true)

  // Listen to dark mode changes
  useEffect(() => {
    const updateTheme = () => {
      setIsDark(document.documentElement.classList.contains("dark"))
    }
    updateTheme()

    const observer = new MutationObserver((mutations) => {
      for (const m of mutations) {
        if (m.type === "attributes" && m.attributeName === "class") {
          updateTheme()
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

    const reducedMotion =
      typeof window !== "undefined" &&
      window.matchMedia?.("(prefers-reduced-motion: reduce)").matches

    let animId = 0
    let lastTime = performance.now()
    let width = 0
    let height = 0
    let isVisible = true

    // Mouse tracker with smooth spring interpolation (lerp)
    const cursor = {
      x: -1,
      y: -1,
      targetX: -1,
      targetY: -1,
      heat: 0,
    }

    // Active energy pulses traversing perspective rays
    const pulses: Pulse[] = []
    const MAX_PULSES = 16
    const HUES = [265, 275, 160, 195, 290] // Violet, Indigo, Emerald, Cyan, Magenta

    const spawnPulse = () => {
      if (pulses.length >= MAX_PULSES) return
      // Spread across rays
      const angles = [-0.95, -0.75, -0.55, -0.35, -0.18, 0, 0.18, 0.35, 0.55, 0.75, 0.95]
      const rayAngle = angles[Math.floor(Math.random() * angles.length)]
      pulses.push({
        rayAngle,
        z: 0.98, // starts near horizon
        speed: (0.002 + Math.random() * 0.0035) * speed,
        length: 0.08 + Math.random() * 0.12,
        hue: HUES[Math.floor(Math.random() * HUES.length)],
        size: 2.0 + Math.random() * 2.5,
      })
    }

    // Initial pulses
    for (let i = 0; i < 8; i++) {
      spawnPulse()
      if (pulses[i]) pulses[i].z = Math.random() * 0.8 + 0.1
    }

    const resize = () => {
      const rect = canvas.getBoundingClientRect()
      const dpr = Math.min(window.devicePixelRatio || 1, 2)
      width = rect.width
      height = rect.height
      canvas.width = Math.round(width * dpr)
      canvas.height = Math.round(height * dpr)
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    }

    let zOffset = 0

    const render = (now: number) => {
      const dt = Math.min((now - lastTime) / 1000, 0.1)
      lastTime = now

      if (!reducedMotion) {
        zOffset += dt * 0.28 * speed
        if (zOffset > 1) zOffset -= 1

        // Smooth cursor lerp
        if (cursor.targetX >= 0) {
          cursor.x += (cursor.targetX - cursor.x) * 0.09
          cursor.y += (cursor.targetY - cursor.y) * 0.09
          cursor.heat += (1 - cursor.heat) * 0.08
        } else {
          cursor.heat += (0 - cursor.heat) * 0.04
        }
      }

      ctx.clearRect(0, 0, width, height)

      const horizon = height * horizonY
      const fov = height * 0.82
      const groundHeight = height - horizon

      // Subtle ambient background gradient
      if (isDark) {
        const bgGrad = ctx.createRadialGradient(
          width / 2,
          horizon,
          10,
          width / 2,
          height * 0.6,
          Math.max(width, height) * 0.8
        )
        bgGrad.addColorStop(0, "rgba(22, 16, 42, 0.45)")
        bgGrad.addColorStop(0.35, "rgba(10, 10, 22, 0.65)")
        bgGrad.addColorStop(1, "rgba(3, 3, 6, 0.95)")
        ctx.fillStyle = bgGrad
        ctx.fillRect(0, 0, width, height)
      } else {
        const bgGrad = ctx.createRadialGradient(
          width / 2,
          horizon,
          10,
          width / 2,
          height * 0.6,
          Math.max(width, height) * 0.8
        )
        bgGrad.addColorStop(0, "rgba(240, 235, 255, 0.5)")
        bgGrad.addColorStop(1, "rgba(248, 248, 252, 0.8)")
        ctx.fillStyle = bgGrad
        ctx.fillRect(0, 0, width, height)
      }

      // Draw Horizon soft glow line
      const horizonGlow = ctx.createLinearGradient(0, horizon - 20, 0, horizon + 20)
      if (isDark) {
        horizonGlow.addColorStop(0, "rgba(139, 92, 246, 0)")
        horizonGlow.addColorStop(0.5, "rgba(168, 85, 247, 0.28)")
        horizonGlow.addColorStop(1, "rgba(139, 92, 246, 0)")
      } else {
        horizonGlow.addColorStop(0, "rgba(124, 58, 237, 0)")
        horizonGlow.addColorStop(0.5, "rgba(124, 58, 237, 0.12)")
        horizonGlow.addColorStop(1, "rgba(124, 58, 237, 0)")
      }
      ctx.fillStyle = horizonGlow
      ctx.fillRect(0, horizon - 20, width, 40)

      // Perspective Grid System
      // 1. Vertical perspective lines radiating from vanishing point
      const RAY_COUNT = 34
      const vpX = width / 2
      const vpY = horizon

      // Project ground point (xWorld, zWorld) to 2D
      // z goes from ~0.08 (closest to bottom) to 1.0 (at horizon)
      const project = (xNorm: number, zNorm: number) => {
        // Perspective scaling: depth factor = 1 / zNorm
        const depth = 1 / Math.max(0.04, zNorm)
        const screenX = vpX + xNorm * depth * (width * 0.32)
        const screenY = vpY + (1 - zNorm) * groundHeight
        return { x: screenX, y: screenY }
      }

      // Base line colors
      const baseLineColor = isDark
        ? "rgba(139, 92, 246, 0.14)"
        : "rgba(109, 40, 217, 0.10)"
      const baseLineColorBright = isDark
        ? "rgba(192, 132, 252, 0.28)"
        : "rgba(109, 40, 217, 0.22)"

      ctx.lineWidth = 1

      // Draw vertical radiating rays
      for (let i = -RAY_COUNT / 2; i <= RAY_COUNT / 2; i++) {
        const xNorm = (i / (RAY_COUNT / 2)) * 1.6
        const pFar = project(xNorm, 0.98)
        const pNear = project(xNorm, 0.05)

        // Mouse proximity brightening along this ray
        let boost = 0
        if (interactive && cursor.heat > 0.02) {
          const midX = (pFar.x + pNear.x) / 2
          const midY = (pFar.y + pNear.y) / 2
          const dist = Math.hypot(cursor.x - midX, cursor.y - midY)
          boost = Math.max(0, 1 - dist / (width * 0.35)) * cursor.heat * 0.4
        }

        ctx.strokeStyle = boost > 0.1 ? baseLineColorBright : baseLineColor
        ctx.beginPath()
        ctx.moveTo(pFar.x, pFar.y)
        ctx.lineTo(pNear.x, pNear.y)
        ctx.stroke()
      }

      // 2. Horizontal scanline rungs with exponential perspective depth
      const RUNG_COUNT = 24
      for (let r = 0; r < RUNG_COUNT; r++) {
        // Compute moving z depth from 1.0 down to ~0.04
        const normR = (r + zOffset) / RUNG_COUNT
        // Exponential distribution: rungs spread wider as they approach camera
        const z = Math.pow(1 - normR, 1.9) * 0.94 + 0.04

        const pLeft = project(-2.2, z)
        const pRight = project(2.2, z)

        // Alpha fades near horizon and near bottom
        const alpha = Math.sin(normR * Math.PI)
        const rungAlpha = isDark ? alpha * 0.22 : alpha * 0.14

        // Mouse spotlight boost for this rung
        let mouseBoost = 0
        if (interactive && cursor.heat > 0.02) {
          const dy = Math.abs(cursor.y - pLeft.y)
          if (dy < 120) {
            mouseBoost = (1 - dy / 120) * cursor.heat * 0.4
          }
        }

        ctx.strokeStyle = isDark
          ? `rgba(168, 85, 247, ${Math.min(1, rungAlpha + mouseBoost)})`
          : `rgba(124, 58, 237, ${Math.min(1, rungAlpha + mouseBoost * 0.6)})`
        ctx.lineWidth = mouseBoost > 0.1 ? 1.4 : 1

        ctx.beginPath()
        ctx.moveTo(pLeft.x, pLeft.y)
        ctx.lineTo(pRight.x, pRight.y)
        ctx.stroke()

        // Highlight intersection dots near cursor
        if (interactive && cursor.heat > 0.05 && mouseBoost > 0.15) {
          for (let i = -8; i <= 8; i++) {
            const xNorm = (i / 8) * 1.4
            const pt = project(xNorm, z)
            const d = Math.hypot(cursor.x - pt.x, cursor.y - pt.y)
            if (d < 160) {
              const dotAlpha = (1 - d / 160) * cursor.heat
              ctx.fillStyle = isDark
                ? `rgba(216, 180, 254, ${dotAlpha * 0.9})`
                : `rgba(147, 51, 234, ${dotAlpha * 0.7})`
              ctx.beginPath()
              ctx.arc(pt.x, pt.y, 1.8, 0, Math.PI * 2)
              ctx.fill()
            }
          }
        }
      }

      // 3. Render glowing pulse energy packets
      if (!reducedMotion) {
        if (Math.random() < 0.04) {
          spawnPulse()
        }

        for (let i = pulses.length - 1; i >= 0; i--) {
          const p = pulses[i]
          p.z -= p.speed * (1.6 - p.z * 0.6) // accelerates as it approaches camera

          if (p.z <= 0.04) {
            pulses.splice(i, 1)
            continue
          }

          const head = project(p.rayAngle, p.z)
          const tailZ = Math.min(0.99, p.z + p.length)
          const tail = project(p.rayAngle, tailZ)

          // Proximity to mouse increases glow
          let pulseGlow = 1.0
          if (interactive && cursor.heat > 0.05) {
            const dist = Math.hypot(cursor.x - head.x, cursor.y - head.y)
            if (dist < 220) {
              pulseGlow += (1 - dist / 220) * 1.2
            }
          }

          // Beam line
          const beamGrad = ctx.createLinearGradient(tail.x, tail.y, head.x, head.y)
          beamGrad.addColorStop(0, `hsla(${p.hue}, 85%, 65%, 0)`)
          beamGrad.addColorStop(
            0.7,
            `hsla(${p.hue}, 90%, 65%, ${Math.min(1, 0.45 * pulseGlow)})`
          )
          beamGrad.addColorStop(
            1,
            `hsla(${p.hue}, 100%, 75%, ${Math.min(1, 0.9 * pulseGlow)})`
          )

          ctx.strokeStyle = beamGrad
          ctx.lineWidth = Math.max(1.5, p.size * (1 / (p.z + 0.2)) * 0.35)
          ctx.beginPath()
          ctx.moveTo(tail.x, tail.y)
          ctx.lineTo(head.x, head.y)
          ctx.stroke()

          // Pulse glowing tip
          const tipRadius = Math.max(2, p.size * (1 / (p.z + 0.3)) * 0.45 * pulseGlow)
          const tipGrad = ctx.createRadialGradient(
            head.x,
            head.y,
            0,
            head.x,
            head.y,
            tipRadius * 3
          )
          tipGrad.addColorStop(0, `hsla(${p.hue}, 100%, 85%, ${Math.min(1, 0.95 * pulseGlow)})`)
          tipGrad.addColorStop(
            0.4,
            `hsla(${p.hue}, 90%, 60%, ${Math.min(1, 0.45 * pulseGlow)})`
          )
          tipGrad.addColorStop(1, `hsla(${p.hue}, 90%, 60%, 0)`)

          ctx.fillStyle = tipGrad
          ctx.beginPath()
          ctx.arc(head.x, head.y, tipRadius * 3, 0, Math.PI * 2)
          ctx.fill()
        }
      }

      // 4. Interactive Spotlight Cursor Halo
      if (interactive && cursor.heat > 0.01) {
        const spotRadius = Math.min(width * 0.28, 280)
        const spotGrad = ctx.createRadialGradient(
          cursor.x,
          cursor.y,
          0,
          cursor.x,
          cursor.y,
          spotRadius
        )
        if (isDark) {
          spotGrad.addColorStop(0, `rgba(168, 85, 247, ${0.16 * cursor.heat})`)
          spotGrad.addColorStop(0.5, `rgba(99, 102, 241, ${0.08 * cursor.heat})`)
          spotGrad.addColorStop(1, "rgba(99, 102, 241, 0)")
        } else {
          spotGrad.addColorStop(0, `rgba(147, 51, 234, ${0.10 * cursor.heat})`)
          spotGrad.addColorStop(0.5, `rgba(99, 102, 241, ${0.04 * cursor.heat})`)
          spotGrad.addColorStop(1, "rgba(99, 102, 241, 0)")
        }

        ctx.fillStyle = spotGrad
        ctx.beginPath()
        ctx.arc(cursor.x, cursor.y, spotRadius, 0, Math.PI * 2)
        ctx.fill()
      }

      // 5. Atmospheric Vignette Overlay (fades out edges and top)
      const topVignette = ctx.createLinearGradient(0, 0, 0, horizon * 1.5)
      if (isDark) {
        topVignette.addColorStop(0, "rgba(3, 3, 6, 0.95)")
        topVignette.addColorStop(0.5, "rgba(3, 3, 6, 0.65)")
        topVignette.addColorStop(1, "rgba(3, 3, 6, 0)")
      } else {
        topVignette.addColorStop(0, "rgba(248, 248, 252, 0.95)")
        topVignette.addColorStop(0.5, "rgba(248, 248, 252, 0.65)")
        topVignette.addColorStop(1, "rgba(248, 248, 252, 0)")
      }
      ctx.fillStyle = topVignette
      ctx.fillRect(0, 0, width, horizon * 1.5)

      // Bottom edge fade
      const bottomVignette = ctx.createLinearGradient(0, height - 140, 0, height)
      if (isDark) {
        bottomVignette.addColorStop(0, "rgba(3, 3, 6, 0)")
        bottomVignette.addColorStop(1, "rgba(3, 3, 6, 0.85)")
      } else {
        bottomVignette.addColorStop(0, "rgba(248, 248, 252, 0)")
        bottomVignette.addColorStop(1, "rgba(248, 248, 252, 0.75)")
      }
      ctx.fillStyle = bottomVignette
      ctx.fillRect(0, height - 140, width, 140)
    }

    const loop = (time: number) => {
      if (isVisible) {
        render(time)
      }
      animId = requestAnimationFrame(loop)
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

    const onVisibilityChange = () => {
      isVisible = document.visibilityState === "visible"
    }
    document.addEventListener("visibilitychange", onVisibilityChange)

    // Pointer events on window so cursor glows anywhere on screen
    const onPointerMove = (e: PointerEvent) => {
      cursor.targetX = e.clientX
      cursor.targetY = e.clientY
      if (cursor.x < 0) {
        cursor.x = e.clientX
        cursor.y = e.clientY
      }
    }

    const onPointerLeave = () => {
      cursor.targetX = -1
      cursor.targetY = -1
    }

    if (interactive && !reducedMotion) {
      window.addEventListener("pointermove", onPointerMove, { passive: true })
      document.addEventListener("pointerleave", onPointerLeave)
    }

    return () => {
      cancelAnimationFrame(animId)
      resizeObserver.disconnect()
      document.removeEventListener("visibilitychange", onVisibilityChange)
      if (interactive && !reducedMotion) {
        window.removeEventListener("pointermove", onPointerMove)
        document.removeEventListener("pointerleave", onPointerLeave)
      }
    }
  }, [horizonY, speed, interactive, isDark])

  return (
    <div
      aria-hidden="true"
      className={cn(
        "pointer-events-none fixed inset-0 -z-10 overflow-hidden select-none",
        className
      )}
    >
      <canvas
        ref={canvasRef}
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 h-full w-full"
      />
    </div>
  )
}
