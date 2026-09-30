import * as React from "react"

/**
 * Reopening a floating surface while its exit motion still runs.
 *
 * Radix keeps a closed layer mounted until its exit animation ends, and the
 * fading layer still acts on the page: it took the press on the trigger
 * that reopened its menu as an outside press and closed the menu again, and
 * a reopened layer would be the same instance, never taking focus. So each
 * root counts its openings and each opening mounts its own content (keyed
 * by the count): a reopen starts fresh, with its entry motion and focus,
 * and drops the fading layer. A layer that has closed, or that a newer
 * opening has replaced, neither dismisses nor restores focus. overlay.css
 * lets the pointer pass through closing surfaces.
 */

interface RenderedOpening {
  readonly open: boolean
  readonly opening: number
}

interface FloatingOpening {
  /** The current opening; its content's React key. */
  readonly opening: number
  /** The root's state as last committed, read by the content's guards. */
  readonly rendered: React.RefObject<RenderedOpening>
}

const FloatingOpeningContext = React.createContext<FloatingOpening | null>(null)

/** A root's open state, controlled or not, so its openings can be counted. */
function useControllableOpen({
  open,
  defaultOpen = false,
  onOpenChange,
}: {
  open?: boolean
  defaultOpen?: boolean
  onOpenChange?: (open: boolean) => void
}): [boolean, (open: boolean) => void] {
  const [uncontrolledOpen, setUncontrolledOpen] = React.useState(defaultOpen)
  const controlled = open !== undefined
  const setOpen = React.useCallback(
    (next: boolean) => {
      if (!controlled) setUncontrolledOpen(next)
      onOpenChange?.(next)
    },
    [controlled, onOpenChange]
  )
  return [open ?? uncontrolledOpen, setOpen]
}

/** Counts a root's openings; wrap its parts in the returned provider. */
function useFloatingOpening(open: boolean): FloatingOpening {
  const [counted, setCounted] = React.useState({ open, opening: 0 })
  let opening = counted.opening
  if (counted.open !== open) {
    // Derived during render, so the content key changes in the same
    // render that opens it.
    if (open) opening += 1
    setCounted({ open, opening })
  }
  const rendered = React.useRef<RenderedOpening>({ open, opening })
  React.useLayoutEffect(() => {
    rendered.current = { open, opening }
  })
  return React.useMemo(() => ({ opening, rendered }), [opening])
}

function FloatingOpeningProvider({
  value,
  children,
}: {
  value: FloatingOpening
  children?: React.ReactNode
}) {
  return (
    <FloatingOpeningContext.Provider value={value}>{children}</FloatingOpeningContext.Provider>
  )
}

/**
 * The content side: its key, plus outside-interaction and close-focus
 * handlers that do nothing for a layer that has closed or been replaced
 * (and call the consumer's handlers otherwise).
 */
function useFloatingLayer<
  InteractEvent extends Event,
  FocusEvent extends Event,
>({
  onInteractOutside,
  onCloseAutoFocus,
}: {
  onInteractOutside?: (event: InteractEvent) => void
  onCloseAutoFocus?: (event: FocusEvent) => void
}): {
  key: number | undefined
  onInteractOutside: ((event: InteractEvent) => void) | undefined
  onCloseAutoFocus: ((event: FocusEvent) => void) | undefined
} {
  const context = React.useContext(FloatingOpeningContext)
  if (!context) return { key: undefined, onInteractOutside, onCloseAutoFocus }
  const { opening, rendered } = context
  return {
    key: opening,
    onInteractOutside: (event) => {
      const root = rendered.current
      if (!root.open || root.opening !== opening) {
        event.preventDefault()
        return
      }
      onInteractOutside?.(event)
    },
    onCloseAutoFocus: (event) => {
      if (rendered.current.opening !== opening) {
        event.preventDefault()
        return
      }
      onCloseAutoFocus?.(event)
    },
  }
}

export {
  FloatingOpeningProvider,
  useControllableOpen,
  useFloatingLayer,
  useFloatingOpening,
}
