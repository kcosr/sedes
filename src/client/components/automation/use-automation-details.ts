import { useCallback, useEffect, useRef, useState } from "react";
import type { AutomationCapability } from "../../../shared/index.js";
import { ApiError } from "../../api/ApiClient.js";
import { threadRunPhase } from "../../automation/automation-health.js";
import {
  messageFrom,
  type ApplicationClientStore,
} from "../../stores/ApplicationClientStore.js";
import type { ThreadAutomationDefinition } from "../../types.js";
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

export interface AutomationDefinitionState {
  /** `idle` without an automation; `missing` when the server has none after all. */
  readonly status: "idle" | "loading" | "ready" | "error" | "missing";
  readonly definition?: ThreadAutomationDefinition;
  readonly error?: string;
  readonly retry: () => void;
  /** Takes the definition an action returned (null: the action ended it). */
  readonly replace: (definition: ThreadAutomationDefinition | null) => void;
}

/**
 * The saved definition behind the page, read again whenever the summary's
 * live key (revision, latest run) moves. A refetch keeps the current
 * definition on screen until the new one arrives.
 */
export function useAutomationDefinition(
  store: DetailsStore,
  threadId: string,
  liveKey: string | undefined,
): AutomationDefinitionState {
  const [definition, setDefinition] = useState<ThreadAutomationDefinition>();
  const [status, setStatus] = useState<AutomationDefinitionState["status"]>(
    liveKey === undefined ? "idle" : "loading",
  );
  const [error, setError] = useState<string>();
  const [attempt, setAttempt] = useState(0);
  const definitionRef = useRef(definition);
  definitionRef.current = definition;
  useEffect(() => {
    if (liveKey === undefined) {
      setDefinition(undefined);
      setStatus("idle");
      setError(undefined);
      return;
    }
    const controller = new AbortController();
    if (definitionRef.current === undefined) setStatus("loading");
    store.api.getThreadAutomation(threadId, controller.signal).then(
      (loaded) => {
        if (controller.signal.aborted) return;
        setDefinition(loaded);
        setStatus("ready");
        setError(undefined);
      },
      (reason: unknown) => {
        if (controller.signal.aborted) return;
        if (reason instanceof ApiError && reason.code === "not_found") {
          setDefinition(undefined);
          setStatus("missing");
          return;
        }
        setError(messageFrom(reason));
        if (definitionRef.current === undefined) setStatus("error");
      },
    );
    return () => controller.abort();
  }, [attempt, liveKey, store, threadId]);
  return {
    status,
    ...(definition ? { definition } : {}),
    ...(error === undefined ? {} : { error }),
    retry: useCallback(() => setAttempt((current) => current + 1), []),
    replace: useCallback((next: ThreadAutomationDefinition | null) => {
      setDefinition(next ?? undefined);
      setStatus(next ? "ready" : "missing");
      setError(undefined);
    }, []),
  };
}
