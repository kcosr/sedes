import { useEffect, useRef } from "react";
import { parseRoute, pushHistoryEntry, replaceHistoryEntry } from "../app/router.js";
import { objectStringField } from "./panel-dom.js";

const MOBILE_TERMINAL_HISTORY_KEY = "sedesMobileTerminalPanel";

/**
 * On phones the Terminals panel is a client-local viewer over the thread. A
 * same-URL history entry lets browser and Android Back (and Escape) dismiss
 * it without navigating away from the thread.
 *
 * `dismiss` is the caller's close; the returned function closes through
 * history when the viewer's entry is current, and reports whether it did.
 */
export function useMobileTerminalHistory({
  active,
  enabled,
  threadId,
  dismiss,
}: {
  readonly active: boolean;
  /** A phone layout whose foreground panel is Terminals. */
  readonly enabled: boolean;
  readonly threadId: string;
  readonly dismiss: () => void;
}): () => boolean {
  const activeRef = useRef(active);
  activeRef.current = active;
  const dismissRef = useRef(dismiss);
  dismissRef.current = dismiss;
  const historyRef = useRef<
    { readonly token: string; readonly previousState: unknown } | undefined
  >(undefined);

  useEffect(() => {
    if (!active || !enabled) return;
    const retained = historyRef.current;
    const reuseEntry =
      retained !== undefined && historyMarker(window.history.state) === retained.token;
    const previousState: unknown = reuseEntry
      ? retained.previousState
      : window.history.state;
    const token = reuseEntry ? retained.token : crypto.randomUUID();
    if (!reuseEntry)
      pushHistoryEntry(withHistoryMarker(previousState, token), window.location.href);
    historyRef.current = { token, previousState };

    const closeFromBack = () => {
      const current = historyRef.current;
      const destination = parseRoute(window.location.pathname, window.location.hash);
      // Router publication precedes React's effect cleanup. A Forward into
      // Settings can reach this old listener before `active` becomes false.
      if (
        current?.token !== token ||
        destination.name !== "thread" ||
        destination.threadId !== threadId ||
        historyMarker(window.history.state) === current.token
      )
        return;
      historyRef.current = undefined;
      dismissRef.current();
    };
    const closeFromEscape = (event: KeyboardEvent) => {
      if (
        event.key !== "Escape" ||
        event.defaultPrevented ||
        event.isComposing ||
        event.altKey ||
        event.ctrlKey ||
        event.metaKey ||
        event.shiftKey
      )
        return;
      const targetOverlay =
        event.target instanceof Element
          ? event.target.closest(
              '[role="dialog"][data-state="open"], [role="menu"][data-state="open"], [role="listbox"][data-state="open"]',
            )
          : null;
      if (targetOverlay && !targetOverlay.matches('[data-mobile-terminal-panel="true"]'))
        return;
      event.preventDefault();
      event.stopPropagation();
      dismissRef.current();
    };
    window.addEventListener("popstate", closeFromBack);
    document.addEventListener("keydown", closeFromEscape);
    return () => {
      window.removeEventListener("popstate", closeFromBack);
      document.removeEventListener("keydown", closeFromEscape);
      // Settings temporarily suspends this viewer. Keep its original entry so
      // returning with browser Back does not create another same-URL entry.
      if (!activeRef.current) return;
      if (historyRef.current?.token !== token) return;
      historyRef.current = undefined;
      // A non-Back dismissal should not leave a stale terminal marker as the
      // current entry. (Back-driven dismissal has already popped the entry.)
      if (historyMarker(window.history.state) === token)
        replaceHistoryEntry(previousState, window.location.href);
    };
  }, [active, enabled, threadId]);

  return () => {
    const retained = historyRef.current;
    if (!enabled || retained === undefined) return false;
    if (historyMarker(window.history.state) !== retained.token) return false;
    window.history.back();
    return true;
  };
}

function historyMarker(value: unknown): string | undefined {
  return objectStringField(value, MOBILE_TERMINAL_HISTORY_KEY);
}

function withHistoryMarker(value: unknown, token: string): Record<string, unknown> {
  return {
    ...(typeof value === "object" && value !== null
      ? (value as Record<string, unknown>)
      : {}),
    [MOBILE_TERMINAL_HISTORY_KEY]: token,
  };
}
