/** Fixed-position placement for popovers and listboxes, clamped to the viewport. */
import { useLayoutEffect, useState } from "react";
import type { CSSProperties, RefObject } from "react";

export type Placement = "bottom-start" | "bottom-end" | "top-start" | "top-end";

const GAP = 6;
const MARGIN = 8;

export function computePosition(
  anchor: { top: number; bottom: number; left: number; right: number },
  size: { width: number; height: number },
  placement: Placement,
  viewport: { width: number; height: number },
  gap = GAP,
): { top: number; left: number } {
  const below = anchor.bottom + gap;
  const above = anchor.top - gap - size.height;
  const fitsBelow = below + size.height <= viewport.height - MARGIN;
  const fitsAbove = above >= MARGIN;
  const wantsTop = placement.startsWith("top");
  let top = wantsTop
    ? fitsAbove || !fitsBelow
      ? above
      : below
    : fitsBelow || !fitsAbove
      ? below
      : above;
  top = Math.max(MARGIN, Math.min(top, viewport.height - size.height - MARGIN));
  let left = placement.endsWith("end")
    ? anchor.right - size.width
    : anchor.left;
  left = Math.max(MARGIN, Math.min(left, viewport.width - size.width - MARGIN));
  return { top: Math.round(top), left: Math.round(left) };
}

/**
 * Position `floating` next to `anchor` while `open` (fixed positioning).
 * Returns the style to apply and whether the first measurement happened
 * (render hidden until then to avoid a flash at 0,0).
 */
export function useAnchoredPosition(
  open: boolean,
  anchor: RefObject<HTMLElement | null>,
  floating: RefObject<HTMLElement | null>,
  placement: Placement = "bottom-start",
  options: { matchWidth?: boolean | undefined; gap?: number | undefined } = {},
): { style: CSSProperties; measured: boolean } {
  const { matchWidth = false, gap = GAP } = options;
  const [pos, setPos] = useState<{
    top: number;
    left: number;
    width?: number;
  } | null>(null);

  useLayoutEffect(() => {
    if (!open) {
      setPos(null);
      return;
    }
    const place = () => {
      const a = anchor.current;
      const f = floating.current;
      if (!a || !f) return;
      const r = a.getBoundingClientRect();
      const width = matchWidth ? r.width : f.offsetWidth;
      const next = computePosition(
        r,
        { width, height: f.offsetHeight },
        placement,
        { width: window.innerWidth, height: window.innerHeight },
        gap,
      );
      setPos((prev) =>
        prev &&
        prev.top === next.top &&
        prev.left === next.left &&
        prev.width === (matchWidth ? r.width : undefined)
          ? prev
          : matchWidth
            ? { ...next, width: r.width }
            : next,
      );
    };
    place();
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    const observer =
      typeof ResizeObserver === "function" ? new ResizeObserver(place) : null;
    if (floating.current) observer?.observe(floating.current);
    if (anchor.current) observer?.observe(anchor.current);
    return () => {
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
      observer?.disconnect();
    };
  }, [open, anchor, floating, placement, matchWidth, gap]);

  const style: CSSProperties = pos
    ? {
        top: pos.top,
        left: pos.left,
        ...(pos.width !== undefined ? { width: pos.width } : {}),
      }
    : { top: 0, left: 0 };
  return { style, measured: pos !== null };
}
