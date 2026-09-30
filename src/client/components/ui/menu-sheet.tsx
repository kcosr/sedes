"use client"

import * as React from "react"
import { createPortal } from "react-dom"
import { Slot } from "radix-ui"
import {
  CheckIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  LoaderCircleIcon,
} from "lucide-react"

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@client/components/ui/dialog"
import {
  menuDescriptionClass,
  menuEmptyClass,
  menuShortcutClass,
} from "@client/components/ui/floating"
import { useFloatingLayer } from "@client/components/ui/floating-opening"
import { cn } from "@client/lib/utils"

/**
 * Menu-to-sheet. A DropdownMenu or ContextMenu with `presentation="sheet"`
 * renders its own items as the shared bottom Sheet instead of a floating
 * menu: the header is the subject's name with a meta line, rows are 44px,
 * and submenus drill in with a back row. Call sites write the menu once and
 * pick the presentation, typically `useTouchDensity() ? "sheet" : "menu"`.
 *
 * The components here are the sheet-mode halves of the DropdownMenu and
 * ContextMenu parts; those parts switch to them while a MenuSheetRoot is
 * above them.
 */
export type MenuPresentation = "menu" | "sheet"

interface MenuSheetLevel {
  readonly id: string
  readonly label: string
}

interface MenuSheetState {
  readonly setOpen: (open: boolean) => void
  /** Opens the sheet, returning focus to `opener` when it closes. */
  readonly openFrom: (opener: HTMLElement | null) => void
  /** A context menu's opener: the element focused when it opened. */
  readonly returnFocus: React.RefObject<HTMLElement | null>
  /**
   * A dropdown's trigger, registered by its ref: where focus returns however
   * the sheet opened (a click, controlled `open` or `defaultOpen`).
   */
  readonly triggerRef: React.RefObject<HTMLElement | null>
  readonly stack: readonly MenuSheetLevel[]
  readonly drillIn: (level: MenuSheetLevel) => void
  readonly back: () => void
  readonly pane: HTMLElement | null
  readonly setPane: (node: HTMLElement | null) => void
}

const MenuSheetContext = React.createContext<MenuSheetState | null>(null)

/**
 * Runs the consumer's handler first and the part's own behavior only when
 * the consumer did not prevent the default, as Radix composes menu handlers.
 */
function composeHandlers<E extends React.SyntheticEvent>(
  external: ((event: E) => void) | undefined,
  internal: (event: E) => void
): (event: E) => void {
  return (event) => {
    external?.(event)
    if (!event.defaultPrevented) internal(event)
  }
}

/** The element that has focus, if any: what a closing sheet returns focus to. */
function focusedElement(): HTMLElement | null {
  const active = document.activeElement
  return active instanceof HTMLElement && active !== document.body ? active : null
}

/** The sheet-mode state, or null when the menu renders as a floating menu. */
export function useMenuSheet(): MenuSheetState | null {
  return React.useContext(MenuSheetContext)
}

/** A floating menu's scope: its parts render as a menu even inside a sheet. */
export function MenuScope({ children }: { children?: React.ReactNode }) {
  return <MenuSheetContext.Provider value={null}>{children}</MenuSheetContext.Provider>
}

/**
 * The sheet-mode root: a Dialog with the drill-in stack. The menu root
 * above it owns the open state and counts its openings.
 */
export function MenuSheetRoot({
  open,
  onOpenChange: setOpen,
  children,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  children?: React.ReactNode
}) {
  const [stack, setStack] = React.useState<readonly MenuSheetLevel[]>([])
  const [pane, setPane] = React.useState<HTMLElement | null>(null)
  const returnFocus = React.useRef<HTMLElement | null>(null)
  const triggerRef = React.useRef<HTMLElement | null>(null)
  React.useEffect(() => {
    if (!open) setStack([])
  }, [open])
  const state = React.useMemo<MenuSheetState>(
    () => ({
      setOpen,
      openFrom: (opener) => {
        returnFocus.current = opener
        setOpen(true)
      },
      returnFocus,
      triggerRef,
      stack,
      drillIn: (level) => setStack((current) => [...current, level]),
      back: () => setStack((current) => current.slice(0, -1)),
      pane,
      setPane,
    }),
    [pane, setOpen, stack]
  )
  return (
    <MenuSheetContext.Provider value={state}>
      <Dialog open={open} onOpenChange={setOpen}>
        {children}
      </Dialog>
    </MenuSheetContext.Provider>
  )
}

/**
 * The sheet-mode dropdown trigger: a click opens the sheet, and the sheet
 * returns focus here when it closes.
 */
export function MenuSheetTrigger({
  ref,
  ...props
}: React.ComponentProps<typeof DialogTrigger>) {
  const triggerRef = useMenuSheet()?.triggerRef
  const register = React.useCallback(
    (node: HTMLButtonElement | null) => {
      if (triggerRef) triggerRef.current = node
      if (typeof ref === "function") return ref(node)
      if (ref) ref.current = node
    },
    [ref, triggerRef]
  )
  return <DialogTrigger {...props} ref={register} />
}

const LONG_PRESS_MS = 700
const LONG_PRESS_SLOP_PX = 10

/**
 * The sheet-mode context-menu trigger: a secondary click or a touch long
 * press opens the sheet, as Radix's ContextMenu trigger opens its menu. The
 * element focused when it opens gets focus back when it closes. The click
 * a touch press produces when the finger lifts after a long press opened
 * the sheet is swallowed, so the row under it does not act as well.
 */
export function MenuSheetContextTrigger({
  asChild = false,
  disabled = false,
  onClickCapture,
  onContextMenu,
  onPointerDown,
  onPointerMove,
  onPointerUp,
  onPointerCancel,
  style,
  ...props
}: React.ComponentProps<"span"> & { asChild?: boolean; disabled?: boolean }) {
  const state = useMenuSheet()
  const timer = React.useRef<ReturnType<typeof setTimeout>>(undefined)
  const origin = React.useRef<{ x: number; y: number }>(undefined)
  const suppressClick = React.useRef(false)
  const clear = () => {
    if (timer.current !== undefined) clearTimeout(timer.current)
    timer.current = undefined
    origin.current = undefined
  }
  React.useEffect(() => clear, [])
  const openFromLongPress = () => {
    clear()
    suppressClick.current = true
    state?.openFrom(focusedElement())
  }
  const Comp = asChild ? Slot.Root : "span"
  return (
    <Comp
      {...props}
      data-slot="context-menu-trigger"
      data-disabled={disabled ? "" : undefined}
      style={{ WebkitTouchCallout: "none", ...style }}
      onClickCapture={(event: React.MouseEvent<HTMLSpanElement>) => {
        onClickCapture?.(event)
        if (!suppressClick.current) return
        suppressClick.current = false
        // A keyboard click (detail 0) is an interaction of its own.
        if (event.detail === 0) return
        event.preventDefault()
        event.stopPropagation()
      }}
      onContextMenu={(event: React.MouseEvent<HTMLSpanElement>) => {
        onContextMenu?.(event)
        if (event.defaultPrevented || disabled) return
        event.preventDefault()
        // Android fires contextmenu during a touch hold: that is the long
        // press, and its release clicks too.
        if (origin.current !== undefined) {
          openFromLongPress()
          return
        }
        clear()
        state?.openFrom(focusedElement())
      }}
      onPointerDown={(event: React.PointerEvent<HTMLSpanElement>) => {
        onPointerDown?.(event)
        // A new press: a long press that produced no click leaves nothing
        // to swallow.
        suppressClick.current = false
        if (event.defaultPrevented || disabled || event.pointerType === "mouse") return
        clear()
        origin.current = { x: event.clientX, y: event.clientY }
        timer.current = setTimeout(openFromLongPress, LONG_PRESS_MS)
      }}
      onPointerMove={(event: React.PointerEvent<HTMLSpanElement>) => {
        onPointerMove?.(event)
        const start = origin.current
        if (
          start &&
          Math.hypot(event.clientX - start.x, event.clientY - start.y) > LONG_PRESS_SLOP_PX
        ) {
          clear()
        }
      }}
      onPointerUp={(event: React.PointerEvent<HTMLSpanElement>) => {
        onPointerUp?.(event)
        clear()
      }}
      onPointerCancel={(event: React.PointerEvent<HTMLSpanElement>) => {
        onPointerCancel?.(event)
        clear()
      }}
    />
  )
}

/**
 * Menu content props that only place or scope a floating menu. A sheet
 * drops them and takes every other prop (class, data attributes, handlers);
 * the menu's aria-label names the sheet's list.
 */
const FLOATING_ONLY_PROPS = [
  "side",
  "sideOffset",
  "align",
  "alignOffset",
  "avoidCollisions",
  "collisionBoundary",
  "collisionPadding",
  "arrowPadding",
  "sticky",
  "hideWhenDetached",
  "updatePositionStrategy",
  "loop",
  "onEntryFocus",
  "asChild",
  "aria-label",
] as const

/** A menu content's props for its sheet presentation. */
export function menuSheetContentProps(
  props: object
): Omit<React.ComponentProps<typeof MenuSheetContent>, "title" | "description" | "label"> {
  const sheetProps: Record<string, unknown> = { ...props }
  for (const key of FLOATING_ONLY_PROPS) delete sheetProps[key]
  return sheetProps
}

/**
 * A row's name for the drill-in back row and pane: its text without the
 * trailing value, shortcut or description, or `textValue` when given.
 */
function rowLabel(row: HTMLElement): string {
  const copy = row.cloneNode(true) as HTMLElement
  copy
    .querySelectorAll(
      '[data-slot$="-shortcut"], [data-slot$="-item-description"], [aria-hidden="true"]'
    )
    .forEach((node) => node.remove())
  return copy.textContent?.replace(/\s+/g, " ").trim() ?? ""
}

const ROW_SELECTOR = '[role="menuitem"], [role="menuitemcheckbox"], [role="menuitemradio"]'

function visibleRows(list: HTMLElement): HTMLElement[] {
  const pane = Array.from(
    list.querySelectorAll<HTMLElement>('[data-slot="menu-sheet-pane"]')
  ).find((candidate) => !candidate.hidden)
  if (!pane) return []
  return Array.from(pane.querySelectorAll<HTMLElement>(ROW_SELECTOR)).filter(
    (row) => !row.matches(":disabled")
  )
}

function focusRow(list: HTMLElement | null, which: "first" | "last" | 1 | -1) {
  if (!list) return
  const rows = visibleRows(list)
  if (rows.length === 0) return
  const current = rows.indexOf(document.activeElement as HTMLElement)
  const next =
    which === "first" ? 0
    : which === "last" ? rows.length - 1
    : current < 0 ? (which === 1 ? 0 : rows.length - 1)
    : (current + which + rows.length) % rows.length
  rows[next]?.focus()
}

const LIST_KEYS: Readonly<Record<string, "first" | "last" | 1 | -1>> = {
  ArrowDown: 1,
  ArrowUp: -1,
  Home: "first",
  End: "last",
}

/**
 * The sheet-mode content: the Sheet with the subject's name and meta line
 * as its header, then the rows. Arrow keys move between rows. On close,
 * focus returns to the opener unless something else took it (for example a
 * dialog that a selected item opened) or `onCloseAutoFocus` prevents it.
 */
export function MenuSheetContent({
  title,
  description,
  label,
  children,
  onCloseAutoFocus,
  ...props
}: Omit<React.ComponentProps<typeof DialogContent>, "title" | "layout" | "children"> & {
  /** The subject's name, e.g. the thread title. */
  title?: React.ReactNode
  /** The meta line under the name, e.g. "sedes · Claude · updated 12m ago". */
  description?: React.ReactNode
  /** The accessible name when there is no visible title. */
  label?: string
  children?: React.ReactNode
}) {
  const state = useMenuSheet()
  const list = React.useRef<HTMLDivElement>(null)
  const depth = state?.stack.length ?? 0
  React.useEffect(() => {
    if (depth > 0) focusRow(list.current, "first")
  }, [depth])
  const layer = useFloatingLayer({
    onInteractOutside: props.onInteractOutside,
    onCloseAutoFocus: (event: Event) => {
      onCloseAutoFocus?.(event)
      if (event.defaultPrevented) return
      event.preventDefault()
      const content = event.currentTarget as HTMLElement
      const active = document.activeElement
      const focusLost = !active || active === document.body || content.contains(active)
      const opener = state?.returnFocus.current ?? state?.triggerRef.current
      if (focusLost && opener?.isConnected) opener.focus()
    },
  })
  return (
    <DialogContent
      key={layer.key}
      layout="sheet"
      data-menu-sheet=""
      {...(description === undefined ? { "aria-describedby": undefined } : {})}
      {...props}
      onInteractOutside={layer.onInteractOutside}
      onCloseAutoFocus={layer.onCloseAutoFocus}
    >
      <DialogHeader className={title === undefined ? "sr-only" : undefined}>
        <DialogTitle>{title ?? label ?? "Actions"}</DialogTitle>
        {description !== undefined && <DialogDescription>{description}</DialogDescription>}
      </DialogHeader>
      <div
        ref={list}
        role="menu"
        aria-label={label ?? (typeof title === "string" ? title : undefined)}
        data-slot="menu-sheet-list"
        data-autofocus=""
        tabIndex={-1}
        className="-mx-1 flex min-h-0 flex-1 flex-col overflow-y-auto overscroll-contain px-1 outline-none"
        onKeyDown={(event) => {
          const which = LIST_KEYS[event.key]
          if (which === undefined) return
          event.preventDefault()
          focusRow(list.current, which)
        }}
      >
        <div data-slot="menu-sheet-pane" hidden={depth > 0} className="flex flex-col">
          {children}
        </div>
        <div ref={state?.setPane} className="contents" />
      </div>
    </DialogContent>
  )
}

/** Sheet rows: 44px, 15px text, 18px icons, the wash on press and focus. */
export const menuSheetRowClass =
  "relative flex min-h-11 w-full shrink-0 cursor-pointer items-center gap-3 rounded-(--menu-row-radius) border-0 bg-transparent px-3 py-2 text-left text-(length:--text-title) leading-5 text-foreground outline-none select-none " +
  "hover:bg-(--hover) focus-visible:bg-(--hover) active:bg-(--hover) disabled:pointer-events-none disabled:opacity-(--disabled-opacity) " +
  "[&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-[18px] [&_svg:not([class*='text-'])]:text-muted-foreground " +
  "data-[variant=destructive]:text-destructive data-[variant=destructive]:*:[svg]:text-destructive! " +
  "has-[[data-slot$=item-description]]:items-start has-[[data-slot$=item-description]]:font-medium has-[[data-slot$=item-description]]:[&>svg]:mt-px " +
  "[&_[data-slot$=item-description]]:text-(length:--text-ui) [&_[data-slot$=item-description]]:leading-[18px]"

/** Rows with no leading icon line up with the text of rows that have one. */
const SHEET_INSET_CLASS = "pl-[42px]"

function selectEvent(): Event {
  return new Event("menu.itemSelect", { cancelable: true })
}

/** A sheet row; selecting it closes the sheet unless `onSelect` prevents it. */
export function MenuSheetItem({
  asChild = false,
  inset,
  variant = "default",
  textValue: _textValue,
  onSelect,
  onClick,
  className,
  disabled,
  dataSlot,
  ...props
}: Omit<React.ComponentProps<"button">, "onSelect"> & {
  asChild?: boolean
  inset?: boolean
  variant?: "default" | "destructive"
  textValue?: string
  onSelect?: (event: Event) => void
  dataSlot: string
}) {
  const state = useMenuSheet()
  const Comp = asChild ? Slot.Root : "button"
  return (
    <Comp
      {...props}
      type={asChild ? undefined : "button"}
      role="menuitem"
      data-slot={dataSlot}
      data-variant={variant}
      data-disabled={disabled ? "" : undefined}
      aria-disabled={disabled || undefined}
      disabled={disabled}
      className={cn(menuSheetRowClass, inset && SHEET_INSET_CLASS, className)}
      onClick={composeHandlers(onClick, () => {
        if (disabled) return
        const select = selectEvent()
        onSelect?.(select)
        if (!select.defaultPrevented) state?.setOpen(false)
      })}
    />
  )
}

function MenuSheetCheck({ checked }: { checked: boolean }) {
  return (
    <span className="pointer-events-none absolute top-1/2 right-3 flex size-[18px] -translate-y-1/2 items-center justify-center">
      {checked && <CheckIcon className="size-[18px] text-foreground" aria-hidden="true" />}
    </span>
  )
}

/** A sheet checkbox row: role menuitemcheckbox with a trailing check. */
export function MenuSheetCheckboxItem({
  checked = false,
  onCheckedChange,
  onSelect,
  onClick,
  textValue: _textValue,
  children,
  className,
  disabled,
  dataSlot,
  ...props
}: Omit<React.ComponentProps<"button">, "onSelect"> & {
  checked?: boolean | "indeterminate"
  onCheckedChange?: (checked: boolean) => void
  onSelect?: (event: Event) => void
  textValue?: string
  dataSlot: string
}) {
  const state = useMenuSheet()
  const isChecked = checked === true
  return (
    <button
      {...props}
      type="button"
      role="menuitemcheckbox"
      aria-checked={checked === "indeterminate" ? "mixed" : isChecked}
      data-slot={dataSlot}
      data-state={isChecked ? "checked" : "unchecked"}
      disabled={disabled}
      className={cn(menuSheetRowClass, "pr-11 data-[state=checked]:font-medium", className)}
      onClick={composeHandlers(onClick, () => {
        if (disabled) return
        const select = selectEvent()
        onSelect?.(select)
        onCheckedChange?.(!isChecked)
        if (!select.defaultPrevented) state?.setOpen(false)
      })}
    >
      {children}
      <MenuSheetCheck checked={isChecked} />
    </button>
  )
}

const MenuSheetRadioContext = React.createContext<{
  value?: string
  onValueChange?: (value: string) => void
} | null>(null)

export function MenuSheetRadioGroup({
  value,
  onValueChange,
  dataSlot,
  className,
  ...props
}: Omit<React.ComponentProps<"div">, "dir"> & {
  value?: string
  onValueChange?: (value: string) => void
  dataSlot: string
}) {
  const context = React.useMemo(() => ({ value, onValueChange }), [onValueChange, value])
  return (
    <MenuSheetRadioContext.Provider value={context}>
      <div {...props} role="group" data-slot={dataSlot} className={cn("flex flex-col", className)} />
    </MenuSheetRadioContext.Provider>
  )
}

/** A sheet radio row: role menuitemradio with a trailing check. */
export function MenuSheetRadioItem({
  value,
  onSelect,
  onClick,
  textValue: _textValue,
  children,
  className,
  disabled,
  dataSlot,
  ...props
}: Omit<React.ComponentProps<"button">, "onSelect" | "value"> & {
  value: string
  onSelect?: (event: Event) => void
  textValue?: string
  dataSlot: string
}) {
  const state = useMenuSheet()
  const group = React.useContext(MenuSheetRadioContext)
  const checked = group?.value === value
  return (
    <button
      {...props}
      type="button"
      role="menuitemradio"
      aria-checked={checked}
      data-slot={dataSlot}
      data-state={checked ? "checked" : "unchecked"}
      disabled={disabled}
      className={cn(menuSheetRowClass, "pr-11 data-[state=checked]:font-medium", className)}
      onClick={composeHandlers(onClick, () => {
        if (disabled) return
        const select = selectEvent()
        onSelect?.(select)
        group?.onValueChange?.(value)
        if (!select.defaultPrevented) state?.setOpen(false)
      })}
    >
      {children}
      <MenuSheetCheck checked={checked} />
    </button>
  )
}

export function MenuSheetLabel({
  className,
  inset,
  variant = "label",
  description,
  children,
  dataSlot,
  ...props
}: React.ComponentProps<"div"> & {
  inset?: boolean
  variant?: "label" | "header"
  description?: React.ReactNode
  dataSlot: string
}) {
  return (
    <div
      {...props}
      data-slot={dataSlot}
      data-variant={variant}
      className={cn(
        variant === "header"
          ? "px-3 pt-2 pb-1 text-(length:--text-title) leading-5 font-medium text-foreground"
          : "px-3 pt-2.5 pb-1 text-(length:--text-label) leading-4 font-semibold tracking-(--tracking-label) text-muted-foreground-2 uppercase",
        inset && SHEET_INSET_CLASS,
        className
      )}
    >
      {children}
      {description !== undefined && (
        <span className={cn(menuDescriptionClass, "mt-0.5 text-(length:--text-ui)")}>{description}</span>
      )}
    </div>
  )
}

export function MenuSheetSeparator({
  className,
  dataSlot,
  ...props
}: React.ComponentProps<"div"> & { dataSlot: string }) {
  return (
    <div
      role="separator"
      data-slot={dataSlot}
      className={cn("my-1 h-px shrink-0 bg-border", className)}
      {...props}
    />
  )
}

export function MenuSheetShortcut({
  className,
  dataSlot,
  ...props
}: React.ComponentProps<"span"> & { dataSlot: string }) {
  return (
    <span
      data-slot={dataSlot}
      className={cn(menuShortcutClass, "text-(length:--text-ui)", className)}
      {...props}
    />
  )
}

export function MenuSheetEmpty({
  className,
  loading = false,
  children,
  dataSlot,
  ...props
}: React.ComponentProps<"div"> & { loading?: boolean; dataSlot: string }) {
  return (
    <div
      role="status"
      data-slot={dataSlot}
      className={cn(menuEmptyClass, "min-h-11 text-(length:--text-ui)", className)}
      {...props}
    >
      {loading && <LoaderCircleIcon aria-hidden="true" />}
      {children}
    </div>
  )
}

export function MenuSheetGroup({
  dataSlot,
  className,
  ...props
}: React.ComponentProps<"div"> & { dataSlot: string }) {
  return <div role="group" data-slot={dataSlot} className={cn("flex flex-col", className)} {...props} />
}

const MenuSheetSubContext = React.createContext<string | null>(null)

/** A submenu: its trigger drills into its items; a back row returns. */
export function MenuSheetSub({ children }: { children?: React.ReactNode }) {
  const id = React.useId()
  return <MenuSheetSubContext.Provider value={id}>{children}</MenuSheetSubContext.Provider>
}

export function MenuSheetSubTrigger({
  className,
  inset,
  variant = "default",
  textValue,
  children,
  disabled,
  dataSlot,
  onClick,
  ...props
}: React.ComponentProps<"button"> & {
  inset?: boolean
  variant?: "default" | "destructive"
  textValue?: string
  dataSlot: string
}) {
  const state = useMenuSheet()
  const id = React.useContext(MenuSheetSubContext)
  const open = id !== null && state?.stack.some((level) => level.id === id) === true
  return (
    <button
      {...props}
      type="button"
      role="menuitem"
      aria-haspopup="menu"
      aria-expanded={open}
      data-slot={dataSlot}
      data-variant={variant}
      data-sub-id={id ?? undefined}
      data-disabled={disabled ? "" : undefined}
      disabled={disabled}
      className={cn(menuSheetRowClass, inset && SHEET_INSET_CLASS, className)}
      onClick={composeHandlers(onClick, (event) => {
        if (id === null || !state || disabled) return
        state.drillIn({ id, label: textValue ?? rowLabel(event.currentTarget) })
      })}
    >
      {children}
      <ChevronRightIcon className="ml-auto" aria-hidden="true" />
    </button>
  )
}

export function MenuSheetSubContent({
  className,
  children,
  dataSlot,
}: {
  className?: string
  children?: React.ReactNode
  dataSlot: string
}) {
  const state = useMenuSheet()
  const id = React.useContext(MenuSheetSubContext)
  if (!state?.pane || id === null) return null
  const index = state.stack.findIndex((level) => level.id === id)
  if (index < 0) return null
  const level = state.stack[index]!
  return createPortal(
    <div
      data-slot="menu-sheet-pane"
      data-sub-slot={dataSlot}
      hidden={index !== state.stack.length - 1}
      role="group"
      aria-label={level.label}
      className={cn("flex flex-col", className)}
    >
      <button
        type="button"
        role="menuitem"
        data-slot="menu-sheet-back"
        className={cn(menuSheetRowClass, "font-medium")}
        onClick={() => {
          state.back()
          requestAnimationFrame(() => {
            document
              .querySelector<HTMLElement>(`[data-sub-id="${CSS.escape(id)}"]`)
              ?.focus()
          })
        }}
      >
        <ChevronLeftIcon aria-hidden="true" />
        {level.label}
      </button>
      <div role="separator" className="my-1 h-px shrink-0 bg-border" />
      {children}
    </div>,
    state.pane
  )
}
