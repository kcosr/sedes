import * as React from "react"

import { cn } from "@client/lib/utils"
import { Badge } from "@client/components/ui/badge"
import type { Tone } from "@client/components/ui/tone"

/** A live state (Connected, Changes pending, Error): a dot and a label on the tone's wash. */
function StatusPill({
  tone = "neutral",
  className,
  children,
  ...props
}: Omit<React.ComponentProps<"span">, "color"> & { tone?: Tone }) {
  return (
    <Badge
      data-slot="status-pill"
      tone={tone}
      appearance="soft"
      size="sm"
      className={cn("gap-1.5", className)}
      {...props}
    >
      <span
        aria-hidden="true"
        data-slot="status-pill-dot"
        className="size-1.5 shrink-0 rounded-full bg-current"
      />
      {children}
    </Badge>
  )
}

export { StatusPill }
