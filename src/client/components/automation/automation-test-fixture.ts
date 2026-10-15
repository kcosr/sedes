import { vi, type Mock } from "vitest";
import type { NormalizedApplicationThreadSummary } from "../../../shared/index.js";
import type { ThreadAutomationRun } from "../../../shared/protocol/automation-presentation.js";
import type { SummaryAutomation } from "../../automation/automation-health.js";
import type {
  ApplicationClientState,
  ApplicationClientStore,
} from "../../stores/ApplicationClientStore.js";
import type { ThreadClientState } from "../../stores/ThreadClientStore.js";
import type { ThreadAutomationDefinition } from "../../types.js";
import type { AutomationThreadSource } from "./use-automation-thread.js";

/** Test data and a live application store for the automation page and editor. */

export const AUTOMATION_ID = "30000000-0000-4000-8000-000000000001";
export const THREAD_ID = "10000000-0000-4000-8000-000000000001";

export function automationSummary(
  overrides: Partial<SummaryAutomation> = {},
): SummaryAutomation {
  return definition(overrides);

}

export function definition(
  overrides: Partial<ThreadAutomationDefinition> = {},
): ThreadAutomationDefinition {
  return {
    id: AUTOMATION_ID,
    threadId: THREAD_ID,
    name: "Nightly dependency audit",
    source: { title: "Nightly dependency audit", workspaceId: "workspace-1", environmentId: "environment-1", targetId: "target-1", groupId: null, backendLabel: "Pi SDK", available: true, backingState: "bound", runState: "idle", inventoryState: "active", inventoryRevision: 4 },
    status: "enabled",
    runMode: "same_thread",
    scheduleKind: "cron",
    nextRunAt: "2026-10-07T02:00:00.000Z",
    revision: 3,
    runsRevision: 0,
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
    automationId: AUTOMATION_ID,
    id: `20000000-0000-4000-8000-${String(runSequence).padStart(12, "0")}`,
    occurrence: "scheduled",
    scheduledFor: "2026-10-06T02:00:00.000Z",
    state: "completed",
    runMode: "same_thread",
    // The server names the thread a run used, the anchor or a fork run's own.
    resultThreadId: THREAD_ID,
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
    automations: { totalCount: thread.automation ? 1 : 0, enabledCount: thread.automation?.status === "enabled" ? 1 : 0, pausedCount: thread.automation?.status === "paused" ? 1 : 0, exhaustedCount: thread.automation?.status === "exhausted" ? 1 : 0, inFlightCount: 0, attentionCount: thread.automation?.attention ? 1 : 0, nextRunAt: thread.automation?.nextRunAt, revision: thread.automation?.revision ?? 0 },
  } as unknown as NormalizedApplicationThreadSummary;
}

/** Server settings the application store carries. */
export interface FixtureSettings {
  readonly experimentalUsageEnabled?: boolean;
}

function stateFor(
  threads: readonly FixtureThread[],
  loadedForks: readonly FixtureThread[] = [],
  settings: FixtureSettings = {},
): ApplicationClientState {
  return {
    status: "ready",
    connection: "connected",
    authoritative: true,
    providerPulseEnabled: false,
    experimentalUsageEnabled: settings.experimentalUsageEnabled ?? false,
    search: "",
    visibleThreads: [],
    descendantPages:
      loadedForks.length === 0
        ? {}
        : {
            "fork-root": {
              descendants: loadedForks.map((fork) => ({ thread: threadSummary(fork) })),
              loading: false,
              loaded: true,
            },
          },
    pendingThreadConfigurationCopySourceIds: [],
    snapshot: {
      executionTargets: [], groups: [], tasks: [], lineageFamilies: [],
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
    | "acknowledgeAutomationRun"
    | "listAutomations"
    | "getAutomation"
    | "getThreadAutomationCapability"
    | "listAutomationRuns"
    | "previewThreadAutomationSchedule"
    | "createAutomation"
    | "updateAutomation"
    | "setAutomationState"
    | "deleteAutomation"
    | "runAutomationNow"
    | "resolveAutomationRun"
    | "testThreadAutomationPrecheck"
    | "getUsageAvailability"
    | "getUsage"]: ReturnType<typeof vi.fn>;
};

export interface AutomationStore {
  readonly store: ApplicationClientStore;
  readonly automationForThread: (threadId: string) => SummaryAutomation | null;
  readonly invalidate: (automationId?: string) => void;
  readonly invalidateSource: (threadId?: string) => void;
  readonly api: AutomationApi;
  readonly mutateInventory: ReturnType<typeof vi.fn>;
  /** Replaces the threads (and the loaded fork pages), as a stream event would. */
  readonly publish: (threads: readonly FixtureThread[], loadedForks?: readonly FixtureThread[]) => void;
  /** The thread stores a page or editor loads a thread the store lacks from. */
  readonly threadRegistry: FixtureThreadRegistry;
}

export interface FixtureThreadRegistry extends AutomationThreadSource {
  readonly retain: Mock<AutomationThreadSource["retain"]>;
  readonly release: Mock<AutomationThreadSource["release"]>;
  readonly retryLoad: Mock<() => void>;
  /** Settles the retained thread store: the thread loads, or its load fails. */
  readonly settle: (result: { readonly thread: FixtureThread } | { readonly error: string }) => void;
}

/** A thread registry whose stores stay loading until `settle`. */
export function threadRegistry(): FixtureThreadRegistry {
  const listeners = new Set<() => void>();
  let state = { status: "loading" } as ThreadClientState;
  const retryLoad = vi.fn<() => void>();
  const threadStore = {
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    getSnapshot: () => state,
    retryLoad,
  };
  return {
    retain: vi.fn<AutomationThreadSource["retain"]>(() => threadStore),
    release: vi.fn<AutomationThreadSource["release"]>(),
    retryLoad,
    settle: (result) => {
      state = (
        "error" in result
          ? { status: "error", error: result.error }
          : { status: "ready", snapshot: { thread: threadSummary(result.thread) } }
      ) as ThreadClientState;
      for (const listener of listeners) listener();
    },
  };
}

/**
 * An application store with the given threads and an automation API whose
 * calls resolve to plain defaults; pass overrides for the ones a test drives.
 * The usage reads have no default answer: a test that turns experimental
 * usage on drives them.
 */
export function automationStore(
  threads: readonly FixtureThread[] | undefined,
  api: Partial<AutomationApi> = {},
  loadedForks: readonly FixtureThread[] = [],
  settings: FixtureSettings = {},
): AutomationStore {
  const listeners = new Set<() => void>();
  const automationListeners = new Set<(change: any) => void>();
  const sourceListeners = new Set<(id: string | undefined) => void>();
  let currentThreads = [...(threads ?? []), ...loadedForks];
  const automationForThread = (threadId: string) => currentThreads.find((thread) => (thread.id ?? THREAD_ID) === threadId)?.automation ?? null;
  let state: ApplicationClientState = threads
    ? stateFor(threads, loadedForks, settings)
    : ({ status: "loading", search: "", descendantPages: {} } as unknown as ApplicationClientState);
  const fullApi: AutomationApi = {
    acknowledgeAutomationRun: vi.fn().mockResolvedValue({ run: run(), automation: definition() }),
    listAutomations: vi.fn().mockImplementation(async (input) => ({ items: currentThreads.flatMap((thread) => thread.automation && (!input?.threadId || input.threadId === (thread.id ?? THREAD_ID)) ? [thread.automation] : []), nextCursor: null })),
    getAutomation: vi.fn().mockImplementation(async (id) => currentThreads.find((thread) => thread.automation?.id === id)?.automation ?? definition({ id })) ,
    getThreadAutomationCapability: vi.fn().mockResolvedValue({
      available: true,
      canAttach: true,
      canRunNow: true,
      canCloneOnRun: true,
    }),
    listAutomationRuns: vi
      .fn()
      .mockResolvedValue({ items: [], nextCursor: null, counts: { all: 0, problems: 0, skipped: 0 } }),
    previewThreadAutomationSchedule: vi.fn().mockResolvedValue({
      occurrences: [
        "2026-10-07T02:00:00.000Z",
        "2026-10-08T02:00:00.000Z",
        "2026-10-09T02:00:00.000Z",
      ],
    }),
    createAutomation: vi.fn(),
    updateAutomation: vi.fn(),
    setAutomationState: vi.fn(),
    deleteAutomation: vi.fn().mockResolvedValue({ deleted: true }),
    runAutomationNow: vi.fn(),
    resolveAutomationRun: vi.fn(),
    testThreadAutomationPrecheck: vi.fn(),
    getUsageAvailability: vi.fn().mockRejectedValue(new Error("Usage is not driven by this test.")),
    getUsage: vi.fn().mockRejectedValue(new Error("Usage is not driven by this test.")),
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
    mutateInventory,
    subscribeThreadSummaryChanges: (listener: (id: string | undefined) => void) => { sourceListeners.add(listener); return () => sourceListeners.delete(listener); },
    subscribeAutomationChanges: (listener: (change: any) => void) => { automationListeners.add(listener); return () => automationListeners.delete(listener); },
  } as unknown as ApplicationClientStore;
  return {
    store,
    automationForThread,
    invalidateSource: (threadId) => { for (const listener of sourceListeners) listener(threadId); },
    invalidate: (automationId) => { for (const listener of automationListeners) listener(automationId ? { automationId, threadId: THREAD_ID } : undefined); },
    api: fullApi,
    mutateInventory,
    publish: (next, forks = []) => {
      currentThreads = [...next, ...forks];
      for (const listener of automationListeners) listener(undefined);
      state = stateFor(next, forks, settings);
      for (const listener of listeners) listener();
    },
    threadRegistry: threadRegistry(),
  };
}

export function installAutomationDom(): void {
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} unobserve() {} });
  vi.stubGlobal("matchMedia", vi.fn((media: string) => ({ matches: false, media, addEventListener: vi.fn(), removeEventListener: vi.fn() })));
  Object.assign(window.HTMLElement.prototype, { scrollIntoView: vi.fn(), hasPointerCapture: vi.fn(), setPointerCapture: vi.fn(), releasePointerCapture: vi.fn() });
}
