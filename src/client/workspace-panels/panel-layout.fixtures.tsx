import { createRef, useEffect, useState } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, vi } from "vitest";
import type { AssociatedTask, TerminalResource } from "../../shared/index.js";
import { NavigationControlsContext } from "../app/navigation-controls.js";
import { TasksPanel } from "../components/tasks/TasksPanel.js";
import { TasksHostContext, type TasksHost } from "../components/tasks/tasks-host.js";
import type { ApplicationClientStore } from "../stores/ApplicationClientStore.js";
import type { ThreadClientState } from "../stores/ThreadClientStore.js";
import type { ThreadStoreRegistry } from "../stores/ThreadStoreRegistry.js";
import { PanelChrome, type PanelChromeControls } from "./PanelChrome.js";
import { PanelLayout } from "./PanelLayout.js";
import { resetTerminalPanelFixture } from "./panel-layout.terminal-fixture.js";
import { PanelRegionStore } from "./region-store.js";
import type { RegionStorage } from "./region-persistence.js";
import {
  WorkspacePanelTenantRegistry,
  type WorkspacePanelTenant,
} from "./registry.js";

/**
 * Shared fixtures for the PanelLayout tests: fake thread and application
 * stores, a Chat stand-in with a draft, a Files tenant with a draft, and a
 * desktop stage of 1200×800 unless a test measures another.
 *
 * Each test file mocks the terminal renderer itself:
 *
 *   vi.mock("../terminals/TerminalPanel.js", async () => ({
 *     TerminalPanel: (await import("./panel-layout.terminal-fixture.js"))
 *       .TerminalPanelFixture,
 *   }));
 */

export const TERMINAL_ID = "11111111-1111-4111-8111-111111111111";
export const SECOND_TERMINAL_ID = "33333333-3333-4333-8333-333333333333";

export const initialThreadState: ThreadClientState = {
  status: "loading",
  connection: "reconnecting",
  authoritative: false,
  actionPending: false,
  pendingComposerTransfers: [],
  pendingServerSubmissions: [],
  pendingQueuedSteers: [],
  historyLoading: false,
  stashes: [],
  forkAttempts: {},
  questionRequests: [],
  questionRevision: 0,
  questionStatuses: {},
  questionInboxOpenRevision: 0,
  questionInboxConsumedOpenRevision: 0,
  questionInboxClosedQuestionKeys: [],
  questionStatus: "ready",
  questionDrafts: {},
  pendingQuestionIds: [],
  pendingQuestionReplies: [],
  bookmarks: [],
  bookmarkRevision: 0,
  bookmarkStatus: "loading",
  pendingBookmarkTurnIds: [],
};

const initialApplicationState = {
  status: "loading" as const,
  connection: "reconnecting",
  authoritative: false,
  providerPulseEnabled: false,
  experimentalUsageEnabled: false,
  search: "",
  visibleThreads: [],
  descendantPages: {},
  pendingThreadConfigurationCopySourceIds: [],
  snapshot: undefined as unknown,
};

/** Mutable test state; reset before each test. */
export const harness = {
  threadState: initialThreadState,
  threadListeners: new Set<() => void>(),
  applicationState: initialApplicationState as typeof initialApplicationState &
    Record<string, unknown>,
  applicationListeners: new Set<() => void>(),
  mobile: false,
  coarsePointer: false,
  mediaListeners: new Set<(event: MediaQueryListEvent) => void>(),
  toggleSidebar: vi.fn(),
  stage: { width: 1_200, height: 800 },
  resizeCallbacks: [] as ResizeObserverCallback[],
};

export const fakeThreadStore = {
  subscribe: (listener: () => void) => {
    harness.threadListeners.add(listener);
    return () => harness.threadListeners.delete(listener);
  },
  getSnapshot: () => harness.threadState,
};

export const threadRegistry = {
  get: () => fakeThreadStore,
  retainCached: () => fakeThreadStore,
  releaseCached: () => undefined,
} as unknown as ThreadStoreRegistry;

export const applicationStore = {
  subscribe: (listener: () => void) => {
    harness.applicationListeners.add(listener);
    return () => harness.applicationListeners.delete(listener);
  },
  getSnapshot: () => harness.applicationState,
} as unknown as ApplicationClientStore;

/** The application client's API, replaced per test. */
export function setApi(api: Record<string, unknown>): void {
  Object.assign(applicationStore, { api });
}

export function publishThreadState(next: ThreadClientState): void {
  harness.threadState = next;
  for (const listener of harness.threadListeners) listener();
}

export function publishApplicationState(
  patch: Partial<typeof initialApplicationState> & Record<string, unknown>,
): void {
  harness.applicationState = { ...harness.applicationState, ...patch };
  for (const listener of [...harness.applicationListeners]) listener();
}

/** Resizes the measured stage and tells the layout's observer. */
export function measureStage(width: number, height = 800): void {
  harness.stage = { width, height };
  for (const callback of harness.resizeCallbacks)
    callback([], {} as ResizeObserver);
}

/** Crosses the phone breakpoint. */
export function setMobile(mobile: boolean): void {
  harness.mobile = mobile;
  for (const listener of harness.mediaListeners)
    listener({ matches: mobile } as MediaQueryListEvent);
}

export function installPanelLayoutHarness(): void {
  beforeEach(() => {
    window.localStorage.clear();
    harness.threadState = initialThreadState;
    harness.threadListeners = new Set();
    harness.applicationListeners = new Set();
    harness.applicationState = { ...initialApplicationState };
    harness.mobile = false;
    harness.coarsePointer = false;
    harness.mediaListeners = new Set();
    harness.toggleSidebar = vi.fn();
    harness.stage = { width: 1_200, height: 800 };
    harness.resizeCallbacks = [];
    resetTerminalPanelFixture();
    window.history.replaceState(null, "", "/threads/thread-1");
    setApi({
      readTerminal: vi.fn(() => new Promise(() => undefined)),
      listWorkpads: vi.fn(),
    });
    vi.stubGlobal("matchMedia", (query: string) => ({
      get matches() {
        if (query === "(min-width: 820px) and (pointer: fine)")
          return !harness.mobile && !harness.coarsePointer;
        if (query.includes("(pointer: coarse)"))
          return harness.mobile || harness.coarsePointer;
        return harness.mobile;
      },
      media: query,
      onchange: null,
      addEventListener: vi.fn(
        (_type: string, listener: (event: MediaQueryListEvent) => void) => {
          harness.mediaListeners.add(listener);
        },
      ),
      removeEventListener: vi.fn(
        (_type: string, listener: (event: MediaQueryListEvent) => void) => {
          harness.mediaListeners.delete(listener);
        },
      ),
      dispatchEvent: vi.fn(),
    }));
    vi.stubGlobal(
      "ResizeObserver",
      class {
        constructor(callback: ResizeObserverCallback) {
          harness.resizeCallbacks.push(callback);
        }
        observe() {}
        disconnect() {}
      },
    );
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
      () => ({
        x: 0,
        y: 0,
        left: 0,
        top: 0,
        right: harness.stage.width,
        bottom: harness.stage.height,
        width: harness.stage.width,
        height: harness.stage.height,
        toJSON: () => ({}),
      }),
    );
    Object.assign(HTMLElement.prototype, {
      hasPointerCapture: vi.fn(() => false),
      setPointerCapture: vi.fn(),
      releasePointerCapture: vi.fn(),
      scrollIntoView: vi.fn(),
    });
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });
}

export function terminalResource(
  terminalId = TERMINAL_ID,
  displayName = "Remote shell",
  threadId = "thread-1",
): TerminalResource {
  const now = new Date().toISOString();
  return {
    terminalId,
    threadId,
    workspaceId: "workspace-1",
    environmentId: "environment-1",
    environmentLabel: "Local",
    incarnationId: "22222222-2222-4222-8222-222222222222",
    displayName,
    shellProfile: null,
    initialCwd: "/workspace",
    lifecycle: "running",
    terminationEffect: "end_process",
    lifecycleRevision: 1,
    rows: 24,
    columns: 80,
    initialRows: 24,
    initialColumns: 80,
    historyFloorSeq: 0,
    headSeq: 0,
    exitCode: null,
    exitSignal: null,
    publicReason: null,
    createdAt: now,
    startedAt: now,
    exitedAt: null,
    updatedAt: now,
  };
}

export function makeThreadTask({
  id,
  threadId = "thread-1",
  completed = false,
}: {
  readonly id: string;
  readonly threadId?: string;
  readonly completed?: boolean;
}): AssociatedTask {
  return {
    id,
    scope: { kind: "thread", threadId },
    associatedProjectId: "project-1",
    title: `Task ${id}`,
    details: "",
    pinned: false,
    backlog: false,
    files: [],
    completedAt: completed ? "2026-08-25T20:00:00.000Z" : null,
    revision: 0,
    createdAt: "2026-08-25T19:00:00.000Z",
    updatedAt: "2026-08-25T20:00:00.000Z",
  };
}

/** A tenant whose content is a draft input, with mount hooks. */
export function draftTenant(
  input: {
    readonly id?: string;
    readonly title?: string;
    readonly scope?: WorkspacePanelTenant["scope"];
    readonly label?: string;
    readonly mounted?: () => void;
    readonly unmounted?: () => void;
  } = {},
): WorkspacePanelTenant {
  const label = input.label ?? "File draft";
  const testId = (input.id ?? "workspace-files") === "workspace-files"
    ? "files"
    : (input.id ?? "draft");
  function DraftFixture({
    context,
  }: {
    context: Parameters<WorkspacePanelTenant["render"]>[0];
  }) {
    const [value, setValue] = useState("");
    useEffect(() => {
      input.mounted?.();
      return () => input.unmounted?.();
    }, []);
    return (
      <div>
        <input
          aria-label={label}
          data-panel-autofocus
          value={value}
          onChange={(event) => {
            setValue(event.currentTarget.value);
            context.host.setDirty(Boolean(event.currentTarget.value));
          }}
        />
        <span data-testid={`${testId}-visible`}>{String(context.visible)}</span>
        <span data-testid={`${testId}-thread`}>{context.threadId ?? "none"}</span>
      </div>
    );
  }
  return {
    id: input.id ?? "workspace-files",
    title: input.title ?? "Files",
    icon: () => null,
    scope: input.scope ?? "workspace",
    size: {
      minWidth: 280,
      minHeight: 160,
      preferredWidth: 400,
      preferredHeight: 300,
    },
    preferredPlacement: { edge: "right" },
    availability: () => ({ available: true }),
    render: (context) => <DraftFixture context={context} />,
  };
}

export function filesTenant(
  input: { readonly mounted?: () => void; readonly unmounted?: () => void } = {},
): WorkspacePanelTenant {
  return draftTenant(input);
}

export function workpadsTenant(
  input: { readonly mounted?: () => void; readonly unmounted?: () => void } = {},
): WorkspacePanelTenant {
  return draftTenant({
    ...input,
    id: "workpads",
    title: "Workpads",
    scope: "global",
    label: "Workpad draft",
  });
}

export function Chat({
  controls,
  visible,
  disabled = false,
  mounted,
  unmounted,
}: {
  readonly controls: PanelChromeControls;
  readonly visible: boolean;
  readonly disabled?: boolean;
  readonly mounted?: () => void;
  readonly unmounted?: () => void;
}): React.JSX.Element {
  const [value, setValue] = useState("");
  useEffect(() => {
    mounted?.();
    return () => unmounted?.();
  }, []);
  return (
    <section>
      <PanelChrome panelTitle="Chat" leading={<span>Chat</span>} controls={controls} />
      <input
        aria-label="Chat draft"
        data-workspace-primary-focus="preferred"
        disabled={disabled}
        value={value}
        onChange={(event) => setValue(event.currentTarget.value)}
      />
      <span data-testid="chat-visible">{String(visible)}</span>
    </section>
  );
}

export const noStorage: RegionStorage = {
  getItem: () => null,
  setItem: () => undefined,
};

export function navigationControls(): React.ContextType<typeof NavigationControlsContext> {
  return {
    openDrawer: vi.fn(),
    toggleDrawer: vi.fn(),
    toggleSidebar: harness.toggleSidebar,
    sidebarCollapsed: false,
    drawerOpen: false,
    connection: "connected",
    triggerRef: createRef<HTMLButtonElement>(),
  };
}

export interface LayoutElementInput {
  readonly store: PanelRegionStore;
  readonly tenants: WorkspacePanelTenantRegistry;
  readonly threadId?: string;
  /** Null renders a thread whose workspace is not known yet. */
  readonly workspaceId?: string | null;
  readonly active?: boolean;
  readonly threadRegistry?: ThreadStoreRegistry;
  readonly environmentTintEnabled?: boolean;
  readonly chat?: (controls: PanelChromeControls, visible: boolean) => React.ReactElement;
}

/** A PanelLayout for one thread, rendered through that thread's store. */
export function layoutElement({
  store,
  tenants,
  threadId = "thread-1",
  workspaceId = "workspace-1",
  active = true,
  threadRegistry: registry = threadRegistry,
  environmentTintEnabled = true,
  chat = (controls, visible) => <Chat controls={controls} visible={visible} />,
}: LayoutElementInput): React.JSX.Element {
  return (
    <NavigationControlsContext.Provider value={navigationControls()}>
      <PanelLayout
        active={active}
        store={store.forThread(threadId)}
        tenants={tenants}
        applicationStore={applicationStore}
        threadRegistry={registry}
        threadId={threadId}
        workspaceId={workspaceId ?? undefined}
        environmentId="environment-1"
        environmentIds={["environment-1", "environment-2"]}
        environmentTintEnabled={environmentTintEnabled}
        renderChat={chat}
      />
    </NavigationControlsContext.Provider>
  );
}

export interface SetupInput {
  readonly extraTenants?: readonly WorkspacePanelTenant[];
  /** Replaces the default Files tenant. */
  readonly tenants?: readonly WorkspacePanelTenant[];
  readonly storage?: RegionStorage;
  readonly mountedFiles?: () => void;
  readonly unmountedFiles?: () => void;
  readonly mountedChat?: () => void;
  readonly unmountedChat?: () => void;
  readonly chatDisabledUntilAuthoritative?: boolean;
  readonly chatUnmountedUntilReady?: boolean;
  readonly tasksHost?: TasksHost;
  /** Wraps the layout in the real Tasks host, as the application shell does. */
  readonly withTasksPanel?: boolean;
}

export type SetupStore = PanelRegionStore & {
  setActive(active: boolean): void;
  rerenderWorkspace(workspaceId: string): void;
  rerenderThread(threadId: string): void;
};

export function setup(input: SetupInput = {}): SetupStore {
  const registry = new WorkspacePanelTenantRegistry([
    ...(input.tenants ?? [
      filesTenant({ mounted: input.mountedFiles, unmounted: input.unmountedFiles }),
    ]),
    ...(input.extraTenants ?? []),
  ]);
  const store = new PanelRegionStore(registry, {
    threadId: "thread-1",
    storage: input.storage ?? noStorage,
  });
  const chat = (controls: PanelChromeControls, visible: boolean) =>
    input.chatUnmountedUntilReady &&
    fakeThreadStore.getSnapshot().status === "loading" ? (
      <div aria-label="Loading Chat">Loading Chat</div>
    ) : (
      <Chat
        controls={controls}
        visible={visible}
        disabled={
          input.chatDisabledUntilAuthoritative &&
          !fakeThreadStore.getSnapshot().authoritative
        }
        mounted={input.mountedChat}
        unmounted={input.unmountedChat}
      />
    );
  let threadId = "thread-1";
  let workspaceId = "workspace-1";
  let active = true;
  const element = () => {
    const layout = layoutElement({
      store,
      tenants: registry,
      threadId,
      workspaceId,
      active,
      chat,
    });
    const hosted = input.tasksHost ? (
      <TasksHostContext.Provider value={input.tasksHost}>{layout}</TasksHostContext.Provider>
    ) : (
      layout
    );
    return input.withTasksPanel ? (
      <TasksPanel
        store={applicationStore}
        panelLayoutStore={store.forThread(threadId)}
        route={{ name: "thread", threadId }}
      >
        {hosted}
      </TasksPanel>
    ) : (
      hosted
    );
  };
  const view = render(element());
  return Object.assign(store, {
    setActive: (next: boolean) => {
      active = next;
      view.rerender(element());
    },
    rerenderWorkspace: (next: string) => {
      workspaceId = next;
      view.rerender(element());
    },
    rerenderThread: (next: string) => {
      threadId = next;
      view.rerender(element());
    },
  });
}

/** Opens ▾: a menu, or under touch density (phones included) a sheet. */
export async function openPanelsMenu(): Promise<HTMLElement> {
  const trigger = screen.getByRole("button", { name: "Panels" });
  if (harness.mobile || harness.coarsePointer) {
    fireEvent.click(trigger);
    return screen.findByRole("dialog", { name: "Panels" });
  }
  fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false });
  return screen.findByRole("menu");
}

/** Opens a panel's header ⋯ menu. */
export async function openPanelActions(title: string): Promise<HTMLElement> {
  fireEvent.pointerDown(
    screen.getByRole("button", { name: `${title} panel actions` }),
    { button: 0, ctrlKey: false },
  );
  return screen.findByRole("menu");
}
