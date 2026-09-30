import * as React from "react"
import { CheckIcon, ChevronRightIcon, LoaderCircleIcon } from "lucide-react"
import { ContextMenu as ContextMenuPrimitive } from "radix-ui"

import { FieldControlContext } from "@client/components/ui/control"
import { DialogPortalContainerContext } from "@client/components/ui/dialog"
import {
  FLOATING_COLLISION_PADDING,
  SUBMENU_ALIGN_OFFSET,
  SUBMENU_SIDE_OFFSET,
  menuCheckIndicatorClass,
  menuCheckRowClass,
  menuDescriptionClass,
  menuEmptyClass,
  menuHeaderClass,
  menuLabelClass,
  menuPanelClass,
  menuRowClass,
  menuRowDestructiveClass,
  menuRowNoWrapClass,
  menuSeparatorClass,
  menuShortcutClass,
  menuValueClass,
} from "@client/components/ui/floating"
import {
  FloatingOpeningProvider,
  useFloatingLayer,
  useFloatingOpening,
} from "@client/components/ui/floating-opening"
import {
  MenuScope,
  MenuSheetCheckboxItem,
  MenuSheetContent,
  menuSheetContentProps,
  MenuSheetContextTrigger,
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
  MenuSheetValue,
  useMenuSheet,
  type MenuPresentation,
} from "@client/components/ui/menu-sheet"
import { cn } from "@client/lib/utils"

/**
 * `presentation="sheet"` opens the same parts as the shared bottom Sheet on
 * a secondary click or a touch long press (see ui/menu-sheet.tsx); give
 * ContextMenuContent a `sheetTitle` and `sheetDescription` for its header.
 * Each opening mounts fresh content, even while the last one animates out
 * (see ui/floating-opening.tsx).
 */
function ContextMenu({
  presentation = "menu",
  onOpenChange,
  ...props
}: React.ComponentProps<typeof ContextMenuPrimitive.Root> & {
  presentation?: MenuPresentation
}) {
  // Radix owns a context menu's open state and reports every change, so
  // following those reports keeps this count in step with it.
  const { open, setOpen, value } = useFloatingOpening({ onOpenChange })
  return (
    <FloatingOpeningProvider value={value}>
      {presentation === "sheet" ? (
        <MenuSheetRoot open={open} onOpenChange={setOpen}>
          {props.children}
        </MenuSheetRoot>
      ) : (
        <MenuScope>
          <ContextMenuPrimitive.Root
            data-slot="context-menu"
            {...props}
            onOpenChange={setOpen}
          />
        </MenuScope>
      )}
    </FloatingOpeningProvider>
  )
}

function ContextMenuTrigger({
  ...props
}: React.ComponentProps<typeof ContextMenuPrimitive.Trigger>) {
  const sheet = useMenuSheet()
  if (sheet) {
    return (
      <MenuSheetContextTrigger
        {...(props as React.ComponentProps<typeof MenuSheetContextTrigger>)}
      />
    )
  }
  return (
    <ContextMenuPrimitive.Trigger data-slot="context-menu-trigger" {...props} />
  )
}

function ContextMenuGroup({
  ...props
}: React.ComponentProps<typeof ContextMenuPrimitive.Group>) {
  const sheet = useMenuSheet()
  if (sheet) return <MenuSheetGroup dataSlot="context-menu-group" {...props} />
  return (
    <ContextMenuPrimitive.Group data-slot="context-menu-group" {...props} />
  )
}

function ContextMenuPortal({
  children,
  ...props
}: React.ComponentProps<typeof ContextMenuPrimitive.Portal>) {
  const sheet = useMenuSheet()
  const dialogContainer = React.useContext(DialogPortalContainerContext)
  if (sheet) return <>{children}</>
  return (
    <ContextMenuPrimitive.Portal
      data-slot="context-menu-portal"
      container={dialogContainer ?? undefined}
      {...props}
    >
      {children}
    </ContextMenuPrimitive.Portal>
  )
}

function ContextMenuSub({
  ...props
}: React.ComponentProps<typeof ContextMenuPrimitive.Sub>) {
  const sheet = useMenuSheet()
  if (sheet) return <MenuSheetSub>{props.children}</MenuSheetSub>
  return <ContextMenuPrimitive.Sub data-slot="context-menu-sub" {...props} />
}

function ContextMenuRadioGroup({
  ...props
}: React.ComponentProps<typeof ContextMenuPrimitive.RadioGroup>) {
  const sheet = useMenuSheet()
  if (sheet) {
    return (
      <MenuSheetRadioGroup
        dataSlot="context-menu-radio-group"
        {...(props as Omit<React.ComponentProps<typeof MenuSheetRadioGroup>, "dataSlot">)}
      />
    )
  }
  return (
    <ContextMenuPrimitive.RadioGroup
      data-slot="context-menu-radio-group"
      {...props}
    />
  )
}

function ContextMenuSubTrigger({
  className,
  inset,
  variant = "default",
  children,
  ...props
}: React.ComponentProps<typeof ContextMenuPrimitive.SubTrigger> & {
  inset?: boolean
  variant?: "default" | "destructive"
}) {
  const sheet = useMenuSheet()
  if (sheet) {
    return (
      <MenuSheetSubTrigger
        dataSlot="context-menu-sub-trigger"
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
    <ContextMenuPrimitive.SubTrigger
      data-slot="context-menu-sub-trigger"
      data-inset={inset}
      data-variant={variant}
      className={cn(
        menuRowClass,
        menuRowNoWrapClass,
        menuRowDestructiveClass,
        "data-[inset]:pl-8 data-[state=open]:bg-(--hover)",
        className
      )}
      {...props}
    >
      {children}
      <ChevronRightIcon className="ml-auto size-4" />
    </ContextMenuPrimitive.SubTrigger>
  )
}

function ContextMenuSubContent({
  className,
  sideOffset = SUBMENU_SIDE_OFFSET,
  alignOffset = SUBMENU_ALIGN_OFFSET,
  collisionPadding = FLOATING_COLLISION_PADDING,
  children,
  ...props
}: React.ComponentProps<typeof ContextMenuPrimitive.SubContent>) {
  const sheet = useMenuSheet()
  if (sheet) {
    return (
      <MenuSheetSubContent dataSlot="context-menu-sub-content" className={className}>
        {children}
      </MenuSheetSubContent>
    )
  }
  return (
    <ContextMenuPrimitive.SubContent
      data-slot="context-menu-sub-content"
      sideOffset={sideOffset}
      alignOffset={alignOffset}
      collisionPadding={collisionPadding}
      className={cn(
        menuPanelClass,
        "max-h-(--radix-context-menu-content-available-height) origin-(--radix-context-menu-content-transform-origin)",
        className
      )}
      {...props}
    >
      {children}
    </ContextMenuPrimitive.SubContent>
  )
}

function ContextMenuContent({
  className,
  collisionPadding = FLOATING_COLLISION_PADDING,
  sheetTitle,
  sheetDescription,
  children,
  ...props
}: React.ComponentProps<typeof ContextMenuPrimitive.Content> & {
  /** Sheet presentation: the header, e.g. the thread's name. */
  sheetTitle?: React.ReactNode
  /** Sheet presentation: the meta line under the header. */
  sheetDescription?: React.ReactNode
}) {
  const sheet = useMenuSheet()
  const dialogContainer = React.useContext(DialogPortalContainerContext)
  const layer = useFloatingLayer({
    onInteractOutside: props.onInteractOutside,
    onCloseAutoFocus: props.onCloseAutoFocus,
  })
  if (sheet) {
    return (
      <MenuSheetContent
        {...menuSheetContentProps(props)}
        className={className}
        title={sheetTitle}
        description={sheetDescription}
        label={props["aria-label"]}
      >
        {children}
      </MenuSheetContent>
    )
  }
  // Inside a dialog, portal into it so the menu layers above the dialog.
  if (dialogContainer === null) return null
  return (
    <ContextMenuPrimitive.Portal container={dialogContainer}>
      <ContextMenuPrimitive.Content
        key={layer.key}
        data-slot="context-menu-content"
        collisionPadding={collisionPadding}
        className={cn(
          menuPanelClass,
          "max-h-(--radix-context-menu-content-available-height) origin-(--radix-context-menu-content-transform-origin)",
          className
        )}
        {...props}
        onInteractOutside={layer.onInteractOutside}
        onCloseAutoFocus={layer.onCloseAutoFocus}
      >
        {/* React context crosses the portal: a control in the menu is not the Field's control. */}
        <FieldControlContext.Provider value={null}>{children}</FieldControlContext.Provider>
      </ContextMenuPrimitive.Content>
    </ContextMenuPrimitive.Portal>
  )
}

function ContextMenuItem({
  className,
  inset,
  variant = "default",
  ...props
}: React.ComponentProps<typeof ContextMenuPrimitive.Item> & {
  inset?: boolean
  variant?: "default" | "destructive"
}) {
  const sheet = useMenuSheet()
  if (sheet) {
    return (
      <MenuSheetItem
        dataSlot="context-menu-item"
        inset={inset}
        variant={variant}
        className={className}
        {...(props as Omit<React.ComponentProps<typeof MenuSheetItem>, "dataSlot">)}
      />
    )
  }
  return (
    <ContextMenuPrimitive.Item
      data-slot="context-menu-item"
      data-inset={inset}
      data-variant={variant}
      className={cn(menuRowClass, menuRowNoWrapClass, menuRowDestructiveClass, "data-[inset]:pl-8", className)}
      {...props}
    />
  )
}

/** The second line of a two-line row; place it inside the row's text span. */
function ContextMenuItemDescription({
  className,
  ...props
}: React.ComponentProps<"span">) {
  return (
    <span
      data-slot="context-menu-item-description"
      className={cn(menuDescriptionClass, className)}
      {...props}
    />
  )
}

function ContextMenuCheckboxItem({
  className,
  children,
  checked,
  ...props
}: React.ComponentProps<typeof ContextMenuPrimitive.CheckboxItem>) {
  const sheet = useMenuSheet()
  if (sheet) {
    return (
      <MenuSheetCheckboxItem
        dataSlot="context-menu-checkbox-item"
        checked={checked}
        className={className}
        {...(props as Omit<React.ComponentProps<typeof MenuSheetCheckboxItem>, "dataSlot">)}
      >
        {children}
      </MenuSheetCheckboxItem>
    )
  }
  return (
    <ContextMenuPrimitive.CheckboxItem
      data-slot="context-menu-checkbox-item"
      className={cn(menuRowClass, menuRowNoWrapClass, menuCheckRowClass, className)}
      checked={checked}
      {...props}
    >
      {children}
      <span className={menuCheckIndicatorClass}>
        <ContextMenuPrimitive.ItemIndicator>
          <CheckIcon className="size-4 text-foreground" />
        </ContextMenuPrimitive.ItemIndicator>
      </span>
    </ContextMenuPrimitive.CheckboxItem>
  )
}

function ContextMenuRadioItem({
  className,
  children,
  ...props
}: React.ComponentProps<typeof ContextMenuPrimitive.RadioItem>) {
  const sheet = useMenuSheet()
  if (sheet) {
    return (
      <MenuSheetRadioItem
        dataSlot="context-menu-radio-item"
        className={className}
        {...(props as Omit<React.ComponentProps<typeof MenuSheetRadioItem>, "dataSlot">)}
      >
        {children}
      </MenuSheetRadioItem>
    )
  }
  return (
    <ContextMenuPrimitive.RadioItem
      data-slot="context-menu-radio-item"
      className={cn(menuRowClass, menuRowNoWrapClass, menuCheckRowClass, className)}
      {...props}
    >
      {children}
      <span className={menuCheckIndicatorClass}>
        <ContextMenuPrimitive.ItemIndicator>
          <CheckIcon className="size-4 text-foreground" />
        </ContextMenuPrimitive.ItemIndicator>
      </span>
    </ContextMenuPrimitive.RadioItem>
  )
}

/**
 * The 11px uppercase section label, or with `variant="header"` a plain
 * 13px/500 header for names (never uppercase user text), with an optional
 * muted `description` line.
 */
function ContextMenuLabel({
  className,
  inset,
  variant = "label",
  description,
  children,
  ...props
}: React.ComponentProps<typeof ContextMenuPrimitive.Label> & {
  inset?: boolean
  variant?: "label" | "header"
  description?: React.ReactNode
}) {
  const sheet = useMenuSheet()
  if (sheet) {
    return (
      <MenuSheetLabel
        dataSlot="context-menu-label"
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
    <ContextMenuPrimitive.Label
      data-slot="context-menu-label"
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
    </ContextMenuPrimitive.Label>
  )
}

function ContextMenuSeparator({
  className,
  ...props
}: React.ComponentProps<typeof ContextMenuPrimitive.Separator>) {
  const sheet = useMenuSheet()
  if (sheet) {
    return (
      <MenuSheetSeparator
        dataSlot="context-menu-separator"
        className={className}
        {...(props as React.ComponentProps<"div">)}
      />
    )
  }
  return (
    <ContextMenuPrimitive.Separator
      data-slot="context-menu-separator"
      className={cn(menuSeparatorClass, className)}
      {...props}
    />
  )
}

/** A trailing keyboard hint ("⌘K"); values and reasons use ContextMenuValue. */
function ContextMenuShortcut({
  className,
  ...props
}: React.ComponentProps<"span">) {
  const sheet = useMenuSheet()
  if (sheet) {
    return <MenuSheetShortcut dataSlot="context-menu-shortcut" className={className} {...props} />
  }
  return (
    <span
      data-slot="context-menu-shortcut"
      className={cn(menuShortcutClass, className)}
      {...props}
    />
  )
}

/**
 * A row's current value or a disabled row's short reason ("Running",
 * "Unavailable"): muted, at the row's size, truncating before the label.
 */
function ContextMenuValue({
  className,
  ...props
}: React.ComponentProps<"span">) {
  const sheet = useMenuSheet()
  if (sheet) {
    return <MenuSheetValue dataSlot="context-menu-item-value" className={className} {...props} />
  }
  return (
    <span
      data-slot="context-menu-item-value"
      className={cn(menuValueClass, className)}
      {...props}
    />
  )
}

/** A non-focusable empty or loading row; never a disabled item. */
function ContextMenuEmpty({
  className,
  loading = false,
  children,
  ...props
}: React.ComponentProps<"div"> & { loading?: boolean }) {
  const sheet = useMenuSheet()
  if (sheet) {
    return (
      <MenuSheetEmpty dataSlot="context-menu-empty" loading={loading} className={className} {...props}>
        {children}
      </MenuSheetEmpty>
    )
  }
  return (
    <div
      role="status"
      data-slot="context-menu-empty"
      className={cn(menuEmptyClass, className)}
      {...props}
    >
      {loading && <LoaderCircleIcon aria-hidden="true" />}
      {children}
    </div>
  )
}

export {
  ContextMenu,
  ContextMenuTrigger,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuItemDescription,
  ContextMenuCheckboxItem,
  ContextMenuRadioItem,
  ContextMenuLabel,
  ContextMenuSeparator,
  ContextMenuShortcut,
  ContextMenuValue,
  ContextMenuEmpty,
  ContextMenuGroup,
  ContextMenuPortal,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
  ContextMenuRadioGroup,
}
