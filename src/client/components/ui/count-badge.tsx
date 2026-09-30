import * as React from "react"
import { cva, type VariantProps } from "class-variance-authority"

import { cn } from "@client/lib/utils"

const countBadgeVariants = cva(
  "inline-flex h-4 min-w-4 shrink-0 items-center justify-center rounded-full px-1 text-(length:--text-micro) leading-none font-semibold tabular-nums",
  {
    variants: {
      tone: {
        neutral: "bg-muted-foreground/12 text-muted-foreground",
        primary: "bg-primary text-primary-foreground",
        warning: "bg-warning text-background",
        destructive: "bg-(--destructive-solid) text-white",
      },
    },
    defaultVariants: { tone: "neutral" },
  }
)

/** A small count (tab totals, unread items). Counts above `max` read "99+". */
function CountBadge({
  count,
  max = 99,
  tone = "neutral",
  className,
  ...props
}: Omit<React.ComponentProps<"span">, "children"> &
  VariantProps<typeof countBadgeVariants> & {
    count: number
    max?: number
  }) {
  return (
    <span
      data-slot="count-badge"
      data-tone={tone}
      className={cn(countBadgeVariants({ tone }), className)}
      {...props}
    >
      {count > max ? `${max}+` : count}
    </span>
  )
}

export { CountBadge, countBadgeVariants }
