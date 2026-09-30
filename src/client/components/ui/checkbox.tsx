import * as React from "react"
import { CheckIcon, MinusIcon } from "lucide-react"
import { Checkbox as CheckboxPrimitive } from "radix-ui"

import { cn } from "@client/lib/utils"
import { useFieldControl } from "@client/components/ui/control"

function Checkbox({
  className,
  ...props
}: React.ComponentProps<typeof CheckboxPrimitive.Root>) {
  const controlProps = useFieldControl(props)
  return (
    <CheckboxPrimitive.Root
      data-slot="checkbox"
      className={cn(
        // The unchecked box is only its border, so that border carries the
        // whole affordance: `border-input` measured 1.18:1 (light) / 2.74:1
        // (dark) against the surfaces this sits on, under WCAG 1.4.11's 3:1
        // floor. `--muted-foreground-2` is the quietest token that clears it
        // (4.6–5.6:1 on background/card/secondary/popover).
        // Radius: the nested step (6px). The control step (8px) on a 16px
        // box is a full circle — it reads as a radio, which this dialog also
        // renders a few rows above.
        "peer size-(--icon-md) shrink-0 rounded-(--radius-inline) border border-muted-foreground-2 shadow-xs transition-shadow outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-(--disabled-opacity) aria-invalid:border-destructive aria-invalid:ring-destructive/20 data-[state=checked]:border-primary data-[state=checked]:bg-primary data-[state=checked]:text-primary-foreground data-[state=indeterminate]:border-primary data-[state=indeterminate]:bg-primary data-[state=indeterminate]:text-primary-foreground dark:bg-input/30 dark:aria-invalid:ring-destructive/40 dark:data-[state=checked]:bg-primary dark:data-[state=indeterminate]:bg-primary",
        className
      )}
      {...controlProps}
    >
      <CheckboxPrimitive.Indicator
        data-slot="checkbox-indicator"
        className="grid place-content-center text-current transition-none"
      >
        {props.checked === "indeterminate" ? (
          <MinusIcon className="size-(--icon-sm)" />
        ) : (
          <CheckIcon className="size-(--icon-sm)" />
        )}
      </CheckboxPrimitive.Indicator>
    </CheckboxPrimitive.Root>
  )
}

export { Checkbox }
