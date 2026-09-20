import { useEffect, useState } from "react";

/**
 * Reactive media-query hook following the appearance.ts listener pattern:
 * the query is evaluated on mount and re-evaluated on every change event.
 * A new query string re-subscribes against the fresh MediaQueryList.
 */
export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(
    () => window.matchMedia(query).matches,
  );
  useEffect(() => {
    const media = window.matchMedia(query);
    setMatches(media.matches);
    const onChange = (event: MediaQueryListEvent) => {
      setMatches(event.matches);
    };
    media.addEventListener("change", onChange);
    return () => media.removeEventListener("change", onChange);
  }, [query]);
  return matches;
}
