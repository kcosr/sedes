import { useCallback } from "react";
import type {
  NormalizedApplicationThreadSummary,
  ThreadRunState,
} from "../../../shared/index.js";
import { describeProjectLocations } from "../../app/project-locations.js";
import type { SummaryAutomation } from "../../automation/automation-health.js";
import type {
  ApplicationClientState,
  ApplicationClientStore,
} from "../../stores/ApplicationClientStore.js";
import { useApplicationStoreSelector } from "../../stores/use-application-store-selector.js";

/** What the automation page and its editor read from the live thread summary. */
export interface AutomationThread {
  readonly id: string;
  readonly title: string;
  readonly projectLabel?: string;
  readonly backendLabel: string;
  readonly inventoryState: NormalizedApplicationThreadSummary["inventoryState"];
  readonly snoozedUntil?: string;
  readonly available: boolean;
  readonly backingState: NormalizedApplicationThreadSummary["backingState"];
  readonly runState: ThreadRunState;
  readonly automation: SummaryAutomation | null;
}

type ThreadStore = Pick<ApplicationClientStore, "subscribe" | "getSnapshot">;

function selectAutomationThread(
  state: ApplicationClientState,
  threadId: string,
): AutomationThread | null | undefined {
  const snapshot = state.snapshot;
  if (!snapshot) return undefined;
  const thread = snapshot.threads.find(({ id }) => id === threadId);
  if (!thread) return null;
  const environments = snapshot.environments ?? [];
  const projectLabel = describeProjectLocations({
    projects: snapshot.projects ?? [],
    workspaces: snapshot.workspaces ?? [],
    environments,
  }).projectFolderLabel(thread.workspaceId, {
    includeEnvironment: environments.length > 1,
  });
  return {
    id: thread.id,
    title: thread.title.text || "Untitled thread",
    ...(projectLabel === undefined ? {} : { projectLabel }),
    backendLabel: thread.backend.label.text,
    inventoryState: thread.inventoryState,
    ...(thread.snoozedUntil === undefined
      ? {}
      : { snoozedUntil: thread.snoozedUntil }),
    available: thread.available,
    backingState: thread.backingState,
    runState: thread.runState,
    automation: thread.automation,
  };
}

/** The selection is rebuilt on every store event; equal content keeps the render. */
function sameSelection(
  left: AutomationThread | null | undefined,
  right: AutomationThread | null | undefined,
): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

/**
 * The live summary of an automation's anchor thread: undefined until the
 * application snapshot arrives, null when the snapshot has no such thread.
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

/**
 * The summary fields that move when the automation or its runs change: the
 * definition revision and the latest run's id and state. The page refetches
 * when this changes.
 */
export function automationLiveKey(
  automation: SummaryAutomation | null | undefined,
): string | undefined {
  if (!automation) return undefined;
  const lastRun = automation.lastRun;
  return `${automation.revision}:${lastRun?.id ?? ""}:${lastRun?.state ?? ""}`;
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
      const summary =
        state.snapshot?.threads.find(({ id }) => id === threadId) ??
        Object.values(state.descendantPages ?? {})
          .flatMap(({ descendants }) => descendants)
          .find(({ thread }) => thread.id === threadId)?.thread;
      return summary ? summary.title.text || "Untitled thread" : undefined;
    },
    [threadId],
  );
  return useApplicationStoreSelector(store, select);
}
