import * as React from "react"

import { cn } from "@client/lib/utils"
import { controlVariants, useFieldControl } from "@client/components/ui/control"

function Textarea({ className, ...props }: React.ComponentProps<"textarea">) {
  const controlProps = useFieldControl(props)
  return (
    <textarea
      data-slot="textarea"
      className={cn(
        controlVariants({ size: "multiline" }),
        "flex field-sizing-content min-h-16 w-full px-2.5 py-2 disabled:bg-input/50 dark:disabled:bg-input/80",
        className
      )}
      {...controlProps}
    />
  )
}

export { Textarea }
