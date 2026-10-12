import { useCallback, useLayoutEffect, useRef, useState } from "react";
import type { KeyboardEvent, PointerEvent, RefObject } from "react";
import { cx } from "./cx";

export interface PaneResizeSpec {
  label: string;
  /** ID of the pane controlled by the separator. */
  controls: string;
  className?: string | undefined;
  /** Custom property on the frame that controls this pane's width. */
  cssVar: `--${string}`;
  min: number;
  max: number;
  /** Direction that widens the pane: right for a left pane, left for a right pane. */
  grow: 1 | -1;
}

export interface PaneResizeState {
  enabled: boolean;
  /** Saved width, which can exceed the currently available space. */
  preferred: number;
  width: number;
  limit: number;
  save: (value: number) => void;
  reset: () => void;
}

/**
 * Shared resize interaction for application-owned pane layouts. The caller owns
 * fitting and persistence. Pointer moves update the frame's CSS property without
 * rendering the shell. Interrupted drags restore the displayed width and never
 * overwrite the preference. Render `separator` inside the positioned pane.
 */
export function usePaneResize(
  spec: PaneResizeSpec,
  frame: RefObject<HTMLElement | null>,
  { enabled, preferred, width, limit, save, reset }: PaneResizeState,
) {
  const handle = useRef<HTMLDivElement | null>(null);
  const [dragging, setDragging] = useState(false);
  const drag = useRef<{
    id: number;
    x: number;
    width: number;
    current: number;
    target: HTMLDivElement;
  } | null>(null);
  const display = (value: number) => {
    frame.current?.style.setProperty(spec.cssVar, `${value}px`);
    handle.current?.setAttribute("aria-valuenow", String(value));
    handle.current?.setAttribute("aria-valuetext", `${value} pixels`);
  };
  const release = (d: NonNullable<typeof drag.current>) => {
    if (d.target.hasPointerCapture(d.id)) d.target.releasePointerCapture(d.id);
  };
  const cancel = () => {
    const d = drag.current;
    if (!d) return;
    drag.current = null;
    display(width);
    setDragging(false);
    release(d);
  };
  const cancelLatest = useRef(cancel);
  useLayoutEffect(() => {
    cancelLatest.current = cancel;
  });
  // Cancel if the pane vanishes, the viewport changes or another pane changes
  // the available room. Keeping the old drag origin would produce a jump.
  useLayoutEffect(() => {
    cancelLatest.current();
    // A detached separator's ref cleanup can cancel before this commit's
    // layout effects, using the previous width. Reconcile the new geometry.
    display(width);
  }, [enabled, width, limit]);
  const attach = useCallback((el: HTMLDivElement | null) => {
    if (!el) cancelLatest.current();
    handle.current = el;
  }, []);
  const clamp = (value: number) =>
    Math.round(Math.max(spec.min, Math.min(spec.max, limit, value)));
  const commit = (value: number) =>
    save(Math.round(Math.max(spec.min, Math.min(spec.max, value))));

  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    if (!enabled || !e.isPrimary || e.button !== 0 || drag.current) return;
    e.preventDefault();
    e.currentTarget.focus();
    e.currentTarget.setPointerCapture(e.pointerId);
    drag.current = {
      id: e.pointerId,
      x: e.clientX,
      width,
      current: width,
      target: e.currentTarget,
    };
    setDragging(true);
  };
  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d || d.id !== e.pointerId) return;
    d.current = clamp(d.width + spec.grow * (e.clientX - d.x));
    display(d.current);
  };
  const onPointerUp = (e: PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d || d.id !== e.pointerId) return;
    drag.current = null;
    setDragging(false);
    release(d);
    if (d.current !== d.width) commit(d.current);
  };
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === "Escape" && drag.current) {
      e.preventDefault();
      e.stopPropagation();
      cancel();
      return;
    }
    if (!enabled || drag.current || e.altKey || e.ctrlKey || e.metaKey) return;
    const more = spec.grow === 1 ? "ArrowRight" : "ArrowLeft";
    const less = spec.grow === 1 ? "ArrowLeft" : "ArrowRight";
    // At the visible limit, a grow key must not discard a wider saved width.
    if ((e.key === more || e.key === "End") && preferred >= limit) {
      e.preventDefault();
      return;
    }
    const step = e.shiftKey ? 40 : 10;
    const next =
      e.key === less
        ? width - step
        : e.key === more
          ? width + step
          : e.key === "Home"
            ? spec.min
            : e.key === "End"
              ? limit
              : null;
    if (next === null) return;
    e.preventDefault();
    commit(clamp(next));
  };

  return {
    dragging,
    handle,
    separator: (
      <div
        ref={attach}
        className={cx(
          "wb-pane-resize",
          spec.grow === -1 && "wb-pane-resize--left",
          spec.className,
        )}
        role="separator"
        tabIndex={enabled ? 0 : -1}
        aria-disabled={!enabled || undefined}
        aria-label={spec.label}
        aria-orientation="vertical"
        aria-controls={spec.controls}
        aria-valuemin={spec.min}
        aria-valuemax={limit}
        aria-valuenow={width}
        aria-valuetext={`${width} pixels`}
        title="Drag to resize; arrow keys adjust width; double-click to reset"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={cancel}
        onLostPointerCapture={cancel}
        onKeyDown={onKeyDown}
        onDoubleClick={() => {
          if (!enabled) return;
          cancel();
          reset();
        }}
      />
    ),
  };
}

export interface PaneWidth {
  min: number;
  max: number;
  preferred: number;
  shown: boolean;
}

/**
 * Fit two edge panes into the room remaining after the main pane's minimum.
 * The sidebar yields first, then the drawer. Minima remain authoritative; the
 * application must collapse or replace panes when those minima cannot fit.
 */
export function fitPaneWidths({
  room,
  sidebar,
  drawer: detail,
}: {
  room: number;
  sidebar: PaneWidth;
  drawer: PaneWidth;
}) {
  const drawer = Math.max(
    detail.min,
    Math.min(
      detail.max,
      detail.preferred,
      room - (sidebar.shown ? sidebar.min : 0),
    ),
  );
  const sideMax = Math.max(
    sidebar.min,
    Math.min(sidebar.max, room - (detail.shown ? drawer : 0)),
  );
  const side = Math.max(sidebar.min, Math.min(sidebar.preferred, sideMax));
  const drawerMax = Math.max(
    detail.min,
    Math.min(detail.max, room - (sidebar.shown ? side : 0)),
  );
  return { side, sideMax, drawer, drawerMax };
}
