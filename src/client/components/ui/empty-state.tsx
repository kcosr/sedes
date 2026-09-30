import * as React from "react"

import { cn } from "@client/lib/utils"

/**
 * Nothing to show yet. `panel` is a dashed, centred block for an empty page
 * or pane; `inline` is a quiet left-aligned line inside a list or section.
 */
function EmptyState({
  variant = "panel",
  icon,
  title,
  description,
  action,
  className,
  ...props
}: Omit<React.ComponentProps<"div">, "title" | "children"> & {
  variant?: "panel" | "inline"
  icon?: React.ReactNode
  title: React.ReactNode
  description?: React.ReactNode
  action?: React.ReactNode
}) {
  if (variant === "inline") {
    return (
      <div
        data-slot="empty-state"
        data-variant="inline"
        className={cn(
          "flex min-w-0 flex-wrap items-center gap-x-3 gap-y-2 py-3 text-(length:--text-ui) leading-(--leading-normal)",
          className
        )}
        {...props}
      >
        {icon ? (
          <span
            aria-hidden="true"
            className="flex shrink-0 text-muted-foreground-2 [&>svg]:size-(--icon-md)"
          >
            {icon}
          </span>
        ) : null}
        <div className="min-w-0 flex-1">
          <p className="m-0 text-muted-foreground">{title}</p>
          {description ? (
            <p className="m-0 text-(length:--text-meta) text-muted-foreground-2">
              {description}
            </p>
          ) : null}
        </div>
        {action ? <div className="flex shrink-0 gap-2">{action}</div> : null}
      </div>
    )
  }
  return (
    <div
      data-slot="empty-state"
      data-variant="panel"
      className={cn(
        "flex min-w-0 flex-col items-center justify-center gap-1 rounded-(--radius-card) border border-dashed border-border px-6 py-10 text-center text-(length:--text-ui) leading-(--leading-normal)",
        className
      )}
      {...props}
    >
      {icon ? (
        <span
          aria-hidden="true"
          className="mb-2 flex text-muted-foreground-2 [&>svg]:size-(--icon-lg)"
        >
          {icon}
        </span>
      ) : null}
      <p className="m-0 font-medium text-foreground">{title}</p>
      {description ? (
        <p className="m-0 max-w-[48ch] text-(length:--text-meta) text-muted-foreground-2">
          {description}
        </p>
      ) : null}
      {action ? (
        <div className="mt-3 flex flex-wrap justify-center gap-2">{action}</div>
      ) : null}
    </div>
  )
}

export { EmptyState }
