import { useId, useState } from "react";
import type { ReactNode } from "react";
import { cx, toneClass } from "../lib/cx";
import type { Tone } from "../lib/cx";
import { Icon } from "./Icon";
import type { IconName } from "./Icon";
import { useLinkComponent } from "./Link";

/** The left pane (put it in AppShell's `sidebar` slot). Scrolls on its own. */
export function Sidebar({
  label,
  children,
  className,
}: {
  /** Landmark name ("Filters", "Services"). */
  label: string;
  children: ReactNode;
  className?: string | undefined;
}) {
  return (
    <aside className={cx("wb-sidebar", className)} aria-label={label}>
      {children}
    </aside>
  );
}

/** Top block: filter input, Seg, quick links. */
export function SidebarTop({ children }: { children: ReactNode }) {
  return <div className="wb-side-top">{children}</div>;
}

/** A row of small accent text buttons ("All · None · Pinned") with a note on the right. */
export function SidebarQuick({
  children,
  note,
}: {
  children: ReactNode;
  note?: ReactNode;
}) {
  return (
    <div className="wb-side-quick">
      {children}
      {note ? <span className="wb-side-quick-note">{note}</span> : null}
    </div>
  );
}

export interface SidebarSectionAction {
  label: string;
  icon?: IconName | undefined;
  /** Short visible text instead of an icon ("Clear"). */
  text?: string | undefined;
  onClick: () => void;
}

export interface SidebarSectionProps {
  title: ReactNode;
  /** Lower-case note on the right of the header ("open / total"). */
  note?: ReactNode;
  action?: SidebarSectionAction | undefined;
  /** Header becomes a disclosure button. */
  collapsible?: boolean | undefined;
  /** Controlled open state (collapsible). */
  open?: boolean | undefined;
  defaultOpen?: boolean | undefined;
  onOpenChange?: ((open: boolean) => void) | undefined;
  /** Badge with the number of active filters in this group. */
  activeCount?: number | undefined;
  /**
   * Collapsible sections: mount the children only once the section is first
   * opened (pickers inside don't fetch while collapsed); after that they
   * stay mounted, keeping their state, while collapsed.
   */
  lazy?: boolean | undefined;
  children?: ReactNode;
  className?: string | undefined;
}

/** Uppercase section header plus its items; optionally collapsible with an active-count badge. */
export function SidebarSection({
  title,
  note,
  action,
  collapsible = false,
  open,
  defaultOpen = true,
  onOpenChange,
  activeCount,
  lazy = false,
  children,
  className,
}: SidebarSectionProps) {
  const [localOpen, setLocalOpen] = useState(defaultOpen);
  const isOpen = !collapsible || (open ?? localOpen);
  const [opened, setOpened] = useState(isOpen);
  if (isOpen && !opened) setOpened(true);
  const id = useId();
  const bodyId = `wb-side-body-${id}`;
  const titleId = `wb-side-title-${id}`;
  const toggle = () => {
    const next = !isOpen;
    if (open === undefined) setLocalOpen(next);
    onOpenChange?.(next);
  };
  const badge =
    activeCount !== undefined && activeCount > 0 ? (
      <span className="wb-side-h-count">
        <span aria-hidden="true">{activeCount}</span>
        <span className="wb-sr-only">{`, ${activeCount} active`}</span>
      </span>
    ) : null;

  return (
    <section
      className={cx("wb-side-section", className)}
      aria-labelledby={titleId}
    >
      <div className="wb-side-h">
        {collapsible ? (
          <button
            type="button"
            className="wb-side-h-toggle"
            aria-expanded={isOpen}
            aria-controls={bodyId}
            onClick={toggle}
          >
            <Icon name="chevron-down" />
            <span id={titleId}>{title}</span>
            {badge}
          </button>
        ) : (
          <span className="wb-side-h-title">
            <span id={titleId}>{title}</span>
            {badge}
          </span>
        )}
        {note ? <span className="wb-side-h-note">{note}</span> : null}
        {action ? (
          <button
            type="button"
            className="wb-side-h-action"
            aria-label={action.label}
            title={action.label}
            onClick={action.onClick}
          >
            {action.text ?? <Icon name={action.icon ?? "plus"} />}
          </button>
        ) : null}
      </div>
      <div className="wb-side-body" id={bodyId} hidden={!isOpen}>
        {lazy && !opened ? null : children}
      </div>
    </section>
  );
}

export interface SidebarItemProps {
  label: ReactNode;
  icon?: IconName | undefined;
  /** Colours the icon (e.g. decision facets: success / danger). */
  iconTone?: Tone | undefined;
  count?: number | string | undefined;
  /** Selected (aria-current: "page" for links, "true" for buttons). */
  current?: boolean | undefined;
  href?: string | undefined;
  onClick?: (() => void) | undefined;
  title?: string | undefined;
  /** Secondary action revealed on hover/focus (delete a saved view). */
  action?:
    | { label: string; icon?: IconName | undefined; onClick: () => void }
    | undefined;
  trailing?: ReactNode;
  className?: string | undefined;
}

/** A navigation or selection row: icon, label, count. */
export function SidebarItem({
  label,
  icon,
  iconTone,
  count,
  current = false,
  href,
  onClick,
  title,
  action,
  trailing,
  className,
}: SidebarItemProps) {
  const Link = useLinkComponent();
  const body = (
    <>
      {icon ? (
        <Icon name={icon} className={cx("wb-side-icon", toneClass(iconTone))} />
      ) : null}
      <span className="wb-side-item-label">{label}</span>
      {trailing}
      {count !== undefined ? " " : null}
      {count !== undefined ? (
        <span className="wb-side-item-count">{count}</span>
      ) : null}
    </>
  );
  const cls = cx("wb-side-item", className);
  const item =
    href !== undefined ? (
      <Link
        href={href}
        className={cls}
        aria-current={current ? "page" : undefined}
        title={title}
        onClick={onClick}
      >
        {body}
      </Link>
    ) : (
      <button
        type="button"
        className={cls}
        aria-current={current ? "true" : undefined}
        title={title}
        onClick={onClick}
      >
        {body}
      </button>
    );
  if (!action) return item;
  return (
    <div className="wb-side-row">
      {item}
      <button
        type="button"
        className="wb-side-row-action"
        aria-label={action.label}
        title={action.label}
        onClick={action.onClick}
      >
        <Icon name={action.icon ?? "x"} />
      </button>
    </div>
  );
}

/** Facet checkbox row: checkbox, label, count. The whole row is the label. */
export function SidebarCheck({
  label,
  checked,
  onChange,
  count,
  icon,
  iconTone,
  title,
  disabled,
  className,
}: {
  label: ReactNode;
  checked: boolean;
  onChange: (checked: boolean) => void;
  count?: number | string | undefined;
  icon?: IconName | undefined;
  /** Colours the icon (e.g. decision facets). */
  iconTone?: Tone | undefined;
  title?: string | undefined;
  disabled?: boolean | undefined;
  className?: string | undefined;
}) {
  const countId = `wb-side-count-${useId()}`;
  return (
    <label className={cx("wb-side-check", className)} title={title}>
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        aria-describedby={count !== undefined ? countId : undefined}
        onChange={(e) => onChange(e.target.checked)}
      />
      {icon ? (
        <Icon name={icon} className={cx("wb-side-icon", toneClass(iconTone))} />
      ) : null}
      <span className="wb-side-check-label">{label}</span>
      {count !== undefined ? (
        <span className="wb-side-check-count" id={countId} aria-hidden="true">
          {count}
        </span>
      ) : null}
    </label>
  );
}

/** Muted "nothing here" line inside a section. */
export function SidebarEmpty({ children }: { children: ReactNode }) {
  return <div className="wb-side-empty">{children}</div>;
}

/** "Show 12 more" disclosure row. */
export function SidebarMore({
  expanded,
  onToggle,
  children,
}: {
  expanded: boolean;
  onToggle: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      className="wb-side-more"
      aria-expanded={expanded}
      onClick={onToggle}
    >
      <Icon name={expanded ? "chevron-down" : "chevron-right"} />
      {children}
    </button>
  );
}
