import { useEffect, useState } from "react";

/**
 * Pixels of layout viewport occluded by the soft keyboard. Android WebView
 * (default `interactive-widget=resizes-visual`) shrinks only the visual
 * viewport, so a bottom-anchored fixed sheet must lift itself by this inset.
 */
export function useKeyboardInset(enabled: boolean): number {
  const [inset, setInset] = useState(0);
  useEffect(() => {
    if (!enabled) return undefined;
    const viewport = window.visualViewport;
    if (!viewport) return undefined;
    const update = () => {
      setInset(
        Math.max(
          0,
          Math.round(window.innerHeight - viewport.height - viewport.offsetTop),
        ),
      );
    };
    update();
    viewport.addEventListener("resize", update);
    viewport.addEventListener("scroll", update);
    return () => {
      viewport.removeEventListener("resize", update);
      viewport.removeEventListener("scroll", update);
    };
  }, [enabled]);
  return enabled ? inset : 0;
}

