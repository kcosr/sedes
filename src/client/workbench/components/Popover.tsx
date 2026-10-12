import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import type { KeyboardEvent, ReactNode, RefObject } from "react";
import { createPortal } from "react-dom";
import { cx } from "../lib/cx";
import {
  activeTrapRoot,
  OverlayScope,
  tabbableIn,
  useLayer,
  useOverlayOwner,
} from "../lib/layers";
import { useAnchoredPosition } from "../lib/position";
import type { Placement } from "../lib/position";
import { Icon } from "./Icon";
import type { IconName } from "./Icon";
import { useLinkComponent } from "./Link";

export type { Placement };

export type PopoverInitialFocus =
  | "first"
  | "container"
  | "none"
  | RefObject<HTMLElement | null>
  | ((popover: HTMLElement) => HTMLElement | null | undefined);

export interface PopoverProps {
  open: boolean;
  onClose: () => void;
  /** Element the popover is attached to (focus returns to it on close). */
  anchorRef: RefObject<HTMLElement | null>;
  placement?: Placement | undefined;
  /** Accessible name of the dialog. */
  label?: string | undefined;
  role?: "dialog" | "menu" | undefined;
  id?: string | undefined;
  /** 12px/14px inner padding for forms (menus use 4px). */
  padded?: boolean | undefined;
  /**
   * What to focus once the popover is positioned and visible: the first
   * tabbable (default), the container, nothing, a ref, or a function
   * picking an element inside the popover.
   */
  initialFocus?: PopoverInitialFocus | undefined;
  className?: string | undefined;
  onKeyDown?: ((e: KeyboardEvent<HTMLDivElement>) => void) | undefined;
  children: ReactNode;
}

/**
 * Anchored, fixed-position, viewport-clamped layer. Closes on outside click,
 * Esc (layer stack) and when focus leaves it; returns focus to the anchor.
 * Tab past its last control moves on to the control after the anchor.
 */
export function Popover(props: PopoverProps) {
  if (!props.open) return null;
  return <PopoverSurface {...props} />;
}

function PopoverSurface({
  onClose,
  anchorRef,
  placement = "bottom-start",
  label,
  role = "dialog",
  id,
  padded = false,
  initialFocus = "first",
  className,
  onKeyDown,
  children,
}: PopoverProps) {
  const ref = useRef<HTMLDivElement | null>(null);
  const { style, measured } = useAnchoredPosition(
    true,
    anchorRef,
    ref,
    placement,
  );
  const layers = useLayer(true, onClose, true, ref);
  const owner = useOverlayOwner(ref);
  const initialFocusRef = useRef(initialFocus);
  useLayoutEffect(() => {
    initialFocusRef.current = initialFocus;
  });

  // Focus in once the popover is positioned (hidden elements can't take focus).
  const focused = useRef(false);
  useEffect(() => {
    const el = ref.current;
    if (!measured || focused.current || !el) return;
    focused.current = true;
    // Something inside (an autoFocus field, a child modal) already has focus.
    if (owner.contains(document.activeElement)) return;
    const how = initialFocusRef.current;
    const target =
      how === "none"
        ? null
        : how === "container"
          ? el
          : how === "first"
            ? (tabbableIn(el)[0] ?? el)
            : typeof how === "function"
              ? (how(el) ?? el)
              : (how.current ?? el);
    target?.focus({ preventScroll: true });
  }, [measured, owner]);

  // Back to the anchor on close, unless focus already moved elsewhere.
  useLayoutEffect(() => {
    const anchor = anchorRef.current;
    return () => {
      const active = document.activeElement;
      if (!active || active === document.body || owner.contains(active)) {
        anchor?.focus({ preventScroll: true });
      }
    };
  }, [anchorRef, owner]);

  useEffect(() => {
    const onDown = (e: PointerEvent) => {
      const t = e.target as Node | null;
      if (!t || owner.contains(t) || anchorRef.current?.contains(t)) return;
      onClose();
    };
    document.addEventListener("pointerdown", onDown, true);
    return () => document.removeEventListener("pointerdown", onDown, true);
  }, [anchorRef, onClose, owner]);

  const onTab = (e: KeyboardEvent<HTMLDivElement>) => {
    const el = ref.current;
    const anchor = anchorRef.current;
    if (!el || !anchor) return;
    const els = tabbableIn(el);
    const current = document.activeElement;
    let target: HTMLElement | undefined;
    if (e.shiftKey) {
      if (els.length === 0 || current === els[0] || current === el)
        target = anchor;
    } else if (els.length === 0 || current === els[els.length - 1]) {
      // The popover is portaled to the end of <body>: continue after the
      // anchor, within the innermost focus trap (wrapping there, like the
      // trap does) or else the document.
      const trap = activeTrapRoot();
      const scope = trap?.contains(anchor) ? trap : null;
      const order = tabbableIn(scope ?? document.body).filter(
        (x) => !owner.contains(x),
      );
      const next = order[order.indexOf(anchor) + 1];
      target = next ?? (scope ? order[0] : undefined) ?? anchor;
    }
    if (!target) return;
    e.preventDefault();
    target.focus();
    onClose();
  };

  return createPortal(
    <OverlayScope layers={layers} owner={owner}>
      <div
        ref={ref}
        id={id}
        role={role}
        aria-label={label}
        tabIndex={-1}
        className={cx(
          "wb-popover",
          padded && "wb-popover--padded",
          !measured && "is-measuring",
          className,
        )}
        style={style}
        onKeyDown={(e) => {
          onKeyDown?.(e);
          if (!e.defaultPrevented && e.key === "Tab") onTab(e);
        }}
        onBlur={(e) => {
          const next = e.relatedTarget as Node | null;
          if (
            next &&
            !owner.contains(next) &&
            !anchorRef.current?.contains(next)
          )
            onClose();
        }}
      >
        {children}
      </div>
    </OverlayScope>,
    document.body,
  );
}

// ---------------------------------------------------------------- menu

export interface MenuItem {
  type?: "item" | undefined;
  id: string;
  label: ReactNode;
  icon?: IconName | undefined;
  /** Right-aligned hint (shortcut, count). */
  hint?: ReactNode;
  onSelect?: (() => void) | undefined;
  /** Navigate instead (through LinkProvider). */
  href?: string | undefined;
  external?: boolean | undefined;
  danger?: boolean | undefined;
  disabled?: boolean | undefined;
  /** Radio-style item (menuitemradio) with a check when true. */
  checked?: boolean | undefined;
}

export interface MenuSeparator {
  type: "separator";
  id?: string | undefined;
}

export interface MenuHeading {
  type: "heading";
  id?: string | undefined;
  label: ReactNode;
  sub?: ReactNode;
}

export type MenuEntry = MenuItem | MenuSeparator | MenuHeading;

export interface MenuTriggerProps {
  ref: RefObject<HTMLButtonElement | null>;
  onClick: () => void;
  onKeyDown: (e: KeyboardEvent<HTMLElement>) => void;
  "aria-haspopup": "menu";
  "aria-expanded": boolean;
  "aria-controls": string | undefined;
}

export interface MenuProps {
  /** Accessible name of the menu. */
  label: string;
  items: readonly MenuEntry[];
  /** Render the trigger button, spreading the given props onto it. */
  trigger: (props: MenuTriggerProps) => ReactNode;
  placement?: Placement | undefined;
  className?: string | undefined;
}

/**
 * Menu button: arrow keys move, Home/End, type-ahead by first letter, Enter
 * activates, Esc/Tab/outside click close; focus returns to the trigger.
 */
export function Menu({
  label,
  items,
  trigger,
  placement = "bottom-end",
  className,
}: MenuProps) {
  const [open, setOpen] = useState(false);
  const [focusLast, setFocusLast] = useState(false);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const menuId = `wb-menu-${useId()}`;
  const Link = useLinkComponent();

  const itemsIn = (root: ParentNode | null | undefined) =>
    Array.from(
      root?.querySelectorAll<HTMLElement>(
        '[role^="menuitem"]:not([aria-disabled="true"])',
      ) ?? [],
    );
  const itemEls = () => itemsIn(menuRef.current);

  const close = () => setOpen(false);

  const show = (last: boolean) => {
    setFocusLast(last);
    setOpen(true);
  };

  const select = (item: MenuItem) => {
    setOpen(false);
    // Focus the trigger before the action so dialogs it opens return focus here.
    triggerRef.current?.focus({ preventScroll: true });
    item.onSelect?.();
  };

  const onMenuKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const els = itemEls();
    const i = els.indexOf(document.activeElement as HTMLElement);
    let next: HTMLElement | undefined;
    if (e.key === "ArrowDown") next = els[(i + 1) % els.length];
    else if (e.key === "ArrowUp") next = els[(i - 1 + els.length) % els.length];
    else if (e.key === "Home") next = els[0];
    else if (e.key === "End") next = els[els.length - 1];
    else if (e.key === "Tab") {
      // The menu is portaled to the end of the document: go back to the trigger.
      e.preventDefault();
      setOpen(false);
      triggerRef.current?.focus({ preventScroll: true });
      return;
    } else if (
      e.key.length === 1 &&
      /\S/.test(e.key) &&
      !e.ctrlKey &&
      !e.metaKey &&
      !e.altKey
    ) {
      const ch = e.key.toLowerCase();
      const order = [...els.slice(i + 1), ...els.slice(0, i + 1)];
      next = order.find((el) =>
        el.textContent?.trim().toLowerCase().startsWith(ch),
      );
    } else return;
    e.preventDefault();
    next?.focus();
  };

  const triggerProps: MenuTriggerProps = {
    ref: triggerRef,
    onClick: () => (open ? close() : show(false)),
    onKeyDown: (e) => {
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        show(e.key === "ArrowUp");
      }
    },
    "aria-haspopup": "menu",
    "aria-expanded": open,
    "aria-controls": open ? menuId : undefined,
  };

  return (
    <>
      {trigger(triggerProps)}
      <Popover
        open={open}
        onClose={close}
        anchorRef={triggerRef}
        placement={placement}
        role="menu"
        label={label}
        id={menuId}
        initialFocus={(popover) => {
          const els = itemsIn(popover);
          return focusLast ? els[els.length - 1] : els[0];
        }}
        className={className}
        onKeyDown={onMenuKeyDown}
      >
        <div ref={menuRef}>
          {items.map((entry, index) => {
            if (entry.type === "separator") {
              return (
                <div
                  key={entry.id ?? `sep-${index}`}
                  role="separator"
                  className="wb-menu-sep"
                />
              );
            }
            if (entry.type === "heading") {
              return (
                <div
                  key={entry.id ?? `h-${index}`}
                  className="wb-menu-heading"
                  role="presentation"
                >
                  {entry.label}
                  {entry.sub ? (
                    <span className="wb-menu-heading-sub">{entry.sub}</span>
                  ) : null}
                </div>
              );
            }
            const role =
              entry.checked === undefined ? "menuitem" : "menuitemradio";
            const cls = cx(
              "wb-menu-item",
              entry.danger && "wb-menu-item--danger",
            );
            const body = (
              <>
                {entry.checked !== undefined ? (
                  <span className="wb-menu-check">
                    {entry.checked ? <Icon name="check" /> : null}
                  </span>
                ) : entry.icon ? (
                  <Icon name={entry.icon} />
                ) : null}
                <span className="wb-menu-label-text">{entry.label}</span>
                {entry.hint ? (
                  <span className="wb-menu-hint">{entry.hint}</span>
                ) : null}
              </>
            );
            if (entry.href !== undefined && !entry.disabled) {
              const onClick = () => {
                setOpen(false);
                entry.onSelect?.();
              };
              return entry.external ? (
                <a
                  key={entry.id}
                  role={role}
                  aria-checked={entry.checked}
                  tabIndex={-1}
                  className={cls}
                  href={entry.href}
                  target="_blank"
                  rel="noopener noreferrer"
                  onClick={onClick}
                >
                  {body}
                </a>
              ) : (
                <Link
                  key={entry.id}
                  role={role}
                  aria-checked={entry.checked}
                  tabIndex={-1}
                  className={cls}
                  href={entry.href}
                  onClick={onClick}
                >
                  {body}
                </Link>
              );
            }
            return (
              <button
                key={entry.id}
                type="button"
                role={role}
                tabIndex={-1}
                className={cls}
                aria-checked={entry.checked}
                aria-disabled={entry.disabled ? true : undefined}
                onClick={() => {
                  if (!entry.disabled) select(entry);
                }}
              >
                {body}
              </button>
            );
          })}
        </div>
      </Popover>
    </>
  );
}
