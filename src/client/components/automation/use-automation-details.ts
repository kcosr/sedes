import { useCallback, useEffect, useState } from "react";
import type { AutomationCapability } from "../../../shared/index.js";
import { threadRunPhase } from "../../automation/automation-health.js";
import {
  messageFrom,
  type ApplicationClientStore,
} from "../../stores/ApplicationClientStore.js";
import type { AutomationThread } from "./use-automation-thread.js";

type DetailsStore = Pick<ApplicationClientStore, "api">;

export interface AutomationCapabilityState {
  readonly capability?: AutomationCapability;
  readonly error?: string;
  readonly retry: () => void;
}

/**
 * The thread's automation capability (can it take one, run it now, fork per
 * run). It acquires the conversation, so it is read once per page or editor
 * and again only when the summary changes what it depends on: the
 * thread's inventory state, its availability, its binding to the backend,
 * whether it has an automation, and the phase of its run state (steps
 * within a phase do not change the answer).
 */
export function useAutomationCapability(
  store: DetailsStore,
  threadId: string,
  thread: AutomationThread | null | undefined,
): AutomationCapabilityState {
  const [capability, setCapability] = useState<AutomationCapability>();
  const [error, setError] = useState<string>();
  const [attempt, setAttempt] = useState(0);
  const dependency = thread
    ? [
        thread.inventoryState,
        thread.available,
        thread.backingState,
        thread.automation !== null,
        threadRunPhase(thread.runState),
      ].join(":")
    : undefined;
  useEffect(() => {
    if (dependency === undefined) return;
    const controller = new AbortController();
    store.api.getThreadAutomationCapability(threadId, controller.signal).then(
      (next) => {
        if (controller.signal.aborted) return;
        setCapability(next);
        setError(undefined);
      },
      (reason: unknown) => {
        if (!controller.signal.aborted) setError(messageFrom(reason));
      },
    );
    return () => controller.abort();
  }, [attempt, dependency, store, threadId]);
  return {
    ...(capability ? { capability } : {}),
    ...(error === undefined ? {} : { error }),
    retry: useCallback(() => setAttempt((current) => current + 1), []),
  };
}
