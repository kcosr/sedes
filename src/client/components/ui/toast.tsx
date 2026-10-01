import * as React from "react"
import { X } from "lucide-react"
import { Toast as ToastPrimitive } from "radix-ui"

import { useKeyboardInset } from "@client/app/use-keyboard-inset"
import { useTouchDensity } from "@client/app/use-touch-density"
import "./toast.css"

/** A toast's one action, such as Undo. Choosing it also closes the toast. */
type ToastAction = {
  readonly label: string
  readonly onAction: () => void
}

type ToastOptions = {
  readonly message: string
  readonly action?: ToastAction
  /** Milliseconds before the toast closes; about five seconds by default. */
  readonly duration?: number
}

type ToastControls = {
  /** Shows a toast, replacing the one on screen. */
  readonly show: (options: ToastOptions) => void
}

const TOAST_DURATION = 5_000

const ToastContext = React.createContext<ToastControls | null>(null)

type ToastEntry = {
  readonly id: number
  readonly options: ToastOptions
  readonly open: boolean
}

/**
 * The app's one toast region, mounted once at the root. It holds one toast
 * at a time: a new toast replaces the current one. A toast closes after its
 * duration, which pauses while the pointer is over it or focus is inside
 * it (Radix Toast also pauses while the window is in the background). F8
 * moves focus to the region; Escape or a downward swipe dismisses.
 */
function ToastProvider({ children }: { readonly children: React.ReactNode }) {
  const [toast, setToast] = React.useState<ToastEntry | null>(null)
  const nextId = React.useRef(0)
  const controls = React.useMemo<ToastControls>(
    () => ({
      show(options) {
        nextId.current += 1
        setToast({ id: nextId.current, options, open: true })
      },
    }),
    []
  )
  const close = React.useCallback((id: number) => {
    setToast((current) =>
      current?.id === id ? { ...current, open: false } : current
    )
  }, [])

  return (
    <ToastContext.Provider value={controls}>
      <ToastPrimitive.Provider
        duration={TOAST_DURATION}
        swipeDirection="down"
        label="Notification"
      >
        {children}
        {toast && (
          <ToastItem
            key={toast.id}
            options={toast.options}
            open={toast.open}
            onClose={() => close(toast.id)}
          />
        )}
        <ToastViewport active={toast?.open ?? false} />
      </ToastPrimitive.Provider>
    </ToastContext.Provider>
  )
}

function ToastItem({
  options,
  open,
  onClose,
}: {
  readonly options: ToastOptions
  readonly open: boolean
  readonly onClose: () => void
}) {
  const { message, action, duration } = options
  return (
    <ToastPrimitive.Root
      data-slot="toast"
      // "background" announces politely instead of interrupting.
      type="background"
      open={open}
      duration={duration}
      onOpenChange={(next) => {
        if (!next) onClose()
      }}
    >
      <ToastPrimitive.Description data-slot="toast-message">
        {message}
      </ToastPrimitive.Description>
      {action && (
        <ToastPrimitive.Action
          data-slot="toast-action"
          altText={action.label}
          onClick={action.onAction}
        >
          {action.label}
        </ToastPrimitive.Action>
      )}
      <ToastPrimitive.Close data-slot="toast-close" aria-label="Dismiss">
        <X aria-hidden="true" />
      </ToastPrimitive.Close>
    </ToastPrimitive.Root>
  )
}

type ToastPlacement = {
  /** Horizontal centre of the region, in viewport pixels. */
  readonly x: number
  /** Distance from the viewport bottom to the lowest clear edge. */
  readonly bottom: number
  readonly regionWidth: number
}

/** Room kept above a toast when an avoided element is very tall. */
const TOAST_MIN_ROOM = 64

function toastAvoidElements(): HTMLElement[] {
  return Array.from(
    document.querySelectorAll<HTMLElement>("[data-toast-avoid]")
  ).filter(
    // Content behind a modal dialog or sheet is aria-hidden (or inert) and
    // covered, so the toast need not clear it.
    (element) => !element.closest('[aria-hidden="true"], [inert]')
  )
}

/**
 * Centres the toast on the element marked `data-toast-region` (the active
 * workspace; the whole viewport without one) and lifts it above every
 * visible `data-toast-avoid` element across it, such as the composer or a
 * sheet's bottom bar, and above the soft keyboard.
 */
function measureToastPlacement(keyboardInset: number): ToastPlacement {
  const viewportBottom = window.innerHeight - keyboardInset
  const region = document.querySelector<HTMLElement>("[data-toast-region]")
  const regionBox = region?.getBoundingClientRect()
  const measured = regionBox !== undefined && regionBox.width > 0
  const left = measured ? regionBox.left : 0
  const right = measured ? regionBox.right : window.innerWidth
  const top = measured ? regionBox.top : 0
  let edge = Math.min(measured ? regionBox.bottom : window.innerHeight, viewportBottom)
  for (const element of toastAvoidElements()) {
    const box = element.getBoundingClientRect()
    if (box.width === 0 || box.height === 0) continue
    if (box.right <= left || box.left >= right) continue
    if (box.top >= edge || box.bottom <= top) continue
    edge = box.top
  }
  edge = Math.max(edge, top + TOAST_MIN_ROOM)
  return {
    x: Math.round((left + right) / 2),
    bottom: Math.max(0, Math.round(window.innerHeight - edge)),
    regionWidth: Math.round(right - left),
  }
}

function ToastViewport({ active }: { readonly active: boolean }) {
  const touch = useTouchDensity()
  const keyboardInset = useKeyboardInset(touch && active)
  const [placement, setPlacement] = React.useState<ToastPlacement>()

  React.useLayoutEffect(() => {
    if (!active) return undefined
    const update = () => {
      const next = measureToastPlacement(keyboardInset)
      setPlacement((current) =>
        current?.x === next.x &&
        current.bottom === next.bottom &&
        current.regionWidth === next.regionWidth
          ? current
          : next
      )
    }
    update()
    window.addEventListener("resize", update)
    // The composer grows and shrinks while a toast is up, for example when
    // the chip a toast announces arrives.
    const observer =
      typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(update)
    const region = document.querySelector<HTMLElement>("[data-toast-region]")
    if (observer) {
      if (region) observer.observe(region)
      for (const element of toastAvoidElements()) observer.observe(element)
    }
    return () => {
      window.removeEventListener("resize", update)
      observer?.disconnect()
    }
  }, [active, keyboardInset])

  return (
    <ToastPrimitive.Viewport
      data-slot="toast-viewport"
      style={
        placement
          ? ({
              "--toast-x": `${placement.x}px`,
              "--toast-bottom": `${placement.bottom}px`,
              "--toast-region-width": `${placement.regionWidth}px`,
            } as React.CSSProperties)
          : undefined
      }
    />
  )
}

/** Shows toasts in the app's toast region. Use inside `ToastProvider`. */
function useToast(): ToastControls {
  const controls = React.useContext(ToastContext)
  if (!controls) throw new Error("useToast must be used inside ToastProvider")
  return controls
}

export { ToastProvider, useToast, type ToastAction, type ToastOptions, type ToastControls }
