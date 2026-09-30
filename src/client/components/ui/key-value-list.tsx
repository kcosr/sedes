import * as React from "react"

import { cn } from "@client/lib/utils"

interface KeyValueItem {
  /** Defaults to the label when it is a string. */
  readonly key?: string
  readonly label: React.ReactNode
  readonly value: React.ReactNode
  /** Identifiers and paths: monospaced, and they break anywhere. */
  readonly mono?: boolean
}

/** Labelled facts in a `max-content 1fr` grid: labels hug their text, values take the rest. */
function KeyValueList({
  items,
  className,
  ...props
}: Omit<React.ComponentProps<"dl">, "children"> & {
  items: readonly KeyValueItem[]
}) {
  return (
    <dl
      data-slot="key-value-list"
      className={cn(
        "m-0 grid min-w-0 grid-cols-[max-content_minmax(0,1fr)] items-baseline gap-x-6 gap-y-1.5 text-(length:--text-ui) leading-(--leading-normal)",
        className
      )}
      {...props}
    >
      {items.map((item, index) => (
        <div
          key={item.key ?? (typeof item.label === "string" ? item.label : index)}
          className="contents"
        >
          <dt className="text-(length:--text-meta) text-muted-foreground-2">
            {item.label}
          </dt>
          <dd
            className={cn(
              "m-0 min-w-0 [overflow-wrap:anywhere]",
              item.mono && "font-mono text-(length:--text-meta) break-all"
            )}
          >
            {item.value}
          </dd>
        </div>
      ))}
    </dl>
  )
}

export { KeyValueList }
export type { KeyValueItem }
