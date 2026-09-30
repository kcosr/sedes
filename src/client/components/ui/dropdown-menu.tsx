"use client"

import * as React from "react"
import { CheckIcon, ChevronRightIcon, LoaderCircleIcon } from "lucide-react"
import { DropdownMenu as DropdownMenuPrimitive } from "radix-ui"

import { DialogPortalContainerContext } from "@client/components/ui/dialog"
import {
  FLOATING_COLLISION_PADDING,
  SUBMENU_ALIGN_OFFSET,
  SUBMENU_SIDE_OFFSET,
  FLOATING_SIDE_OFFSET,
  menuCheckIndicatorClass,
  menuCheckRowClass,
  menuDescriptionClass,
  menuEmptyClass,
  menuHeaderClass,
  menuLabelClass,
  menuPanelClass,
  menuRowClass,
  menuRowDestructiveClass,
  menuSeparatorClass,
  menuShortcutClass,
} from "@client/components/ui/floating"
import {
  MenuScope,
  MenuSheetCheckboxItem,
  MenuSheetContent,
  MenuSheetEmpty,
  MenuSheetGroup,
  MenuSheetItem,
  MenuSheetLabel,
  MenuSheetRadioGroup,
  MenuSheetRadioItem,
  MenuSheetRoot,
  MenuSheetSeparator,
  MenuSheetShortcut,
  MenuSheetSub,
  MenuSheetSubContent,
  MenuSheetSubTrigger,
  MenuSheetTrigger,
  useMenuSheet,
  type MenuPresentation,
} from "@client/components/ui/menu-sheet"
import { cn } from "@client/lib/utils"

/**
 * `presentation="sheet"` renders the same parts as the shared bottom Sheet
 * (see ui/menu-sheet.tsx); give DropdownMenuContent a `sheetTitle` and
 * `sheetDescription` for its header.
 */
function DropdownMenu({
  presentation = "menu",
  ...props
}: React.ComponentProps<typeof DropdownMenuPrimitive.Root> & {
  presentation?: MenuPresentation
}) {
  if (presentation === "sheet") {
    return (
      <MenuSheetRoot
        open={props.open}
        defaultOpen={props.defaultOpen}
        onOpenChange={props.onOpenChange}
      >
        {props.children}
      </MenuSheetRoot>
    )
  }
  return (
    <MenuScope>
      <DropdownMenuPrimitive.Root data-slot="dropdown-menu" {...props} />
    </MenuScope>
  )
}

function DropdownMenuPortal({
  children,
  ...props
}: React.ComponentProps<typeof DropdownMenuPrimitive.Portal>) {
  const dialogContainer = React.useContext(DialogPortalContainerContext)
  const sheet = useMenuSheet()
  if (sheet) return <>{children}</>
  return (
    <DropdownMenuPrimitive.Portal
      data-slot="dropdown-menu-portal"
      container={dialogContainer ?? undefined}
      {...props}
    >
      {children}
    </DropdownMenuPrimitive.Portal>
  )
}

function DropdownMenuTrigger({
  ...props
}: React.ComponentProps<typeof DropdownMenuPrimitive.Trigger>) {
  const sheet = useMenuSheet()
  if (sheet) return <MenuSheetTrigger data-slot="dropdown-menu-trigger" {...props} />
  return (
    <DropdownMenuPrimitive.Trigger
      data-slot="dropdown-menu-trigger"
      {...props}
    />
  )
}

function DropdownMenuContent({
  className,
  sideOffset = FLOATING_SIDE_OFFSET,
  collisionPadding = FLOATING_COLLISION_PADDING,
  sheetTitle,
  sheetDescription,
  children,
  ...props
}: React.ComponentProps<typeof DropdownMenuPrimitive.Content> & {
  /** Sheet presentation: the header, e.g. the thread's name. */
  sheetTitle?: React.ReactNode
  /** Sheet presentation: the meta line under the header. */
  sheetDescription?: React.ReactNode
}) {
  const sheet = useMenuSheet()
  const dialogContainer = React.useContext(DialogPortalContainerContext)
  if (sheet) {
    return (
      <MenuSheetContent
        title={sheetTitle}
        description={sheetDescription}
        label={props["aria-label"]}
        data-testid={(props as { "data-testid"?: string })["data-testid"]}
        onCloseAutoFocus={props.onCloseAutoFocus}
        onEscapeKeyDown={props.onEscapeKeyDown}
      >
        {children}
      </MenuSheetContent>
    )
  }
  // Inside a dialog, portal into it so the menu layers above the dialog.
  if (dialogContainer === null) return null
  return (
    <DropdownMenuPrimitive.Portal container={dialogContainer}>
      <DropdownMenuPrimitive.Content
        data-slot="dropdown-menu-content"
        sideOffset={sideOffset}
        collisionPadding={collisionPadding}
        className={cn(
          menuPanelClass,
          "max-h-(--radix-dropdown-menu-content-available-height) origin-(--radix-dropdown-menu-content-transform-origin)",
          className
        )}
        {...props}
      >
        {children}
      </DropdownMenuPrimitive.Content>
    </DropdownMenuPrimitive.Portal>
  )
}

function DropdownMenuGroup({
  ...props
}: React.ComponentProps<typeof DropdownMenuPrimitive.Group>) {
  const sheet = useMenuSheet()
  if (sheet) return <MenuSheetGroup dataSlot="dropdown-menu-group" {...props} />
  return (
    <DropdownMenuPrimitive.Group data-slot="dropdown-menu-group" {...props} />
  )
}

function DropdownMenuItem({
  className,
  inset,
  variant = "default",
  ...props
}: React.ComponentProps<typeof DropdownMenuPrimitive.Item> & {
  inset?: boolean
  variant?: "default" | "destructive"
}) {
  const sheet = useMenuSheet()
  if (sheet) {
    return (
      <MenuSheetItem
        dataSlot="dropdown-menu-item"
        inset={inset}
        variant={variant}
        className={className}
        {...(props as Omit<React.ComponentProps<typeof MenuSheetItem>, "dataSlot">)}
      />
    )
  }
  return (
    <DropdownMenuPrimitive.Item
      data-slot="dropdown-menu-item"
      data-inset={inset}
      data-variant={variant}
      className={cn(menuRowClass, menuRowDestructiveClass, "data-[inset]:pl-8", className)}
      {...props}
    />
  )
}

/** The second line of a two-line row; place it inside the row's text span. */
function DropdownMenuItemDescription({
  className,
  ...props
}: React.ComponentProps<"span">) {
  return (
    <span
      data-slot="dropdown-menu-item-description"
      className={cn(menuDescriptionClass, className)}
      {...props}
    />
  )
}

function DropdownMenuCheckboxItem({
  className,
  children,
  checked,
  ...props
}: React.ComponentProps<typeof DropdownMenuPrimitive.CheckboxItem>) {
  const sheet = useMenuSheet()
  if (sheet) {
    return (
      <MenuSheetCheckboxItem
        dataSlot="dropdown-menu-checkbox-item"
        checked={checked}
        className={className}
        {...(props as Omit<React.ComponentProps<typeof MenuSheetCheckboxItem>, "dataSlot">)}
      >
        {children}
      </MenuSheetCheckboxItem>
    )
  }
  return (
    <DropdownMenuPrimitive.CheckboxItem
      data-slot="dropdown-menu-checkbox-item"
      className={cn(menuRowClass, menuCheckRowClass, className)}
      checked={checked}
      {...props}
    >
      {children}
      <span className={menuCheckIndicatorClass}>
        <DropdownMenuPrimitive.ItemIndicator>
          <CheckIcon className="size-4 text-foreground" />
        </DropdownMenuPrimitive.ItemIndicator>
      </span>
    </DropdownMenuPrimitive.CheckboxItem>
  )
}

function DropdownMenuRadioGroup({
  ...props
}: React.ComponentProps<typeof DropdownMenuPrimitive.RadioGroup>) {
  const sheet = useMenuSheet()
  if (sheet) {
    return (
      <MenuSheetRadioGroup
        dataSlot="dropdown-menu-radio-group"
        {...(props as Omit<React.ComponentProps<typeof MenuSheetRadioGroup>, "dataSlot">)}
      />
    )
  }
  return (
    <DropdownMenuPrimitive.RadioGroup
      data-slot="dropdown-menu-radio-group"
      {...props}
    />
  )
}

function DropdownMenuRadioItem({
  className,
  children,
  ...props
}: React.ComponentProps<typeof DropdownMenuPrimitive.RadioItem>) {
  const sheet = useMenuSheet()
  if (sheet) {
    return (
      <MenuSheetRadioItem
        dataSlot="dropdown-menu-radio-item"
        className={className}
        {...(props as Omit<React.ComponentProps<typeof MenuSheetRadioItem>, "dataSlot">)}
      >
        {children}
      </MenuSheetRadioItem>
    )
  }
  return (
    <DropdownMenuPrimitive.RadioItem
      data-slot="dropdown-menu-radio-item"
      className={cn(menuRowClass, menuCheckRowClass, className)}
      {...props}
    >
      {children}
      <span className={menuCheckIndicatorClass}>
        <DropdownMenuPrimitive.ItemIndicator>
          <CheckIcon className="size-4 text-foreground" />
        </DropdownMenuPrimitive.ItemIndicator>
      </span>
    </DropdownMenuPrimitive.RadioItem>
  )
}

/**
 * The 11px uppercase section label, or with `variant="header"` a plain
 * 13px/500 header for names (never uppercase user text), with an optional
 * muted `description` line.
 */
function DropdownMenuLabel({
  className,
  inset,
  variant = "label",
  description,
  children,
  ...props
}: React.ComponentProps<typeof DropdownMenuPrimitive.Label> & {
  inset?: boolean
  variant?: "label" | "header"
  description?: React.ReactNode
}) {
  const sheet = useMenuSheet()
  if (sheet) {
    return (
      <MenuSheetLabel
        dataSlot="dropdown-menu-label"
        inset={inset}
        variant={variant}
        description={description}
        className={className}
        {...(props as React.ComponentProps<"div">)}
      >
        {children}
      </MenuSheetLabel>
    )
  }
  return (
    <DropdownMenuPrimitive.Label
      data-slot="dropdown-menu-label"
      data-inset={inset}
      data-variant={variant}
      className={cn(
        variant === "header" ? menuHeaderClass : menuLabelClass,
        "data-[inset]:pl-8",
        className
      )}
      {...props}
    >
      {children}
      {description !== undefined && (
        <span className={cn(menuDescriptionClass, "mt-0.5")}>{description}</span>
      )}
    </DropdownMenuPrimitive.Label>
  )
}

function DropdownMenuSeparator({
  className,
  ...props
}: React.ComponentProps<typeof DropdownMenuPrimitive.Separator>) {
  const sheet = useMenuSheet()
  if (sheet) {
    return (
      <MenuSheetSeparator
        dataSlot="dropdown-menu-separator"
        className={className}
        {...(props as React.ComponentProps<"div">)}
      />
    )
  }
  return (
    <DropdownMenuPrimitive.Separator
      data-slot="dropdown-menu-separator"
      className={cn(menuSeparatorClass, className)}
      {...props}
    />
  )
}

/** A trailing shortcut, or a short reason on a disabled row ("Running"). */
function DropdownMenuShortcut({
  className,
  ...props
}: React.ComponentProps<"span">) {
  const sheet = useMenuSheet()
  if (sheet) {
    return <MenuSheetShortcut dataSlot="dropdown-menu-shortcut" className={className} {...props} />
  }
  return (
    <span
      data-slot="dropdown-menu-shortcut"
      className={cn(menuShortcutClass, className)}
      {...props}
    />
  )
}

/** A non-focusable empty or loading row; never a disabled item. */
function DropdownMenuEmpty({
  className,
  loading = false,
  children,
  ...props
}: React.ComponentProps<"div"> & { loading?: boolean }) {
  const sheet = useMenuSheet()
  if (sheet) {
    return (
      <MenuSheetEmpty dataSlot="dropdown-menu-empty" loading={loading} className={className} {...props}>
        {children}
      </MenuSheetEmpty>
    )
  }
  return (
    <div
      role="status"
      data-slot="dropdown-menu-empty"
      className={cn(menuEmptyClass, className)}
      {...props}
    >
      {loading && <LoaderCircleIcon aria-hidden="true" />}
      {children}
    </div>
  )
}

function DropdownMenuSub({
  ...props
}: React.ComponentProps<typeof DropdownMenuPrimitive.Sub>) {
  const sheet = useMenuSheet()
  if (sheet) return <MenuSheetSub>{props.children}</MenuSheetSub>
  return <DropdownMenuPrimitive.Sub data-slot="dropdown-menu-sub" {...props} />
}

function DropdownMenuSubTrigger({
  className,
  inset,
  variant = "default",
  children,
  ...props
}: React.ComponentProps<typeof DropdownMenuPrimitive.SubTrigger> & {
  inset?: boolean
  variant?: "default" | "destructive"
}) {
  const sheet = useMenuSheet()
  if (sheet) {
    return (
      <MenuSheetSubTrigger
        dataSlot="dropdown-menu-sub-trigger"
        inset={inset}
        variant={variant}
        className={className}
        {...(props as React.ComponentProps<"button">)}
      >
        {children}
      </MenuSheetSubTrigger>
    )
  }
  return (
    <DropdownMenuPrimitive.SubTrigger
      data-slot="dropdown-menu-sub-trigger"
      data-inset={inset}
      data-variant={variant}
      className={cn(
        menuRowClass,
        menuRowDestructiveClass,
        "data-[inset]:pl-8 data-[state=open]:bg-(--hover)",
        className
      )}
      {...props}
    >
      {children}
      <ChevronRightIcon className="ml-auto size-4" />
    </DropdownMenuPrimitive.SubTrigger>
  )
}

function DropdownMenuSubContent({
  className,
  sideOffset = SUBMENU_SIDE_OFFSET,
  alignOffset = SUBMENU_ALIGN_OFFSET,
  collisionPadding = FLOATING_COLLISION_PADDING,
  children,
  ...props
}: React.ComponentProps<typeof DropdownMenuPrimitive.SubContent>) {
  const sheet = useMenuSheet()
  if (sheet) {
    return (
      <MenuSheetSubContent dataSlot="dropdown-menu-sub-content" className={className}>
        {children}
      </MenuSheetSubContent>
    )
  }
  return (
    <DropdownMenuPrimitive.SubContent
      data-slot="dropdown-menu-sub-content"
      sideOffset={sideOffset}
      alignOffset={alignOffset}
      collisionPadding={collisionPadding}
      className={cn(
        menuPanelClass,
        "max-h-(--radix-dropdown-menu-content-available-height) origin-(--radix-dropdown-menu-content-transform-origin)",
        className
      )}
      {...props}
    >
      {children}
    </DropdownMenuPrimitive.SubContent>
  )
}

export {
  DropdownMenu,
  DropdownMenuPortal,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuLabel,
  DropdownMenuItem,
  DropdownMenuItemDescription,
  DropdownMenuCheckboxItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuEmpty,
  DropdownMenuSub,
  DropdownMenuSubTrigger,
  DropdownMenuSubContent,
}
