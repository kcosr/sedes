import { useId } from "react";
import type { HTMLAttributes, ReactNode } from "react";
import { cx } from "../lib/cx";

export interface MediaFrameProps extends Omit<
  HTMLAttributes<HTMLDivElement>,
  "title" | "children"
> {
  /** Optional visible name. Omit it for media that needs no header. */
  title?: ReactNode;
  /** Supporting text, such as dimensions or a revision label. */
  metadata?: ReactNode;
  /** App-owned buttons or controls; the frame adds no interactions. */
  actions?: ReactNode;
  children: ReactNode;
  bodyClassName?: string | undefined;
}

const hasContent = (node: ReactNode) =>
  node !== null && node !== undefined && node !== false && node !== "";

/**
 * A lightweight frame for app-owned media renderers. It does not resize,
 * execute, or otherwise interpret the content. Its CSS can be imported alone.
 */
export function MediaFrame({
  title,
  metadata,
  actions,
  children,
  className,
  bodyClassName,
  role,
  "aria-labelledby": labelledBy,
  "aria-describedby": describedBy,
  ...props
}: MediaFrameProps) {
  const id = useId();
  const hasTitle = hasContent(title);
  const hasMetadata = hasContent(metadata);
  const hasActions = hasContent(actions);
  const titleId = `${id}-title`;
  const metadataId = `${id}-metadata`;

  return (
    <div
      {...props}
      className={cx("wb-media-frame", className)}
      role={role ?? (hasTitle ? "group" : undefined)}
      aria-labelledby={labelledBy ?? (hasTitle ? titleId : undefined)}
      aria-describedby={describedBy ?? (hasMetadata ? metadataId : undefined)}
    >
      {hasTitle || hasMetadata || hasActions ? (
        <div className="wb-media-frame-header">
          {hasTitle || hasMetadata ? (
            <div className="wb-media-frame-labels">
              {hasTitle ? (
                <div id={titleId} className="wb-media-frame-title">
                  {title}
                </div>
              ) : null}
              {hasMetadata ? (
                <div id={metadataId} className="wb-media-frame-metadata">
                  {metadata}
                </div>
              ) : null}
            </div>
          ) : null}
          {hasActions ? (
            <div className="wb-media-frame-actions">{actions}</div>
          ) : null}
        </div>
      ) : null}
      <div className={cx("wb-media-frame-body", bodyClassName)}>{children}</div>
    </div>
  );
}
