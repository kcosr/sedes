import { isValidElement } from "react";
import type { ReactNode } from "react";
import { cx, toneClass } from "../lib/cx";
import type { Tone } from "../lib/cx";
import { Icon } from "./Icon";
import type { IconName } from "./Icon";
import { useLinkComponent } from "./Link";

export interface SegOption<T extends string> {
  value: T;
  label: ReactNode;
  icon?: IconName | undefined;
  /** Colours the icon while selected (e.g. success for "Active"). */
  tone?: Tone | undefined;
  count?: number | string | undefined;
  title?: string | undefined;
  disabled?: boolean | undefined;
  /** Show only the icon; `label` becomes screen-reader-only text. */
  iconOnly?: boolean | undefined;
}

export interface SegProps<T extends string> {
  /** Accessible group name, e.g. "Status". */
  label: string;
  value: T;
  onChange: (value: T) => void;
  options: readonly SegOption<T>[];
  size?: "default" | "sm" | undefined;
  /**
   * "compact": tighter padding, and icons hidden on segments that have a
   * text label (labels, counts and names stay). Seg in the main pane
   * compacts on its own when the pane is ≤700px.
   */
  density?: "default" | "compact" | undefined;
  /** Stretch to the container width with equal segments. */
  full?: boolean | undefined;
  className?: string | undefined;
}

/**
 * A segment shows text beside its icon, so the icon can go in compact
 * density. Not for icon-only segments (`iconOnly`, or a label that is just
 * a `wb-sr-only` element).
 */
function labelled(label: ReactNode, iconOnly: boolean | undefined): boolean {
  if (iconOnly) return false;
  if (label === undefined || label === null || label === false || label === "")
    return false;
  if (isValidElement<{ className?: unknown }>(label)) {
    const cls = label.props.className;
    if (typeof cls === "string" && cls.split(/\s+/).includes("wb-sr-only"))
      return false;
  }
  return true;
}

function segLabel(label: ReactNode, iconOnly: boolean | undefined) {
  return iconOnly ? <span className="wb-sr-only">{label}</span> : label;
}

/** Segmented control: a group of toggle buttons (aria-pressed), one selected. */
export function Seg<T extends string>({
  label,
  value,
  onChange,
  options,
  size = "default",
  density = "default",
  full = false,
  className,
}: SegProps<T>) {
  return (
    <div
      role="group"
      aria-label={label}
      className={cx(
        "wb-seg",
        size === "sm" && "wb-seg--sm",
        density === "compact" && "wb-seg--compact",
        full && "wb-seg--full",
        className,
      )}
    >
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          className={cx(
            "wb-seg-btn",
            o.icon && labelled(o.label, o.iconOnly) && "wb-seg-btn--labelled",
            toneClass(o.tone),
          )}
          aria-pressed={o.value === value}
          title={o.title}
          disabled={o.disabled}
          onClick={() => {
            if (o.value !== value) onChange(o.value);
          }}
        >
          {o.icon ? <Icon name={o.icon} /> : null}
          {segLabel(o.label, o.iconOnly)}
          {o.count !== undefined ? (
            <>
              {" "}
              <span className="wb-seg-count">{o.count}</span>
            </>
          ) : null}
        </button>
      ))}
    </div>
  );
}

export interface SegLinkItem {
  href: string;
  label: ReactNode;
  current: boolean;
  icon?: IconName | undefined;
  tone?: Tone | undefined;
  count?: number | string | undefined;
  title?: string | undefined;
  /** Show only the icon; `label` becomes screen-reader-only text. */
  iconOnly?: boolean | undefined;
}

/**
 * Segmented look for navigation (e.g. a top-bar space switch "Admin | My
 * access"): a <nav> of links through LinkProvider, the current one with
 * aria-current="page".
 */
export function SegLinks({
  label,
  items,
  size = "default",
  density = "default",
  full = false,
  className,
}: {
  /** Accessible name of the navigation. */
  label: string;
  items: readonly SegLinkItem[];
  size?: "default" | "sm" | undefined;
  /** As Seg's `density`. */
  density?: "default" | "compact" | undefined;
  full?: boolean | undefined;
  className?: string | undefined;
}) {
  const Link = useLinkComponent();
  return (
    <nav
      aria-label={label}
      className={cx(
        "wb-seg",
        size === "sm" && "wb-seg--sm",
        density === "compact" && "wb-seg--compact",
        full && "wb-seg--full",
        className,
      )}
    >
      {items.map((item) => (
        <Link
          key={item.href}
          href={item.href}
          className={cx(
            "wb-seg-btn",
            item.icon &&
              labelled(item.label, item.iconOnly) &&
              "wb-seg-btn--labelled",
            toneClass(item.tone),
          )}
          aria-current={item.current ? "page" : undefined}
          title={item.title}
        >
          {item.icon ? <Icon name={item.icon} /> : null}
          {segLabel(item.label, item.iconOnly)}
          {item.count !== undefined ? (
            <>
              {" "}
              <span className="wb-seg-count">{item.count}</span>
            </>
          ) : null}
        </Link>
      ))}
    </nav>
  );
}
