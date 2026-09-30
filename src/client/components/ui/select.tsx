import * as React from "react"
import { CheckIcon, ChevronDownIcon, ChevronUpIcon } from "lucide-react"
import { Select as SelectPrimitive } from "radix-ui"

import { DialogPortalContainerContext } from "@client/components/ui/dialog"
import {
  FLOATING_COLLISION_PADDING,
  FLOATING_SIDE_OFFSET,
  floatingSurfaceClass,
  menuCheckIndicatorClass,
  menuCheckRowClass,
  menuDescriptionClass,
  menuLabelClass,
  menuRowClass,
  menuSeparatorClass,
} from "@client/components/ui/floating"
import { cn } from "@client/lib/utils"

function Select({
  ...props
}: React.ComponentProps<typeof SelectPrimitive.Root>) {
  return <SelectPrimitive.Root data-slot="select" {...props} />
}

function SelectGroup({
  ...props
}: React.ComponentProps<typeof SelectPrimitive.Group>) {
  return <SelectPrimitive.Group data-slot="select-group" {...props} />
}

function SelectValue({
  ...props
}: React.ComponentProps<typeof SelectPrimitive.Value>) {
  return <SelectPrimitive.Value data-slot="select-value" {...props} />
}

function SelectTrigger({
  className,
  size = "default",
  children,
  ...props
}: React.ComponentProps<typeof SelectPrimitive.Trigger> & {
  size?: "sm" | "default"
}) {
  return (
    <SelectPrimitive.Trigger
      data-slot="select-trigger"
      data-size={size}
      className={cn(
        "flex w-fit items-center justify-between gap-2 rounded-md border border-input bg-transparent px-3 py-2 text-sm whitespace-nowrap shadow-xs transition-[color,box-shadow] outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-destructive/20 data-[placeholder]:text-muted-foreground data-[size=default]:h-9 data-[size=sm]:h-8 *:data-[slot=select-value]:line-clamp-1 *:data-[slot=select-value]:flex *:data-[slot=select-value]:items-center *:data-[slot=select-value]:gap-2 dark:bg-input/30 dark:hover:bg-input/50 dark:aria-invalid:ring-destructive/40 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4 [&_svg:not([class*='text-'])]:text-muted-foreground",
        className
      )}
      {...props}
    >
      {children}
      <SelectPrimitive.Icon asChild>
        <ChevronDownIcon className="size-4 opacity-50" />
      </SelectPrimitive.Icon>
    </SelectPrimitive.Trigger>
  )
}

function SelectContent({
  className,
  children,
  position = "popper",
  align = "start",
  sideOffset = FLOATING_SIDE_OFFSET,
  collisionPadding = FLOATING_COLLISION_PADDING,
  ...props
}: React.ComponentProps<typeof SelectPrimitive.Content>) {
  const dialogContainer = React.useContext(DialogPortalContainerContext)
  // Inside a dialog, portal into it so the options layer above the dialog.
  if (dialogContainer === null) return null
  return (
    <SelectPrimitive.Portal container={dialogContainer}>
      <SelectPrimitive.Content
        data-slot="select-content"
        className={cn(
          floatingSurfaceClass,
          "relative max-h-(--radix-select-content-available-height) min-w-[9rem] origin-(--radix-select-content-transform-origin) overflow-x-hidden overflow-y-auto",
          className
        )}
        position={position}
        align={align}
        sideOffset={sideOffset}
        collisionPadding={collisionPadding}
        {...props}
      >
        <SelectScrollUpButton />
        <SelectPrimitive.Viewport
          className={cn(
            "p-(--menu-panel-padding)",
            position === "popper" &&
              "h-[var(--radix-select-trigger-height)] w-full min-w-[var(--radix-select-trigger-width)] scroll-my-1"
          )}
        >
          {children}
        </SelectPrimitive.Viewport>
        <SelectScrollDownButton />
      </SelectPrimitive.Content>
    </SelectPrimitive.Portal>
  )
}

function SelectLabel({
  className,
  ...props
}: React.ComponentProps<typeof SelectPrimitive.Label>) {
  return (
    <SelectPrimitive.Label
      data-slot="select-label"
      className={cn(menuLabelClass, className)}
      {...props}
    />
  )
}

/**
 * A select option in the menu row anatomy: trailing check and weight 500
 * when selected. `description` adds a muted second line that stays out of
 * the trigger's value text.
 */
function SelectItem({
  className,
  children,
  description,
  ...props
}: React.ComponentProps<typeof SelectPrimitive.Item> & {
  description?: React.ReactNode
}) {
  const text = (
    <SelectPrimitive.ItemText className="flex min-w-0 items-center gap-2">
      {children}
    </SelectPrimitive.ItemText>
  )
  return (
    <SelectPrimitive.Item
      data-slot="select-item"
      className={cn(menuRowClass, menuCheckRowClass, className)}
      {...props}
    >
      <span data-slot="select-item-indicator" className={menuCheckIndicatorClass}>
        <SelectPrimitive.ItemIndicator>
          <CheckIcon className="size-4 text-foreground" />
        </SelectPrimitive.ItemIndicator>
      </span>
      {description === undefined ? (
        text
      ) : (
        <span className="flex min-w-0 flex-col">
          {text}
          <span data-slot="select-item-description" className={menuDescriptionClass}>
            {description}
          </span>
        </span>
      )}
    </SelectPrimitive.Item>
  )
}

function SelectSeparator({
  className,
  ...props
}: React.ComponentProps<typeof SelectPrimitive.Separator>) {
  return (
    <SelectPrimitive.Separator
      data-slot="select-separator"
      className={cn("pointer-events-none", menuSeparatorClass, className)}
      {...props}
    />
  )
}

function SelectScrollUpButton({
  className,
  ...props
}: React.ComponentProps<typeof SelectPrimitive.ScrollUpButton>) {
  return (
    <SelectPrimitive.ScrollUpButton
      data-slot="select-scroll-up-button"
      className={cn(
        "flex cursor-default items-center justify-center py-1 text-muted-foreground",
        className
      )}
      {...props}
    >
      <ChevronUpIcon className="size-4" />
    </SelectPrimitive.ScrollUpButton>
  )
}

function SelectScrollDownButton({
  className,
  ...props
}: React.ComponentProps<typeof SelectPrimitive.ScrollDownButton>) {
  return (
    <SelectPrimitive.ScrollDownButton
      data-slot="select-scroll-down-button"
      className={cn(
        "flex cursor-default items-center justify-center py-1 text-muted-foreground",
        className
      )}
      {...props}
    >
      <ChevronDownIcon className="size-4" />
    </SelectPrimitive.ScrollDownButton>
  )
}

export {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectScrollDownButton,
  SelectScrollUpButton,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
}
