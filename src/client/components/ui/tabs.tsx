import * as React from "react"
import { Tabs as TabsPrimitive } from "radix-ui"

import { cn } from "@client/lib/utils"

/**
 * Underlined tabs: a row of triggers over a hairline, the active one marked
 * by a 2px foreground underline. Triggers keep at least the control height
 * of the density switch, so they stay touch targets.
 */
function Tabs({
  className,
  ...props
}: React.ComponentProps<typeof TabsPrimitive.Root>) {
  return (
    <TabsPrimitive.Root
      data-slot="tabs"
      className={cn("flex min-w-0 flex-col gap-4", className)}
      {...props}
    />
  )
}

function TabsList({
  className,
  ...props
}: React.ComponentProps<typeof TabsPrimitive.List>) {
  return (
    <TabsPrimitive.List
      data-slot="tabs-list"
      className={cn(
        "flex min-w-0 items-stretch gap-1 overflow-x-auto border-b border-border-soft [scrollbar-width:none]",
        className
      )}
      {...props}
    />
  )
}

function TabsTrigger({
  className,
  ...props
}: React.ComponentProps<typeof TabsPrimitive.Trigger>) {
  return (
    <TabsPrimitive.Trigger
      data-slot="tabs-trigger"
      className={cn(
        "inline-flex min-h-[max(var(--control-lg),var(--control-default))] shrink-0 items-center gap-1.5 px-3 text-(length:--text-ui) font-medium whitespace-nowrap text-muted-foreground-2 transition-[color,box-shadow] duration-(--duration-fast) outline-none hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:ring-inset disabled:pointer-events-none disabled:opacity-(--disabled-opacity) data-[state=active]:text-foreground data-[state=active]:shadow-[inset_0_-2px_0_var(--foreground)] [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-(--icon-md)",
        className
      )}
      {...props}
    />
  )
}

function TabsContent({
  className,
  ...props
}: React.ComponentProps<typeof TabsPrimitive.Content>) {
  return (
    <TabsPrimitive.Content
      data-slot="tabs-content"
      className={cn("min-w-0", className)}
      {...props}
    />
  )
}

export { Tabs, TabsContent, TabsList, TabsTrigger }
