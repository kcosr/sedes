import * as React from "react"
import { cva } from "class-variance-authority"

/**
 * The one form-control box shared by Input, Textarea, SelectTrigger and
 * NativeSelect: the same border, radius, type step and focus ring as Button.
 * `default` follows the density switch (32px and 13px text on desktop, 44px
 * and 16px text on touch, so iOS does not zoom); `sm` is the fixed compact
 * step that Button's `sm` also uses; `multiline` leaves the height to the
 * content (Textarea).
 */
const controlVariants = cva(
  "rounded-(--radius-ctl) border border-input bg-transparent text-(length:--text-input) shadow-xs transition-[color,box-shadow] outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-(--disabled-opacity) aria-invalid:border-destructive aria-invalid:ring-destructive/20 dark:bg-input/30 dark:aria-invalid:border-destructive/50 dark:aria-invalid:ring-destructive/40",
  {
    variants: {
      size: {
        default: "h-(--control-default)",
        sm: "h-(--control-sm) text-(length:--text-meta)",
        multiline: "",
      },
    },
    defaultVariants: {
      size: "default",
    },
  }
)

/** What a Field tells the control it wraps. */
interface FieldControlState {
  /** The control's id; the Field's label points at it. */
  readonly id: string
  /** The label's id, for controls that are not labelable elements. */
  readonly labelId: string
  /** The error and description ids, in that order. */
  readonly describedBy: string | undefined
  readonly invalid: boolean
}

const FieldControlContext = React.createContext<FieldControlState | null>(null)

interface FieldControlProps {
  id?: string
  "aria-describedby"?: string
  "aria-invalid"?: React.AriaAttributes["aria-invalid"]
  "aria-labelledby"?: string
}

/**
 * Wires a control to the enclosing Field: `id` (so the label's `htmlFor`
 * resolves), `aria-describedby` (error, then description) and
 * `aria-invalid`. Props the control sets itself win; describedby ids are
 * merged. With `labelledBy`, the control also gets `aria-labelledby` for
 * elements a `<label for>` cannot name (a radiogroup, for example).
 */
function useFieldControl<P extends FieldControlProps>(
  props: P,
  { labelledBy = false }: { labelledBy?: boolean } = {}
): P {
  const field = React.useContext(FieldControlContext)
  if (!field) return props
  const describedBy =
    [props["aria-describedby"], field.describedBy].filter(Boolean).join(" ") ||
    undefined
  return {
    ...props,
    id: props.id ?? field.id,
    "aria-describedby": describedBy,
    "aria-invalid": props["aria-invalid"] ?? (field.invalid || undefined),
    ...(labelledBy
      ? { "aria-labelledby": props["aria-labelledby"] ?? field.labelId }
      : {}),
  }
}

export { controlVariants, FieldControlContext, useFieldControl }
export type { FieldControlState }
