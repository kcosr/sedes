import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
} from "react";
import type {
  NormalizedApplicationSnapshot,
  NormalizedThreadSummary,
  ThreadRunState,
} from "../../../shared/index.js";
import { describeProjectLocations } from "../../app/project-locations.js";
import type { SummaryAutomation } from "../../automation/automation-health.js";
import { findLoadedThread } from "../../automation/loaded-threads.js";
import type {
  ApplicationClientState,
  ApplicationClientStore,
} from "../../stores/ApplicationClientStore.js";
import type {
  ThreadClientState,
  ThreadClientStore,
} from "../../stores/ThreadClientStore.js";
import { useApplicationStoreSelector } from "../../stores/use-application-store-selector.js";

/** What the automation page and its editor read from the live thread summary. */
export interface AutomationThread {
  readonly id: string;
  readonly title: string;
  readonly projectLabel?: string;
  readonly backendLabel: string;
  readonly inventoryState: NormalizedThreadSummary["inventoryState"];
  /** The inventory revision a restore or wake is made against. */
  readonly inventoryRevision: number;
  readonly snoozedUntil?: string;
  readonly available: boolean;
  readonly backingState: NormalizedThreadSummary["backingState"];
  readonly runState: ThreadRunState;
  readonly automation: SummaryAutomation | null;
}

type ThreadStore = Pick<ApplicationClientStore, "subscribe" | "getSnapshot">;

function projectLabelFor(
  snapshot: NormalizedApplicationSnapshot,
  workspaceId: string,
): string | undefined {
  const environments = snapshot.environments;
  return describeProjectLocations({
    projects: snapshot.projects,
    workspaces: snapshot.workspaces,
    environments,
  }).projectFolderLabel(workspaceId, {
    includeEnvironment: environments.length > 1,
  });
}

function toAutomationThread(
  thread: NormalizedThreadSummary,
  projectLabel: string | undefined,
): AutomationThread {
  return {
    id: thread.id,
    title: thread.title.text || "Untitled thread",
    ...(projectLabel === undefined ? {} : { projectLabel }),
    backendLabel: thread.backend.label.text,
    inventoryState: thread.inventoryState,
    inventoryRevision: thread.inventoryRevision,
    ...(thread.snoozedUntil === undefined
      ? {}
      : { snoozedUntil: thread.snoozedUntil }),
    available: thread.available,
    backingState: thread.backingState,
    runState: thread.runState,
    automation: thread.automation,
  };
}

function selectAutomationThread(
  state: ApplicationClientState,
  threadId: string,
): AutomationThread | null | undefined {
  const snapshot = state.snapshot;
  if (!snapshot) return undefined;
  const thread = findLoadedThread(state, threadId);
  return thread
    ? toAutomationThread(thread, projectLabelFor(snapshot, thread.workspaceId))
    : null;
}

/** The selection is rebuilt on every store event; equal content keeps the render. */
function sameSelection(
  left: AutomationThread | null | undefined,
  right: AutomationThread | null | undefined,
): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

/**
 * The summary of a thread the application store holds, in its snapshot or
 * among the fork descendants loaded beyond it: undefined until the snapshot
 * arrives, null when the store does not hold the thread.
 */
export function useAutomationThread(
  store: ThreadStore,
  threadId: string,
): AutomationThread | null | undefined {
  const select = useCallback(
    (state: ApplicationClientState) => selectAutomationThread(state, threadId),
    [threadId],
  );
  return useApplicationStoreSelector(store, select, sameSelection);
}

/** The thread stores that thread routes use: the `ThreadStoreRegistry`. */
export interface AutomationThreadSource {
  readonly retain: (
    threadId: string,
  ) => Pick<ThreadClientStore, "subscribe" | "getSnapshot" | "retryLoad">;
  readonly release: (threadId: string) => void;
}

type RetainedThreadStore = ReturnType<AutomationThreadSource["retain"]>;

const noSubscription = () => () => undefined;

/**
 * Holds a thread's live store from `source` while `needed`, the way a thread
 * route does: a cached store resumes its stream, a new one loads the thread.
 * Undefined until the store for `threadId` is held.
 */
function useRetainedThreadStore(
  source: AutomationThreadSource,
  threadId: string,
  needed: boolean,
): { readonly store: RetainedThreadStore; readonly state: ThreadClientState } | undefined {
  const [held, setHeld] = useState<{
    readonly threadId: string;
    readonly store: RetainedThreadStore;
  }>();
  useEffect(() => {
    if (!needed) return;
    const store = source.retain(threadId);
    setHeld({ threadId, store });
    return () => {
      setHeld(undefined);
      source.release(threadId);
    };
  }, [needed, source, threadId]);
  // A store held for the previous thread is not this thread's.
  const store = held?.threadId === threadId ? held.store : undefined;
  const getSnapshot = useCallback(() => store?.getSnapshot(), [store]);
  const state = useSyncExternalStore(
    store?.subscribe ?? noSubscription,
    getSnapshot,
    getSnapshot,
  );
  return store && state ? { store, state } : undefined;
}

export type AutomationAnchor =
  | { readonly status: "loading" }
  | { readonly status: "ready"; readonly thread: AutomationThread }
  | {
      readonly status: "unavailable";
      readonly message: string;
      readonly retry: () => void;
    };

/**
 * The live summary of an automation's anchor thread for its page and
 * editor. It comes from the application store when that holds the thread.
 * A thread outside it (a fork beyond the bootstrap that the sidebar has not
 * loaded, reached by a deep link or from its thread's header) is read from
 * its thread store, as its thread route would; only that load can say the
 * thread is unavailable.
 */
export function useAutomationAnchor(
  store: ThreadStore,
  source: AutomationThreadSource,
  threadId: string,
): AutomationAnchor {
  const held = useAutomationThread(store, threadId);
  const retained = useRetainedThreadStore(source, threadId, held === null);
  const summary = retained?.state.snapshot?.thread;
  const workspaceId = summary?.workspaceId;
  const selectLabel = useCallback(
    (state: ApplicationClientState) =>
      workspaceId !== undefined && state.snapshot
        ? projectLabelFor(state.snapshot, workspaceId)
        : undefined,
    [workspaceId],
  );
  const projectLabel = useApplicationStoreSelector(store, selectLabel);
  // The thread store publishes for every transcript event; equal content
  // keeps the previous object.
  const loadedJson =
    summary?.id === threadId
      ? JSON.stringify(toAutomationThread(summary, projectLabel))
      : undefined;
  const loaded = useMemo(
    () =>
      loadedJson === undefined
        ? undefined
        : (JSON.parse(loadedJson) as AutomationThread),
    [loadedJson],
  );
  if (held) return { status: "ready", thread: held };
  if (held === null && loaded) return { status: "ready", thread: loaded };
  if (held === null && retained?.state.status === "error") {
    const threadStore = retained.store;
    return {
      status: "unavailable",
      message: retained.state.error ?? "This thread could not be loaded.",
      retry: () => threadStore.retryLoad(),
    };
  }
  return { status: "loading" };
}

/**
 * The summary fields that move when the automation or its runs change: the
 * definition revision and the latest run's id, state and settled turn. The
 * page refetches when this changes.
 */
export function automationLiveKey(
  automation: SummaryAutomation | null | undefined,
): string | undefined {
  if (!automation) return undefined;
  const lastRun = automation.lastRun;
  return `${automation.revision}:${lastRun?.id ?? ""}:${lastRun?.state ?? ""}:${lastRun?.turn?.outcome ?? ""}`;
}

/**
 * A thread's title from the application store, also among loaded fork
 * descendants (clone runs create forks); undefined when it is not loaded.
 */
export function useThreadTitle(
  store: ThreadStore,
  threadId: string | undefined,
): string | undefined {
  const select = useCallback(
    (state: ApplicationClientState) => {
      if (threadId === undefined) return undefined;
      const summary = findLoadedThread(state, threadId);
      return summary ? summary.title.text || "Untitled thread" : undefined;
    },
    [threadId],
  );
  return useApplicationStoreSelector(store, select);
}

/**
 * A thread's run state from the application store, also among loaded fork
 * descendants (a fork run's result thread); undefined when it is not loaded.
 */
export function useThreadRunState(
  store: ThreadStore,
  threadId: string | undefined,
): ThreadRunState | undefined {
  const select = useCallback(
    (state: ApplicationClientState) =>
      threadId === undefined ? undefined : findLoadedThread(state, threadId)?.runState,
    [threadId],
  );
  return useApplicationStoreSelector(store, select);
}
