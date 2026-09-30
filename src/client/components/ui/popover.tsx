import * as React from "react"
import { Popover as PopoverPrimitive } from "radix-ui"

import { FieldControlContext } from "./control.js"
import { DialogPortalContainerContext } from "./dialog.js"
import {
  FLOATING_COLLISION_PADDING,
  FLOATING_SIDE_OFFSET,
  floatingSurfaceClass,
} from "./floating.js"

import { cn } from "@client/lib/utils"

function Popover({
  ...props
}: React.ComponentProps<typeof PopoverPrimitive.Root>) {
  return <PopoverPrimitive.Root data-slot="popover" {...props} />
}

function PopoverTrigger({
  ...props
}: React.ComponentProps<typeof PopoverPrimitive.Trigger>) {
  return <PopoverPrimitive.Trigger data-slot="popover-trigger" {...props} />
}

function PopoverContent({
  className,
  align = "center",
  sideOffset = FLOATING_SIDE_OFFSET,
  collisionPadding = FLOATING_COLLISION_PADDING,
  children,
  ...props
}: React.ComponentProps<typeof PopoverPrimitive.Content>) {
  const dialogContainer = React.useContext(DialogPortalContainerContext)
  // Wait for the containing dialog node instead of mounting in body then
  // remounting (and refocusing) when its ref becomes available.
  if (dialogContainer === null) return null
  return (
    <PopoverPrimitive.Portal container={dialogContainer}>
      <PopoverPrimitive.Content
        data-slot="popover-content"
        align={align}
        sideOffset={sideOffset}
        collisionPadding={collisionPadding}
        collisionBoundary={dialogContainer ?? undefined}
        className={cn(
          floatingSurfaceClass,
          // A content container by default (forms, details); list pickers
          // set their own padding.
          "flex max-h-[min(var(--radix-popover-content-available-height),calc(100dvh-16px))] w-72 origin-(--radix-popover-content-transform-origin) flex-col gap-2.5 overflow-y-auto p-2.5 text-(length:--text-ui)",
          className
        )}
        {...props}
      >
        {/* React context crosses the portal: a control in the popover is not the Field's control. */}
        <FieldControlContext.Provider value={null}>{children}</FieldControlContext.Provider>
      </PopoverPrimitive.Content>
    </PopoverPrimitive.Portal>
  )
}

function PopoverAnchor({
  ...props
}: React.ComponentProps<typeof PopoverPrimitive.Anchor>) {
  return <PopoverPrimitive.Anchor data-slot="popover-anchor" {...props} />
}

function PopoverHeader({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="popover-header"
      className={cn("flex flex-col gap-0.5 text-(length:--text-ui)", className)}
      {...props}
    />
  )
}

function PopoverTitle({ className, ...props }: React.ComponentProps<"h2">) {
  return (
    <h2
      data-slot="popover-title"
      className={cn("text-(length:--text-ui) font-medium", className)}
      {...props}
    />
  )
}

function PopoverDescription({
  className,
  ...props
}: React.ComponentProps<"p">) {
  return (
    <p
      data-slot="popover-description"
      className={cn("text-muted-foreground", className)}
      {...props}
    />
  )
}

export {
  Popover,
  PopoverAnchor,
  PopoverContent,
  PopoverDescription,
  PopoverHeader,
  PopoverTitle,
  PopoverTrigger,
}
