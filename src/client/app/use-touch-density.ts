import { useSyncExternalStore } from "react";

/**
 * The one density switch, the same query as the `styles.css` density block:
 * narrow layouts and coarse pointers get touch-sized rows, controls and
 * sheets. 819/820px is the app breakpoint.
 */
export const TOUCH_DENSITY_QUERY = "(max-width: 819px), (pointer: coarse)";

/** Evaluates the density switch once, for event handlers and effects. */
export function matchesTouchDensity(): boolean {
  return (
    typeof window.matchMedia === "function" &&
    window.matchMedia(TOUCH_DENSITY_QUERY).matches
  );
}

function subscribe(onChange: () => void): () => void {
  if (typeof window.matchMedia !== "function") return () => undefined;
  const media = window.matchMedia(TOUCH_DENSITY_QUERY);
  media.addEventListener?.("change", onChange);
  return () => media.removeEventListener?.("change", onChange);
}

/**
 * Reactive density switch: true while the touch density applies. Overlay
 * primitives call it, so it tolerates environments without matchMedia.
 */
export function useTouchDensity(): boolean {
  return useSyncExternalStore(subscribe, matchesTouchDensity, () => false);
}
