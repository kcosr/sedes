import * as React from "react"
import { Dialog as DialogPrimitive } from "radix-ui"
import { XIcon } from "lucide-react"

import { useKeyboardInset } from "@client/app/use-keyboard-inset"
import { useTouchDensity } from "@client/app/use-touch-density"
import { Button } from "@client/components/ui/button"
import { Callout } from "@client/components/ui/callout"
import { FieldControlContext } from "@client/components/ui/control"

// Floating content opened inside a dialog portals into the dialog node, so
// it layers above the dialog and stays inside its focus and scroll lock.
export const DialogPortalContainerContext = React.createContext<HTMLElement | null | undefined>(undefined)

type DialogSize = "sm" | "md" | "lg" | "xl" | "viewer"
type DialogLayout = "modal" | "side" | "sheet"
type DialogMobile = "card" | "sheet" | "fullscreen"
type DialogPresentation = "modal" | "side" | "sheet" | "fullscreen"
/**
 * The stacking band: `dialog` (default); `over-dialog` for dialogs opened
 * from the mobile drawer or from a sheet, which sit above the dialog band;
 * `blocking` for dialogs that belong to a blocking operation or open over
 * one.
 */
type DialogLayer = "dialog" | "over-dialog" | "blocking"

function Dialog({
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Root>) {
  return <DialogPrimitive.Root data-slot="dialog" {...props} />
}

function DialogTrigger({
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Trigger>) {
  return <DialogPrimitive.Trigger data-slot="dialog-trigger" {...props} />
}

function DialogPortal({
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Portal>) {
  return <DialogPrimitive.Portal data-slot="dialog-portal" {...props} />
}

function DialogClose({
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Close>) {
  return <DialogPrimitive.Close data-slot="dialog-close" {...props} />
}

function DialogOverlay({
  layer = "dialog",
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Overlay> & { layer?: DialogLayer }) {
  // Surface, layer and motion: components/ui/overlay.css.
  return (
    <DialogPrimitive.Overlay
      data-slot="dialog-overlay"
      data-testid="dialog-overlay"
      data-layer={layer}
      {...props}
    />
  )
}

function defaultMobile(layout: DialogLayout, size: DialogSize): DialogMobile {
  if (layout !== "modal") return "sheet"
  if (size === "sm") return "card"
  if (size === "viewer") return "fullscreen"
  return "sheet"
}

const MOBILE_PRESENTATION: Record<DialogMobile, DialogPresentation> = {
  card: "modal",
  sheet: "sheet",
  fullscreen: "fullscreen",
}

const FIELD_SELECTOR = [
  'input:not([type="hidden"]):not([type="file"]):not([readonly])',
  "textarea:not([readonly])",
  "select",
  '[contenteditable="true"]',
  '[role="combobox"]',
  '[role="textbox"]',
  '[role="checkbox"]',
  '[role="switch"]',
  '[role="radio"]',
  '[role="slider"]',
].join(", ")

function isShown(element: HTMLElement, boundary: HTMLElement): boolean {
  if (element.matches(':disabled, [aria-disabled="true"]')) return false
  // Floating content portalled into the dialog manages its own focus.
  if (element.closest("[data-radix-popper-content-wrapper]")) return false
  for (let node: HTMLElement | null = element; node && node !== boundary; node = node.parentElement) {
    if (node.hidden || node.inert) return false
    const style = getComputedStyle(node)
    if (style.display === "none" || style.visibility === "hidden") return false
  }
  return true
}

const isTabbable = (element: HTMLElement, boundary: HTMLElement): boolean =>
  element.tabIndex >= 0 && isShown(element, boundary)

/**
 * Where focus lands when a dialog opens: an element marked
 * `data-autofocus`, else the first field, else the primary action (the last
 * footer button) unless it is destructive, in which case the safe choice
 * (the first non-destructive footer button). Never the X; with nothing to
 * focus, the dialog itself. Content that swaps phases while open (progress,
 * then choices) applies it again after the swap.
 */
function initialFocusTarget(content: HTMLElement): HTMLElement {
  const find = (selector: string, accept: typeof isShown) =>
    Array.from(content.querySelectorAll<HTMLElement>(selector)).find(
      (element) => accept(element, content)
    )
  // An explicit target may be programmatically focusable only (tabIndex -1).
  const explicit = find("[data-autofocus]", isShown)
  if (explicit) return explicit
  const field = find(FIELD_SELECTOR, isTabbable)
  if (field) return field
  const footer = Array.from(
    content.querySelectorAll<HTMLElement>('[data-slot="dialog-footer"]')
  ).at(-1)
  const actions = footer
    ? Array.from(footer.querySelectorAll<HTMLElement>("button, a[href]")).filter(
        (element) =>
          !element.closest('[data-slot="dialog-footer-start"]') &&
          isTabbable(element, content)
      )
    : []
  const primary = actions.at(-1)
  if (primary?.dataset.variant === "destructive") {
    return actions.find((action) => action.dataset.variant !== "destructive") ?? content
  }
  return primary ?? content
}

/** The element focused when a dialog opened, if it lies outside the dialog. */
function focusedOutside(content: HTMLElement): HTMLElement | null {
  const active = document.activeElement
  if (!(active instanceof HTMLElement) || active === document.body) return null
  return content.contains(active) ? null : active
}

/**
 * Whether focus already sits somewhere a closing dialog must not take it
 * from, for example a dialog that opened as this one closed. The body, the
 * closing content and any other dialog that is closing do not count.
 */
function focusMovedElsewhere(content: HTMLElement): boolean {
  const active = document.activeElement
  if (!active || active === document.body || content.contains(active)) return false
  return !active.closest('[data-slot="dialog-content"][data-state="closed"]')
}

type FocusTarget =
  | React.RefObject<HTMLElement | null>
  | (() => HTMLElement | null | undefined)

function resolveFocusTarget(target: FocusTarget | undefined): HTMLElement | null {
  if (!target) return null
  return (typeof target === "function" ? target() : target.current) ?? null
}

function DialogContent({
  className,
  children,
  size = "sm",
  layout = "modal",
  mobile,
  dismissible = true,
  showClose = true,
  showOverlay = true,
  layer = "dialog",
  returnFocusRef,
  fallbackFocus,
  style,
  ref,
  onOpenAutoFocus,
  onCloseAutoFocus,
  onEscapeKeyDown,
  onInteractOutside,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Content> & {
  /** Width step: sm 400 (confirms), md 560, lg 760, xl 1000, viewer for media. */
  size?: DialogSize
  /** A centered card, a trailing side panel, or a bottom sheet. */
  layout?: DialogLayout
  /** Presentation under the density switch; sm cards stay cards, md and up become sheets. */
  mobile?: DialogMobile
  /** False blocks Escape, outside clicks and the X, e.g. while an action is pending. */
  dismissible?: boolean
  showClose?: boolean
  // Non-modal surfaces leave chrome outside the dialog usable, so they opt
  // out of the scrim that would otherwise cover it.
  showOverlay?: boolean
  /** The stacking band; raise it for dialogs opened from the drawer, a sheet or a blocking operation. */
  layer?: DialogLayer
  /**
   * Where focus returns on close, in place of the element that was focused
   * when the dialog opened (the default). Name it when that element does not
   * outlive the dialog, e.g. a menu row that unmounts with its menu.
   */
  returnFocusRef?: React.RefObject<HTMLElement | null>
  /**
   * Where focus goes when the return target is gone, e.g. after the action
   * removed the row that opened the dialog: a surviving neighbour or the
   * list. A function is read at close, after the removal has rendered.
   */
  fallbackFocus?: FocusTarget
}) {
  const touch = useTouchDensity()
  const keyboardInset = useKeyboardInset(touch)
  const presentation = touch
    ? MOBILE_PRESENTATION[mobile ?? defaultMobile(layout, size)]
    : layout
  const [container, setContainer] = React.useState<HTMLDivElement | null>(null)
  // The element focused when this opening mounted; focus returns there.
  const opener = React.useRef<{ content: HTMLElement; element: HTMLElement | null }>(null)
  const contentRef = React.useCallback((node: HTMLDivElement | null) => {
    if (node && opener.current?.content !== node) {
      opener.current = { content: node, element: focusedOutside(node) }
    }
    setContainer(node)
    if (typeof ref === "function") return ref(node)
    if (ref) ref.current = node
  }, [ref])
  return (
    <DialogPortal>
      {showOverlay && <DialogOverlay layer={layer} />}
      <DialogPrimitive.Content
        ref={contentRef}
        data-slot="dialog-content"
        data-size={size}
        data-layout={presentation}
        data-layer={layer}
        data-close={showClose ? "" : undefined}
        className={className}
        style={{ "--keyboard-inset": `${keyboardInset}px`, ...style } as React.CSSProperties}
        onOpenAutoFocus={(event) => {
          // Escape hatch: a handler that prevents the default owns focus.
          onOpenAutoFocus?.(event)
          if (event.defaultPrevented) return
          event.preventDefault()
          const content = event.currentTarget as HTMLElement
          // Floating content that opened with the dialog focuses itself.
          if (content.querySelector("[data-radix-popper-content-wrapper]")) return
          initialFocusTarget(content).focus({ preventScroll: true })
        }}
        onCloseAutoFocus={(event) => {
          // A handler that prevents the default owns focus.
          onCloseAutoFocus?.(event)
          if (event.defaultPrevented) return
          const content = event.currentTarget as HTMLElement
          // A reopening may already have mounted new content; keep its opener.
          let openedFrom: HTMLElement | null = null
          if (opener.current?.content === content) {
            openedFrom = opener.current.element
            opener.current = null
          }
          if (focusMovedElsewhere(content)) {
            event.preventDefault()
            return
          }
          // The named target, else the opener, else the caller's survivor;
          // detached elements are skipped. With none, Radix focuses a
          // DialogTrigger if there is one.
          const target = [resolveFocusTarget(returnFocusRef), openedFrom]
            .find((element) => element?.isConnected)
            ?? resolveFocusTarget(fallbackFocus)
          if (!target?.isConnected) return
          event.preventDefault()
          target.focus()
        }}
        onEscapeKeyDown={(event) => {
          onEscapeKeyDown?.(event)
          if (!dismissible) event.preventDefault()
        }}
        onInteractOutside={(event) => {
          onInteractOutside?.(event)
          if (!dismissible) event.preventDefault()
        }}
        {...props}
      >
        <DialogPortalContainerContext.Provider value={container}>
          {/* React context crosses the portal: a dialog opened from inside a
              Field starts a new form. */}
          <FieldControlContext.Provider value={null}>{children}</FieldControlContext.Provider>
          {showClose && (
            <DialogPrimitive.Close data-slot="dialog-close" asChild>
              <Button
                variant="ghost"
                size="icon-sm"
                className="size-(--dialog-close-size)"
                disabled={!dismissible}
              >
                <XIcon />
                <span className="sr-only">Close</span>
              </Button>
            </DialogPrimitive.Close>
          )}
        </DialogPortalContainerContext.Provider>
      </DialogPrimitive.Content>
    </DialogPortal>
  )
}

/** Title, description and (visually) the X on the title row; never scrolls. */
function DialogHeader({ ...props }: React.ComponentProps<"div">) {
  return <div data-slot="dialog-header" {...props} />
}

/** The dialog's only scroll region, between the pinned header and footer. */
function DialogBody({ ...props }: React.ComponentProps<"div">) {
  return <div data-slot="dialog-body" {...props} />
}

/**
 * A titled group inside DialogBody: the uppercase section label, an optional
 * description, then the content (rows, a hairline card, a list).
 */
function DialogSection({
  title,
  description,
  children,
  ...props
}: Omit<React.ComponentProps<"section">, "title"> & {
  title: React.ReactNode
  description?: React.ReactNode
}) {
  const id = React.useId()
  return (
    <section data-slot="dialog-section" aria-labelledby={id} {...props}>
      <h3 id={id} data-slot="dialog-section-title">
        {title}
      </h3>
      {description ? (
        <p data-slot="dialog-section-description">{description}</p>
      ) : null}
      {children}
    </section>
  )
}

/** Below 520px dialog footers stack their actions full width (overlay.css). */
const DIALOG_FOOTER_STACK_QUERY = "(max-width: 519px)"

/**
 * Pinned actions: `start` holds tertiary actions on the leading edge; the
 * children follow as outline Cancel, then the primary action last. Below
 * 520px they stack full width with the primary on top.
 */
function DialogFooter({
  start,
  children,
  ...props
}: React.ComponentProps<"div"> & { start?: React.ReactNode }) {
  return (
    <div data-slot="dialog-footer" {...props}>
      {start !== undefined && start !== null && (
        <div data-slot="dialog-footer-start">{start}</div>
      )}
      {children}
    </div>
  )
}

function DialogTitle({
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Title>) {
  return <DialogPrimitive.Title data-slot="dialog-title" {...props} />
}

function DialogDescription({
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Description>) {
  return <DialogPrimitive.Description data-slot="dialog-description" {...props} />
}

/**
 * A notice or error inside a dialog: the Callout, info by default. Danger
 * alerts are announced (role="alert"); pass `role` to change that.
 */
function DialogAlert({
  tone = "info",
  role,
  ...props
}: React.ComponentProps<typeof Callout>) {
  return (
    <Callout
      data-slot="dialog-alert"
      tone={tone}
      role={role ?? (tone === "danger" ? "alert" : undefined)}
      {...props}
    />
  )
}

export {
  DIALOG_FOOTER_STACK_QUERY,
  Dialog,
  DialogAlert,
  DialogBody,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogOverlay,
  DialogPortal,
  DialogSection,
  DialogTitle,
  DialogTrigger,
  initialFocusTarget,
}
export type { DialogLayer, DialogLayout, DialogMobile, DialogSize }
