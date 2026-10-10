import { useEffect } from "react";
import type { TerminalPanelHandle } from "../terminals/index.js";
import {
  focusInside,
  focusRequestMatchesThread,
  preferredFocusTarget,
  type PanelTargets,
} from "./panel-dom.js";
import type { PanelFocusRequest, PanelRegionStore } from "./region-store.js";
import type { PanelKind } from "./regions.js";

/**
 * Carries out the store's focus request for this thread: focuses the
 * requested panel's preferred control (the region itself on phones, the
 * terminal for Terminals) once its content can take focus, then consumes
 * the request. Pressing or typing anywhere else abandons a pending request.
 */
export function usePanelFocusRequests({
  active,
  desktop,
  focusRequest,
  store,
  threadId,
  targets,
  terminalRef,
  chatAutofocus,
  threadState,
  onFocusPanel,
}: {
  readonly active: boolean;
  readonly desktop: boolean;
  /** This thread's pending request, from the store's snapshot. */
  readonly focusRequest: PanelFocusRequest | undefined;
  readonly store: PanelRegionStore;
  readonly threadId: string;
  readonly targets: PanelTargets;
  readonly terminalRef: React.RefObject<TerminalPanelHandle | null>;
  /** Whether Chat's request may focus its composer on this device. */
  readonly chatAutofocus: boolean;
  readonly threadState: {
    readonly status: string;
    readonly authoritative: boolean;
    readonly connection: string;
  };
  /** A request names the phone's foreground panel. */
  readonly onFocusPanel: (kind: PanelKind) => void;
}): void {
  useEffect(() => {
    if (!active || !focusRequest || !focusRequestMatchesThread(focusRequest, threadId))
      return;
    // A cold Chat route initially contains only ThreadLoading. Focusing the
    // portal target at that point would consume the request before the
    // preferred composer mounts. Keep an eligible autofocus request pending;
    // the interaction listeners below still abandon it if the user chooses a
    // different target while the thread loads.
    if (
      chatAutofocus &&
      focusRequest.kind === "chat" &&
      threadState.status === "loading" &&
      preferredFocusTarget(targets.chat) === undefined
    )
      return;
    let cancelled = false;
    onFocusPanel(focusRequest.kind);
    const focusesTerminal =
      focusRequest.kind === "terminals" &&
      (focusRequest.terminalId !== undefined ||
        Boolean(store.terminalPanel()?.activeTerminalId));
    const attemptFocus = (remainingRetries: number) => {
      if (cancelled) return;
      if (focusesTerminal) {
        const focused = !desktop || terminalRef.current?.focus() === true;
        if (focused) {
          store.consumeFocusRequest(focusRequest.sequence);
        } else if (remainingRetries > 0) {
          requestAnimationFrame(() => attemptFocus(remainingRetries - 1));
        }
        return;
      }
      if (
        !focusInside(
          targets[focusRequest.kind],
          focusRequest.kind === "chat" ? chatAutofocus : desktop,
        )
      )
        return;
      const focused = document.activeElement;
      requestAnimationFrame(() => {
        if (cancelled) return;
        const pending =
          store.getSnapshot().focusRequest?.sequence === focusRequest.sequence;
        if (
          focused instanceof HTMLElement &&
          focused.isConnected &&
          document.activeElement === focused &&
          pending
        ) {
          store.consumeFocusRequest(focusRequest.sequence);
        } else if (remainingRetries > 0 && pending) {
          attemptFocus(remainingRetries - 1);
        }
      });
    };
    requestAnimationFrame(() => {
      if (!cancelled) requestAnimationFrame(() => attemptFocus(2));
    });
    return () => {
      cancelled = true;
    };
  }, [
    active,
    chatAutofocus,
    desktop,
    focusRequest,
    store,
    targets,
    onFocusPanel,
    terminalRef,
    threadId,
    threadState.authoritative,
    threadState.connection,
    threadState.status,
  ]);

  useEffect(() => {
    if (!active || !focusRequest || !focusRequestMatchesThread(focusRequest, threadId))
      return;
    const requestedTarget = targets[focusRequest.kind];
    const abandonDeferredFocus = (event: Event) => {
      if (event.target instanceof Node && requestedTarget.contains(event.target))
        return;
      store.consumeFocusRequest(focusRequest.sequence);
    };
    document.addEventListener("pointerdown", abandonDeferredFocus, true);
    document.addEventListener("keydown", abandonDeferredFocus, true);
    return () => {
      document.removeEventListener("pointerdown", abandonDeferredFocus, true);
      document.removeEventListener("keydown", abandonDeferredFocus, true);
    };
  }, [active, focusRequest, store, targets, threadId]);
}
