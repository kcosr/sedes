import { navigate, threadPath, threadTurnPath } from "../app/router.js";

const THREAD_PANEL_OPEN_REQUEST_EVENT = "sedes-thread-panel-open-request";

export interface ThreadPanelOpenRequest {
  readonly threadId: string;
}

/**
 * Requests panel activation synchronously, then changes the route. The shell's
 * listener therefore shows the destination's Chat, wherever it lives, before
 * route rendering.
 */
export function openThreadRoute(threadId: string, turnId?: string): void {
  window.dispatchEvent(
    new CustomEvent<ThreadPanelOpenRequest>(THREAD_PANEL_OPEN_REQUEST_EVENT, {
      detail: { threadId },
    }),
  );
  navigate(turnId ? threadTurnPath(threadId, turnId) : threadPath(threadId));
}

export function installThreadPanelOpenRequestListener(
  target: Pick<Window, "addEventListener" | "removeEventListener">,
  onRequest: (request: ThreadPanelOpenRequest) => void,
): () => void {
  const listener = (event: Event) => {
    const request = (event as CustomEvent<ThreadPanelOpenRequest>).detail;
    if (!request?.threadId) return;
    onRequest(request);
  };
  target.addEventListener(THREAD_PANEL_OPEN_REQUEST_EVENT, listener);
  return () =>
    target.removeEventListener(THREAD_PANEL_OPEN_REQUEST_EVENT, listener);
}
