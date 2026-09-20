import { useEffect, useReducer } from "react";
import {
  getSmoothStreamingEnabled,
  subscribeSmoothStreamingEnabled,
} from "./settings.js";

const REDUCED_MOTION_QUERY = "(prefers-reduced-motion: reduce)";

export function isSmoothStreamingEffective(): boolean {
  return (
    getSmoothStreamingEnabled() &&
    !window.matchMedia(REDUCED_MOTION_QUERY).matches
  );
}

/**
 * The effective browser-local smoothing policy. The stored preference remains
 * independent so a temporary OS reduced-motion choice does not overwrite it.
 * Static transcript items pass `active=false` so a long history does not add
 * one settings and media-query subscription per completed Markdown item.
 */
export function useSmoothStreaming(active = true): boolean {
  const [, rerender] = useReducer((revision: number) => revision + 1, 0);

  useEffect(() => {
    if (!active) return undefined;
    const media = window.matchMedia(REDUCED_MOTION_QUERY);
    const announce = () => rerender();
    const unsubscribe = subscribeSmoothStreamingEnabled(announce);
    media.addEventListener("change", announce);
    return () => {
      unsubscribe();
      media.removeEventListener("change", announce);
    };
  }, [active]);

  return isSmoothStreamingEffective();
}
