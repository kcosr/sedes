import * as React from "react"
import { CircleAlertIcon } from "lucide-react"

import { cn } from "@client/lib/utils"
import {
  FieldControlContext,
  type FieldControlState,
} from "@client/components/ui/control"
import { Label } from "@client/components/ui/label"

type FieldProps = Omit<React.ComponentProps<"div">, "id" | "children"> & {
  label: React.ReactNode
  description?: React.ReactNode
  /** Shown under the control with an icon; marks the control `aria-invalid`. */
  error?: React.ReactNode
  /** `horizontal` puts the label and description beside the control. */
  orientation?: "vertical" | "horizontal"
  /** The control's id. Set it here, not on the control, so the label follows. */
  id?: string
  disabled?: boolean
  children: React.ReactNode
}

/**
 * A labelled form control. The control inside (Input, Textarea, NativeSelect,
 * SelectTrigger, Checkbox, Switch, SegmentedControl) picks up its id,
 * `aria-describedby` and `aria-invalid` from the Field.
 */
function Field({
  label,
  description,
  error,
  orientation = "vertical",
  id,
  disabled,
  className,
  children,
  ...props
}: FieldProps) {
  const generated = React.useId()
  const controlId = id ?? `${generated}control`
  const labelId = `${generated}label`
  const descriptionId = description ? `${generated}description` : undefined
  const errorId = error ? `${generated}error` : undefined
  const invalid = Boolean(error)
  const describedBy =
    [errorId, descriptionId].filter(Boolean).join(" ") || undefined
  const state = React.useMemo<FieldControlState>(
    () => ({ id: controlId, labelId, describedBy, invalid }),
    [controlId, labelId, describedBy, invalid]
  )

  const labelNode = (
    <Label
      id={labelId}
      htmlFor={controlId}
      data-slot="field-label"
      className="leading-(--leading-snug)"
    >
      {label}
    </Label>
  )
  const descriptionNode = description ? (
    <p
      id={descriptionId}
      data-slot="field-description"
      className="m-0 text-(length:--text-meta) leading-(--leading-normal) text-muted-foreground-2"
    >
      {description}
    </p>
  ) : null
  const errorNode = error ? (
    <p
      id={errorId}
      data-slot="field-error"
      className="m-0 flex items-start gap-1.5 text-(length:--text-meta) leading-(--leading-normal) text-destructive"
    >
      <CircleAlertIcon
        aria-hidden="true"
        className="mt-px size-(--icon-sm) shrink-0"
      />
      <span className="min-w-0">{error}</span>
    </p>
  ) : null
  const control = (
    <FieldControlContext.Provider value={state}>
      {children}
    </FieldControlContext.Provider>
  )

  return (
    <div
      data-slot="field"
      data-orientation={orientation}
      data-invalid={invalid || undefined}
      data-disabled={disabled ? "true" : undefined}
      className={cn(
        "group grid min-w-0",
        orientation === "horizontal"
          ? "grid-cols-[minmax(0,1fr)_auto] items-center gap-x-6 gap-y-1.5"
          : "gap-1.5",
        className
      )}
      {...props}
    >
      {orientation === "horizontal" ? (
        <>
          <div data-slot="field-text" className="grid min-w-0 content-start gap-1">
            {labelNode}
            {descriptionNode}
          </div>
          <div
            data-slot="field-control"
            className="grid min-w-0 content-start gap-1.5"
          >
            {control}
            {errorNode}
          </div>
        </>
      ) : (
        <>
          {labelNode}
          {control}
          {descriptionNode}
          {errorNode}
        </>
      )}
    </div>
  )
}

export { Field }
export type { FieldProps }
