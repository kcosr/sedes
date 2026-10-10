import { useEffect, useRef } from "react";
import { parseRoute, pushHistoryEntry } from "../app/router.js";
import { objectStringField } from "./panel-dom.js";

const MOBILE_TERMINAL_HISTORY_KEY = "sedesMobileTerminalPanel";

interface TerminalHistoryEntry {
  readonly token: string;
  /** The thread entry's state, under the viewer's entry. */
  readonly previousState: unknown;
}

/**
 * On phones the Terminals panel is a client-local viewer over the thread. A
 * same-URL history entry lets browser and Android Back (and Escape) return
 * to Chat without navigating away from the thread; Terminals stays loaded.
 *
 * The entry exists only while the viewer is in front. Leaving it any other
 * way (another panel, ✕, a wider window) pops it, so switching away and back
 * never piles entries up. Settings suspends the viewer and keeps its entry.
 *
 * `onBack` runs when Back leaves the entry. The returned function goes back
 * through the entry, as Escape does.
 */
export function useMobileTerminalHistory({
  active,
  enabled,
  threadId,
  onBack,
}: {
  readonly active: boolean;
  /** A phone layout whose foreground panel is Terminals. */
  readonly enabled: boolean;
  readonly threadId: string;
  readonly onBack: () => void;
}): () => void {
  const activeRef = useRef(active);
  activeRef.current = active;
  const threadIdRef = useRef(threadId);
  threadIdRef.current = threadId;
  const onBackRef = useRef(onBack);
  onBackRef.current = onBack;
  /** The viewer's entry while it is in front, or suspended under Settings. */
  const entryRef = useRef<TerminalHistoryEntry | undefined>(undefined);
  /** An entry the viewer left and popped, until that traversal lands. */
  const poppingRef = useRef<TerminalHistoryEntry | undefined>(undefined);

  const back = () => {
    const entry = entryRef.current;
    if (
      entry !== undefined &&
      poppingRef.current !== entry &&
      historyMarker(window.history.state) === entry.token
    ) {
      // The traversal reaches the listener below, which runs `onBack`.
      window.history.back();
      return;
    }
    entryRef.current = undefined;
    onBackRef.current();
  };
  const backRef = useRef(back);
  backRef.current = back;

  useEffect(() => {
    const onPopState = () => {
      const marker = historyMarker(window.history.state);
      const popping = poppingRef.current;
      if (popping !== undefined && marker !== popping.token) {
        // The viewer's own pop landed. Shown again meanwhile, it keeps an
        // entry: put it back.
        poppingRef.current = undefined;
        if (entryRef.current === popping)
          pushHistoryEntry(
            withHistoryMarker(popping.previousState, popping.token),
            window.location.href,
          );
        return;
      }
      const entry = entryRef.current;
      if (entry === undefined || marker === entry.token) return;
      // Router publication precedes React's effect cleanup: a Forward into
      // Settings or another thread reaches this listener first.
      const destination = parseRoute(window.location.pathname, window.location.hash);
      if (destination.name !== "thread" || destination.threadId !== threadIdRef.current)
        return;
      entryRef.current = undefined;
      onBackRef.current();
    };
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, []);

  useEffect(() => {
    if (!active || !enabled) return;
    const marker = historyMarker(window.history.state);
    let entry: TerminalHistoryEntry;
    if (marker === undefined) {
      entry = { token: crypto.randomUUID(), previousState: window.history.state };
      pushHistoryEntry(withHistoryMarker(entry.previousState, entry.token), window.location.href);
    } else {
      // Already on a viewer entry: back from Settings to the suspended
      // viewer, shown again before its pop landed (the listener above puts
      // it back), or back from another thread. Adopt it rather than push.
      entry = [entryRef.current, poppingRef.current].find(
        (candidate) => candidate?.token === marker,
      ) ?? { token: marker, previousState: withoutHistoryMarker(window.history.state) };
    }
    entryRef.current = entry;

    const backFromEscape = (event: KeyboardEvent) => {
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
      backRef.current();
    };
    document.addEventListener("keydown", backFromEscape);
    return () => {
      document.removeEventListener("keydown", backFromEscape);
      // Settings suspends the viewer. Keep its entry so returning with
      // browser Back does not create another same-URL entry.
      if (!activeRef.current) return;
      // Back has already left the entry.
      if (entryRef.current !== entry) return;
      entryRef.current = undefined;
      // Leaving the viewer any other way pops its entry, unless a navigation
      // has already put another entry in front of it.
      if (historyMarker(window.history.state) !== entry.token) return;
      if (poppingRef.current === entry) return;
      poppingRef.current = entry;
      window.history.back();
    };
  }, [active, enabled, threadId]);

  return back;
}

function historyMarker(value: unknown): string | undefined {
  return objectStringField(value, MOBILE_TERMINAL_HISTORY_KEY);
}

function withoutHistoryMarker(value: unknown): unknown {
  if (typeof value !== "object" || value === null) return value;
  const rest: Record<string, unknown> = { ...(value as Record<string, unknown>) };
  delete rest[MOBILE_TERMINAL_HISTORY_KEY];
  return rest;
}

function withHistoryMarker(value: unknown, token: string): Record<string, unknown> {
  return {
    ...(typeof value === "object" && value !== null
      ? (value as Record<string, unknown>)
      : {}),
    [MOBILE_TERMINAL_HISTORY_KEY]: token,
  };
}
