import * as React from "react"
import { cva, type VariantProps } from "class-variance-authority"
import * as Slot from "@radix-ui/react-slot"

import { cn } from "@client/lib/utils"

/**
 * A short label with a tone. `soft` fills with the tone's wash; `outline`
 * draws the tone's border on no fill. Sizes: `xs` is 16px tall with 10px
 * text, `sm` 20px with 11px.
 */
const badgeVariants = cva(
  "group/badge inline-flex w-fit shrink-0 items-center justify-center gap-1 overflow-hidden rounded-full border border-transparent font-medium whitespace-nowrap transition-colors focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 [&>svg]:pointer-events-none",
  {
    variants: {
      tone: {
        neutral: "text-muted-foreground",
        info: "text-info",
        success: "text-success",
        warning: "text-warning",
        destructive: "text-destructive",
      },
      appearance: {
        soft: "",
        outline: "bg-transparent",
      },
      size: {
        xs: "h-4 px-1.5 text-(length:--text-micro) [&>svg]:size-2.5",
        sm: "h-5 px-2 text-(length:--text-label) [&>svg]:size-3",
      },
    },
    compoundVariants: [
      { appearance: "soft", tone: "neutral", className: "bg-muted-foreground/12" },
      { appearance: "soft", tone: "info", className: "bg-info-soft" },
      { appearance: "soft", tone: "success", className: "bg-success-soft" },
      { appearance: "soft", tone: "warning", className: "bg-warning-soft" },
      { appearance: "soft", tone: "destructive", className: "bg-destructive-soft" },
      { appearance: "outline", tone: "neutral", className: "border-border" },
      { appearance: "outline", tone: "info", className: "border-info-border" },
      { appearance: "outline", tone: "success", className: "border-success-border" },
      { appearance: "outline", tone: "warning", className: "border-warning-border" },
      { appearance: "outline", tone: "destructive", className: "border-destructive-border" },
    ],
    defaultVariants: {
      tone: "neutral",
      appearance: "soft",
      size: "sm",
    },
  }
)

type BadgeProps = React.ComponentProps<"span"> &
  VariantProps<typeof badgeVariants> & { asChild?: boolean }

function Badge({
  className,
  tone = "neutral",
  appearance = "soft",
  size = "sm",
  asChild = false,
  ...props
}: BadgeProps) {
  const Comp = asChild ? Slot.Root : "span"

  return (
    <Comp
      data-slot="badge"
      data-tone={tone}
      data-appearance={appearance}
      className={cn(badgeVariants({ tone, appearance, size }), className)}
      {...props}
    />
  )
}

export { Badge, badgeVariants }
export type { BadgeProps }
