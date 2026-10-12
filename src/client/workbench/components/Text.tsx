import type { ReactNode } from "react";
import { cx } from "../lib/cx";

/**
 * Text that truncates at the start ("…/src/components/Table.tsx"), keeping
 * the end of paths and ids visible. `title` defaults to the text.
 */
export function TruncateStart({
  children,
  title,
  className,
}: {
  children: ReactNode;
  title?: string | undefined;
  className?: string | undefined;
}) {
  return (
    <span
      className={cx("wb-truncate-start", className)}
      title={title ?? (typeof children === "string" ? children : undefined)}
    >
      <bdi>{children}</bdi>
    </span>
  );
}

/**
 * A name after a muted prefix ("owner/" before a repository). In a narrow
 * space the prefix gives way first ("octo…/atlas"); the name stays whole
 * until it alone is wider than the room, then ends in an ellipsis. `title`
 * defaults to the full text.
 */
export function QualifiedName({
  prefix,
  name,
  separator = "/",
  title,
  className,
}: {
  name: ReactNode;
  /** Muted, truncates first; omit (or null) for a bare name. */
  prefix?: ReactNode;
  /** Shown after the prefix, outside its ellipsis (default "/"). */
  separator?: string | undefined;
  title?: string | undefined;
  className?: string | undefined;
}) {
  const hasPrefix = prefix !== undefined && prefix !== null && prefix !== "";
  const plain =
    typeof name === "string" && (!hasPrefix || typeof prefix === "string");
  return (
    <span
      className={cx("wb-qname", className)}
      title={
        title ??
        (plain
          ? `${hasPrefix ? `${prefix}${separator}` : ""}${name}`
          : undefined)
      }
    >
      {hasPrefix ? (
        <span className="wb-qname-prefix">
          <span className="wb-qname-prefix-text">{prefix}</span>
          {separator}
        </span>
      ) : null}
      <span className="wb-qname-name">{name}</span>
    </span>
  );
}
