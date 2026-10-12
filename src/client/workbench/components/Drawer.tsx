import {
  Fragment,
  useEffect,
  useId,
  useLayoutEffect,
  useImperativeHandle,
  useRef,
  useState,
} from "react";
import type { CSSProperties, ReactNode, Ref } from "react";
import { cx } from "../lib/cx";
import { OverlayScope, useLayer, useOverlayOwner } from "../lib/layers";
import { IconButton } from "./Button";

export interface DrawerProps {
  id?: string | undefined;
  /** Access the drawer surface for application-owned responsive focus behavior. */
  ref?: Ref<HTMLElement> | undefined;
  title: ReactNode;
  /** Accessible name when the title is not plain text (or still loading). */
  label?: string | undefined;
  /** Top line next to the × (type, mono ID, parent link). */
  kicker?: ReactNode;
  /** Line under the title (state pill, owner, relative time). */
  meta?: ReactNode;
  /** Buttons under the meta line. */
  actions?: ReactNode;
  /** Bottom of the header, e.g. <Tabs>. */
  headerExtra?: ReactNode;
  /** Sticky footer (editors: Save / Cancel). */
  footer?: ReactNode;
  children?: ReactNode;
  onClose: () => void;
  /** default (540px) or wide (760px) for editors. */
  size?: "default" | "wide" | undefined;
  /** Scroll back to the top when this changes (the open item's id). */
  resetKey?: unknown;
  /** Where focus goes on close (default: the element focused when it opened). */
  returnFocus?: (() => HTMLElement | null | undefined) | undefined;
  /** Move focus into the drawer when it mounts (default true). */
  autoFocus?: boolean | undefined;
  className?: string | undefined;
}

/**
 * Non-modal detail column (render it in AppShell's `drawer` slot). Esc closes
 * it via the layer stack; focus moves in on open and back on close.
 */
export function Drawer({
  id,
  ref: forwardedRef,
  title,
  label,
  kicker,
  meta,
  actions,
  headerExtra,
  footer,
  children,
  onClose,
  size = "default",
  resetKey,
  returnFocus,
  autoFocus = true,
  className,
}: DrawerProps) {
  const ref = useRef<HTMLElement | null>(null);
  useImperativeHandle(forwardedRef, () => ref.current!, []);
  const body = useRef<HTMLDivElement | null>(null);
  const titleId = `wb-drawer-${useId()}`;
  const [opener] = useState(() =>
    typeof document !== "undefined"
      ? (document.activeElement as HTMLElement | null)
      : null,
  );
  const returnRef = useRef(returnFocus);
  useLayoutEffect(() => {
    returnRef.current = returnFocus;
  });
  const layers = useLayer(true, onClose, false);
  const owner = useOverlayOwner(ref);

  useEffect(() => {
    const el = ref.current;
    // On mount only: later item changes (j/k) keep focus where it is. Focus
    // already inside (or in an overlay the drawer owns) stays put.
    if (autoFocus && el && !owner.contains(document.activeElement))
      el.focus({ preventScroll: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    body.current?.scrollTo({ top: 0 });
  }, [resetKey]);

  useLayoutEffect(() => {
    // Capture the slot while mounted: its React ref may already be detached
    // when our cleanup runs, while its focused separator still exists.
    const slot = ref.current?.closest<HTMLElement>("[data-wb-drawer-slot]");
    return () => {
      // The shell's resize separator is a sibling of the drawer surface but
      // belongs to this pane for focus return. Other outside focus stays put.
      const active = document.activeElement;
      const onSeparator =
        slot &&
        active?.parentElement === slot &&
        active.getAttribute("role") === "separator" &&
        active.getAttribute("aria-controls") === slot.id;
      if (
        active &&
        active !== document.body &&
        !owner.contains(active) &&
        !onSeparator
      )
        return;
      requestAnimationFrame(() => {
        if (document.activeElement && document.activeElement !== document.body)
          return;
        const target = returnRef.current?.() ?? opener;
        if (target && target !== document.body && target.isConnected) {
          target.focus({ preventScroll: true });
        }
      });
    };
  }, [opener, owner]);

  return (
    <OverlayScope layers={layers} owner={owner}>
      <aside
        id={id}
        ref={ref}
        className={cx(
          "wb-drawer",
          size === "wide" && "wb-drawer--wide",
          className,
        )}
        aria-labelledby={label ? undefined : titleId}
        aria-label={label}
        tabIndex={-1}
      >
        <div className="wb-drawer-body" ref={body}>
          <div className="wb-drawer-head">
            <div className="wb-drawer-top">
              <div className="wb-drawer-kicker">{kicker}</div>
              <IconButton
                icon="x"
                label="Close"
                title="Close (Esc)"
                className="wb-drawer-close"
                onClick={onClose}
              />
            </div>
            <h2 className="wb-drawer-title" id={titleId}>
              {title}
            </h2>
            {meta ? <div className="wb-drawer-meta">{meta}</div> : null}
            {actions ? (
              <div className="wb-drawer-actions">{actions}</div>
            ) : null}
            {headerExtra}
          </div>
          {children}
        </div>
        {footer ? <div className="wb-drawer-foot">{footer}</div> : null}
      </aside>
    </OverlayScope>
  );
}

/** A drawer section with an uppercase heading and optional count / action. */
export function DrawerSection({
  title,
  count,
  action,
  children,
  className,
}: {
  title: ReactNode;
  count?: number | string | undefined;
  /** Small control at the right of the heading. */
  action?: ReactNode;
  children?: ReactNode;
  className?: string | undefined;
}) {
  const id = `wb-drsec-${useId()}`;
  return (
    <section
      className={cx("wb-drawer-section", className)}
      aria-labelledby={id}
    >
      <h3 className="wb-drawer-section-title">
        <span id={id}>{title}</span>
        {count !== undefined ? (
          <span className="wb-drawer-section-count">{count}</span>
        ) : null}
        {action ? (
          <span className="wb-drawer-section-action">{action}</span>
        ) : null}
      </h3>
      {children}
    </section>
  );
}

export interface KeyValueItem {
  label: ReactNode;
  value: ReactNode;
  key?: string | undefined;
}

/** Definition list: muted labels, values. Falsy entries are skipped (conditional rows). */
export function KeyValue({
  items,
  labelWidth,
  className,
}: {
  items: readonly (KeyValueItem | null | false | undefined)[];
  /** Label column width in px (default 120). */
  labelWidth?: number | undefined;
  className?: string | undefined;
}) {
  const style =
    labelWidth !== undefined
      ? ({ "--wb-kv-label": `${labelWidth}px` } as CSSProperties)
      : undefined;
  return (
    <dl className={cx("wb-kv", className)} style={style}>
      {items.map((item, i) =>
        item ? (
          <Fragment
            key={item.key ?? (typeof item.label === "string" ? item.label : i)}
          >
            <dt>{item.label}</dt>
            <dd>{item.value}</dd>
          </Fragment>
        ) : null,
      )}
    </dl>
  );
}
