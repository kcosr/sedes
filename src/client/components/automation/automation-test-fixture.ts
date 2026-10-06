import { vi } from "vitest";
import type { NormalizedApplicationThreadSummary } from "../../../shared/index.js";
import type { ThreadAutomationRun } from "../../../shared/protocol/automation-presentation.js";
import type { SummaryAutomation } from "../../automation/automation-health.js";
import type {
  ApplicationClientState,
  ApplicationClientStore,
} from "../../stores/ApplicationClientStore.js";
import type { ThreadAutomationDefinition } from "../../types.js";

/** Test data and a live application store for the automation page and editor. */

export const THREAD_ID = "10000000-0000-4000-8000-000000000001";

export function automationSummary(
  overrides: Partial<SummaryAutomation> = {},
): SummaryAutomation {
  return {
    status: "enabled",
    runMode: "same_thread",
    scheduleKind: "cron",
    schedule: { kind: "cron", expression: "0 2 * * *", timeZone: "UTC" },
    misfirePolicy: "coalesce",
    promptPreview: "Check dependencies",
    nextRunAt: "2026-10-07T02:00:00.000Z",
    revision: 3,
    hasPrecheck: false,
    ...overrides,
  };
}

export function definition(
  overrides: Partial<ThreadAutomationDefinition> = {},
): ThreadAutomationDefinition {
  return {
    status: "enabled",
    runMode: "same_thread",
    scheduleKind: "cron",
    nextRunAt: "2026-10-07T02:00:00.000Z",
    revision: 3,
    createdAt: "2026-10-06T03:05:00.000Z",
    updatedAt: "2026-10-06T03:15:00.000Z",
    hasPrecheck: false,
    prompt: "Check acme-web for outdated dependencies.",
    schedule: { kind: "cron", expression: "0 2 * * *", timeZone: "UTC" },
    misfirePolicy: "coalesce",
    precheck: null,
    ...overrides,
  };
}

let runSequence = 0;

export function run(overrides: Partial<ThreadAutomationRun> = {}): ThreadAutomationRun {
  runSequence += 1;
  return {
    id: `20000000-0000-4000-8000-${String(runSequence).padStart(12, "0")}`,
    occurrence: "scheduled",
    scheduledFor: "2026-10-06T02:00:00.000Z",
    state: "completed",
    runMode: "same_thread",
    definitionRevision: 3,
    coalescedCount: 0,
    claimedAt: "2026-10-06T02:00:00.000Z",
    startedAt: "2026-10-06T02:00:01.000Z",
    acceptedAt: "2026-10-06T02:00:02.400Z",
    finishedAt: "2026-10-06T02:00:02.400Z",
    ...overrides,
  };
}

export interface FixtureThread {
  readonly id?: string;
  readonly title?: string;
  readonly inventoryState?: NormalizedApplicationThreadSummary["inventoryState"];
  readonly snoozedUntil?: string;
  readonly runState?: NormalizedApplicationThreadSummary["runState"];
  readonly backingState?: NormalizedApplicationThreadSummary["backingState"];
  readonly automation: SummaryAutomation | null;
}

function threadSummary(thread: FixtureThread): NormalizedApplicationThreadSummary {
  return {
    id: thread.id ?? THREAD_ID,
    workspaceId: "workspace-1",
    title: { text: thread.title ?? "Nightly dependency audit" },
    backend: { label: { text: "Pi SDK" }, brand: "pi" },
    inventoryState: thread.inventoryState ?? "active",
    inventoryRevision: 4,
    ...(thread.snoozedUntil ? { snoozedUntil: thread.snoozedUntil } : {}),
    available: true,
    backingState: thread.backingState ?? "bound",
    runState: thread.runState ?? "idle",
    automation: thread.automation,
  } as unknown as NormalizedApplicationThreadSummary;
}

function stateFor(threads: readonly FixtureThread[]): ApplicationClientState {
  return {
    status: "ready",
    connection: "connected",
    authoritative: true,
    providerPulseEnabled: false,
    experimentalUsageEnabled: false,
    search: "",
    visibleThreads: [],
    descendantPages: {},
    pendingThreadConfigurationCopySourceIds: [],
    snapshot: {
      projects: [{ id: "project-1", name: "acme-web" }],
      workspaces: [
        {
          id: "workspace-1",
          environmentId: "environment-1",
          projectId: "project-1",
          label: { text: "acme-web" },
          displayPath: { text: "/srv/acme-web" },
          available: true,
        },
      ],
      environments: [
        { id: "environment-1", kind: "local", label: { text: "Local" }, available: true },
      ],
      threads: threads.map(threadSummary),
    },
  } as unknown as ApplicationClientState;
}

export type AutomationApi = {
  readonly [Key in
    | "getThreadAutomation"
    | "getThreadAutomationCapability"
    | "listThreadAutomationRuns"
    | "previewThreadAutomationSchedule"
    | "createThreadAutomation"
    | "updateThreadAutomation"
    | "setThreadAutomationState"
    | "deleteThreadAutomation"
    | "runThreadAutomationNow"
    | "resolveThreadAutomationRun"
    | "testThreadAutomationPrecheck"]: ReturnType<typeof vi.fn>;
};

export interface AutomationStore {
  readonly store: ApplicationClientStore;
  readonly api: AutomationApi;
  readonly mutateInventory: ReturnType<typeof vi.fn>;
  /** Replaces the threads, as a stream event would. */
  readonly publish: (threads: readonly FixtureThread[]) => void;
}

/**
 * An application store with the given threads and an automation API whose
 * calls resolve to plain defaults; pass overrides for the ones a test drives.
 */
export function automationStore(
  threads: readonly FixtureThread[] | undefined,
  api: Partial<AutomationApi> = {},
): AutomationStore {
  const listeners = new Set<() => void>();
  let state: ApplicationClientState = threads
    ? stateFor(threads)
    : ({ status: "loading", search: "", descendantPages: {} } as unknown as ApplicationClientState);
  const fullApi: AutomationApi = {
    getThreadAutomation: vi.fn().mockResolvedValue(definition()),
    getThreadAutomationCapability: vi.fn().mockResolvedValue({
      available: true,
      canAttach: false,
      canRunNow: true,
      canCloneOnRun: true,
    }),
    listThreadAutomationRuns: vi
      .fn()
      .mockResolvedValue({ items: [], nextCursor: null, counts: { all: 0, problems: 0, skipped: 0 } }),
    previewThreadAutomationSchedule: vi.fn().mockResolvedValue({
      occurrences: [
        "2026-10-07T02:00:00.000Z",
        "2026-10-08T02:00:00.000Z",
        "2026-10-09T02:00:00.000Z",
      ],
    }),
    createThreadAutomation: vi.fn(),
    updateThreadAutomation: vi.fn(),
    setThreadAutomationState: vi.fn(),
    deleteThreadAutomation: vi.fn().mockResolvedValue({ deleted: true }),
    runThreadAutomationNow: vi.fn(),
    resolveThreadAutomationRun: vi.fn(),
    testThreadAutomationPrecheck: vi.fn(),
    ...api,
  };
  const mutateInventory = vi.fn().mockResolvedValue(undefined);
  const store = {
    api: fullApi,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    getSnapshot: () => state,
    getThreadSummaries: () => state.snapshot?.threads ?? [],
    mutateInventory,
  } as unknown as ApplicationClientStore;
  return {
    store,
    api: fullApi,
    mutateInventory,
    publish: (next) => {
      state = stateFor(next);
      for (const listener of listeners) listener();
    },
  };
}
