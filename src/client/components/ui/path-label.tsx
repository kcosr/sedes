import * as React from "react"

import { cn } from "@client/lib/utils"

/** Splits a path before its last segment; a trailing "/" stays with it. */
function splitPath(path: string): { directory: string; name: string } {
  const slash = path.lastIndexOf("/", path.length - 2)
  return slash < 0
    ? { directory: "", name: path }
    : { directory: path.slice(0, slash + 1), name: path.slice(slash + 1) }
}

/**
 * A path on one line that gives way from its start, so its last segment (the
 * file name) stays visible: the muted directory shrinks first and ellipsizes
 * at its beginning; only a name too long for the whole line ellipsizes at its
 * end. The tooltip keeps the whole path unless `title` replaces it.
 */
function PathLabel({
  path,
  title,
  className,
  ...props
}: Omit<React.ComponentProps<"span">, "children"> & { path: string }) {
  const { directory, name } = splitPath(path)
  return (
    <span
      data-slot="path-label"
      title={title ?? path}
      className={cn("flex min-w-0 items-baseline overflow-hidden whitespace-nowrap", className)}
      {...props}
    >
      {directory ? (
        <span
          data-slot="path-label-directory"
          // Right-to-left, the line overflows (and ellipsizes) at its start;
          // the isolated path still reads left to right.
          className="min-w-0 shrink truncate text-left text-muted-foreground [direction:rtl]"
        >
          <bdi dir="ltr">{directory}</bdi>
        </span>
      ) : null}
      <span data-slot="path-label-name" className="max-w-full shrink-0 truncate">
        {name}
      </span>
    </span>
  )
}

export { PathLabel }
