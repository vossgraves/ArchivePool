// SPDX-License-Identifier: GPL-3.0-or-later
import * as React from "react"
import { cva, type VariantProps } from "class-variance-authority"
import { cn } from "@/lib/utils"

const skeletonVariants = cva(
  "animate-pulse bg-secondary/70 transition-colors",
  {
    variants: {
      variant: {
        default: "rounded-md",
        circular: "rounded-full",
        rounded: "rounded-lg",
        pill: "rounded-full",
      },
      shimmer: {
        true: "relative overflow-hidden before:absolute before:inset-0 before:-translate-x-full before:animate-[shimmer_1.5s_infinite] before:bg-gradient-to-r before:from-transparent before:via-foreground/5 before:to-transparent",
        false: "",
      },
    },
    defaultVariants: {
      variant: "default",
      shimmer: false,
    },
  }
)

export interface SkeletonProps
  extends React.ComponentProps<"div">,
    VariantProps<typeof skeletonVariants> {}

function Skeleton({ className, variant, shimmer, ...props }: SkeletonProps) {
  return (
    <div
      data-slot="skeleton"
      aria-hidden="true"
      className={cn(skeletonVariants({ variant, shimmer }), className)}
      {...props}
    />
  )
}

export { Skeleton, skeletonVariants }
