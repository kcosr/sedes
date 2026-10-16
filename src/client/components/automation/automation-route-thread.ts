import { useEffect, useSyncExternalStore } from "react";

/**
 * The thread an automation belongs to, as its page or editor loaded it. The
 * route names only the automation, so the shell reads this to keep the
 * thread selected in the sidebar. An automation never changes thread, so the
 * pair stays true after the page goes; keeping it leaves no gap in the
 * selection between the page and its editor.
 */
let shown: { readonly automationId: string; readonly threadId: string } | undefined;
const listeners = new Set<() => void>();

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Publishes the thread `automationId` belongs to, once it is known. */
export function usePublishAutomationThread(
  automationId: string | undefined,
  threadId: string | undefined,
): void {
  useEffect(() => {
    if (automationId === undefined || threadId === undefined) return;
    if (shown?.automationId === automationId && shown.threadId === threadId) return;
    shown = { automationId, threadId };
    for (const listener of listeners) listener();
  }, [automationId, threadId]);
}

/** The thread `automationId` belongs to, once its page or editor has loaded it. */
export function useAutomationThreadId(automationId: string | undefined): string | undefined {
  const read = () => (shown && shown.automationId === automationId ? shown.threadId : undefined);
  return useSyncExternalStore(subscribe, read, read);
}
