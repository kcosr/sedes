import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { ApiError } from "../../api/ApiClient.js";
import type { ThreadAutomationDefinition } from "../../types.js";
import { messageFrom, type ApplicationClientStore } from "../../stores/ApplicationClientStore.js";
import { AutomationResourceReads } from "./automation-resource-reads.js";

type Store = Pick<ApplicationClientStore, "api" | "subscribeAutomationChanges" | "subscribeThreadSummaryChanges">;

/** One identity owns a request, its retained definition, and its invalidations. */
export function useAutomationResource(store: Store, automationId: string | undefined) {
  const [definition, setDefinition] = useState<ThreadAutomationDefinition>();
  const [failure, setFailure] = useState<{ id: string; message: string; missing: boolean }>();
  const [attempt, setAttempt] = useState(0);
  const reads = useMemo(() => new AutomationResourceReads(), [automationId, store]);
  const phase = useSyncExternalStore(reads.subscribe, reads.getSnapshot);
  const reload = useCallback(() => {
    if (reads.getSnapshot() !== "active") return;
    setAttempt((value) => value + 1);
  }, [reads]);
  useEffect(() => store.subscribeAutomationChanges((change) => {
    if (change && change.automationId === automationId && change.deleted) {
      reads.markDeleted();
      return;
    }
    if (!change || change.automationId === automationId) reload();
  }), [automationId, reads, reload, store]);
  const sourceId = definition && definition.id === automationId ? definition.threadId : undefined;
  useEffect(() => store.subscribeThreadSummaryChanges((threadId) => {
    if (sourceId && (threadId === undefined || threadId === sourceId)) reload();
  }), [reload, sourceId, store]);
  useEffect(() => {
    if (phase !== "active") return;
    if (!automationId) { setDefinition(undefined); return; }
    const controller = reads.begin();
    if (controller.signal.aborted) return;
    store.api.getAutomation(automationId, controller.signal).then((value) => {
      if (!controller.signal.aborted) { setDefinition(value); setFailure(undefined); }
    }, (reason: unknown) => {
      if (!controller.signal.aborted) setFailure({ id: automationId, message: messageFrom(reason), missing: reason instanceof ApiError && reason.code === "not_found" });
    }).finally(() => reads.release(controller));
    return () => {
      controller.abort();
      reads.release(controller);
    };
  }, [automationId, attempt, phase, reads, store]);
  // Never display the retained response from a previously selected identity.
  const currentFailure = failure && failure.id === automationId ? failure : undefined;
  return { definition: definition?.id === automationId ? definition : undefined, error: phase === "deleted" ? "This automation was deleted." : currentFailure?.message, missing: phase === "deleted" || currentFailure?.missing === true, reload, reads };
}
