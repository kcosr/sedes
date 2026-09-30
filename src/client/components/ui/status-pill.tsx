import * as React from "react"

import { cn } from "@client/lib/utils"
import { Badge } from "@client/components/ui/badge"

type StatusTone = "neutral" | "success" | "info" | "warning" | "danger"

const BADGE_TONE = {
  neutral: "neutral",
  success: "success",
  info: "info",
  warning: "warning",
  danger: "destructive",
} as const satisfies Record<StatusTone, string>

/** A live state (Connected, Changes pending, Error): a dot and a label on the tone's wash. */
function StatusPill({
  tone = "neutral",
  className,
  children,
  ...props
}: Omit<React.ComponentProps<"span">, "color"> & { tone?: StatusTone }) {
  return (
    <Badge
      data-slot="status-pill"
      data-status={tone}
      tone={BADGE_TONE[tone]}
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
export type { StatusTone }
