import * as React from "react"
import { createPortal } from "react-dom"
import { X } from "lucide-react"
import { DismissableLayer, Presence } from "radix-ui/internal"

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
  /**
   * An element in the surface that raised the toast, such as a side panel
   * or a popover (or that surface itself). The toast sits at the bottom
   * centre of the anchor's nearest `data-toast-region`, and at the app's
   * default region without one, or once that surface has gone.
   */
  readonly anchor?: Element | null
}

type ToastControls = {
  /** Shows a toast, replacing the one on screen. */
  readonly show: (options: ToastOptions) => void
}

const TOAST_DURATION = 5_000

/** A downward drag at least this long dismisses the toast. */
const SWIPE_THRESHOLD = 50

/** How long the announcement stays in its live region. */
const ANNOUNCEMENT_DURATION = 1_000

const ToastContext = React.createContext<ToastControls | null>(null)

type ToastEntry = {
  readonly id: number
  readonly options: ToastOptions
  readonly open: boolean
  /** The anchor's region, found as the toast is shown. */
  readonly region: HTMLElement | null
}

/** The app's default region: the workspace. */
const DEFAULT_REGION_SELECTOR = '[data-toast-region="default"]'

/**
 * The app's one toast region, mounted once at the root. It holds one toast
 * at a time: a new toast replaces the current one. A toast closes after its
 * duration, which pauses while the pointer is over it, focus is inside it,
 * or the window is in the background. F8 moves focus to it; Escape, while
 * focus is inside it, or a downward swipe dismisses it.
 *
 * A toast is not a dismissable layer (unlike Radix Toast, whose every toast
 * is one and so takes Escape from an open menu, popover or sheet beneath
 * it). Its region is a dismissable-layer branch instead, so pressing or
 * focusing a toast never dismisses the layer underneath.
 */
function ToastProvider({ children }: { readonly children: React.ReactNode }) {
  const [toast, setToast] = React.useState<ToastEntry | null>(null)
  const nextId = React.useRef(0)
  const controls = React.useMemo<ToastControls>(
    () => ({
      show(options) {
        nextId.current += 1
        setToast({
          id: nextId.current,
          options,
          open: true,
          region: options.anchor?.closest<HTMLElement>("[data-toast-region]") ?? null,
        })
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
      {children}
      <ToastRegion toast={toast} onClose={close} />
    </ToastContext.Provider>
  )
}

function ToastRegion({
  toast,
  onClose,
}: {
  readonly toast: ToastEntry | null
  readonly onClose: (id: number) => void
}) {
  const open = toast?.open ?? false
  const region = React.useRef<HTMLDivElement>(null)
  const viewport = React.useRef<HTMLOListElement>(null)
  // Where focus was before it entered the region, to return it on close.
  const returnFocus = React.useRef<HTMLElement | null>(null)
  const [hovered, setHovered] = React.useState(false)
  const [focused, setFocused] = React.useState(false)
  const [windowBlurred, setWindowBlurred] = React.useState(false)
  const placement = useToastPlacement(open, toast?.region ?? null)
  const toastId = toast?.id
  const closeCurrent = React.useCallback(() => {
    if (toastId !== undefined) onClose(toastId)
  }, [onClose, toastId])

  // F8 moves focus to the toast.
  React.useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "F8" && event.code !== "F8") return
      const item = viewport.current?.querySelector<HTMLElement>(
        '[data-slot="toast"][data-state="open"]'
      )
      if (!item) return
      event.preventDefault()
      item.focus()
    }
    document.addEventListener("keydown", onKeyDown)
    return () => document.removeEventListener("keydown", onKeyDown)
  }, [])

  // Escape belongs to the toast only while focus is inside it; otherwise it
  // reaches whatever is underneath, such as an open menu, a popover, a
  // sheet or Settings. The window's capture phase runs before the topmost
  // Radix layer's document listener, so a focused toast closes first, and
  // the handled event goes no further.
  React.useEffect(() => {
    if (!open) return undefined
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented || event.isComposing)
        return
      if (!(event.target instanceof Node) || !region.current?.contains(event.target))
        return
      event.preventDefault()
      event.stopPropagation()
      closeCurrent()
    }
    window.addEventListener("keydown", onKeyDown, { capture: true })
    return () =>
      window.removeEventListener("keydown", onKeyDown, { capture: true })
  }, [open, closeCurrent])

  React.useEffect(() => {
    if (!open) return undefined
    const onBlur = () => setWindowBlurred(true)
    const onFocus = () => setWindowBlurred(false)
    window.addEventListener("blur", onBlur)
    window.addEventListener("focus", onFocus)
    return () => {
      window.removeEventListener("blur", onBlur)
      window.removeEventListener("focus", onFocus)
      setWindowBlurred(false)
    }
  }, [open])

  // A toast that closes with focus inside it hands focus back to where it
  // came from (the viewport when that is gone), so it is not dropped.
  React.useEffect(() => {
    if (open) return
    const active = document.activeElement
    if (!active || !region.current?.contains(active)) return
    const target = returnFocus.current
    returnFocus.current = null
    if (target?.isConnected) target.focus({ preventScroll: true })
    else viewport.current?.focus({ preventScroll: true })
  }, [open])

  return (
    <DismissableLayer.Branch
      ref={region}
      role="region"
      aria-label="Notifications (F8)"
      onPointerMove={() => setHovered(true)}
      onPointerLeave={() => setHovered(false)}
      onFocus={(event) => {
        const from = event.relatedTarget
        if (
          from instanceof HTMLElement &&
          !event.currentTarget.contains(from)
        )
          returnFocus.current = from
        setFocused(true)
      }}
      onBlur={(event) => {
        const to = event.relatedTarget
        if (!(to instanceof Node) || !event.currentTarget.contains(to))
          setFocused(false)
      }}
    >
      <ol
        ref={viewport}
        data-slot="toast-viewport"
        tabIndex={-1}
        style={
          placement
            ? ({
                "--toast-x": `${placement.x}px`,
                "--toast-bottom": `${placement.bottom}px`,
                "--toast-region-width": `${placement.regionWidth}px`,
              } as React.CSSProperties)
            : undefined
        }
      >
        {toast && (
          <Presence.Presence key={toast.id} present={toast.open}>
            <ToastItem
              options={toast.options}
              open={toast.open}
              paused={hovered || focused || windowBlurred}
              onClose={closeCurrent}
            />
          </Presence.Presence>
        )}
      </ol>
    </DismissableLayer.Branch>
  )
}

type Swipe = {
  readonly startX: number
  readonly startY: number
  started: boolean
  distance: number
}

function ToastItem({
  options,
  open,
  paused,
  onClose,
  ref,
}: {
  readonly options: ToastOptions
  readonly open: boolean
  readonly paused: boolean
  readonly onClose: () => void
  readonly ref?: React.Ref<HTMLLIElement>
}) {
  const { message, action, duration = TOAST_DURATION } = options
  const remaining = React.useRef(duration)
  const swipe = React.useRef<Swipe | null>(null)

  React.useEffect(() => {
    if (!open || paused || !Number.isFinite(remaining.current)) return undefined
    const started = Date.now()
    const timer = window.setTimeout(onClose, Math.max(0, remaining.current))
    return () => {
      window.clearTimeout(timer)
      remaining.current -= Date.now() - started
    }
  }, [open, paused, onClose])

  const endSwipe = (element: HTMLLIElement, pointerId: number) => {
    const current = swipe.current
    swipe.current = null
    if (!current?.started) return
    if (element.hasPointerCapture(pointerId))
      element.releasePointerCapture(pointerId)
    element.style.removeProperty("--toast-swipe-move-y")
    if (current.distance >= SWIPE_THRESHOLD) {
      element.setAttribute("data-swipe", "end")
      element.style.setProperty("--toast-swipe-end-y", `${current.distance}px`)
      onClose()
    } else {
      element.setAttribute("data-swipe", "cancel")
    }
    // The press that ended a swipe is not a click on the toast's controls.
    element.addEventListener(
      "click",
      (event) => {
        event.preventDefault()
        event.stopPropagation()
      },
      { once: true, capture: true }
    )
  }

  return (
    <li
      ref={ref}
      data-slot="toast"
      data-state={open ? "open" : "closed"}
      data-swipe-direction="down"
      tabIndex={0}
      style={{ userSelect: "none", touchAction: "none" }}
      onPointerDown={(event) => {
        if (event.button !== 0) return
        swipe.current = {
          startX: event.clientX,
          startY: event.clientY,
          started: false,
          distance: 0,
        }
      }}
      onPointerMove={(event) => {
        const current = swipe.current
        if (!current) return
        const x = event.clientX - current.startX
        const y = event.clientY - current.startY
        if (!current.started) {
          const buffer = event.pointerType === "touch" ? 10 : 2
          if (y > buffer && Math.abs(x) <= y) {
            current.started = true
            event.currentTarget.setPointerCapture(event.pointerId)
            event.currentTarget.setAttribute("data-swipe", "start")
          } else if (Math.abs(x) > buffer || Math.abs(y) > buffer) {
            // Moving any other way is not a swipe.
            swipe.current = null
          }
          return
        }
        current.distance = Math.max(0, y)
        event.currentTarget.setAttribute("data-swipe", "move")
        event.currentTarget.style.setProperty(
          "--toast-swipe-move-y",
          `${current.distance}px`
        )
      }}
      onPointerUp={(event) => endSwipe(event.currentTarget, event.pointerId)}
      onPointerCancel={(event) => {
        const current = swipe.current
        if (current) current.distance = 0
        endSwipe(event.currentTarget, event.pointerId)
      }}
    >
      <ToastAnnouncement
        text={
          action
            ? `${message}. ${action.label} is available: press F8.`
            : message
        }
      />
      <div data-slot="toast-message">{message}</div>
      {action && (
        <button
          type="button"
          data-slot="toast-action"
          onClick={() => {
            action.onAction()
            onClose()
          }}
        >
          {action.label}
        </button>
      )}
      <button
        type="button"
        data-slot="toast-close"
        aria-label="Dismiss"
        onClick={onClose}
      >
        <X aria-hidden="true" />
      </button>
    </li>
  )
}

/**
 * Announces a toast politely. The live region is a fresh child of the
 * document body, outside anything a modal layer hides, and is filled a
 * frame after it mounts so screen readers notice the change.
 */
function ToastAnnouncement({ text }: { readonly text: string }) {
  const [filled, setFilled] = React.useState(false)
  const [done, setDone] = React.useState(false)
  React.useEffect(() => {
    const frame = window.requestAnimationFrame(() => setFilled(true))
    const timer = window.setTimeout(() => setDone(true), ANNOUNCEMENT_DURATION)
    return () => {
      window.cancelAnimationFrame(frame)
      window.clearTimeout(timer)
    }
  }, [])
  if (done) return null
  return createPortal(
    <div role="status" aria-live="polite" aria-atomic="true" className="sr-only">
      {filled ? text : null}
    </div>,
    document.body
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
 * The region the toast sits on: the anchor's while it is still shown, else
 * the app's default region (the whole viewport without one).
 */
function toastRegion(anchored: HTMLElement | null): HTMLElement | null {
  if (anchored?.isConnected && anchored.getBoundingClientRect().width > 0)
    return anchored
  return document.querySelector<HTMLElement>(DEFAULT_REGION_SELECTOR)
}

/**
 * Centres the toast on its region and lifts it above every visible
 * `data-toast-avoid` element across it, such as the composer or a sheet's
 * bottom bar, and above the soft keyboard.
 */
function measureToastPlacement(
  keyboardInset: number,
  anchored: HTMLElement | null
): ToastPlacement {
  const viewportBottom = window.innerHeight - keyboardInset
  const region = toastRegion(anchored)
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

/** Attributes whose change can add, remove, hide or reveal an avoided element. */
const PLACEMENT_ATTRIBUTES = [
  "data-toast-avoid",
  "data-toast-region",
  "aria-hidden",
  "inert",
]

/**
 * The toast's placement while one is up. It is measured again on resize,
 * when the region or an avoided element changes size (the composer grows
 * when the chip a toast announces arrives), when avoided elements come and
 * go or are covered (a sheet opening or closing), and when an animation or
 * transition ends (a sheet sliding into place). Changes are coalesced to one
 * measurement per frame.
 */
function useToastPlacement(
  active: boolean,
  anchored: HTMLElement | null
): ToastPlacement | undefined {
  const touch = useTouchDensity()
  const keyboardInset = useKeyboardInset(touch && active)
  const [placement, setPlacement] = React.useState<ToastPlacement>()

  React.useLayoutEffect(() => {
    if (!active) return undefined
    let frame = 0
    const observed = new Set<Element>()
    const resizeObserver =
      typeof ResizeObserver === "undefined"
        ? undefined
        : new ResizeObserver(() => schedule())
    const update = () => {
      frame = 0
      const next = measureToastPlacement(keyboardInset, anchored)
      setPlacement((current) =>
        current?.x === next.x &&
        current.bottom === next.bottom &&
        current.regionWidth === next.regionWidth
          ? current
          : next
      )
      if (!resizeObserver) return
      const region = toastRegion(anchored)
      const targets = new Set<Element>(toastAvoidElements())
      if (region) targets.add(region)
      for (const element of observed) {
        if (targets.has(element)) continue
        resizeObserver.unobserve(element)
        observed.delete(element)
      }
      for (const element of targets) {
        if (observed.has(element)) continue
        resizeObserver.observe(element)
        observed.add(element)
      }
    }
    const schedule = () => {
      if (frame === 0) frame = window.requestAnimationFrame(update)
    }
    update()
    const mutationObserver = new MutationObserver(schedule)
    mutationObserver.observe(document.body, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: PLACEMENT_ATTRIBUTES,
    })
    window.addEventListener("resize", schedule)
    document.addEventListener("animationend", schedule, true)
    document.addEventListener("transitionend", schedule, true)
    return () => {
      if (frame !== 0) window.cancelAnimationFrame(frame)
      mutationObserver.disconnect()
      resizeObserver?.disconnect()
      window.removeEventListener("resize", schedule)
      document.removeEventListener("animationend", schedule, true)
      document.removeEventListener("transitionend", schedule, true)
    }
  }, [active, anchored, keyboardInset])

  return placement
}

/** Shows toasts in the app's toast region. Use inside `ToastProvider`. */
function useToast(): ToastControls {
  const controls = React.useContext(ToastContext)
  if (!controls) throw new Error("useToast must be used inside ToastProvider")
  return controls
}

export { ToastProvider, useToast, type ToastAction, type ToastOptions, type ToastControls }
