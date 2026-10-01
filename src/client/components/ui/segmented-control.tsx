import * as React from "react"
import { cva } from "class-variance-authority"
import { ToggleGroup as ToggleGroupPrimitive } from "radix-ui"

import { cn } from "@client/lib/utils"
import { useFieldControl } from "@client/components/ui/control"

type SegmentedControlSize = "default" | "sm"

const SegmentedControlSizeContext =
  React.createContext<SegmentedControlSize>("default")

const segmentedControlVariants = cva(
  "inline-flex w-fit min-w-0 items-stretch gap-0.5 rounded-(--radius-ctl) bg-code p-0.5",
  {
    variants: {
      size: {
        default: "h-(--control-default)",
        sm: "h-(--control-sm)",
      },
    },
    defaultVariants: { size: "default" },
  }
)

/**
 * One choice out of a few, always set: a radiogroup of segments on a track,
 * with the selected segment raised as a thumb. Clicking the selected segment
 * keeps it selected (Radix would clear it). The track follows the density
 * switch by default; `sm` is the fixed compact step.
 */
function SegmentedControl({
  className,
  size = "default",
  value,
  defaultValue,
  onValueChange,
  ...props
}: Omit<
  React.ComponentProps<typeof ToggleGroupPrimitive.Root>,
  "type" | "value" | "defaultValue" | "onValueChange"
> & {
  value?: string
  defaultValue?: string
  onValueChange?: (value: string) => void
  size?: SegmentedControlSize
}) {
  const controlProps = useFieldControl(props, { labelledBy: true })
  const [uncontrolled, setUncontrolled] = React.useState(defaultValue ?? "")
  const current = value ?? uncontrolled
  return (
    <SegmentedControlSizeContext.Provider value={size}>
      <ToggleGroupPrimitive.Root
        data-slot="segmented-control"
        data-size={size}
        type="single"
        value={current}
        onValueChange={(next) => {
          if (!next || next === current) return
          setUncontrolled(next)
          onValueChange?.(next)
        }}
        className={cn(segmentedControlVariants({ size }), className)}
        {...controlProps}
      />
    </SegmentedControlSizeContext.Provider>
  )
}

function SegmentedControlItem({
  className,
  ...props
}: React.ComponentProps<typeof ToggleGroupPrimitive.Item>) {
  const size = React.useContext(SegmentedControlSizeContext)
  return (
    <ToggleGroupPrimitive.Item
      data-slot="segmented-control-item"
      className={cn(
        "inline-flex min-w-0 flex-1 items-center justify-center gap-1.5 rounded-(--radius-inline) px-2.5 font-medium whitespace-nowrap text-muted-foreground transition-[color,background-color,box-shadow] duration-(--duration-fast) outline-none hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50 disabled:pointer-events-none disabled:opacity-(--disabled-opacity) data-[state=on]:bg-popover data-[state=on]:text-foreground data-[state=on]:shadow-(--elevation-1) [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-(--icon-sm)",
        size === "sm"
          ? "text-(length:--text-meta)"
          : "text-(length:--text-ui)",
        className
      )}
      {...props}
    />
  )
}

export { SegmentedControl, SegmentedControlItem }
