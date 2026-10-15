import { useCallback, useEffect, useState } from "react";
import { ApiError } from "../../api/ApiClient.js";
import type { ThreadAutomationDefinition } from "../../types.js";
import { messageFrom, type ApplicationClientStore } from "../../stores/ApplicationClientStore.js";

type Store = Pick<ApplicationClientStore, "api" | "subscribeAutomationChanges" | "subscribeThreadSummaryChanges">;

/** One identity owns a request, its retained definition, and its invalidations. */
export function useAutomationResource(store: Store, automationId: string | undefined) {
  const [definition, setDefinition] = useState<ThreadAutomationDefinition>();
  const [failure, setFailure] = useState<{ id: string; message: string; missing: boolean }>();
  const [attempt, setAttempt] = useState(0);
  const reload = useCallback(() => setAttempt((value) => value + 1), []);
  useEffect(() => store.subscribeAutomationChanges((change) => {
    if (!change || change.automationId === automationId) reload();
  }), [automationId, reload, store]);
  const sourceId = definition && definition.id === automationId ? definition.threadId : undefined;
  useEffect(() => store.subscribeThreadSummaryChanges((threadId) => {
    if (sourceId && (threadId === undefined || threadId === sourceId)) reload();
  }), [reload, sourceId, store]);
  useEffect(() => {
    if (!automationId) { setDefinition(undefined); return; }
    const controller = new AbortController();
    store.api.getAutomation(automationId, controller.signal).then((value) => {
      if (!controller.signal.aborted) { setDefinition(value); setFailure(undefined); }
    }, (reason: unknown) => {
      if (!controller.signal.aborted) setFailure({ id: automationId, message: messageFrom(reason), missing: reason instanceof ApiError && reason.code === "not_found" });
    });
    return () => controller.abort();
  }, [automationId, attempt, store]);
  // Never display the retained response from a previously selected identity.
  const currentFailure = failure && failure.id === automationId ? failure : undefined;
  return { definition: definition?.id === automationId ? definition : undefined, error: currentFailure?.message, missing: currentFailure?.missing === true, reload, replace: setDefinition };
}
