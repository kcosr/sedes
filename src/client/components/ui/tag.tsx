import * as React from "react"

import { cn } from "@client/lib/utils"

/** A fixed, neutral attribute of an item: its kind, "Default", "Paired". */
function Tag({ className, ...props }: React.ComponentProps<"span">) {
  return (
    <span
      data-slot="tag"
      className={cn(
        "inline-flex h-5 w-fit shrink-0 items-center gap-1 rounded-(--radius-inline) border border-border px-1.5 text-(length:--text-label) font-medium whitespace-nowrap text-muted-foreground [&>svg]:pointer-events-none [&>svg]:size-3 [&>svg]:shrink-0",
        className
      )}
      {...props}
    />
  )
}

export { Tag }
