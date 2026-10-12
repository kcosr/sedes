import { Fragment, useId, useLayoutEffect, useRef } from "react";
import type { LiHTMLAttributes, ReactNode } from "react";
import { cx, toneClass } from "../lib/cx";
import type { Tone } from "../lib/cx";
import { isPlainClick } from "../lib/dom";
import { ROW_ID_ATTR } from "../lib/listCursor";
import { Kbd } from "./Chips";
import { Icon } from "./Icon";
import type { IconName } from "./Icon";
import { useLinkComponent } from "./Link";

/** Padded list column inside Main's scroll region (max 1180px unless `full`). */
export function List({
  children,
  full = false,
  className,
}: {
  children: ReactNode;
  full?: boolean | undefined;
  className?: string | undefined;
}) {
  return (
    <div className={cx("wb-list", full && "wb-list--full", className)}>
      {children}
    </div>
  );
}

/** Sticky group header: title, subtitle, hairline rule, count. */
export function GroupHeader({
  title,
  sub,
  count,
  actions,
  id,
  as: Heading = "h2",
  sticky = true,
}: {
  title: ReactNode;
  sub?: ReactNode;
  count?: ReactNode;
  /** Buttons at the end ("Issue token"); they wrap below when narrow. */
  actions?: ReactNode;
  id?: string | undefined;
  as?: "h2" | "h3" | "div" | undefined;
  /**
   * Stick to the top of the pane while its rows scroll (default). Use
   * false for a section title above a DataTable, whose own header sticks.
   */
  sticky?: boolean | undefined;
}) {
  const ref = useRef<HTMLDivElement | null>(null);
  // A sticky header can wrap (actions): publish its height so rows below
  // scroll into view clear of it (j/k), whatever its line count.
  useLayoutEffect(() => {
    const el = ref.current;
    const parent = el?.parentElement;
    if (!sticky || !el || !parent) return;
    const publish = () => {
      const h = el.getBoundingClientRect().height;
      if (h > 0) parent.style.setProperty("--wb-group-h", `${Math.ceil(h)}px`);
    };
    publish();
    const ro =
      typeof ResizeObserver === "undefined"
        ? null
        : new ResizeObserver(publish);
    ro?.observe(el);
    return () => {
      ro?.disconnect();
      parent.style.removeProperty("--wb-group-h");
    };
  }, [sticky]);
  return (
    <div
      ref={ref}
      className={cx("wb-group-h", !sticky && "wb-group-h--static")}
    >
      <Heading className="wb-group-title" id={id}>
        {title}
      </Heading>
      {sub ? <span className="wb-group-sub">{sub}</span> : null}
      <span className="wb-group-rule" />
      {count !== undefined && count !== null ? (
        <span className="wb-group-count">{count}</span>
      ) : null}
      {actions ? <span className="wb-group-actions">{actions}</span> : null}
    </div>
  );
}

/** A labelled group: sticky header + its rows. */
export function ListGroup({
  title,
  sub,
  count,
  actions,
  sticky,
  children,
  className,
}: {
  title: ReactNode;
  sub?: ReactNode;
  count?: ReactNode;
  actions?: ReactNode;
  sticky?: boolean | undefined;
  children: ReactNode;
  className?: string | undefined;
}) {
  const id = `wb-group-${useId()}`;
  return (
    <section className={cx("wb-group", className)} aria-labelledby={id}>
      <GroupHeader
        title={title}
        sub={sub}
        count={count}
        actions={actions}
        sticky={sticky}
        id={id}
      />
      <ul className="wb-rows" role="list">
        {children}
      </ul>
    </section>
  );
}

/** Rows without group headers. */
export function Rows({
  children,
  label,
  className,
}: {
  children: ReactNode;
  label?: string | undefined;
  className?: string | undefined;
}) {
  return (
    <ul className={cx("wb-rows", className)} role="list" aria-label={label}>
      {children}
    </ul>
  );
}

export interface ListRowProps extends Omit<
  LiHTMLAttributes<HTMLLIElement>,
  "title"
> {
  /** Stable id: j/k cursor and focus return find the row by it. */
  itemId?: string | undefined;
  icon?: IconName | undefined;
  /** Colours the leading icon. */
  iconTone?: Tone | undefined;
  title: ReactNode;
  /** Primary action as a link (URL-addressable drawer: "?item=42", "#/events/42"). */
  href?: string | undefined;
  /** Primary action as a button. */
  onOpen?: (() => void) | undefined;
  /** Badges after the title (outside the link). */
  titleExtra?: ReactNode;
  /** Secondary line under the title (12.5px). */
  meta?: ReactNode;
  /** Up to two lines of description. */
  description?: ReactNode;
  /** Right column (time, counts). */
  side?: ReactNode;
  /** Icon buttons revealed on hover/focus/cursor (below `side`). */
  actions?: ReactNode;
  /** The keyboard cursor is on this row (inset accent ring). */
  cursor?: boolean | undefined;
  /** Open in the drawer (accent-weak background, aria-current). */
  active?: boolean | undefined;
  /** One line per row: title and meta inline, no description. */
  compact?: boolean | undefined;
}

/**
 * The dense row: grid with icon, title/meta/description, side column.
 * The title is the row's link/button; its hit area stretches over the whole
 * row while other controls in the row stay clickable. Separators hide next
 * to hovered, active and cursor rows.
 */
export function ListRow({
  itemId,
  icon,
  iconTone,
  title,
  href,
  onOpen,
  titleExtra,
  meta,
  description,
  side,
  actions,
  cursor = false,
  active = false,
  compact = false,
  children,
  className,
  ...rest
}: ListRowProps) {
  const Link = useLinkComponent();
  const interactive = href !== undefined || onOpen !== undefined;
  const attrs = itemId !== undefined ? { [ROW_ID_ATTR]: itemId } : {};
  const titleBody =
    href !== undefined ? (
      <Link
        href={href}
        className="wb-row-link"
        aria-current={active ? "true" : undefined}
        onClick={(e) => {
          // Modifier/middle clicks open the href elsewhere (new tab);
          // only a plain click also runs onOpen (e.g. opens the drawer).
          if (onOpen && isPlainClick(e)) onOpen();
        }}
      >
        {title}
      </Link>
    ) : onOpen !== undefined ? (
      <button
        type="button"
        className="wb-row-link"
        aria-current={active ? "true" : undefined}
        onClick={onOpen}
      >
        {title}
      </button>
    ) : (
      title
    );
  return (
    <li
      {...rest}
      {...attrs}
      className={cx(
        "wb-row",
        !icon && "wb-row--noicon",
        compact && "wb-row--compact",
        !interactive && "wb-row--static",
        cursor && "is-cursor",
        active && "is-active",
        className,
      )}
    >
      {icon ? (
        <span className={cx("wb-row-icon", toneClass(iconTone))}>
          <Icon name={icon} />
        </span>
      ) : null}
      <div className="wb-row-main">
        <div className="wb-row-title">
          {titleBody}
          {titleExtra && !compact ? (
            <span className="wb-row-extra">{titleExtra}</span>
          ) : null}
        </div>
        {titleExtra && compact ? (
          <span className="wb-row-extra">{titleExtra}</span>
        ) : null}
        {meta ? <div className="wb-row-meta">{meta}</div> : null}
        {description && !compact ? (
          <p className="wb-row-desc">{description}</p>
        ) : null}
        {children}
      </div>
      {side || actions ? (
        <div className="wb-row-side">
          {side}
          {actions ? <div className="wb-row-actions">{actions}</div> : null}
        </div>
      ) : null}
    </li>
  );
}

/** Keyboard legend under a list: pass [keys, text] pairs. */
export function ListFooter({
  hints = [
    [["j", "k"], "move"],
    [["↵"], "details"],
    [["/"], "filter"],
  ],
  children,
}: {
  hints?: readonly (readonly [readonly string[], string])[] | undefined;
  children?: ReactNode;
}) {
  return (
    <div className="wb-list-foot">
      {hints.map(([keys, text]) => (
        <span key={text}>
          {keys.map((k, i) => (
            <Fragment key={k}>
              {i > 0 ? " " : null}
              <Kbd>{k}</Kbd>
            </Fragment>
          ))}{" "}
          {text}
        </span>
      ))}
      {children}
    </div>
  );
}

/** Muted note under a list ("Showing the 500 most recent…"). */
export function ListNote({ children }: { children: ReactNode }) {
  return <div className="wb-list-note">{children}</div>;
}
