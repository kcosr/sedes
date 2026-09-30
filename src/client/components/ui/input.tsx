import * as React from "react"

import { cn } from "@client/lib/utils"
import { controlVariants, useFieldControl } from "@client/components/ui/control"

function Input({ className, type, ...props }: React.ComponentProps<"input">) {
  const controlProps = useFieldControl(props)
  return (
    <input
      type={type}
      data-slot="input"
      className={cn(
        controlVariants(),
        "w-full min-w-0 px-2.5 py-1 selection:bg-primary selection:text-primary-foreground file:inline-flex file:h-7 file:border-0 file:bg-transparent file:text-(length:--text-ui) file:font-medium file:text-foreground disabled:pointer-events-none",
        className
      )}
      {...controlProps}
    />
  )
}

export { Input }
