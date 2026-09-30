import * as React from "react"
import { Dialog as DialogPrimitive } from "radix-ui"
import {
  CircleAlertIcon,
  CircleCheckIcon,
  InfoIcon,
  TriangleAlertIcon,
  XIcon,
} from "lucide-react"
import { cva } from "class-variance-authority"

import { useKeyboardInset } from "@client/app/use-keyboard-inset"
import { useTouchDensity } from "@client/app/use-touch-density"
import { Button } from "@client/components/ui/button"
import { cn } from "@client/lib/utils"

// Floating content opened inside a dialog portals into the dialog node, so
// it layers above the dialog and stays inside its focus and scroll lock.
export const DialogPortalContainerContext = React.createContext<HTMLElement | null | undefined>(undefined)

type DialogSize = "sm" | "md" | "lg" | "xl" | "viewer"
type DialogLayout = "modal" | "side" | "sheet"
type DialogMobile = "card" | "sheet" | "fullscreen"
type DialogPresentation = "modal" | "side" | "sheet" | "fullscreen"

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
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Overlay>) {
  // Surface, layer and motion: components/ui/overlay.css.
  return (
    <DialogPrimitive.Overlay
      data-slot="dialog-overlay"
      data-testid="dialog-overlay"
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
 * focus, the dialog itself.
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

function DialogContent({
  className,
  overlayClassName,
  children,
  size = "sm",
  layout = "modal",
  mobile,
  dismissible = true,
  showClose = true,
  showOverlay = true,
  style,
  ref,
  onOpenAutoFocus,
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
  overlayClassName?: string
}) {
  const touch = useTouchDensity()
  const keyboardInset = useKeyboardInset(touch)
  const presentation = touch
    ? MOBILE_PRESENTATION[mobile ?? defaultMobile(layout, size)]
    : layout
  const [container, setContainer] = React.useState<HTMLDivElement | null>(null)
  const contentRef = React.useCallback((node: HTMLDivElement | null) => {
    setContainer(node)
    if (typeof ref === "function") return ref(node)
    if (ref) ref.current = node
  }, [ref])
  return (
    <DialogPortal>
      {showOverlay && <DialogOverlay className={overlayClassName} />}
      <DialogPrimitive.Content
        ref={contentRef}
        data-slot="dialog-content"
        data-size={size}
        data-layout={presentation}
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
          {children}
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

// A local copy of the Callout look (spec §3 "Callout"): the integration
// swaps DialogAlert's body for ui/callout.tsx and keeps this API.
const dialogAlertVariants = cva(
  "flex items-start gap-2.5 rounded-(--radius-ctl) border px-3 py-2.5 text-(length:--text-ui) leading-5 text-foreground [&>svg]:mt-0.5 [&>svg]:size-4 [&>svg]:shrink-0",
  {
    variants: {
      tone: {
        info: "border-info-border bg-info-soft [&>svg]:text-info",
        success: "border-success-border bg-success-soft [&>svg]:text-success",
        warning: "border-warning-border bg-warning-soft [&>svg]:text-warning",
        destructive: "border-destructive-border bg-destructive-soft [&>svg]:text-destructive",
      },
    },
    defaultVariants: { tone: "info" },
  }
)

type DialogAlertTone = "info" | "success" | "warning" | "destructive"

const DIALOG_ALERT_ICONS: Record<DialogAlertTone, typeof InfoIcon> = {
  info: InfoIcon,
  success: CircleCheckIcon,
  warning: TriangleAlertIcon,
  destructive: CircleAlertIcon,
}

/**
 * The one notice and error style inside dialogs. Destructive alerts are
 * announced (role="alert"); pass `role` to change that.
 */
function DialogAlert({
  tone = "info",
  title,
  action,
  children,
  className,
  ...props
}: Omit<React.ComponentProps<"div">, "title"> & {
  tone?: DialogAlertTone
  title?: React.ReactNode
  action?: React.ReactNode
}) {
  const Icon = DIALOG_ALERT_ICONS[tone]
  return (
    <div
      data-slot="dialog-alert"
      data-tone={tone}
      role={tone === "destructive" ? "alert" : undefined}
      className={cn(dialogAlertVariants({ tone }), className)}
      {...props}
    >
      <Icon aria-hidden="true" />
      <div className="grid min-w-0 flex-1 gap-0.5">
        {title !== undefined && <p className="m-0 font-medium">{title}</p>}
        {children !== undefined && (
          <div
            className={cn(
              "min-w-0 [overflow-wrap:anywhere]",
              title !== undefined && "text-(length:--text-meta) leading-4 text-muted-foreground"
            )}
          >
            {children}
          </div>
        )}
      </div>
      {action !== undefined && <div className="shrink-0 self-center">{action}</div>}
    </div>
  )
}

export {
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
  DialogTitle,
  DialogTrigger,
}
export type { DialogAlertTone, DialogLayout, DialogMobile, DialogSize }
