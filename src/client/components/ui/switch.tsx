import * as React from "react"
import { Switch as SwitchPrimitive } from "radix-ui"

import { cn } from "@client/lib/utils"
import { useFieldControl } from "@client/components/ui/control"

/**
 * An on/off setting that applies as it flips. The 32×18 track keeps a hit
 * area of the density switch's control height, so it stays a touch target.
 * Off is a muted thumb on a faint track, on a light thumb on the primary
 * track; the off thumb carries the 3:1 non-text contrast (see Checkbox).
 */
function Switch({
  className,
  ...props
}: React.ComponentProps<typeof SwitchPrimitive.Root>) {
  const controlProps = useFieldControl(props)
  return (
    <SwitchPrimitive.Root
      data-slot="switch"
      className={cn(
        "peer relative inline-flex h-4.5 w-8 shrink-0 items-center rounded-full p-0.5 outline-none transition-colors duration-(--duration-fast) before:absolute before:inset-x-[-6px] before:top-1/2 before:h-(--control-default) before:-translate-y-1/2 focus-visible:ring-3 focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-(--disabled-opacity) aria-invalid:ring-3 aria-invalid:ring-destructive/20 data-[state=checked]:bg-primary data-[state=unchecked]:bg-input dark:aria-invalid:ring-destructive/40",
        className
      )}
      {...controlProps}
    >
      <SwitchPrimitive.Thumb
        data-slot="switch-thumb"
        className="pointer-events-none block size-3.5 rounded-full bg-muted-foreground shadow-xs transition-transform duration-(--duration-fast) data-[state=checked]:translate-x-3.5 data-[state=checked]:bg-primary-foreground data-[state=unchecked]:translate-x-0"
      />
    </SwitchPrimitive.Root>
  )
}

export { Switch }
