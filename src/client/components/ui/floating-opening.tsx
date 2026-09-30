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
 * and drops the fading layer. The replaced layer neither dismisses the new
 * opening nor restores focus. A fading layer's own close request is
 * harmless: dropdown, popover and sheet roots are controlled here, so Radix
 * ignores it while the root is closed, and a context menu reopens on the
 * contextmenu event, after the press. Any other press during an exit
 * reaches the layer as before and leaves focus where that press put it.
 * overlay.css lets the pointer pass through closing surfaces.
 */

interface FloatingOpening {
  /** The current opening; its content's React key. */
  readonly opening: number
  /** The opening last committed, read by the content's guards. */
  readonly current: React.RefObject<number>
}

const FloatingOpeningContext = React.createContext<FloatingOpening | null>(null)

/**
 * A root's open state, controlled or not, with its openings counted. Pass
 * `open` and `setOpen` to the Radix root and wrap its parts in a
 * FloatingOpeningProvider with `value`.
 */
function useFloatingOpening({
  open: openProp,
  defaultOpen = false,
  onOpenChange,
}: {
  open?: boolean
  defaultOpen?: boolean
  onOpenChange?: (open: boolean) => void
}): {
  open: boolean
  setOpen: (open: boolean) => void
  value: FloatingOpening
} {
  const [uncontrolledOpen, setUncontrolledOpen] = React.useState(defaultOpen)
  const controlled = openProp !== undefined
  const open = openProp ?? uncontrolledOpen
  const setOpen = React.useCallback(
    (next: boolean) => {
      if (!controlled) setUncontrolledOpen(next)
      onOpenChange?.(next)
    },
    [controlled, onOpenChange]
  )

  const [counted, setCounted] = React.useState({ open, opening: 0 })
  let opening = counted.opening
  if (counted.open !== open) {
    // Derived during render, so the content key changes in the same
    // render that opens it.
    if (open) opening += 1
    setCounted({ open, opening })
  }
  const current = React.useRef(opening)
  React.useLayoutEffect(() => {
    current.current = opening
  })
  const value = React.useMemo(() => ({ opening, current }), [opening])
  return { open, setOpen, value }
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
 * handlers that do nothing for a layer a reopening replaces (and call the
 * consumer's handlers otherwise).
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
  const { opening, current } = context
  return {
    key: opening,
    onInteractOutside: (event) => {
      // A newer opening replaced this layer: dismissing would close it.
      if (current.current !== opening) {
        event.preventDefault()
        return
      }
      onInteractOutside?.(event)
    },
    onCloseAutoFocus: (event) => {
      if (current.current !== opening) {
        event.preventDefault()
        return
      }
      onCloseAutoFocus?.(event)
    },
  }
}

export { FloatingOpeningProvider, useFloatingLayer, useFloatingOpening }
