// SPDX-License-Identifier: GPL-3.0-or-later
"use client"

/**
 * Particle Button — adapted from KokonutUI (MIT, @dorianbaffier, kokonutui.com).
 *
 * Fires a short burst of achromatic particles from the button's centre on click. Kept because the
 * particles are `bg-black dark:bg-white`: on a deliberately hueless palette (see globals.css) a
 * saturated flourish would compete with the ok/warn/dead status colours, and this one does not.
 *
 * Changes from upstream, all of them fixes rather than taste:
 *  - upstream's handler never invoked the incoming `onClick`, so the prop silently did nothing;
 *    it also destructured `onSuccess` and never called it. Both now work, and the handler is no
 *    longer pointlessly `async`.
 *  - upstream imported a `ButtonProps` type this project's Button does not export. The props are
 *    derived from the component itself instead, so it cannot drift from the real signature.
 *  - upstream hardcoded a MousePointerClick icon into every instance. It is opt-in here: a
 *    primary CTA reading "Get an API key →" should not grow a cursor glyph.
 *  - the burst is skipped under prefers-reduced-motion, matching the click ripple in globals.css.
 */

import { MousePointerClick } from "lucide-react"
import { AnimatePresence, motion } from "motion/react"
import { type ComponentProps, useCallback, useRef, useState } from "react"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"

type ParticleButtonProps = ComponentProps<typeof Button> & {
  /** Called after the burst finishes, so a caller can chain a transition off it. */
  onSuccess?: () => void
  /** How long the particles live, ms. */
  successDuration?: number
  /** Append the upstream cursor glyph. Off by default. */
  showIcon?: boolean
}

const PARTICLE_COUNT = 6

/**
 * Base UI's Button hands its handlers an augmented event (it carries `preventBaseUIHandler`), not
 * a bare React.MouseEvent. Deriving the handler type from the prop keeps this correct if the
 * primitive's signature changes.
 */
type ButtonClickHandler = NonNullable<ComponentProps<typeof Button>["onClick"]>

function SuccessParticles({ origin }: { origin: { x: number; y: number } }) {
  return (
    <AnimatePresence>
      {Array.from({ length: PARTICLE_COUNT }, (_, i) => (
        <motion.div
          key={i}
          className="pointer-events-none fixed z-50 h-1 w-1 rounded-full bg-black dark:bg-white"
          style={{ left: origin.x, top: origin.y }}
          initial={{ scale: 0, x: 0, y: 0 }}
          animate={{
            scale: [0, 1, 0],
            x: [0, (i % 2 ? 1 : -1) * (Math.random() * 50 + 20)],
            y: [0, -Math.random() * 50 - 20],
          }}
          transition={{ duration: 0.6, delay: i * 0.1, ease: "easeOut" }}
        />
      ))}
    </AnimatePresence>
  )
}

export default function ParticleButton({
  children,
  onClick,
  onSuccess,
  successDuration = 1000,
  showIcon = false,
  className,
  ...props
}: ParticleButtonProps) {
  const [origin, setOrigin] = useState<{ x: number; y: number } | null>(null)
  // Typed to match Base UI's ref, which is HTMLButtonElement. With the `render` prop a caller can
  // emit this as an anchor instead (the landing CTA is a real link), so at runtime this may hold
  // an <a>. That is safe because the only thing read from it is getBoundingClientRect, which every
  // element has — but do not reach for button-specific members here.
  const buttonRef = useRef<HTMLButtonElement>(null)

  const handleClick = useCallback<ButtonClickHandler>(
    (event) => {
      // The caller's handler runs first and unconditionally: the burst is decoration, and a
      // decoration must never be able to swallow the actual action.
      onClick?.(event)

      const reduced =
        typeof window !== "undefined" &&
        window.matchMedia("(prefers-reduced-motion: reduce)").matches
      if (reduced) return

      const rect = buttonRef.current?.getBoundingClientRect()
      if (!rect) return
      setOrigin({ x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 })
      window.setTimeout(() => {
        setOrigin(null)
        onSuccess?.()
      }, successDuration)
    },
    [onClick, onSuccess, successDuration],
  )

  return (
    <>
      {origin && <SuccessParticles origin={origin} />}
      <Button
        ref={buttonRef}
        className={cn("relative transition-transform duration-100", origin && "scale-95", className)}
        onClick={handleClick}
        {...props}
      >
        {children}
        {showIcon && <MousePointerClick className="size-4" aria-hidden="true" />}
      </Button>
    </>
  )
}
