// SPDX-License-Identifier: GPL-3.0-or-later
"use client"

import * as React from "react"
import { cva, type VariantProps } from "class-variance-authority"
import { cn } from "@/lib/utils"

const avatarVariants = cva(
  "relative flex shrink-0 overflow-hidden rounded-full border border-border/80 bg-secondary/50 font-mono font-medium text-foreground select-none",
  {
    variants: {
      size: {
        xs: "size-5 text-[10px]",
        sm: "size-7 text-xs",
        md: "size-8 text-xs",
        lg: "size-10 text-sm",
        xl: "size-12 text-base",
      },
      shape: {
        circle: "rounded-full",
        square: "rounded-md",
      },
    },
    defaultVariants: {
      size: "md",
      shape: "circle",
    },
  }
)

interface AvatarProps
  extends React.ComponentProps<"div">,
    VariantProps<typeof avatarVariants> {}

function Avatar({ className, size, shape, ...props }: AvatarProps) {
  return (
    <div
      data-slot="avatar"
      className={cn(avatarVariants({ size, shape }), className)}
      {...props}
    />
  )
}

function AvatarImage({
  className,
  src,
  alt,
  ...props
}: React.ComponentProps<"img">) {
  const [hasError, setHasError] = React.useState(false)

  if (!src || hasError) return null

  return (
    <img
      data-slot="avatar-image"
      src={src}
      alt={alt}
      onError={() => setHasError(true)}
      className={cn("aspect-square h-full w-full object-cover", className)}
      {...props}
    />
  )
}

function AvatarFallback({
  className,
  ...props
}: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="avatar-fallback"
      className={cn(
        "flex h-full w-full items-center justify-center bg-secondary text-muted-foreground",
        className
      )}
      {...props}
    />
  )
}

export { Avatar, AvatarImage, AvatarFallback }
