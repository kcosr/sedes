import { useSyncExternalStore } from "react";

/** The `@media (pointer: coarse)` switch, for sizes JavaScript lays out. */
export const COARSE_POINTER_QUERY = "(pointer: coarse)";

function matchesCoarsePointer(): boolean {
  return (
    typeof window.matchMedia === "function" &&
    window.matchMedia(COARSE_POINTER_QUERY).matches
  );
}

function subscribe(onChange: () => void): () => void {
  if (typeof window.matchMedia !== "function") return () => undefined;
  const media = window.matchMedia(COARSE_POINTER_QUERY);
  media.addEventListener?.("change", onChange);
  return () => media.removeEventListener?.("change", onChange);
}

/**
 * True on a coarse primary pointer (touch). Virtualized lists and Pierre's
 * item metrics use it to keep their row heights equal to the CSS, which
 * enlarges touch targets under the same media query.
 */
export function useCoarsePointer(): boolean {
  return useSyncExternalStore(subscribe, matchesCoarsePointer, () => false);
}
