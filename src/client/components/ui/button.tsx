import * as React from "react"
import { cva, type VariantProps } from "class-variance-authority"
import * as Slot from "@radix-ui/react-slot"

import { cn } from "@client/lib/utils"

const buttonVariants = cva(
  // Type ramp: the default button sits on the UI step (13px), like the rows
  // and menus it appears beside; the compact sizes drop to the meta step.
  // Heights are the fixed control steps: buttons do not grow under the
  // density switch by themselves (touch sizing is opted into by containers
  // or an explicit size).
  "group/button inline-flex shrink-0 items-center justify-center rounded-(--radius-ctl) border border-transparent bg-clip-padding text-(length:--text-ui) font-medium whitespace-nowrap transition-all outline-none select-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 active:not-aria-[haspopup]:translate-y-px disabled:pointer-events-none disabled:opacity-(--disabled-opacity) aria-invalid:border-destructive aria-invalid:ring-3 aria-invalid:ring-destructive/20 dark:aria-invalid:border-destructive/50 dark:aria-invalid:ring-destructive/40 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-(--icon-md)",
  {
    variants: {
      variant: {
        default: "bg-primary text-primary-foreground hover:bg-primary/80",
        outline:
          "border-border bg-background hover:bg-muted hover:text-foreground aria-expanded:bg-muted aria-expanded:text-foreground dark:border-input dark:bg-input/30 dark:hover:bg-input/50",
        secondary:
          "bg-secondary text-secondary-foreground hover:bg-[color-mix(in_oklch,var(--secondary),var(--foreground)_5%)] aria-expanded:bg-secondary aria-expanded:text-secondary-foreground",
        ghost:
          "hover:bg-muted hover:text-foreground aria-expanded:bg-muted aria-expanded:text-foreground dark:hover:bg-muted/50",
        // Solid, and only for irreversible actions (delete, revoke, force
        // reset). Reversible ones such as Archive use a neutral variant.
        destructive:
          "bg-(--destructive-solid) text-white hover:bg-(--destructive-solid-hover) focus-visible:ring-destructive/30 dark:focus-visible:ring-destructive/40",
        // The outline in the destructive colour: a trigger (a danger zone's
        // Delete…) whose ConfirmDialog carries the solid red.
        "destructive-outline":
          "border-destructive-border bg-background text-destructive hover:bg-destructive-soft hover:text-destructive aria-expanded:bg-destructive-soft focus-visible:border-destructive focus-visible:ring-destructive/30 dark:bg-input/30 dark:hover:bg-destructive-soft dark:focus-visible:ring-destructive/40",
        link: "text-primary underline-offset-4 hover:underline",
      },
      size: {
        default:
          "h-(--control-md) gap-1.5 px-2.5 has-data-[icon=inline-end]:pr-2 has-data-[icon=inline-start]:pl-2",
        xs: "h-(--control-xs) gap-1 px-2 text-(length:--text-meta) has-data-[icon=inline-end]:pr-1.5 has-data-[icon=inline-start]:pl-1.5 [&_svg:not([class*='size-'])]:size-(--icon-xs)",
        sm: "h-(--control-sm) gap-1 px-2.5 text-(length:--text-meta) has-data-[icon=inline-end]:pr-1.5 has-data-[icon=inline-start]:pl-1.5 [&_svg:not([class*='size-'])]:size-(--icon-sm)",
        lg: "h-(--control-lg) gap-1.5 px-2.5 has-data-[icon=inline-end]:pr-2 has-data-[icon=inline-start]:pl-2",
        icon: "size-(--control-md)",
        "icon-xs":
          "size-(--control-xs) [&_svg:not([class*='size-'])]:size-(--icon-xs)",
        "icon-sm": "size-(--control-sm)",
        "icon-lg": "size-(--control-lg)",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  }
)

function Button({
  className,
  variant = "default",
  size = "default",
  asChild = false,
  ...props
}: React.ComponentProps<"button"> &
  VariantProps<typeof buttonVariants> & {
    asChild?: boolean
  }) {
  const Comp = asChild ? Slot.Root : "button"

  return (
    <Comp
      data-slot="button"
      data-variant={variant}
      data-size={size}
      className={cn(buttonVariants({ variant, size, className }))}
      {...props}
    />
  )
}

export { Button, buttonVariants }
