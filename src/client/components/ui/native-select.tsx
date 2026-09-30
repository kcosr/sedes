import * as React from "react"
import { ChevronDownIcon } from "lucide-react"

import { cn } from "@client/lib/utils"
import { controlVariants, useFieldControl } from "@client/components/ui/control"

/**
 * A native `<select>` in the shared control box, for plain option lists where
 * the platform picker is the right tool (it is the accessible choice on
 * touch). `className` sizes the box; it fills its container by default, like
 * Input.
 */
function NativeSelect({
  className,
  size = "default",
  ...props
}: Omit<React.ComponentProps<"select">, "size"> & {
  size?: "default" | "sm"
}) {
  const controlProps = useFieldControl(props)
  return (
    <span
      data-slot="native-select-wrapper"
      className={cn("relative flex w-full min-w-0", className)}
    >
      <select
        data-slot="native-select"
        data-size={size}
        className={cn(
          controlVariants({ size }),
          "peer w-full min-w-0 appearance-none py-0 pr-8 pl-2.5 [&_option]:bg-popover [&_option]:text-popover-foreground"
        )}
        {...controlProps}
      />
      <ChevronDownIcon
        aria-hidden="true"
        className="pointer-events-none absolute top-1/2 right-2.5 size-(--icon-md) -translate-y-1/2 text-muted-foreground opacity-50 peer-disabled:opacity-[calc(var(--disabled-opacity)/2)]"
      />
    </span>
  )
}

export { NativeSelect }
