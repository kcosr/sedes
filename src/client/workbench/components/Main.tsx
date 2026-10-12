import { useLayoutEffect, useRef } from "react";
import type { ReactNode, Ref } from "react";
import { cx } from "../lib/cx";
import { DEFAULT_MAIN_ID, useAppShell } from "./AppShell";
import { ProgressBar } from "./States";

export interface MainProps {
  /** Fixed toolbar above the scroll region (<Toolbar>). */
  toolbar?: ReactNode;
  /** Between toolbar and scroll region (e.g. <Tabs>, a <Banner>). */
  header?: ReactNode;
  children?: ReactNode;
  /** Fixed footer under the scroll region (e.g. <DraftBar>). */
  footer?: ReactNode;
  /** Background refetch: sticky 2px progress bar at the top of the scroll region. */
  refetching?: boolean | undefined;
  /** Dim the content (defaults to `refetching`). */
  stale?: boolean | undefined;
  /** Page-coloured background (settings pages, card grids). */
  tint?: boolean | undefined;
  /** Accessible name of the <main> landmark. */
  label?: string | undefined;
  /**
   * id of the <main> element, the skip link's focus target (default: the
   * surrounding AppShell's `mainId`, else "wb-main").
   */
  id?: string | undefined;
  scrollRef?: Ref<HTMLDivElement> | undefined;
  className?: string | undefined;
  scrollClassName?: string | undefined;
}

/** The main pane: toolbar, scroll region (the only thing that scrolls), optional footer. */
export function Main({
  toolbar,
  header,
  children,
  footer,
  refetching = false,
  stale = refetching,
  tint = false,
  label,
  id,
  scrollRef,
  className,
  scrollClassName,
}: MainProps) {
  const shell = useAppShell();
  return (
    <main
      id={id ?? shell?.mainId ?? DEFAULT_MAIN_ID}
      tabIndex={-1}
      className={cx("wb-main", tint && "is-tint", className)}
      aria-label={label}
    >
      {toolbar}
      {header}
      <div
        ref={scrollRef}
        className={cx("wb-scroll", stale && "is-stale", scrollClassName)}
      >
        <ProgressBar active={refetching} />
        {children}
      </div>
      {footer ? <div className="wb-main-foot">{footer}</div> : null}
    </main>
  );
}

/** Toolbar block; rows inside with <ToolbarRow>. */
export function Toolbar({
  children,
  className,
}: {
  children: ReactNode;
  className?: string | undefined;
}) {
  return <div className={cx("wb-toolbar", className)}>{children}</div>;
}

/**
 * Some child starts below another one: the row wrapped. Only boxes with
 * area count; a zero-height Spacer sits mid-line and would otherwise look
 * like a line of its own.
 */
function wraps(row: HTMLElement): boolean {
  const boxes = Array.from(row.children)
    .map((el) => el.getBoundingClientRect())
    .filter((r) => r.width > 0 && r.height > 0);
  if (boxes.length < 2) return false;
  const firstBottom = Math.min(...boxes.map((r) => r.bottom));
  return boxes.some((r) => r.top >= firstBottom - 0.5);
}

/**
 * A row of toolbar controls. `primary` (the page's main action, e.g. "New
 * grant") sits at the end. When the controls don't fit on one line (a
 * drawer is open, a small window, a crowded toolbar), the row splits: the
 * first control and `primary` share the first line and the other controls
 * move to a second line, instead of the action wrapping alone. Measured,
 * not breakpoint-driven: it splits exactly when the one-line layout would
 * wrap, and re-checks on resize, content changes and font loading.
 */
export function ToolbarRow({
  children,
  primary,
  className,
}: {
  children: ReactNode;
  primary?: ReactNode;
  className?: string | undefined;
}) {
  const hasPrimary =
    primary !== undefined && primary !== null && primary !== false;
  const ref = useRef<HTMLDivElement | null>(null);
  useLayoutEffect(() => {
    const row = ref.current;
    if (!hasPrimary || !row) return;
    const fit = () => {
      // Try the one-line layout; split only if it wraps.
      row.removeAttribute("data-wb-split");
      if (wraps(row)) row.setAttribute("data-wb-split", "");
    };
    fit();
    let width = row.clientWidth;
    const ro =
      typeof ResizeObserver === "undefined"
        ? null
        : new ResizeObserver(() => {
            // our own split changes the height, not the width
            if (row.clientWidth === width) return;
            width = row.clientWidth;
            fit();
          });
    ro?.observe(row);
    const mo =
      typeof MutationObserver === "undefined"
        ? null
        : new MutationObserver(fit);
    mo?.observe(row, {
      childList: true,
      subtree: true,
      characterData: true,
      // not data-wb-split, which fit() itself sets
      attributes: true,
      attributeFilter: ["class", "style", "hidden"],
    });
    const fonts = typeof document === "undefined" ? undefined : document.fonts;
    fonts?.addEventListener?.("loadingdone", fit);
    return () => {
      ro?.disconnect();
      mo?.disconnect();
      fonts?.removeEventListener?.("loadingdone", fit);
      row.removeAttribute("data-wb-split");
    };
  }, [hasPrimary]);
  return (
    <div
      ref={ref}
      className={cx(
        "wb-toolbar-row",
        hasPrimary && "wb-toolbar-row--split",
        className,
      )}
    >
      {children}
      {hasPrimary ? <div className="wb-toolbar-primary">{primary}</div> : null}
    </div>
  );
}

/** Page title for settings-style pages (h1, 16px). */
export function ToolbarTitle({ children }: { children: ReactNode }) {
  return <h1 className="wb-toolbar-title">{children}</h1>;
}

/** Count summary ("<b>217</b> active tokens · 14 services"); `grow` absorbs spare width. */
export function ToolbarSummary({
  children,
  grow = false,
  title,
}: {
  children: ReactNode;
  grow?: boolean | undefined;
  title?: string | undefined;
}) {
  return (
    <span
      className={cx("wb-summary", grow && "wb-summary--grow")}
      title={title}
    >
      {children}
    </span>
  );
}

/** Muted label kept together with its control when the toolbar wraps ("Group [Seg]"). */
export function Ctl({
  label,
  children,
}: {
  label: ReactNode;
  children: ReactNode;
}) {
  return (
    <span className="wb-ctl">
      <span className="wb-toolbar-label">{label}</span>
      {children}
    </span>
  );
}

/** Flexible gap in toolbars and bars. */
export function Spacer() {
  return <span className="wb-spacer" />;
}
