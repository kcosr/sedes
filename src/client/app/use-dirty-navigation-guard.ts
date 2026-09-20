import { useEffect, useRef, useState } from "react";
import {
  installNavigationBlocker,
  navigate,
  parseRoute,
  sameRoute,
  type Route,
} from "./router.js";

export interface DirtyNavigationGuard {
  readonly pendingRoute?: Route;
  readonly cancel: () => void;
  readonly discardAndContinue: () => void;
  readonly proceed: (path: string, options?: { readonly replace?: boolean }) => void;
}

/**
 * Owns route and browser-exit protection for one mounted editor. The caller
 * renders the confirmation UI so focus restoration stays with that editor.
 */
export function useDirtyNavigationGuard(dirty: boolean): DirtyNavigationGuard {
  const [pendingRoute, setPendingRoute] = useState<Route>();
  const pendingContinuation = useRef<(() => void) | undefined>(undefined);
  const bypass = useRef<Route | undefined>(undefined);

  useEffect(
    () =>
      installNavigationBlocker((current, next, proceed) => {
        const allowed = bypass.current;
        if (allowed && sameRoute(allowed, next)) {
          bypass.current = undefined;
          return true;
        }
        if (sameRoute(current, next) || !dirty) return true;
        pendingContinuation.current = proceed;
        setPendingRoute(next);
        return false;
      }),
    [dirty],
  );

  useEffect(() => {
    if (!dirty) return undefined;
    const preventUnload = (event: BeforeUnloadEvent): void => {
      event.preventDefault();
    };
    window.addEventListener("beforeunload", preventUnload);
    return () => window.removeEventListener("beforeunload", preventUnload);
  }, [dirty]);

  return {
    ...(pendingRoute ? { pendingRoute } : {}),
    cancel: () => { pendingContinuation.current = undefined; setPendingRoute(undefined); },
    discardAndContinue: () => {
      const proceed = pendingContinuation.current;
      pendingContinuation.current = undefined;
      setPendingRoute(undefined);
      proceed?.();
    },
    proceed: (path, options) => {
      const parsed = new URL(path, window.location.href);
      const next = parseRoute(parsed.pathname, parsed.hash);
      bypass.current = next;
      pendingContinuation.current = undefined;
      setPendingRoute(undefined);
      navigate(path, options);
    },
  };
}
