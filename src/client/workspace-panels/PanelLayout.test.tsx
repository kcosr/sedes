// @vitest-environment jsdom

import { createRef, useEffect, useMemo, useState } from "react";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { pushHistoryEntry } from "../app/router.js";
import { ApiError } from "../api/ApiClient.js";
import type { ApplicationClientStore } from "../stores/ApplicationClientStore.js";
import { tasksTenant } from "../tasks/tasks-tenant.js";
import { TasksPanel } from "../components/tasks/TasksPanel.js";
import {
  TasksHostContext,
  type TasksDock,
  type TasksHost,
} from "../components/tasks/tasks-host.js";
import { NavigationControlsContext } from "../app/navigation-controls.js";
import { DropdownMenuItem } from "../components/ui/dropdown-menu.js";
import type { ThreadClientState } from "../stores/ThreadClientStore.js";
import type { ThreadStoreRegistry } from "../stores/ThreadStoreRegistry.js";
import type { AssociatedTask, TerminalResource } from "../../shared/index.js";
import { PanelChrome, type PanelChromeControls } from "./PanelChrome.js";
import { PanelLayout } from "./PanelLayout.js";
import { PanelLayoutStore, type PanelLayoutStorage } from "./panel-state.js";
import { panelDockEdge, type SplitNode } from "./layout-tree.js";
import { setConfirmTerminalTermination, setPanelPresentation } from "../app/settings.js";
import {
  WorkspacePanelTenantRegistry,
  type WorkspacePanelTenant,
} from "./registry.js";

const initialThreadState: ThreadClientState = {
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

let threadState = initialThreadState;
let threadListeners = new Set<() => void>();
const fakeThreadStore = {
  subscribe: (listener: () => void) => {
    threadListeners.add(listener);
    return () => threadListeners.delete(listener);
  },
  getSnapshot: () => threadState,
};
const threadRegistry = {
  get: () => fakeThreadStore,
  retainCached: () => fakeThreadStore,
  releaseCached: () => undefined,
} as unknown as ThreadStoreRegistry;
let applicationState = {
  status: "loading" as const,
  connection: "reconnecting",
  authoritative: false,
  providerPulseEnabled: false, experimentalUsageEnabled: false,
  search: "",
  visibleThreads: [],
  descendantPages: {},
  pendingThreadConfigurationCopySourceIds: [],
  snapshot: undefined as unknown,
};
let applicationListeners = new Set<() => void>();
const applicationStore = {
  subscribe: (listener: () => void) => {
    applicationListeners.add(listener);
    return () => applicationListeners.delete(listener);
  },
  getSnapshot: () => applicationState,
} as unknown as ApplicationClientStore;
const TERMINAL_ID = "11111111-1111-4111-8111-111111111111";
const SECOND_TERMINAL_ID = "33333333-3333-4333-8333-333333333333";

function terminalResource(
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

let mobile = false;
let coarsePointer = false;
let mediaListeners = new Set<(event: MediaQueryListEvent) => void>();
let toggleSidebar = vi.fn();
let terminalPanelInstanceSequence = 0;

vi.mock("../terminals/TerminalPanel.js", async () => {
  const React = await import("react");
  return {
    TerminalPanel: React.forwardRef(function TerminalPanelFixture(
      props: {
        readonly terminal: TerminalResource;
        readonly lifecycleError?: string;
        readonly onRemoved?: (terminalId: string) => void;
      },
      ref: React.ForwardedRef<unknown>,
    ) {
      const [instanceId] = React.useState(
        () => ++terminalPanelInstanceSequence,
      );
      React.useImperativeHandle(ref, () => ({
        openSearch: () => undefined,
        openTranscript: () => undefined,
        clearSelection: () => undefined,
        claimControl: () => undefined,
        releaseControl: () => undefined,
        retryConnection: () => undefined,
        retryNotSentInput: () => undefined,
        discardUnconfirmedInput: () => undefined,
        focus: () => true,
      }));
      return (
        <section
          aria-label={`${props.terminal.displayName} terminal`}
          data-terminal-panel-instance={instanceId}
        >
          {props.lifecycleError ? (
            <p role="alert">{props.lifecycleError}</p>
          ) : null}
          <span>stale rendered terminal history</span>
          <button
            type="button"
            onClick={() => props.onRemoved?.(props.terminal.terminalId)}
          >
            Simulate terminal removed
          </button>
        </section>
      );
    }),
  };
});

beforeEach(() => {
  window.localStorage.clear();
  threadState = initialThreadState;
  threadListeners = new Set();
  applicationListeners = new Set();
  mobile = false;
  coarsePointer = false;
  mediaListeners = new Set();
  toggleSidebar = vi.fn();
  terminalPanelInstanceSequence = 0;
  window.history.replaceState(null, "", "/threads/thread-1");
  Object.assign(applicationStore, {
    api: {
      readTerminal: vi.fn(() => new Promise(() => undefined)),
      listWorkpads: vi.fn(),
    },
  });
  applicationState = {
    ...applicationState,
    snapshot: undefined,
    connection: "reconnecting",
    authoritative: false,
  };
  vi.stubGlobal("matchMedia", (query: string) => ({
    get matches() {
      if (query === "(min-width: 820px) and (pointer: fine)") {
        return !mobile && !coarsePointer;
      }
      return mobile;
    },
    media: query,
    onchange: null,
    addEventListener: vi.fn(
      (_type: string, listener: (event: MediaQueryListEvent) => void) => {
        mediaListeners.add(listener);
      },
    ),
    removeEventListener: vi.fn(
      (_type: string, listener: (event: MediaQueryListEvent) => void) => {
        mediaListeners.delete(listener);
      },
    ),
    dispatchEvent: vi.fn(),
  }));
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
    x: 0,
    y: 0,
    left: 0,
    top: 0,
    right: 1_200,
    bottom: 800,
    width: 1_200,
    height: 800,
    toJSON: () => ({}),
  });
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

function filesTenant(
  input: {
    mounted?: () => void;
    unmounted?: () => void;
  } = {},
): WorkspacePanelTenant {
  function FilesFixture({
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
          aria-label="File draft"
          data-panel-autofocus
          value={value}
          onChange={(event) => {
            setValue(event.currentTarget.value);
            context.host.setDirty(Boolean(event.currentTarget.value));
          }}
        />
        <span data-testid="files-visible">{String(context.visible)}</span>
        <span data-testid="files-thread">{context.threadId ?? "none"}</span>
      </div>
    );
  }
  return {
    id: "workspace-files",
    title: "Files",
    icon: () => null,
    scope: "workspace",
    size: {
      minWidth: 280,
      minHeight: 160,
      preferredWidth: 400,
      preferredHeight: 300,
    },
    preferredPlacement: { edge: "right" },
    availability: () => ({ available: true }),
    render: (context) => <FilesFixture context={context} />,
  };
}

function Chat({
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
      <PanelChrome
        panelTitle="Chat"
        leading={<span>Chat</span>}
        controls={controls}
      />
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

function setup(
  input: {
    readonly extraTenants?: readonly WorkspacePanelTenant[];
    readonly storage?: PanelLayoutStorage;
    readonly mountedFiles?: () => void;
    readonly unmountedFiles?: () => void;
    readonly mountedChat?: () => void;
    readonly unmountedChat?: () => void;
    readonly chatDisabledUntilAuthoritative?: boolean;
    readonly chatUnmountedUntilReady?: boolean;
    readonly tasksHost?: TasksHost;
    /** Wraps the layout in the real Tasks host, as the application shell does. */
    readonly withTasksPanel?: boolean;
  } = {},
) {
  const registry = new WorkspacePanelTenantRegistry([
    filesTenant({
      mounted: input.mountedFiles,
      unmounted: input.unmountedFiles,
    }),
    ...(input.extraTenants ?? []),
  ]);
  let panelSequence = 0;
  const store = new PanelLayoutStore(registry, {
    threadId: "thread-1",
    storage: input.storage ?? { getItem: () => null, setItem: () => undefined },
    createId: (kind) => `${kind}-${++panelSequence}`,
  });
  const fakeHost = (layout: React.JSX.Element) =>
    input.tasksHost ? (
      <TasksHostContext.Provider value={input.tasksHost}>
        {layout}
      </TasksHostContext.Provider>
    ) : (
      layout
    );
  const renderLayout = (workspaceId: string, active = true, threadId = "thread-1") => fakeHost(
    <NavigationControlsContext.Provider
      value={{
        openDrawer: vi.fn(),
        toggleDrawer: vi.fn(),
        toggleSidebar,
        sidebarCollapsed: false,
        drawerOpen: false,
        connection: "connected",
        triggerRef: createRef<HTMLButtonElement>(),
      }}
    >
      <PanelLayout
        active={active}
        store={store}
        tenants={registry}
        applicationStore={applicationStore}
        threadRegistry={threadRegistry}
        threadId={threadId}
        workspaceId={workspaceId}
        environmentId="environment-1"
        environmentIds={["environment-1", "environment-2"]}
        environmentTintEnabled
        renderChat={(controls, visible) =>
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
          )
        }
      />
    </NavigationControlsContext.Provider>,
  );
  const withHost = (layout: React.JSX.Element) =>
    input.withTasksPanel ? (
      <TasksPanel
        store={applicationStore}
        panelLayoutStore={store}
        route={{ name: "thread", threadId: "thread-1" }}
      >
        {layout}
      </TasksPanel>
    ) : (
      layout
    );
  const view = render(withHost(renderLayout("workspace-1")));
  return Object.assign(store, {
    setActive: (active: boolean) => view.rerender(withHost(renderLayout("workspace-1", active))),
    rerenderWorkspace: (workspaceId: string) => view.rerender(withHost(renderLayout(workspaceId))),
    rerenderThread: (threadId: string) => view.rerender(withHost(renderLayout("workspace-1", true, threadId))),
  });
}

function publishThreadState(next: ThreadClientState): void {
  threadState = next;
  for (const listener of threadListeners) listener();
}

async function openPanelsMenu(): Promise<void> {
  fireEvent.pointerDown(screen.getByRole("button", { name: "Panels" }), {
    button: 0,
    ctrlKey: false,
  });
  await screen.findByRole("menu");
}

function makeThreadTask({
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

describe("PanelLayout singleton surfaces", () => {
  it.each([
    [0, undefined, "Open Workpads panel"],
    [1, "1", "Open Workpads panel, 1 workpad in this thread"],
    [99, "99", "Open Workpads panel, 99 workpads in this thread"],
    [100, "99+", "Open Workpads panel, 100 workpads in this thread"],
    [187, "99+", "Open Workpads panel, 187 workpads in this thread"],
  ])("badges %s thread workpads from the application summary without listing documents", (count, shown, label) => {
    applicationState = { ...applicationState, authoritative: true, snapshot: { tasks: [], threads: [
      { id: "thread-1", nonArchivedWorkpadCount: count },
      { id: "thread-2", nonArchivedWorkpadCount: 8 },
    ] } };
    setup({ extraTenants: [{ ...filesTenant(), id: "workpads", title: "Workpads", scope: "global" }] });
    const toggle = screen.getByTestId("workpads-panel-toggle");
    expect(toggle).toHaveAccessibleName(label);
    const badge = toggle.querySelector('[data-slot="count-badge"]');
    if (shown === undefined) expect(badge).toBeNull();
    else expect(badge).toHaveTextContent(shown);
    expect(applicationStore.api.listWorkpads).not.toHaveBeenCalled();
  });

  it("hides unavailable workpad counts and follows the current thread and authoritative summary", () => {
    const store = setup({ extraTenants: [{ ...filesTenant(), id: "workpads", title: "Workpads", scope: "global" }] });
    const toggle = screen.getByTestId("workpads-panel-toggle");
    const publish = (authoritative: boolean, threads: readonly { id: string; nonArchivedWorkpadCount: number }[]) => act(() => {
      applicationState = { ...applicationState, authoritative, snapshot: { tasks: [], threads } };
      for (const listener of applicationListeners) listener();
    });
    const threads = [
      { id: "thread-1", nonArchivedWorkpadCount: 2 },
      { id: "thread-2", nonArchivedWorkpadCount: 3 },
    ];
    expect(toggle).toHaveAccessibleName("Open Workpads panel");
    publish(true, threads);
    expect(toggle).toHaveAccessibleName("Open Workpads panel, 2 workpads in this thread");
    fireEvent.click(toggle);
    expect(toggle).toHaveAccessibleName("Close Workpads panel, 2 workpads in this thread");
    act(() => store.collapsePanel("workpads"));
    expect(toggle).toHaveAccessibleName("Show collapsed Workpads panel, 2 workpads in this thread");
    fireEvent.click(toggle);
    fireEvent.click(toggle);
    store.rerenderThread("thread-2");
    expect(toggle).toHaveAccessibleName("Open Workpads panel, 3 workpads in this thread");
    // An old thread update cannot become this thread's count.
    publish(true, [{ ...threads[0]!, nonArchivedWorkpadCount: 9 }, threads[1]!]);
    expect(toggle).toHaveAccessibleName("Open Workpads panel, 3 workpads in this thread");
    publish(false, threads);
    expect(toggle.querySelector('[data-slot="count-badge"]')).toBeNull();
    publish(true, [threads[0]!]);
    expect(toggle).toHaveAccessibleName("Open Workpads panel");
    store.setActive(false);
    publish(true, threads);
    expect(toggle.querySelector('[data-slot="count-badge"]')).toBeNull();
    expect(applicationStore.api.listWorkpads).not.toHaveBeenCalled();
  });

  it("badges only open tasks scoped directly to the current thread in the application header", () => {
    applicationState = { ...applicationState, snapshot: { threads: [], tasks: [
      makeThreadTask({ id: "open-1" }),
      makeThreadTask({ id: "open-2" }),
      makeThreadTask({ id: "completed", completed: true }),
      makeThreadTask({ id: "other-thread", threadId: "thread-2" }),
      { ...makeThreadTask({ id: "project" }), scope: { kind: "project", projectId: "project-1" } },
      { ...makeThreadTask({ id: "global" }), scope: { kind: "global" } },
    ] } };
    setup({ extraTenants: [tasksTenant] });
    const toggle = within(screen.getByTestId("workspace-workbench-bar")).getByTestId("tasks-panel-toggle");
    expect(toggle).toHaveAccessibleName("Open Tasks panel, 2 open tasks");
    expect(toggle.querySelector('[data-slot="count-badge"]')).toHaveTextContent("2");
    fireEvent.click(toggle);
    expect(toggle).toHaveAccessibleName("Close Tasks panel, 2 open tasks");
    expect(toggle).toHaveAttribute("aria-expanded", "true");
  });

  it("keeps a fixed panel list and marks collapsed panels open", async () => {
    const store = setup({ extraTenants: [tasksTenant, { ...filesTenant(), id: "workpads", title: "Workpads", scope: "thread" }] });
    act(() => {
      store.openPanel("workpads");
      store.openPanel("workspace-files", { focus: false });
      store.dockPanel("workspace-files", "left");
      store.collapsePanel("workspace-files");
    });
    await openPanelsMenu();
    const entries = screen.getAllByRole("menuitem").filter(item => item.hasAttribute("data-panel-open"));
    // Tasks and Workpads have their own toggles beside the menu.
    expect(entries.map(item => item.textContent?.split(" —")[0])).toEqual(["Chat", "Files", "Terminals"]);
    expect(entries.map(item => item.getAttribute("data-collapsed"))).toEqual(["false", "true", "false"]);
    expect(entries.map(item => item.getAttribute("aria-description"))).toEqual(["Open", "Open", "Closed"]);
    expect(entries.map(item => Boolean(item.querySelector(".lucide-check")))).toEqual([true, true, false]);
    // An open panel takes the checked row's look: weight 500 and a trailing check.
    expect(entries.map(item => item.getAttribute("data-state"))).toEqual(["checked", "checked", "unchecked"]);
    expect(entries[0]).toHaveClass("data-[state=checked]:font-medium");
    expect(entries[2]).not.toHaveAttribute("data-disabled");
    fireEvent.click(entries[1]!);
    expect(store.isCollapsed("workspace-files")).toBe(false);
  });

  it("keeps Files expanded across thread switches and reload after restoring from Panels", async () => {
    const storage = window.localStorage;
    const store = setup({ storage });
    act(() => {
      store.openPanel("workspace-files");
      store.collapsePanel("workspace-files");
    });
    const otherThread = store.forThread("thread-2");
    expect(otherThread.isCollapsed("workspace-files")).toBe(true);
    await openPanelsMenu();
    fireEvent.click(screen.getByRole("menuitem", { name: /^Files —.*Collapsed$/ }));
    expect(store.isCollapsed("workspace-files")).toBe(false);
    expect(store.forThread("thread-2").isCollapsed("workspace-files")).toBe(false);
    expect(store.forThread("thread-3").isCollapsed("workspace-files")).toBe(false);
    const reloaded = new PanelLayoutStore(store.registry, { threadId: "thread-1", storage });
    expect(reloaded.hasPanel("workspace-files")).toBe(true);
    expect(reloaded.isCollapsed("workspace-files")).toBe(false);
  });

  it.each([false, true])("opens closed singleton panels even from an empty layout (mobile: %s)", async (narrow) => {
    mobile = narrow;
    const store = setup({ extraTenants: [{ ...filesTenant(), id: "workpads", title: "Workpads", scope: "thread" }] });
    act(() => store.closePanel("chat"));
    expect(screen.getByTestId("workspace-panel-empty")).toBeInTheDocument();
    for (const [title, id] of [["Chat", "chat"], ["Files", "workspace-files"]]) {
      await openPanelsMenu();
      const item = screen.getByRole("menuitem", { name: title });
      expect(item).toHaveAttribute("aria-description", "Closed");
      fireEvent.click(item);
      await waitFor(() => expect(store.isVisible(id!)).toBe(true));
    }
    fireEvent.click(screen.getByTestId("workpads-panel-toggle"));
    await waitFor(() => expect(store.isVisible("workpads")).toBe(true));
  });

  it("reopens an existing terminal from the panel list without creating a shell", async () => {
    const resource = terminalResource();
    const listTerminals = vi.fn().mockResolvedValue({ terminals: [resource] });
    const createTerminal = vi.fn();
    Object.assign(applicationStore.api, { listTerminals, createTerminal });
    const store = setup();
    await openPanelsMenu();
    fireEvent.click(screen.getByRole("menuitem", { name: "Terminals" }));
    await waitFor(() => expect(store.terminalPanel()?.activeTerminalId).toBe(resource.terminalId));
    expect(listTerminals).toHaveBeenCalledWith("thread-1", undefined);
    expect(createTerminal).not.toHaveBeenCalled();
    act(() => store.collapsePanel("terminals"));
    await openPanelsMenu();
    fireEvent.click(screen.getByRole("menuitem", { name: /^Terminals —/ }));
    expect(store.isCollapsed("terminals")).toBe(false);
    expect(listTerminals).toHaveBeenCalledTimes(1);
  });

  it("keeps the empty Terminals panel after its last tab closes and creates a new terminal on request", async () => {
    const first = terminalResource();
    const next = terminalResource(SECOND_TERMINAL_ID, "New shell");
    const createTerminal = vi.fn().mockResolvedValue({ terminal: next });
    const listTerminals = vi.fn().mockResolvedValue({ terminals: [first] });
    Object.assign(applicationStore.api, {
      readTerminal: vi.fn(async (id: string) => id === first.terminalId ? first : next),
      createTerminal, listTerminals,
      createTerminalAdmission: vi.fn(), terminalWebSocketUrl: vi.fn(),
    });
    const store = setup();
    act(() => store.openTerminalTab(first.terminalId, { focus: true }));
    await screen.findByRole("tab", { name: "Remote shell" });
    act(() => store.closeTerminalTab(first.terminalId));
    expect(store.terminalPanel()).toMatchObject({ tabs: [], activeTerminalId: null });
    expect(screen.getByText("No terminals open")).toBeVisible();
    expect(within(screen.getByRole("tablist", { name: "Terminal tabs" })).queryAllByRole("tab")).toEqual([]);
    expect(createTerminal).not.toHaveBeenCalled();
    act(() => store.collapsePanel("terminals"));
    await openPanelsMenu();
    fireEvent.click(screen.getByRole("menuitem", { name: /^Terminals —/ }));
    expect(screen.getByText("No terminals open")).toBeVisible();
    expect(listTerminals).not.toHaveBeenCalled();
    expect(createTerminal).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "New terminal" }));
    await waitFor(() => expect(store.terminalPanel()?.activeTerminalId).toBe(next.terminalId));
    expect(createTerminal).toHaveBeenCalledOnce();
    expect(screen.queryByText("No terminals open")).toBeNull();
  });

  it("returns focus to Panels after dismissing a terminal entry failure", async () => {
    Object.assign(applicationStore.api, { listTerminals: vi.fn().mockRejectedValue(new Error("Inventory unavailable")) });
    setup();
    await openPanelsMenu();
    fireEvent.click(screen.getByRole("menuitem", { name: "Terminals" }));
    const dialog = await screen.findByRole("dialog", { name: "Could not open Terminals" });
    expect(dialog).toHaveAccessibleDescription("Inventory unavailable");
    fireEvent.click(within(dialog).getByRole("button", { name: "Close" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Panels" })).toHaveFocus());
  });

  it("creates a terminal when no retained terminal is attachable", async () => {
    Object.assign(applicationStore.api, {
      listTerminals: vi.fn().mockResolvedValue({ terminals: [{ ...terminalResource(), incarnationId: null }] }),
      createTerminal: vi.fn().mockResolvedValue({ terminal: terminalResource() }),
    });
    const store = setup();
    await openPanelsMenu();
    fireEvent.click(screen.getByRole("menuitem", { name: "Terminals" }));
    await waitFor(() => expect(applicationStore.api.createTerminal).toHaveBeenCalledOnce());
    expect(store.terminalPanel()?.activeTerminalId).toBe(TERMINAL_ID);
  });

  it("retries terminal inventory failures before creating a shell", async () => {
    const resource = terminalResource();
    const listTerminals = vi.fn().mockRejectedValueOnce(new Error("Inventory unavailable")).mockResolvedValue({ terminals: [] });
    const createTerminal = vi.fn().mockResolvedValue({ terminal: resource });
    Object.assign(applicationStore.api, { listTerminals, createTerminal });
    const store = setup();
    await openPanelsMenu();
    fireEvent.click(screen.getByRole("menuitem", { name: "Terminals" }));
    const dialog = await screen.findByRole("dialog", { name: "Could not open Terminals" });
    expect(within(dialog).getByText("Inventory unavailable")).toBeInTheDocument();
    expect(createTerminal).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(store.terminalPanel()?.activeTerminalId).toBe(resource.terminalId));
    expect(createTerminal).toHaveBeenCalledTimes(1);
  });

  it.each([false, true])("focuses Workpads content from its toggle (mobile: %s)", async (narrow) => {
    mobile = narrow;
    const store = setup({ extraTenants: [{
      ...filesTenant(),
      id: "workpads",
      title: "Workpads",
      scope: "thread",
      render: () => <input aria-label="Workpad draft" />,
    }] });
    fireEvent.click(screen.getByTestId("workpads-panel-toggle"));
    const draft = await screen.findByRole("textbox", { name: "Workpad draft" });
    const target = narrow
      ? screen.getByRole("region", { name: "Workpads panel content" })
      : draft;
    await waitFor(() => expect(target).toHaveFocus());
    await waitFor(() => expect(store.getSnapshot().focusRequest).toBeUndefined());
    if (!narrow) {
      const dock = vi.spyOn(store, "dockPanel");
      fireEvent.keyDown(document.activeElement!, {
        key: "ArrowDown", ctrlKey: true, shiftKey: true,
      });
      expect(dock).toHaveBeenCalledWith("workpads", "bottom");
    }
  });

  it("toggles Workpads from the workbench bar beside Tasks, outside the shortcut group", () => {
    const store = setup({ extraTenants: [tasksTenant, { ...filesTenant(), id: "workpads", title: "Workpads", scope: "global" }] });
    const bar = within(screen.getByTestId("workspace-workbench-bar"));
    const toggle = bar.getByTestId("workpads-panel-toggle");
    expect(toggle.previousElementSibling).toBe(bar.getByTestId("tasks-panel-toggle"));
    expect(toggle).toHaveAccessibleName("Open Workpads panel");

    fireEvent.click(toggle);
    expect(store.isVisible("workpads")).toBe(true);
    expect(toggle).toHaveAccessibleName("Close Workpads panel");
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    expect(
      within(bar.getByRole("group", { name: "Panel shortcuts" })).queryByRole("button", { name: "Open Workpads panel" }),
    ).toBeNull();

    act(() => { store.collapsePanel("workpads"); });
    expect(toggle).toHaveAccessibleName("Show collapsed Workpads panel");
    fireEvent.click(toggle);
    expect(store.isVisible("workpads")).toBe(true);

    fireEvent.click(toggle);
    expect(store.hasPanel("workpads")).toBe(false);
    expect(toggle).toHaveAccessibleName("Open Workpads panel");
  });

  it("hosts Workpads through docking and collapse without losing dirty text", async () => {
    const unmounted = vi.fn();
    function WorkpadFixture({ context }: { context: Parameters<WorkspacePanelTenant["render"]>[0] }) {
      const [text, setText] = useState("");
      useEffect(() => () => unmounted(), []);
      return <input aria-label="Workpad draft" value={text} onChange={event => { setText(event.target.value); context.host.setDirty(true); }} />;
    }
    const store = setup({ extraTenants: [{ ...filesTenant(), id: "workpads", title: "Workpads", scope: "thread", render: context => <WorkpadFixture context={context} /> }] });
    fireEvent.click(screen.getByTestId("workpads-panel-toggle"));
    const draft = await screen.findByRole("textbox", { name: "Workpad draft" });
    fireEvent.change(draft, { target: { value: "Keep this draft" } });
    act(() => { store.dockPanel("workpads", "bottom"); });
    expect(draft).toHaveValue("Keep this draft");
    fireEvent.click(screen.getByRole("button", { name: "Collapse Workpads panel" }));
    expect(store.isCollapsed("workpads")).toBe(true);
    act(() => { store.restorePanel("workpads", { presentation: "split" }); });
    expect(await screen.findByRole("textbox", { name: "Workpad draft" })).toBe(draft);
    expect(draft).toHaveValue("Keep this draft");
    expect(unmounted).not.toHaveBeenCalled();
    fireEvent.click(within(screen.getByRole("region", { name: "Workpads panel" })).getByRole("button", { name: "Close Workpads panel" }));
    expect(await screen.findByRole("dialog", { name: "Discard unsaved changes?" })).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Keep editing" }));
    expect(draft).toHaveValue("Keep this draft");
    expect(store.hasPanel("workpads")).toBe(true);
  });

  it("draws the back step and ⋯ items a tenant publishes in its panel header", async () => {
    const onRename = vi.fn();
    function WorkpadFixture({ context }: { context: Parameters<WorkspacePanelTenant["render"]>[0] }) {
      const [reading, setReading] = useState(true);
      const items = useMemo(() => reading ? <DropdownMenuItem onSelect={onRename}>Rename…</DropdownMenuItem> : undefined, [reading]);
      useEffect(() => { context.host.setBack(reading ? { label: "Back to workpads", onBack: () => setReading(false) } : undefined); }, [context.host, reading]);
      useEffect(() => { context.host.setMenuItems(items); }, [context.host, items]);
      return <span>{reading ? "Document" : "List"}</span>;
    }
    const store = setup({ extraTenants: [{ ...filesTenant(), id: "workpads", title: "Workpads", scope: "global", render: context => <WorkpadFixture context={context} /> }] });
    act(() => store.openPanel("workpads"));
    const header = within(await screen.findByRole("region", { name: "Workpads panel" })).getByRole("banner", { name: "Workpads panel header" });
    const menuRows = async () => {
      fireEvent.pointerDown(within(header).getByRole("button", { name: "Workpads panel actions" }), { button: 0, ctrlKey: false });
      const menu = await screen.findByRole("menu");
      return [...menu.querySelectorAll("[role^=menuitem]")].map(row => row.textContent);
    };
    // Neither is busy, dirty or titled, yet the header keeps what was published.
    expect(await menuRows()).toEqual(["Left", "Right", "Top", "Bottom", "Rename…"]);
    fireEvent.click(screen.getByRole("menuitem", { name: "Rename…" }));
    expect(onRename).toHaveBeenCalledOnce();
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
    fireEvent.click(within(header).getByRole("button", { name: "Back to workpads" }));
    expect(await screen.findByText("List")).toBeInTheDocument();
    expect(within(header).queryByRole("button", { name: "Back to workpads" })).toBeNull();
    expect(await menuRows()).toEqual(["Left", "Right", "Top", "Bottom"]);
  });

  it("preserves global Workpads dirty protection after changing workspaces", async () => {
    function WorkpadFixture({ context }: { context: Parameters<WorkspacePanelTenant["render"]>[0] }) {
      const [text, setText] = useState("");
      return <input aria-label="Workpad draft" value={text} onChange={event => {
        setText(event.target.value);
        context.host.setDirty(true);
      }} />;
    }
    const store = setup({ extraTenants: [{ ...filesTenant(), id: "workpads", title: "Workpads", scope: "global", render: context => <WorkpadFixture context={context} /> }] });
    act(() => store.openPanel("workpads"));
    const draft = await screen.findByRole("textbox", { name: "Workpad draft" });
    fireEvent.change(draft, { target: { value: "Retain this across workspaces" } });
    store.rerenderWorkspace("workspace-2");
    expect(screen.getByRole("textbox", { name: "Workpad draft" })).toBe(draft);
    fireEvent.click(within(screen.getByRole("region", { name: "Workpads panel" })).getByRole("button", { name: "Close Workpads panel" }));
    const closeDialog = await screen.findByRole("dialog", { name: "Discard unsaved changes?" });
    fireEvent.click(within(closeDialog).getByRole("button", { name: "Keep editing" }));
    expect(draft).toHaveValue("Retain this across workspaces");
    expect(store.hasPanel("workpads")).toBe(true);
    await openPanelsMenu();
    fireEvent.click(screen.getByRole("menuitem", { name: "Reset layout" }));
    const resetDialog = await screen.findByRole("dialog", { name: "Discard unsaved changes?" });
    fireEvent.click(within(resetDialog).getByRole("button", { name: "Keep editing" }));
    expect(draft).toHaveValue("Retain this across workspaces");
    expect(store.hasPanel("workpads")).toBe(true);
  });

  it("keeps panel shortcuts independently clickable beside the descriptive menu", async () => {
    const store = setup();
    const bar = screen.getByTestId("workspace-workbench-bar");
    const shortcuts = within(bar).getByRole("group", {
      name: "Panel shortcuts",
    });
    expect(
      within(shortcuts).getByRole("button", { name: "Open Chat panel" }),
    ).toBeInTheDocument();
    expect(within(bar).getByRole("button", { name: "Panels" })).not.toBe(
      shortcuts,
    );

    await openPanelsMenu();
    fireEvent.click(screen.getByRole("menuitem", { name: /^Files(?: —|$)/ }));
    expect(
      within(shortcuts).getByRole("button", { name: "Open Files panel" }),
    ).toBeInTheDocument();
    act(() => {
      store.openTerminalTab(TERMINAL_ID, { focus: false });
    });
    const terminalShortcut = within(shortcuts).getByRole("button", {
      name: "Open Terminals panel",
    });
    fireEvent.click(terminalShortcut, { shiftKey: true });
    expect(store.getSnapshot().soloPanelInstanceId).toBe("terminals");

    await openPanelsMenu();
    expect(
      screen.getByRole("menuitem", { name: /^Chat —/ }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("menuitem", { name: /^Files —/ }),
    ).toBeInTheDocument();
  });

  it("parks foreground behavior without remounting chat and file drafts", async () => {
    const mountedChat = vi.fn(); const unmountedChat = vi.fn();
    const mountedFiles = vi.fn(); const unmountedFiles = vi.fn();
    const store = setup({ mountedChat, unmountedChat, mountedFiles, unmountedFiles });
    const chatDraft = screen.getByRole("textbox", { name: "Chat draft" });
    fireEvent.change(chatDraft, { target: { value: "Retained chat draft" } });
    await openPanelsMenu();
    fireEvent.click(screen.getByRole("menuitem", { name: /^Files(?: —|$)/ }));
    const fileDraft = screen.getByRole("textbox", { name: "File draft" });
    fireEvent.change(fileDraft, { target: { value: "Unsaved file" } });
    act(() => store.setActive(false));
    expect(screen.getByTestId("chat-visible")).toHaveTextContent("false");
    expect(screen.getByTestId("files-visible")).toHaveTextContent("false");
    expect(unmountedChat).not.toHaveBeenCalled();
    expect(unmountedFiles).not.toHaveBeenCalled();
    act(() => store.setActive(true));
    expect(screen.getByRole("textbox", { name: "Chat draft" })).toBe(chatDraft);
    expect(screen.getByRole("textbox", { name: "File draft" })).toBe(fileDraft);
    expect(chatDraft).toHaveValue("Retained chat draft");
    expect(fileDraft).toHaveValue("Unsaved file");
    expect(mountedChat).toHaveBeenCalledTimes(1);
    expect(mountedFiles).toHaveBeenCalledTimes(1);
  });

  it("projects a Shift-clicked panel alone and restores the split without remounting", async () => {
    const mountedChat = vi.fn();
    const unmountedChat = vi.fn();
    const mountedFiles = vi.fn();
    const unmountedFiles = vi.fn();
    const store = setup({
      mountedChat,
      unmountedChat,
      mountedFiles,
      unmountedFiles,
    });
    const chatDraft = screen.getByRole("textbox", { name: "Chat draft" });
    fireEvent.change(chatDraft, { target: { value: "retained chat" } });
    await openPanelsMenu();
    fireEvent.click(screen.getByRole("menuitem", { name: /^Files(?: —|$)/ }));
    const fileDraft = await screen.findByRole("textbox", {
      name: "File draft",
    });
    fireEvent.change(fileDraft, { target: { value: "retained file" } });
    const originalTree = store.getSnapshot().tree;
    const shortcuts = screen.getByRole("group", { name: "Panel shortcuts" });

    fireEvent.click(
      within(shortcuts).getByRole("button", { name: "Open Chat panel" }),
      { shiftKey: true },
    );
    expect(store.getSnapshot().soloPanelInstanceId).toBe("chat");
    expect(chatDraft).toBeVisible();
    expect(fileDraft.closest(".workspace-panel-parking")).not.toBeNull();
    expect(screen.getByTestId("files-visible")).toHaveTextContent("false");
    expect(store.getSnapshot().tree).toBe(originalTree);

    fireEvent.click(
      within(shortcuts).getByRole("button", { name: "Open Files panel" }),
    );
    expect(store.getSnapshot().soloPanelInstanceId).toBeUndefined();
    expect(chatDraft).toBeVisible();
    expect(fileDraft).toBeVisible();
    expect(fileDraft.closest(".workspace-panel-parking")).toBeNull();
    expect(chatDraft).toHaveValue("retained chat");
    expect(fileDraft).toHaveValue("retained file");
    expect(store.getSnapshot().tree).toBe(originalTree);
    expect(mountedChat).toHaveBeenCalledTimes(1);
    expect(unmountedChat).not.toHaveBeenCalled();
    expect(mountedFiles).toHaveBeenCalledTimes(1);
    expect(unmountedFiles).not.toHaveBeenCalled();
  });

  it("uses the single-panel preference normally and Shift-clicks back to split", async () => {
    setPanelPresentation("single");
    const store = setup();
    act(() => store.openPanel("workspace-files", { focus: false }));

    fireEvent.click(screen.getByRole("button", { name: "Open Files panel" }));
    expect(store.getSnapshot().soloPanelInstanceId).toBe("workspace-files");
    expect(screen.getByRole("textbox", { name: "File draft" })).toBeVisible();
    const shortcuts = screen.getByRole("group", { name: "Panel shortcuts" });

    fireEvent.click(
      within(shortcuts).getByRole("button", { name: "Open Chat panel" }),
      { shiftKey: true },
    );
    expect(store.getSnapshot().soloPanelInstanceId).toBeUndefined();
    expect(screen.getByRole("textbox", { name: "Chat draft" })).toBeVisible();
    expect(screen.getByRole("textbox", { name: "File draft" })).toBeVisible();
  });

  it("uses a descriptive menu entry to leave solo presentation and restore the split", async () => {
    const store = setup();
    await openPanelsMenu();
    fireEvent.click(screen.getByRole("menuitem", { name: /^Files(?: —|$)/ }));
    const shortcuts = screen.getByRole("group", { name: "Panel shortcuts" });
    fireEvent.click(
      within(shortcuts).getByRole("button", { name: "Open Chat panel" }),
      { shiftKey: true },
    );
    expect(store.getSnapshot().soloPanelInstanceId).toBe("chat");

    await openPanelsMenu();
    fireEvent.click(screen.getByRole("menuitem", { name: /^Files —/ }));

    expect(store.getSnapshot().soloPanelInstanceId).toBeUndefined();
    expect(screen.getByRole("textbox", { name: "Chat draft" })).toBeVisible();
    expect(screen.getByRole("textbox", { name: "File draft" })).toBeVisible();
  });

  it("uses Show all to leave solo presentation after restoring collapsed panels", async () => {
    const store = setup();
    await openPanelsMenu();
    fireEvent.click(screen.getByRole("menuitem", { name: /^Files(?: —|$)/ }));
    act(() => {
      store.openTerminalTab(TERMINAL_ID, { focus: false });
      store.collapsePanel("workspace-files");
      store.collapsePanel("terminals");
      store.activatePanel("chat", { presentation: "single", focus: false });
    });
    expect(store.getSnapshot().soloPanelInstanceId).toBe("chat");

    await openPanelsMenu();
    fireEvent.click(screen.getByRole("menuitem", { name: "Show all" }));

    expect(store.getSnapshot().soloPanelInstanceId).toBeUndefined();
    expect(store.getSnapshot().collapsed.size).toBe(0);
    expect(screen.getByText("All panels restored.")).toBeInTheDocument();
  });

  it("keeps global navigation and collapsed restoration in the workbench bar", async () => {
    setup();
    const bar = screen.getByTestId("workspace-workbench-bar");
    const sidebar = screen.getByRole("button", { name: "Hide sidebar" });
    expect(bar).toContainElement(sidebar);
    expect(
      screen.getByRole("banner", { name: "Chat panel header" }),
    ).not.toContainElement(sidebar);
    fireEvent.click(sidebar);
    expect(toggleSidebar).toHaveBeenCalledTimes(1);

    // The menu is the workbench's own inventory, so it stays in the bar
    // whether or not anything is collapsed; only its item state changes.
    const openPanels = screen.getByRole("button", { name: "Panels" });
    expect(bar).toContainElement(openPanels);
    await openPanelsMenu();
    expect(
      screen.getByRole("menuitem", { name: /^Chat —(?!.*Collapsed)/ }),
    ).toBeInTheDocument();
    fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" });

    fireEvent.click(
      screen.getByRole("button", { name: "Collapse Chat panel" }),
    );
    expect(bar).toContainElement(
      screen.getByRole("button", { name: "Panels" }),
    );
    await openPanelsMenu();
    expect(
      screen.getByRole("menuitem", { name: /^Chat —.*Collapsed$/ }),
    ).toBeInTheDocument();
  });

  it("protects unsynced Workpads drafts when resetting the layout", async () => {
    function WorkpadFixture({ context }: { context: Parameters<WorkspacePanelTenant["render"]>[0] }) {
      const [text, setText] = useState("");
      return <input aria-label="Workpad draft" value={text} onChange={(event) => {
        setText(event.target.value);
        context.host.setDirty(true);
      }} />;
    }
    const store = setup({ extraTenants: [{
      ...filesTenant(), id: "workpads", title: "Workpads", scope: "thread",
      render: (context) => <WorkpadFixture context={context} />,
    }] });
    fireEvent.click(screen.getByTestId("workpads-panel-toggle"));
    const draft = await screen.findByRole("textbox", { name: "Workpad draft" });
    fireEvent.change(draft, { target: { value: "Unsynced draft" } });
    const tree = store.getSnapshot().tree;
    await openPanelsMenu();
    fireEvent.click(screen.getByRole("menuitem", { name: "Reset layout" }));
    expect(await screen.findByRole("dialog", { name: "Discard unsaved changes?" }))
      .toHaveTextContent("Resetting the layout will discard unsaved changes in Workpads.");
    expect(store.getSnapshot().tree).toBe(tree);
    fireEvent.click(screen.getByRole("button", { name: "Keep editing" }));
    expect(store.getSnapshot().tree).toBe(tree);
    expect(screen.getByRole("textbox", { name: "Workpad draft" })).toBe(draft);
    expect(draft).toHaveValue("Unsynced draft");
    await openPanelsMenu();
    fireEvent.click(screen.getByRole("menuitem", { name: "Reset layout" }));
    fireEvent.click(await screen.findByRole("button", { name: "Discard and reset" }));
    expect(store.panels().map(({ kind }) => kind)).toEqual(["chat"]);
    expect(screen.queryByRole("textbox", { name: "Workpad draft" })).toBeNull();
  });

  it("offers a visible action that restores the default panel layout", async () => {
    const store = setup();
    await openPanelsMenu();
    fireEvent.click(screen.getByRole("menuitem", { name: /^Files(?: —|$)/ }));
    fireEvent.click(
      screen.getByRole("button", { name: "Collapse Chat panel" }),
    );

    await openPanelsMenu();
    fireEvent.click(screen.getByRole("menuitem", { name: "Reset layout" }));

    expect(store.panels().map(({ kind }) => kind)).toEqual(["chat"]);
    expect(store.getSnapshot().collapsed.size).toBe(0);
    expect(
      screen.queryByRole("button", { name: "Close Files panel" }),
    ).toBeNull();
    expect(screen.getByRole("status")).toHaveTextContent("Panel layout reset.");
  });

  it("keeps transient terminal lookup failures retryable", async () => {
    const readTerminal = vi
      .fn()
      .mockRejectedValueOnce(new Error("Network unavailable"))
      .mockImplementation(() => new Promise(() => undefined));
    Object.assign(applicationStore, { api: { readTerminal } });
    const store = setup();

    act(() => {
      store.openTerminalTab(TERMINAL_ID, { focus: true });
    });

    const terminalTabs = await screen.findByRole("tablist", {
      name: "Terminal tabs",
    });
    const terminalTab = screen.getByRole("tab", { name: "Terminal" });
    expect(terminalTabs).toContainElement(terminalTab);
    expect(terminalTab).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("tabpanel", { name: "Terminal" })).toHaveAttribute(
      "aria-labelledby",
      terminalTab.id,
    );
    expect(
      await screen.findByText(/Couldn’t load this terminal/),
    ).toHaveTextContent("Network unavailable");
    expect(screen.queryByText(/retained history was deleted/)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(readTerminal).toHaveBeenCalledTimes(2));
    expect(screen.getByText("Loading terminal…")).toBeInTheDocument();
  });

  it("labels known-gone terminals separately and allows re-attempting lookup", async () => {
    const readTerminal = vi
      .fn()
      .mockRejectedValue(
        new ApiError(404, "terminal_not_found", "Terminal not found.", false),
      );
    Object.assign(applicationStore, { api: { readTerminal } });
    const store = setup();

    act(() => {
      store.openTerminalTab(TERMINAL_ID, { focus: true });
    });

    expect(
      await screen.findByRole("tablist", { name: "Terminal tabs" }),
    ).toContainElement(screen.getByRole("tab", { name: "Terminal" }));
    expect(
      await screen.findByText("This terminal is no longer available."),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Re-attempt lookup" }));
    await waitFor(() => expect(readTerminal).toHaveBeenCalledTimes(2));
  });

  it("deduplicates concurrent terminal lookups across resource updates", async () => {
    const thirdTerminalId = "44444444-4444-4444-8444-444444444444";
    const pending = new Map<
      string,
      (terminal: TerminalResource) => void
    >();
    const readTerminal = vi.fn(
      (terminalId: string) =>
        new Promise<TerminalResource>((resolve) => {
          pending.set(terminalId, resolve);
        }),
    );
    Object.assign(applicationStore, { api: { readTerminal } });
    const store = setup();

    act(() => {
      store.openTerminalTab(TERMINAL_ID, { focus: false });
      store.openTerminalTab(SECOND_TERMINAL_ID, { focus: false });
      store.openTerminalTab(thirdTerminalId, { focus: false });
    });
    await waitFor(() => expect(readTerminal).toHaveBeenCalledTimes(3));

    await act(async () => {
      pending.get(TERMINAL_ID)?.(
        terminalResource(TERMINAL_ID, "First shell"),
      );
      await Promise.resolve();
    });
    expect(
      await screen.findByRole("tab", { name: "First shell" }),
    ).toBeInTheDocument();
    expect(readTerminal).toHaveBeenCalledTimes(3);

    await act(async () => {
      pending.get(SECOND_TERMINAL_ID)?.(
        terminalResource(SECOND_TERMINAL_ID, "Second shell"),
      );
      await Promise.resolve();
    });
    expect(
      await screen.findByRole("tab", { name: "Second shell" }),
    ).toBeInTheDocument();
    expect(readTerminal).toHaveBeenCalledTimes(3);

    await act(async () => {
      pending.get(thirdTerminalId)?.(
        terminalResource(thirdTerminalId, "Third shell"),
      );
      await Promise.resolve();
    });
    expect(
      await screen.findByRole("tab", { name: "Third shell" }),
    ).toBeInTheDocument();
    expect(readTerminal).toHaveBeenCalledTimes(3);
  });

  it("does not let a slow lookup overwrite a newer inventory resource", async () => {
    applicationState = {
      ...applicationState,
      connection: "connected",
      authoritative: true,
      snapshot: {
        threads: [
          {
            id: "thread-1",
            terminalSummary: { runningCount: 1, retainedCount: 1 },
          },
        ],
      },
    };
    let settleLookup: ((terminal: TerminalResource) => void) | undefined;
    const readTerminal = vi.fn(
      () =>
        new Promise<TerminalResource>((resolve) => {
          settleLookup = resolve;
        }),
    );
    const newer = {
      ...terminalResource(TERMINAL_ID, "Newer shell"),
      lifecycleRevision: 2,
    };
    Object.assign(applicationStore, {
      api: {
        readTerminal,
        listTerminals: vi.fn().mockResolvedValue({ terminals: [newer] }),
        createTerminalAdmission: vi.fn(),
        terminalWebSocketUrl: vi.fn(),
      },
    });
    const store = setup();
    act(() => store.openTerminalTab(TERMINAL_ID, { focus: false }));
    await waitFor(() => expect(readTerminal).toHaveBeenCalledOnce());
    expect(
      await screen.findByRole("tab", { name: "Newer shell" }),
    ).toBeInTheDocument();

    await act(async () => {
      settleLookup?.(terminalResource(TERMINAL_ID, "Older shell"));
      await Promise.resolve();
    });

    expect(readTerminal).toHaveBeenCalledOnce();
    expect(screen.getByRole("tab", { name: "Newer shell" })).toBeVisible();
    expect(screen.queryByRole("tab", { name: "Older shell" })).toBeNull();
  });

  it("removes the local resource, rendered history, and tab after a remote End", async () => {
    const readTerminal = vi.fn().mockResolvedValue(terminalResource());
    Object.assign(applicationStore, {
      api: {
        readTerminal,
        createTerminalAdmission: vi.fn(),
        terminalWebSocketUrl: vi.fn(),
      },
    });
    const store = setup();
    act(() => {
      store.openTerminalTab(TERMINAL_ID, { focus: true });
    });

    expect(
      await screen.findByText("stale rendered terminal history"),
    ).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Remote shell" })).toBeVisible();

    fireEvent.click(
      screen.getByRole("button", { name: "Simulate terminal removed" }),
    );

    await waitFor(() => expect(store.terminalTab(TERMINAL_ID)).toBeUndefined());
    expect(screen.queryByText("stale rendered terminal history")).toBeNull();
    expect(screen.queryByRole("tab", { name: "Remote shell" })).toBeNull();
    expect(screen.getByRole("status")).toHaveTextContent(
      "Remote shell ended. Its retained terminal history was removed.",
    );
  });

  it("offers cancellation before ending a running terminal from its tab", async () => {
    const resource = terminalResource();
    const endTerminal = vi.fn().mockResolvedValue({ terminal: null });
    Object.assign(applicationStore, {
      api: {
        readTerminal: vi.fn().mockResolvedValue(resource),
        createTerminalAdmission: vi.fn(),
        terminalWebSocketUrl: vi.fn(),
        endTerminal,
        deleteTerminal: vi.fn(),
      },
    });
    const store = setup();
    act(() => store.openTerminalTab(TERMINAL_ID, { focus: true }));
    await screen.findByRole("tab", { name: /Remote shell/ });

    fireEvent.click(screen.getByRole("button", { name: "Close Remote shell terminal" }));

    const confirmation = await screen.findByRole("dialog", {
      name: "Close terminal?",
    });
    expect(within(confirmation).getByRole("button", { name: "Close tab" })).toHaveFocus();
    expect(endTerminal).not.toHaveBeenCalled();
    fireEvent.click(
      within(confirmation).getByRole("button", { name: "Cancel" }),
    );
    expect(screen.queryByRole("dialog", { name: "Close terminal?" })).toBeNull();
    expect(endTerminal).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Close Remote shell terminal" }));
    const confirmedDialog = await screen.findByRole("dialog", {
      name: "Close terminal?",
    });
    fireEvent.click(
      within(confirmedDialog).getByRole("button", { name: "End terminal" }),
    );

    await waitFor(() => expect(endTerminal).toHaveBeenCalledOnce());
    expect(endTerminal).toHaveBeenCalledWith(
      resource.terminalId,
      expect.objectContaining({ expectedRevision: resource.lifecycleRevision }),
    );
    await waitFor(() => expect(store.terminalTab(TERMINAL_ID)).toBeUndefined());
    expect(screen.getByRole("status")).toHaveTextContent(
      "Remote shell ended. Its retained terminal history was removed.",
    );
  });

  it.each(["running", "starting", "stopping"] as const)("can close a %s terminal tab without ending its session", async (lifecycle) => {
    const resource = { ...terminalResource(), lifecycle };
    const endTerminal = vi.fn();
    const deleteTerminal = vi.fn();
    Object.assign(applicationStore, { api: {
      readTerminal: vi.fn().mockResolvedValue(resource),
      createTerminalAdmission: vi.fn(), terminalWebSocketUrl: vi.fn(),
      endTerminal, deleteTerminal,
    } });
    const store = setup();
    act(() => store.openTerminalTab(TERMINAL_ID, { focus: true }));
    fireEvent.click(await screen.findByRole("button", { name: "Close Remote shell terminal" }));
    const dialog = await screen.findByRole("dialog", { name: "Close terminal?" });
    if (lifecycle === "stopping") {
      expect(within(dialog).queryByRole("button", { name: "End terminal" })).toBeNull();
    }
    fireEvent.click(within(dialog).getByRole("button", { name: "Close tab" }));
    await waitFor(() => expect(store.terminalTab(TERMINAL_ID)).toBeUndefined());
    expect(endTerminal).not.toHaveBeenCalled();
    expect(deleteTerminal).not.toHaveBeenCalled();
  });

  it.each([true, false])("disconnects an SSH terminal with confirmation %s without promising remote process termination", async (confirm) => {
    setConfirmTerminalTermination(confirm);
    const resource = { ...terminalResource(), terminationEffect: "disconnect_transport" as const };
    const endTerminal = vi.fn().mockResolvedValue({ terminal: null });
    const deleteTerminal = vi.fn();
    Object.assign(applicationStore, { api: {
      readTerminal: vi.fn().mockResolvedValue(resource),
      createTerminalAdmission: vi.fn(), terminalWebSocketUrl: vi.fn(),
      endTerminal, deleteTerminal,
    } });
    const store = setup();
    act(() => store.openTerminalTab(TERMINAL_ID, { focus: true }));
    fireEvent.click(await screen.findByRole("button", {
      name: confirm ? "Close Remote shell terminal" : "Disconnect Remote shell terminal and remove history",
    }));
    if (confirm) {
      const dialog = await screen.findByRole("dialog", { name: "Close terminal?" });
      expect(dialog).toHaveTextContent("disconnect the SSH session and remove its history. Remote processes may continue running.");
      expect(within(dialog).queryByRole("button", { name: "End terminal" })).toBeNull();
      expect(within(dialog).getByRole("button", { name: "Close tab" })).toHaveFocus();
      expect(endTerminal).not.toHaveBeenCalled();
      fireEvent.click(within(dialog).getByRole("button", { name: "Disconnect and remove" }));
    } else {
      expect(screen.queryByRole("dialog")).toBeNull();
    }
    await waitFor(() => expect(endTerminal).toHaveBeenCalledWith(TERMINAL_ID, expect.objectContaining({ expectedRevision: resource.lifecycleRevision })));
    expect(deleteTerminal).not.toHaveBeenCalled();
    await waitFor(() => expect(store.terminalTab(TERMINAL_ID)).toBeUndefined());
  });

  it("removes ended SSH terminal history directly", async () => {
    const deleteTerminal = vi.fn().mockResolvedValue({ terminal: null });
    const endTerminal = vi.fn();
    Object.assign(applicationStore, { api: {
      readTerminal: vi.fn().mockResolvedValue({ ...terminalResource(), lifecycle: "exited", terminationEffect: "disconnect_transport" }),
      createTerminalAdmission: vi.fn(), terminalWebSocketUrl: vi.fn(), endTerminal, deleteTerminal,
    } });
    const store = setup();
    act(() => store.openTerminalTab(TERMINAL_ID, { focus: true }));
    fireEvent.click(await screen.findByRole("button", { name: "Remove Remote shell terminal and history" }));
    await waitFor(() => expect(deleteTerminal).toHaveBeenCalledOnce());
    expect(endTerminal).not.toHaveBeenCalled();
    expect(screen.queryByRole("dialog")).toBeNull();
    await waitFor(() => expect(store.terminalTab(TERMINAL_ID)).toBeUndefined());
  });

  it("ends an active terminal without confirmation and prevents duplicate pending requests", async () => {
    setConfirmTerminalTermination(false);
    let finish: ((value: { terminal: null }) => void) | undefined;
    const endTerminal = vi.fn(() => new Promise<{ terminal: null }>((resolve) => { finish = resolve; }));
    Object.assign(applicationStore, { api: {
      readTerminal: vi.fn().mockResolvedValue(terminalResource()),
      createTerminalAdmission: vi.fn(), terminalWebSocketUrl: vi.fn(),
      endTerminal, deleteTerminal: vi.fn(),
    } });
    const store = setup();
    act(() => store.openTerminalTab(TERMINAL_ID, { focus: true }));
    const close = await screen.findByRole("button", { name: "End Remote shell terminal and remove history" });
    fireEvent.click(close);
    fireEvent.click(close);
    await waitFor(() => expect(endTerminal).toHaveBeenCalledOnce());
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(store.terminalTab(TERMINAL_ID)).toBeDefined();
    await act(async () => { finish?.({ terminal: null }); });
    await waitFor(() => expect(store.terminalTab(TERMINAL_ID)).toBeUndefined());
  });

  it("keeps ended terminal history open when removal fails", async () => {
    const deleteTerminal = vi.fn().mockRejectedValue(new Error("History could not be removed."));
    Object.assign(applicationStore, { api: {
      readTerminal: vi.fn().mockResolvedValue({ ...terminalResource(), lifecycle: "exited" }),
      createTerminalAdmission: vi.fn(), terminalWebSocketUrl: vi.fn(),
      endTerminal: vi.fn(), deleteTerminal,
    } });
    const store = setup();
    act(() => store.openTerminalTab(TERMINAL_ID, { focus: true }));
    fireEvent.click(await screen.findByRole("button", { name: "Remove Remote shell terminal and history" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("History could not be removed.");
    expect(store.terminalTab(TERMINAL_ID)).toBeDefined();
  });

  it("offers only closing the view while terminal state is unknown", async () => {
    const endTerminal = vi.fn();
    const deleteTerminal = vi.fn();
    Object.assign(applicationStore, { api: {
      readTerminal: vi.fn(() => new Promise(() => undefined)),
      endTerminal, deleteTerminal,
    } });
    const store = setup();
    act(() => store.openTerminalTab(TERMINAL_ID, { focus: true }));
    fireEvent.click(await screen.findByRole("button", { name: "Close Terminal terminal" }));
    const dialog = await screen.findByRole("dialog", { name: "Close terminal?" });
    expect(within(dialog).queryByRole("button", { name: "End terminal" })).toBeNull();
    fireEvent.click(within(dialog).getByRole("button", { name: "Close tab" }));
    await waitFor(() => expect(store.terminalTab(TERMINAL_ID)).toBeUndefined());
    expect(endTerminal).not.toHaveBeenCalled();
    expect(deleteTerminal).not.toHaveBeenCalled();
  });

  it("resolves unknown state before removing a terminal with confirmation disabled", async () => {
    setConfirmTerminalTermination(false);
    const resource = { ...terminalResource(), lifecycle: "exited" as const, lifecycleRevision: 9 };
    const readTerminal = vi.fn()
      .mockImplementationOnce(() => new Promise(() => undefined))
      .mockResolvedValue(resource);
    const endTerminal = vi.fn();
    const deleteTerminal = vi.fn().mockResolvedValue({ terminal: null });
    Object.assign(applicationStore, { api: { readTerminal, endTerminal, deleteTerminal } });
    const store = setup();
    act(() => store.openTerminalTab(TERMINAL_ID, { focus: true }));
    await waitFor(() => expect(readTerminal).toHaveBeenCalledOnce());
    fireEvent.click(await screen.findByRole("button", { name: "End Terminal terminal and remove history" }));
    await waitFor(() => expect(deleteTerminal).toHaveBeenCalledWith(TERMINAL_ID, expect.objectContaining({ expectedRevision: 9 })));
    expect(readTerminal).toHaveBeenCalledTimes(2);
    expect(endTerminal).not.toHaveBeenCalled();
    expect(screen.queryByRole("dialog")).toBeNull();
    await waitFor(() => expect(store.terminalTab(TERMINAL_ID)).toBeUndefined());
  });

  it("keeps an unknown terminal tab open when authoritative lookup fails", async () => {
    setConfirmTerminalTermination(false);
    const readTerminal = vi.fn()
      .mockImplementationOnce(() => new Promise(() => undefined))
      .mockRejectedValue(new Error("Terminal server unavailable."));
    const endTerminal = vi.fn();
    const deleteTerminal = vi.fn();
    Object.assign(applicationStore, { api: { readTerminal, endTerminal, deleteTerminal } });
    const store = setup();
    act(() => store.openTerminalTab(TERMINAL_ID, { focus: true }));
    await waitFor(() => expect(readTerminal).toHaveBeenCalledOnce());
    fireEvent.click(await screen.findByRole("button", { name: "End Terminal terminal and remove history" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Terminal server unavailable.");
    expect(store.terminalTab(TERMINAL_ID)).toBeDefined();
    expect(endTerminal).not.toHaveBeenCalled();
    expect(deleteTerminal).not.toHaveBeenCalled();
  });

  it("shows an inactive terminal removal failure and preserves it when that tab is activated", async () => {
    const active = terminalResource();
    const inactive = { ...terminalResource(SECOND_TERMINAL_ID, "Old shell"), lifecycle: "exited" as const };
    Object.assign(applicationStore, { api: {
      readTerminal: vi.fn(async (id: string) => id === TERMINAL_ID ? active : inactive),
      createTerminalAdmission: vi.fn(), terminalWebSocketUrl: vi.fn(),
      deleteTerminal: vi.fn().mockRejectedValue(new Error("Old shell removal failed.")),
    } });
    const store = setup();
    act(() => {
      store.openTerminalTab(TERMINAL_ID, { focus: true });
      store.openTerminalTab(SECOND_TERMINAL_ID, { focus: false });
    });
    fireEvent.click(await screen.findByRole("button", { name: "Remove Old shell terminal and history" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Old shell removal failed.");
    expect(store.terminalTab(SECOND_TERMINAL_ID)).toBeDefined();
    fireEvent.click(screen.getByRole("tab", { name: /Old shell/ }));
    expect(screen.getByRole("alert")).toHaveTextContent("Old shell removal failed.");
  });

  it("marks each panel's dock edge in its panel menu", async () => {
    const store = setup();
    act(() => {
      store.openPanel("workspace-files");
      store.dockPanel("workspace-files", "left");
    });
    const dockEdges = async (panel: string) => {
      fireEvent.pointerDown(screen.getByRole("button", { name: `${panel} panel actions` }), { button: 0, ctrlKey: false });
      const dock = await screen.findByRole("group", { name: "Dock" });
      const checked = within(dock).getAllByRole("menuitemradio")
        .filter(item => item.getAttribute("aria-checked") === "true")
        .map(item => item.textContent);
      fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" });
      await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
      return checked;
    };
    expect(await dockEdges("Files")).toEqual(["Left"]);
    expect(await dockEdges("Chat")).toEqual(["Right"]);

    fireEvent.pointerDown(screen.getByRole("button", { name: "Files panel actions" }), { button: 0, ctrlKey: false });
    fireEvent.click(await screen.findByRole("menuitemradio", { name: "Bottom" }));
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
    expect(await dockEdges("Files")).toEqual(["Bottom"]);
    expect(await dockEdges("Chat")).toEqual(["Top"]);
  });

  it("gives the terminal panel menu's disabled rows a reason", async () => {
    Object.assign(applicationStore, { api: {
      readTerminal: vi.fn(() => new Promise<never>(() => undefined)),
      createTerminalAdmission: vi.fn(), terminalWebSocketUrl: vi.fn(),
    } });
    const store = setup();
    act(() => store.openTerminalTab(TERMINAL_ID, { focus: true }));
    fireEvent.pointerDown(screen.getByRole("button", { name: "Terminals panel actions" }), { button: 0, ctrlKey: false });
    await screen.findByRole("menu");
    for (const name of ["Transcript", "Clear selection"]) {
      const item = screen.getByRole("menuitem", { name: new RegExp(`^${name}`) });
      expect(item).toHaveAttribute("aria-disabled", "true");
      expect(within(item).getByText("No terminal")).toHaveAttribute("data-slot", "dropdown-menu-item-value");
    }
  });

  it("omits terminal destruction from the panel header menu", async () => {
    Object.assign(applicationStore, { api: {
      readTerminal: vi.fn().mockResolvedValue(terminalResource()),
      createTerminalAdmission: vi.fn(), terminalWebSocketUrl: vi.fn(),
    } });
    const store = setup();
    act(() => store.openTerminalTab(TERMINAL_ID, { focus: true }));
    await screen.findByRole("tab", { name: /Remote shell/ });
    fireEvent.pointerDown(screen.getByRole("button", { name: "Terminals panel actions" }), { button: 0, ctrlKey: false });
    await screen.findByRole("menu");
    expect(screen.queryByRole("menuitem", { name: /End terminal|Remove terminal/ })).toBeNull();
  });

  it("renames a terminal tab through the revision-checked terminal contract", async () => {
    const resource = terminalResource();
    const renamed = {
      ...resource,
      displayName: "Build shell",
      lifecycleRevision: resource.lifecycleRevision + 1,
    };
    const renameTerminal = vi.fn().mockResolvedValue({ terminal: renamed });
    Object.assign(applicationStore, {
      api: {
        readTerminal: vi.fn().mockResolvedValue(resource),
        createTerminalAdmission: vi.fn(),
        terminalWebSocketUrl: vi.fn(),
        renameTerminal,
      },
    });
    const store = setup();
    act(() => store.openTerminalTab(TERMINAL_ID, { focus: true }));
    const tab = await screen.findByRole("tab", { name: "Remote shell" });

    fireEvent.contextMenu(tab);
    fireEvent.click(await screen.findByRole("menuitem", { name: "Rename" }));
    const input = screen.getByRole("textbox", { name: "Rename Remote shell" });
    fireEvent.change(input, { target: { value: " Build shell " } });
    fireEvent.keyDown(input, { key: "Enter" });

    await waitFor(() => expect(renameTerminal).toHaveBeenCalledOnce());
    expect(renameTerminal).toHaveBeenCalledWith(
      resource.terminalId,
      expect.objectContaining({
        expectedRevision: resource.lifecycleRevision,
        displayName: "Build shell",
        mutationId: expect.any(String),
      }),
    );
    expect(
      await screen.findByRole("tab", { name: "Build shell" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent(
      "Build shell terminal renamed.",
    );
  });

  it("refreshes a conflicting terminal rename and leaves the draft retryable", async () => {
    const resource = terminalResource();
    const authoritative = {
      ...resource,
      displayName: "Remote logs",
      lifecycleRevision: resource.lifecycleRevision + 1,
    };
    const renameTerminal = vi
      .fn()
      .mockRejectedValueOnce(
        new ApiError(409, "conflict", "The terminal changed.", false),
      )
      .mockResolvedValueOnce({
        terminal: {
          ...authoritative,
          displayName: "Build shell",
          lifecycleRevision: authoritative.lifecycleRevision + 1,
        },
      });
    const readTerminal = vi
      .fn()
      .mockResolvedValueOnce(resource)
      .mockResolvedValueOnce(authoritative);
    Object.assign(applicationStore, {
      api: {
        readTerminal,
        createTerminalAdmission: vi.fn(),
        terminalWebSocketUrl: vi.fn(),
        renameTerminal,
      },
    });
    const store = setup();
    act(() => store.openTerminalTab(TERMINAL_ID, { focus: true }));
    fireEvent.contextMenu(
      await screen.findByRole("tab", { name: "Remote shell" }),
    );
    fireEvent.click(await screen.findByRole("menuitem", { name: "Rename" }));
    const input = screen.getByRole("textbox", { name: "Rename Remote shell" });
    fireEvent.change(input, { target: { value: "Build shell" } });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "The terminal changed elsewhere. Review its latest name and try again.",
    );
    expect(input).toHaveValue("Build shell");
    fireEvent.keyDown(input, { key: "Enter" });

    await waitFor(() => expect(renameTerminal).toHaveBeenCalledTimes(2));
    expect(renameTerminal.mock.calls[1]?.[1]).toEqual(
      expect.objectContaining({
        expectedRevision: authoritative.lifecycleRevision,
        displayName: "Build shell",
      }),
    );
    expect(renameTerminal.mock.calls[1]?.[1].mutationId).not.toBe(
      renameTerminal.mock.calls[0]?.[1].mutationId,
    );
  });

  it("reuses a rename mutation id when an ambiguous request is retried", async () => {
    const resource = terminalResource();
    const renameTerminal = vi
      .fn()
      .mockRejectedValueOnce(new Error("Network unavailable"))
      .mockResolvedValueOnce({
        terminal: {
          ...resource,
          displayName: "Build shell",
          lifecycleRevision: resource.lifecycleRevision + 1,
        },
      });
    Object.assign(applicationStore, {
      api: {
        readTerminal: vi.fn().mockResolvedValue(resource),
        createTerminalAdmission: vi.fn(),
        terminalWebSocketUrl: vi.fn(),
        renameTerminal,
      },
    });
    const store = setup();
    act(() => store.openTerminalTab(TERMINAL_ID, { focus: true }));
    fireEvent.contextMenu(
      await screen.findByRole("tab", { name: "Remote shell" }),
    );
    fireEvent.click(await screen.findByRole("menuitem", { name: "Rename" }));
    const input = screen.getByRole("textbox", { name: "Rename Remote shell" });
    fireEvent.change(input, { target: { value: "Build shell" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Network unavailable",
    );
    fireEvent.keyDown(input, { key: "Enter" });

    await waitFor(() => expect(renameTerminal).toHaveBeenCalledTimes(2));
    expect(renameTerminal.mock.calls[1]?.[1].mutationId).toBe(
      renameTerminal.mock.calls[0]?.[1].mutationId,
    );
  });

  it("checks terminals already displayed in the terminal tab add menu", async () => {
    const resource = terminalResource();
    const other = terminalResource(SECOND_TERMINAL_ID, "Other shell");
    Object.assign(applicationStore, {
      api: {
        listTerminals: vi.fn().mockResolvedValue({
          terminals: [resource, other],
        }),
        readTerminal: vi.fn().mockResolvedValue(resource),
        createTerminalAdmission: vi.fn(),
        terminalWebSocketUrl: vi.fn(),
      },
    });
    const store = setup();
    act(() => store.openTerminalTab(TERMINAL_ID, { focus: true }));
    await screen.findByRole("tab", { name: "Remote shell" });

    fireEvent.pointerDown(
      screen.getByRole("button", { name: "Open terminal tab" }),
      { button: 0, ctrlKey: false },
    );

    const displayed = await screen.findByRole("menuitem", {
      name: /Remote shell.*Running.*open/u,
    });
    expect(displayed.querySelector("svg.lucide-check")).not.toBeNull();
    expect(displayed).not.toHaveAttribute("aria-disabled");
    const otherRow = screen.getByRole("menuitem", { name: /Other shell.*Running/u });
    expect(otherRow.querySelector("svg.lucide-check")).toBeNull();
    expect(otherRow).not.toHaveAttribute("aria-disabled");
  });

  it("mounts an isolated terminal renderer when the active terminal tab changes", async () => {
    const first = terminalResource();
    const second = terminalResource(SECOND_TERMINAL_ID, "Other shell");
    const readTerminal = vi.fn((terminalId: string) =>
      Promise.resolve(terminalId === first.terminalId ? first : second),
    );
    Object.assign(applicationStore, {
      api: {
        readTerminal,
        createTerminalAdmission: vi.fn(),
        terminalWebSocketUrl: vi.fn(),
      },
    });
    const store = setup();

    act(() => store.openTerminalTab(first.terminalId, { focus: true }));
    const firstPanel = await screen.findByRole("region", {
      name: "Remote shell terminal",
    });
    const firstInstance = firstPanel.getAttribute(
      "data-terminal-panel-instance",
    );

    act(() => store.openTerminalTab(second.terminalId, { focus: true }));
    const secondPanel = await screen.findByRole("region", {
      name: "Other shell terminal",
    });

    expect(secondPanel).toHaveAttribute("data-terminal-panel-instance");
    expect(secondPanel.getAttribute("data-terminal-panel-instance")).not.toBe(
      firstInstance,
    );
    expect(
      screen.queryByRole("region", {
        name: "Remote shell terminal",
      }),
    ).toBeNull();
  });

  it.each(["exited", "failed", "interrupted"] as const)("removes %s terminal history directly from its tab", async (lifecycle) => {
    const resource = {
      ...terminalResource(),
      lifecycle,
      exitCode: 0,
    };
    const deleteTerminal = vi.fn().mockResolvedValue({ terminal: null });
    Object.assign(applicationStore, {
      api: {
        readTerminal: vi.fn().mockResolvedValue(resource),
        createTerminalAdmission: vi.fn(),
        terminalWebSocketUrl: vi.fn(),
        endTerminal: vi.fn(),
        deleteTerminal,
      },
    });
    const store = setup();
    act(() => store.openTerminalTab(TERMINAL_ID, { focus: true }));
    await screen.findByRole("tab", { name: /Remote shell/ });

    fireEvent.click(screen.getByRole("button", { name: "Remove Remote shell terminal and history" }));
    expect(screen.queryByRole("dialog")).toBeNull();

    await waitFor(() => expect(deleteTerminal).toHaveBeenCalledOnce());
    await waitFor(() => expect(store.terminalTab(TERMINAL_ID)).toBeUndefined());
    expect(screen.getByRole("status")).toHaveTextContent(
      "Remote shell removed. Its retained terminal history was removed.",
    );
  });

  it("keeps a terminal visible and reports cleanup failures in its panel", async () => {
    const resource = terminalResource();
    const endTerminal = vi
      .fn()
      .mockRejectedValue(new Error("Terminal cleanup could not be confirmed."));
    Object.assign(applicationStore, {
      api: {
        readTerminal: vi.fn().mockResolvedValue(resource),
        createTerminalAdmission: vi.fn(),
        terminalWebSocketUrl: vi.fn(),
        endTerminal,
        deleteTerminal: vi.fn(),
      },
    });
    const store = setup();
    act(() => store.openTerminalTab(TERMINAL_ID, { focus: true }));
    await screen.findByRole("tab", { name: /Remote shell/ });

    fireEvent.click(screen.getByRole("button", { name: "Close Remote shell terminal" }));
    const confirmation = await screen.findByRole("dialog", {
      name: "Close terminal?",
    });
    fireEvent.click(
      within(confirmation).getByRole("button", { name: "End terminal" }),
    );

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Terminal cleanup could not be confirmed.",
    );
    expect(store.terminalTab(TERMINAL_ID)).toBeDefined();
    expect(screen.getByRole("tab", { name: /Remote shell/ })).toBeVisible();
  });

  it("reconciles a same-count inactive replacement after reconnect becomes authoritative", async () => {
    applicationState = {
      ...applicationState,
      snapshot: {
        threads: [
          {
            id: "thread-1",
            terminalSummary: { runningCount: 2, retainedCount: 2 },
          },
        ],
      },
    };
    const authoritative = terminalResource(TERMINAL_ID, "Active shell");
    const removed = terminalResource(SECOND_TERMINAL_ID, "Inactive shell");
    const replacement = terminalResource(
      "44444444-4444-4444-8444-444444444444",
      "Replacement shell",
    );
    const listTerminals = vi.fn(async () => ({
      terminals: [authoritative, replacement],
    }));
    Object.assign(applicationStore, {
      api: {
        listTerminals,
        readTerminal: vi.fn(async (terminalId: string) =>
          terminalId === TERMINAL_ID ? authoritative : removed,
        ),
        createTerminalAdmission: vi.fn(),
        terminalWebSocketUrl: vi.fn(),
      },
    });
    const store = setup();
    act(() => {
      store.openTerminalTab(TERMINAL_ID, { focus: false });
      store.openTerminalTab(SECOND_TERMINAL_ID, { focus: false });
      store.activateTerminalTab(TERMINAL_ID);
    });

    const inactiveTab = await screen.findByRole("tab", {
      name: "Inactive shell",
    });
    expect(inactiveTab).toHaveAttribute("aria-selected", "false");
    expect(listTerminals).not.toHaveBeenCalled();

    act(() => {
      // Another client ended Inactive shell and created Replacement shell
      // while this client was disconnected. Counts did not change; the new
      // thread-summary object and authoritative transition are the signal.
      applicationState = {
        ...applicationState,
        connection: "connected",
        authoritative: true,
        snapshot: {
          threads: [
            {
              id: "thread-1",
              terminalSummary: { runningCount: 2, retainedCount: 2 },
            },
          ],
        },
      };
      for (const listener of applicationListeners) listener();
    });

    await waitFor(() => expect(listTerminals).toHaveBeenCalledOnce());
    await waitFor(() =>
      expect(store.terminalTab(SECOND_TERMINAL_ID)).toBeUndefined(),
    );
    expect(screen.queryByRole("tab", { name: "Inactive shell" })).toBeNull();
    expect(screen.getByRole("tab", { name: "Active shell" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
  });

  it("ignores a stale terminal inventory response without aborting its request", async () => {
    applicationState = {
      ...applicationState,
      connection: "connected",
      authoritative: true,
      snapshot: {
        threads: [
          {
            id: "thread-1",
            terminalSummary: { runningCount: 2, retainedCount: 2 },
          },
        ],
      },
    };
    const active = terminalResource(TERMINAL_ID, "Active shell");
    const inactive = terminalResource(SECOND_TERMINAL_ID, "Inactive shell");
    const pending: Array<
      (result: { terminals: readonly TerminalResource[] }) => void
    > = [];
    const listTerminals = vi.fn(
      () =>
        new Promise<{ terminals: readonly TerminalResource[] }>((resolve) =>
          pending.push(resolve),
        ),
    );
    Object.assign(applicationStore, {
      api: {
        listTerminals,
        readTerminal: vi.fn(async (terminalId: string) =>
          terminalId === TERMINAL_ID ? active : inactive,
        ),
        createTerminalAdmission: vi.fn(),
        terminalWebSocketUrl: vi.fn(),
      },
    });
    const store = setup();
    act(() => {
      store.openTerminalTab(TERMINAL_ID, { focus: false });
      store.openTerminalTab(SECOND_TERMINAL_ID, { focus: false });
      store.activateTerminalTab(TERMINAL_ID);
    });
    await screen.findByRole("tab", { name: "Inactive shell" });
    await waitFor(() => expect(listTerminals).toHaveBeenCalledTimes(1));

    act(() => {
      applicationState = {
        ...applicationState,
        snapshot: {
          threads: [
            {
              id: "thread-1",
              terminalSummary: { runningCount: 2, retainedCount: 2 },
            },
          ],
        },
      };
      for (const listener of applicationListeners) listener();
    });
    await waitFor(() => expect(listTerminals).toHaveBeenCalledTimes(2));

    act(() => {
      pending[1]?.({ terminals: [active, inactive] });
      pending[0]?.({ terminals: [active] });
    });
    await waitFor(() =>
      expect(
        screen.getByRole("tab", { name: "Inactive shell" }),
      ).toBeInTheDocument(),
    );
    expect(store.terminalTab(SECOND_TERMINAL_ID)).toBeDefined();
  });

  it("fails closed when restored storage points at another thread's terminal", async () => {
    const readTerminal = vi.fn().mockResolvedValue({
      terminalId: TERMINAL_ID,
      threadId: "thread-2",
    });
    Object.assign(applicationStore, { api: { readTerminal } });
    const store = setup();

    act(() => {
      store.openTerminalTab(TERMINAL_ID, { focus: false });
    });

    expect(
      await screen.findByRole("tablist", { name: "Terminal tabs" }),
    ).toContainElement(screen.getByRole("tab", { name: "Terminal" }));
    expect(
      await screen.findByText("This terminal is no longer available."),
    ).toBeInTheDocument();
    expect(
      screen.queryByLabelText("Terminal terminal", { exact: true }),
    ).toBeNull();
  });

  it("isolates pending terminal removal across thread switches and stale completions", async () => {
    setConfirmTerminalTermination(false);
    const first = terminalResource(TERMINAL_ID, "Thread A shell", "thread-a");
    const second = terminalResource(SECOND_TERMINAL_ID, "Thread B shell", "thread-b");
    const finish: Array<(value: { terminal: null }) => void> = [];
    const endTerminal = vi.fn(() => new Promise<{ terminal: null }>((resolve) => { finish.push(resolve); }));
    Object.assign(applicationStore, { api: {
      readTerminal: vi.fn(async (id: string) => id === TERMINAL_ID ? first : second),
      createTerminalAdmission: vi.fn(), terminalWebSocketUrl: vi.fn(), endTerminal,
    } });
    const registry = new WorkspacePanelTenantRegistry([filesTenant()]);
    const rootStore = new PanelLayoutStore(registry, {
      storage: { getItem: () => null, setItem: () => undefined },
      createId: (kind) => `${kind}-${crypto.randomUUID()}`,
    });
    const storeA = rootStore.forThread("thread-a");
    const storeB = rootStore.forThread("thread-b");
    storeA.openTerminalTab(TERMINAL_ID, { focus: false });
    // Simulates a stale/restored local layout carrying the same id into B.
    storeB.openTerminalTab(SECOND_TERMINAL_ID, { focus: false });
    const layout = (threadId: string, store: PanelLayoutStore) => (
      <NavigationControlsContext.Provider
        value={{
          openDrawer: vi.fn(),
          toggleDrawer: vi.fn(),
          toggleSidebar,
          sidebarCollapsed: false,
          drawerOpen: false,
          connection: "connected",
          triggerRef: createRef<HTMLButtonElement>(),
        }}
      >
        <PanelLayout
          store={store}
          tenants={registry}
          applicationStore={applicationStore}
          threadRegistry={threadRegistry}
          threadId={threadId}
          workspaceId="workspace-1"
          environmentId="environment-1"
          environmentIds={["environment-1"]}
          environmentTintEnabled={false}
          renderChat={(controls, visible) => (
            <Chat controls={controls} visible={visible} />
          )}
        />
      </NavigationControlsContext.Provider>
    );
    const view = render(layout("thread-a", storeA));
    fireEvent.click(await screen.findByRole("button", { name: "End Thread A shell terminal and remove history" }));
    await waitFor(() => expect(endTerminal).toHaveBeenCalledTimes(1));
    view.rerender(layout("thread-b", storeB));
    const closeB = await screen.findByRole("button", { name: "End Thread B shell terminal and remove history" });
    expect(closeB).toBeEnabled();
    fireEvent.click(closeB);
    await waitFor(() => expect(endTerminal).toHaveBeenCalledTimes(2));
    await act(async () => { finish[0]?.({ terminal: null }); });
    expect(closeB).toBeDisabled();
    expect(storeA.terminalTab(TERMINAL_ID)).toBeDefined();
    view.rerender(layout("thread-a", storeA));
    const closeA = await screen.findByRole("button", { name: "End Thread A shell terminal and remove history" });
    expect(closeA).toBeEnabled();
    await act(async () => { finish[1]?.({ terminal: null }); });
    expect(storeA.terminalTab(TERMINAL_ID)).toBeDefined();
    expect(storeB.terminalTab(SECOND_TERMINAL_ID)).toBeDefined();
  });

  it("never reuses a cached terminal resource across a thread change", async () => {
    const threadBResource = terminalResource(
      TERMINAL_ID,
      "Thread B shell",
      "thread-b",
    );
    let rejectThreadA: ((error: unknown) => void) | undefined;
    let resolveThreadB: ((terminal: TerminalResource) => void) | undefined;
    const readTerminal = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise<TerminalResource>((_resolve, reject) => {
            rejectThreadA = reject;
          }),
      )
      .mockImplementationOnce(
        () =>
          new Promise<TerminalResource>((resolve) => {
            resolveThreadB = resolve;
          }),
      );
    Object.assign(applicationStore, {
      api: {
        readTerminal,
        listTerminals: vi.fn(),
        createTerminalAdmission: vi.fn(),
        terminalWebSocketUrl: vi.fn(),
      },
    });
    const registry = new WorkspacePanelTenantRegistry([filesTenant()]);
    const rootStore = new PanelLayoutStore(registry, {
      storage: { getItem: () => null, setItem: () => undefined },
      createId: (kind) => `${kind}-${crypto.randomUUID()}`,
    });
    const storeA = rootStore.forThread("thread-a");
    const storeB = rootStore.forThread("thread-b");
    storeA.openTerminalTab(TERMINAL_ID, { focus: false });
    // Simulates a stale/restored local layout carrying the same id into B.
    storeB.openTerminalTab(TERMINAL_ID, { focus: false });
    const layout = (threadId: string, store: PanelLayoutStore) => (
      <NavigationControlsContext.Provider
        value={{
          openDrawer: vi.fn(),
          toggleDrawer: vi.fn(),
          toggleSidebar,
          sidebarCollapsed: false,
          drawerOpen: false,
          connection: "connected",
          triggerRef: createRef<HTMLButtonElement>(),
        }}
      >
        <PanelLayout
          store={store}
          tenants={registry}
          applicationStore={applicationStore}
          threadRegistry={threadRegistry}
          threadId={threadId}
          workspaceId="workspace-1"
          environmentId="environment-1"
          environmentIds={["environment-1"]}
          environmentTintEnabled={false}
          renderChat={(controls, visible) => (
            <Chat controls={controls} visible={visible} />
          )}
        />
      </NavigationControlsContext.Provider>
    );
    const view = render(layout("thread-a", storeA));
    await waitFor(() => expect(readTerminal).toHaveBeenCalledOnce());
    expect(screen.getByText("Loading terminal…")).toBeInTheDocument();

    view.rerender(layout("thread-b", storeB));
    await waitFor(() => expect(readTerminal).toHaveBeenCalledTimes(2));
    await act(async () => {
      resolveThreadB?.(threadBResource);
      await Promise.resolve();
    });
    expect(
      await screen.findByRole("tab", { name: "Thread B shell" }),
    ).toBeInTheDocument();

    await act(async () => {
      rejectThreadA?.(
        new ApiError(404, "terminal_not_found", "Terminal not found.", false),
      );
      await Promise.resolve();
    });

    expect(screen.getByRole("tab", { name: "Thread B shell" })).toBeVisible();
    expect(
      screen.queryByText("This terminal is no longer available."),
    ).toBeNull();
    expect(screen.queryByRole("tab", { name: "Thread A shell" })).toBeNull();
    expect(readTerminal).toHaveBeenCalledTimes(2);
  });

  it("keeps Chat and Files mounted with their state while collapsed", async () => {
    const mountedChat = vi.fn();
    const unmountedChat = vi.fn();
    const mountedFiles = vi.fn();
    const unmountedFiles = vi.fn();
    setup({ mountedChat, unmountedChat, mountedFiles, unmountedFiles });

    fireEvent.change(screen.getByRole("textbox", { name: "Chat draft" }), {
      target: { value: "draft message" },
    });
    await openPanelsMenu();
    fireEvent.click(screen.getByRole("menuitem", { name: /^Files(?: —|$)/ }));
    const fileDraft = await screen.findByRole("textbox", {
      name: "File draft",
    });
    fireEvent.change(fileDraft, { target: { value: "edited file" } });

    fireEvent.click(
      screen.getByRole("button", { name: "Collapse Files panel" }),
    );
    expect(screen.queryByRole("dialog", { name: /Discard/ })).toBeNull();
    expect(mountedFiles).toHaveBeenCalledTimes(1);
    expect(unmountedFiles).not.toHaveBeenCalled();
    expect(screen.getByTestId("files-visible")).toHaveTextContent("false");

    await openPanelsMenu();
    const collapsedFiles = screen.getByRole("menuitem", {
      name: /Files —.*Unsaved changes.*Collapsed/u,
    });
    expect(collapsedFiles).toContainElement(
      screen.getByLabelText("Unsaved changes"),
    );
    fireEvent.click(screen.getByText(/Files —/));
    await waitFor(() => expect(fileDraft).toBeVisible());
    expect(fileDraft).toHaveValue("edited file");
    expect(screen.getByRole("textbox", { name: "Chat draft" })).toHaveValue(
      "draft message",
    );
    expect(mountedChat).toHaveBeenCalledTimes(1);
    expect(unmountedChat).not.toHaveBeenCalled();
  });

  it("shows an intentional empty workbench and restores either collapsed singleton", async () => {
    setup();
    await openPanelsMenu();
    fireEvent.click(screen.getByRole("menuitem", { name: /^Files(?: —|$)/ }));
    fireEvent.click(
      screen.getByRole("button", { name: "Collapse Chat panel" }),
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Collapse Files panel" }),
    );

    expect(screen.getByTestId("workspace-panel-empty")).toHaveTextContent(
      "All panels are collapsed",
    );
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Panels" })).toHaveFocus(),
    );

    await openPanelsMenu();
    fireEvent.click(screen.getByText(/Chat —/));
    await waitFor(() =>
      expect(screen.getByRole("textbox", { name: "Chat draft" })).toBeVisible(),
    );
    await waitFor(() =>
      expect(screen.getByRole("textbox", { name: "Chat draft" })).toHaveFocus(),
    );
  });

  it("restores all collapsed panels with named focus and an announcement", async () => {
    setup();
    await openPanelsMenu();
    fireEvent.click(screen.getByRole("menuitem", { name: /^Files(?: —|$)/ }));
    fireEvent.click(
      screen.getByRole("button", { name: "Collapse Chat panel" }),
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Collapse Files panel" }),
    );

    await openPanelsMenu();
    fireEvent.click(screen.getByRole("menuitem", { name: "Show all" }));

    await waitFor(() =>
      expect(screen.getByRole("textbox", { name: "Chat draft" })).toHaveFocus(),
    );
    expect(screen.getByRole("status")).toHaveTextContent(
      "All panels restored.",
    );
    // The trigger outlives the collapse; nothing in it may still read as
    // collapsed, and "Show all" has nothing left to do.
    await openPanelsMenu();
    expect(screen.queryByRole("menuitem", { name: /Collapsed$/ })).toBeNull();
    expect(screen.queryByRole("menuitem", { name: "Show all" })).toBeNull();
  });

  it("bypasses dirty confirmation for collapse but guards true close", async () => {
    const store = setup();
    await openPanelsMenu();
    fireEvent.click(screen.getByRole("menuitem", { name: /^Files(?: —|$)/ }));
    fireEvent.change(
      await screen.findByRole("textbox", { name: "File draft" }),
      {
        target: { value: "unsaved" },
      },
    );
    await waitFor(() =>
      expect(store.hasDirtyWorkspacePanels("workspace-1")).toBe(true),
    );

    fireEvent.click(
      screen.getByRole("button", { name: "Collapse Files panel" }),
    );
    expect(screen.queryByText("Discard unsaved changes?")).toBeNull();
    expect(store.hasDirtyWorkspacePanels("workspace-1")).toBe(true);
    act(() => store.restorePanel("workspace-files"));
    fireEvent.click(screen.getByRole("button", { name: "Close Files panel" }));
    expect(
      await screen.findByText("Discard unsaved changes?"),
    ).toBeInTheDocument();
    expect(store.hasPanel("workspace-files")).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Discard and close" }));
    expect(store.hasPanel("workspace-files")).toBe(false);
    expect(screen.getByRole("status")).toHaveTextContent("Files panel closed.");
    expect(screen.getByRole("status")).not.toHaveTextContent(
      "process was not terminated",
    );
    await waitFor(() =>
      expect(store.hasDirtyWorkspacePanels("workspace-1")).toBe(false),
    );
  });

  it("focuses an already-visible panel from the menu without restoring it", async () => {
    setup();
    await openPanelsMenu();
    fireEvent.click(screen.getByRole("menuitem", { name: /^Files(?: —|$)/ }));
    await screen.findByRole("textbox", { name: "File draft" });

    await openPanelsMenu();
    fireEvent.click(screen.getByText(/Files —/));
    await waitFor(() =>
      expect(screen.getByRole("textbox", { name: "File draft" })).toHaveFocus(),
    );
    // Nothing was collapsed, so nothing may claim to have been restored.
    expect(screen.getByRole("status")).toHaveTextContent("");
    expect(screen.getByTestId("files-visible")).toHaveTextContent("true");
  });

  it("defers a retained Chat focus request until replay enables its composer", async () => {
    const store = setup({ chatDisabledUntilAuthoritative: true });
    fireEvent.click(
      screen.getByRole("button", { name: "Collapse Chat panel" }),
    );

    act(() => store.restorePanel("chat"));
    const composer = screen.getByRole("textbox", { name: "Chat draft" });
    expect(composer).toBeDisabled();
    expect(composer).not.toHaveFocus();
    expect(store.getSnapshot().focusRequest?.panelInstanceId).toBe("chat");

    act(() =>
      publishThreadState({
        ...initialThreadState,
        connection: "connected",
        authoritative: true,
      }),
    );

    await waitFor(() => expect(composer).toHaveFocus());
    expect(store.getSnapshot().focusRequest).toBeUndefined();
  });

  it("defers desktop Chat focus until a cold thread mounts its composer", async () => {
    const store = setup({ chatUnmountedUntilReady: true });

    act(() => {
      store.openPanel("chat", { focus: true });
    });
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(screen.queryByRole("textbox", { name: "Chat draft" })).toBeNull();
    expect(store.getSnapshot().focusRequest?.panelInstanceId).toBe("chat");

    act(() =>
      publishThreadState({
        ...initialThreadState,
        status: "ready",
        connection: "connected",
        authoritative: true,
      }),
    );

    const composer = await screen.findByRole("textbox", { name: "Chat draft" });
    await waitFor(() => expect(composer).toHaveFocus());
    expect(store.getSnapshot().focusRequest).toBeUndefined();
  });

  it.each(["phone", "touch tablet"])("does not carry cold-thread composer focus onto a %s", async (device) => {
    mobile = device === "phone";
    coarsePointer = true;
    const store = setup({ chatUnmountedUntilReady: true });

    act(() => {
      store.openPanel("chat", { focus: true });
    });
    await waitFor(() =>
      expect(store.getSnapshot().focusRequest).toBeUndefined(),
    );

    act(() =>
      publishThreadState({
        ...initialThreadState,
        status: "ready",
        connection: "connected",
        authoritative: true,
      }),
    );

    const composer = await screen.findByRole("textbox", { name: "Chat draft" });
    expect(composer).not.toHaveFocus();
  });

  it.each(["touch", "pen"])("focuses the chat panel instead of its composer after %s selection on a hybrid desktop", async (pointerType) => {
    const store = setup({ chatUnmountedUntilReady: true });
    const pointer = new Event("pointerdown", { bubbles: true });
    Object.defineProperty(pointer, "pointerType", { value: pointerType });
    fireEvent(document.body, pointer);
    act(() => store.openPanel("chat", { focus: true }));
    await waitFor(() => expect(store.getSnapshot().focusRequest).toBeUndefined());
    act(() => publishThreadState({
      ...initialThreadState,
      status: "ready",
      connection: "connected",
      authoritative: true,
    }));
    const composer = await screen.findByRole("textbox", { name: "Chat draft" });
    expect(composer).not.toHaveFocus();
    expect(screen.getByRole("region", { name: "Chat panel content" })).toHaveFocus();

    fireEvent.keyDown(document.body, { key: "Enter" });
    act(() => store.openPanel("chat", { focus: true }));
    await waitFor(() => expect(composer).toHaveFocus());
  });

  it("keeps route-scoped Chat focus pending until the destination composer mounts", async () => {
    const registry = new WorkspacePanelTenantRegistry([]);
    const store = new PanelLayoutStore(registry, {
      storage: { getItem: () => null, setItem: () => undefined },
      createId: (kind) => `${kind}-focus-route`,
    });
    const view = (threadId: string) => (
      <NavigationControlsContext.Provider
        value={{
          openDrawer: vi.fn(),
          toggleDrawer: vi.fn(),
          toggleSidebar,
          sidebarCollapsed: false,
          drawerOpen: false,
          connection: "connected",
          triggerRef: createRef<HTMLButtonElement>(),
        }}
      >
        <PanelLayout
          store={store}
          tenants={registry}
          applicationStore={applicationStore}
          threadRegistry={threadRegistry}
          threadId={threadId}
          environmentIds={[]}
          environmentTintEnabled={false}
          renderChat={(controls, visible) => (
            <Chat key={threadId} controls={controls} visible={visible} />
          )}
        />
      </NavigationControlsContext.Provider>
    );
    const rendered = render(view("thread-a"));
    fireEvent.click(
      screen.getByRole("button", { name: "Collapse Chat panel" }),
    );

    act(() => {
      store.openPanel("chat", {
        focus: true,
        focusScope: { kind: "thread", threadId: "thread-b" },
      });
    });
    const oldComposer = screen.getByRole("textbox", { name: "Chat draft" });
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(oldComposer).not.toHaveFocus();
    expect(store.getSnapshot().focusRequest?.scope).toEqual({
      kind: "thread",
      threadId: "thread-b",
    });

    rendered.rerender(view("thread-b"));
    const destinationComposer = screen.getByRole("textbox", {
      name: "Chat draft",
    });
    expect(destinationComposer).not.toBe(oldComposer);
    await waitFor(() => expect(destinationComposer).toHaveFocus());
    expect(store.getSnapshot().focusRequest).toBeUndefined();
  });

  it("abandons deferred Chat focus when the user interacts with another panel", async () => {
    const store = setup({ chatDisabledUntilAuthoritative: true });
    await openPanelsMenu();
    fireEvent.click(screen.getByRole("menuitem", { name: /^Files(?: —|$)/ }));
    const fileDraft = await screen.findByRole("textbox", {
      name: "File draft",
    });
    fireEvent.click(
      screen.getByRole("button", { name: "Collapse Chat panel" }),
    );

    act(() => store.restorePanel("chat"));
    const composer = screen.getByRole("textbox", { name: "Chat draft" });
    expect(composer).toBeDisabled();
    expect(store.getSnapshot().focusRequest?.panelInstanceId).toBe("chat");

    fireEvent.pointerDown(fileDraft);
    fileDraft.focus();
    expect(store.getSnapshot().focusRequest).toBeUndefined();

    act(() =>
      publishThreadState({
        ...initialThreadState,
        connection: "connected",
        authoritative: true,
      }),
    );

    await waitFor(() => expect(fileDraft).toHaveFocus());
    expect(composer).not.toHaveFocus();
  });

  it("renders a split with no top-level tab semantics", async () => {
    setup();
    await openPanelsMenu();
    fireEvent.click(screen.getByRole("menuitem", { name: /^Files(?: —|$)/ }));
    expect(
      await screen.findByRole("separator", {
        name: "Resize Chat and Files panels",
      }),
    ).toBeInTheDocument();
    expect(screen.queryByRole("tablist")).toBeNull();
    expect(screen.queryByTestId("workspace-panel-tab")).toBeNull();
  });

  it("gives a singleton tabpanel an accessible name without inventing a tablist", () => {
    setup();

    expect(
      screen.getByRole("tabpanel", { name: "Chat panel content" }),
    ).toBeInTheDocument();
    expect(screen.queryByRole("tablist")).toBeNull();
    expect(screen.queryByRole("tab")).toBeNull();
  });

  it("links stable tab and tabpanel ids and supports automatic keyboard navigation", () => {
    const store = setup();
    act(() => {
      store.openPanel("workspace-files", {
        mode: "tab",
        targetNodeId: "main-panel-stack",
        focus: false,
      });
    });

    const chatTab = screen.getByRole("tab", { name: "Chat" });
    const filesTab = screen.getByRole("tab", { name: "Files" });
    const tabPanel = screen.getByRole("tabpanel", { name: "Files" });
    const chatTabId = chatTab.id;
    const filesTabId = filesTab.id;
    const tabPanelId = tabPanel.id;

    expect(chatTabId).not.toBe("");
    expect(filesTabId).not.toBe("");
    expect(tabPanelId).not.toBe("");
    expect(chatTab).toHaveAttribute("aria-controls", tabPanelId);
    expect(filesTab).toHaveAttribute("aria-controls", tabPanelId);
    expect(tabPanel).toHaveAttribute("aria-labelledby", filesTabId);
    expect(filesTab).toHaveAttribute("aria-selected", "true");
    expect(filesTab).toHaveAttribute("tabindex", "0");
    expect(chatTab).toHaveAttribute("tabindex", "-1");

    filesTab.focus();
    fireEvent.keyDown(filesTab, { key: "ArrowRight" });
    expect(chatTab).toHaveFocus();
    expect(chatTab).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("tabpanel", { name: "Chat" })).toHaveAttribute(
      "aria-labelledby",
      chatTabId,
    );

    fireEvent.keyDown(chatTab, { key: "End" });
    expect(filesTab).toHaveFocus();
    fireEvent.keyDown(filesTab, { key: "Home" });
    expect(chatTab).toHaveFocus();
    fireEvent.keyDown(chatTab, { key: "ArrowLeft" });
    expect(filesTab).toHaveFocus();

    expect(chatTab.id).toBe(chatTabId);
    expect(filesTab.id).toBe(filesTabId);
    expect(screen.getByRole("tabpanel").id).toBe(tabPanelId);
  });

  it("colors the Files header with its workspace environment", async () => {
    setup();
    await openPanelsMenu();
    fireEvent.click(screen.getByRole("menuitem", { name: /^Files(?: —|$)/ }));

    const header = await screen.findByRole("banner", {
      name: "Files panel header",
    });
    expect(header).toHaveAttribute("data-environment-tint", "true");
    expect(header.style.getPropertyValue("--environment-hue")).not.toBe("");
    expect(header.style.getPropertyValue("--environment-chroma")).not.toBe("");
  });

  it("uses a full-stage Files panel on narrow screens without remounting it", async () => {
    mobile = true;
    const mountedFiles = vi.fn();
    const unmountedFiles = vi.fn();
    const store = setup({ mountedFiles, unmountedFiles });
    await openPanelsMenu();
    fireEvent.click(screen.getByRole("menuitem", { name: /^Files(?: —|$)/ }));
    const fileDraft = await screen.findByRole("textbox", {
      name: "File draft",
    });
    expect(fileDraft).toBeVisible();
    fireEvent.change(fileDraft, {
      target: { value: "mobile draft" },
    });

    // The full-stage panel leaves the persistent workbench bar reachable.
    expect(screen.getByTestId("workspace-workbench-bar")).toContainElement(
      screen.getByRole("button", { name: "Panels" }),
    );

    fireEvent.click(
      screen.getByRole("button", { name: "Collapse Files panel" }),
    );
    await waitFor(() =>
      expect(store.isCollapsed("workspace-files")).toBe(true),
    );
    expect(mountedFiles).toHaveBeenCalledTimes(1);
    expect(unmountedFiles).not.toHaveBeenCalled();
    act(() => store.restorePanel("workspace-files"));
    expect(
      await screen.findByRole("textbox", { name: "File draft" }),
    ).toHaveValue("mobile draft");
  });

  it("keeps the focused Files surface foregrounded when narrowing", async () => {
    setup();
    await openPanelsMenu();
    fireEvent.click(screen.getByRole("menuitem", { name: /^Files(?: —|$)/ }));
    const fileDraft = await screen.findByRole("textbox", {
      name: "File draft",
    });
    fireEvent.pointerDown(fileDraft);
    fileDraft.focus();
    fileDraft.blur();

    mobile = true;
    act(() => {
      for (const listener of mediaListeners) {
        listener({ matches: mobile } as MediaQueryListEvent);
      }
    });

    expect(screen.getByRole("region", { name: "Files panel" })).toBeVisible();
    expect(fileDraft).toBeVisible();
  });

  it("switches the narrow foreground from the open-panels menu without remounting Files", async () => {
    mobile = true;
    const mountedFiles = vi.fn();
    const unmountedFiles = vi.fn();
    const store = setup({ mountedFiles, unmountedFiles });
    await openPanelsMenu();
    fireEvent.click(screen.getByRole("menuitem", { name: /^Files(?: —|$)/ }));
    const fileDraft = await screen.findByRole("textbox", {
      name: "File draft",
    });
    fireEvent.change(fileDraft, { target: { value: "retained mobile draft" } });
    expect(fileDraft).toBeVisible();

    await openPanelsMenu();
    fireEvent.click(screen.getByRole("menuitem", { name: /^Chat —/ }));
    await waitFor(() =>
      expect(screen.getByTestId("files-visible")).toHaveTextContent("false"),
    );
    expect(screen.getByRole("textbox", { name: "Chat draft" })).toBeVisible();
    expect(store.isCollapsed("workspace-files")).toBe(false);
    expect(mountedFiles).toHaveBeenCalledTimes(1);
    expect(unmountedFiles).not.toHaveBeenCalled();

    await openPanelsMenu();
    fireEvent.click(screen.getByRole("menuitem", { name: /^Files —/ }));
    await waitFor(() =>
      expect(screen.getByTestId("files-visible")).toHaveTextContent("true"),
    );
    expect(fileDraft).toHaveValue("retained mobile draft");
    expect(mountedFiles).toHaveBeenCalledTimes(1);
    expect(unmountedFiles).not.toHaveBeenCalled();

    act(() => store.collapsePanel("chat"));
    expect(fileDraft).toBeVisible();
    await openPanelsMenu();
    fireEvent.click(
      screen.getByRole("menuitem", { name: /^Chat —.*Collapsed$/ }),
    );
    await waitFor(() =>
      expect(screen.getByRole("textbox", { name: "Chat draft" })).toBeVisible(),
    );
    expect(store.isCollapsed("chat")).toBe(false);
    expect(store.isCollapsed("workspace-files")).toBe(false);
    expect(mountedFiles).toHaveBeenCalledTimes(1);
    expect(unmountedFiles).not.toHaveBeenCalled();
  });

  it("offers only individual surface restoration on narrow layouts", async () => {
    mobile = true;
    setup();
    await openPanelsMenu();
    fireEvent.click(screen.getByRole("menuitem", { name: /^Files(?: —|$)/ }));
    fireEvent.click(
      screen.getByRole("button", { name: "Collapse Files panel" }),
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Collapse Chat panel" }),
    );

    await openPanelsMenu();
    expect(screen.queryByRole("menuitem", { name: "Show all" })).toBeNull();
    expect(screen.getAllByRole("menuitem")).toHaveLength(4);
  });

  it("keeps docked Tasks on stage across Chat collapse and close", async () => {
    const store = setup({ extraTenants: [tasksTenant] });
    const tasks = within(screen.getByTestId("workspace-workbench-bar")).getByTestId("tasks-panel-toggle");
    fireEvent.click(tasks);
    expect(tasks).toHaveAttribute("aria-expanded", "true");
    fireEvent.click(
      screen.getByRole("button", { name: "Collapse Chat panel" }),
    );
    await openPanelsMenu();
    fireEvent.click(screen.getByText(/Chat —/));
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Close Chat panel" }),
      ).toBeVisible(),
    );
    fireEvent.click(screen.getByRole("button", { name: "Close Chat panel" }));
    // Tasks is a panel of its own: closing Chat leaves it alone on stage.
    expect(screen.queryByTestId("workspace-panel-empty")).toBeNull();
    expect(store.panels().map((panel) => panel.kind)).toEqual(["tasks"]);
    expect(store.isVisible("tasks")).toBe(true);
    expect(
      screen.getByRole("region", { name: "Tasks panel" }),
    ).toHaveAttribute("data-panel-id", "tasks");
    expect(tasks).toBeVisible();
    expect(tasks).toHaveAttribute("aria-expanded", "true");
  });

  it("retains Files across threads in one workspace and remounts it across workspaces", async () => {
    const mountedFiles = vi.fn();
    const unmountedFiles = vi.fn();
    const retain = vi.fn(() => fakeThreadStore);
    const release = vi.fn();
    const scopedThreadRegistry = {
      get: () => fakeThreadStore,
      retainCached: retain,
      releaseCached: release,
    } as unknown as ThreadStoreRegistry;
    const registry = new WorkspacePanelTenantRegistry([
      filesTenant({ mounted: mountedFiles, unmounted: unmountedFiles }),
    ]);
    const store = new PanelLayoutStore(registry, {
      storage: { getItem: () => null, setItem: () => undefined },
      createId: (kind) => `${kind}-1`,
    });
    const layout = (threadId: string, workspaceId: string) => (
      <PanelLayout
        store={store}
        tenants={registry}
        applicationStore={applicationStore}
        threadRegistry={scopedThreadRegistry}
        threadId={threadId}
        workspaceId={workspaceId}
        environmentId="environment-1"
        environmentIds={["environment-1", "environment-2"]}
        environmentTintEnabled
        renderChat={(controls, visible) => (
          <Chat controls={controls} visible={visible} />
        )}
      />
    );
    const view = render(layout("thread-a", "workspace-a"));
    await openPanelsMenu();
    fireEvent.click(screen.getByRole("menuitem", { name: /^Files(?: —|$)/ }));
    await screen.findByRole("textbox", { name: "File draft" });
    expect(mountedFiles).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId("files-thread")).toHaveTextContent("thread-a");
    fireEvent.click(screen.getByRole("button", { name: "Close Chat panel" }));
    expect(retain).toHaveBeenCalledWith("thread-a");

    view.rerender(layout("thread-b", "workspace-a"));
    expect(mountedFiles).toHaveBeenCalledTimes(1);
    expect(unmountedFiles).not.toHaveBeenCalled();
    expect(screen.getByTestId("files-thread")).toHaveTextContent("thread-b");
    expect(release).toHaveBeenCalledWith("thread-a");
    expect(retain).toHaveBeenCalledWith("thread-b");

    view.rerender(layout("thread-c", "workspace-b"));
    await waitFor(() => expect(mountedFiles).toHaveBeenCalledTimes(2));
    expect(unmountedFiles).toHaveBeenCalledTimes(1);
  });

  it("retains a cold-open Files intent until the panel workspace is known", async () => {
    const registry = new WorkspacePanelTenantRegistry([filesTenant()]);
    const store = new PanelLayoutStore(registry, {
      storage: { getItem: () => null, setItem: () => undefined },
      createId: (kind) => `${kind}-1`,
    });
    const intent = {
      kind: "open-workspace-file",
      workspaceId: "workspace-1",
      rootId: "primary",
      path: "src/index.ts",
      rootVisibility: "listed",
      target: { kind: "file" },
      sequence: 41,
    };
    store.openPanel("workspace-files", { intent, focus: false });
    const layout = (workspaceId?: string) => (
      <PanelLayout
        store={store}
        tenants={registry}
        applicationStore={applicationStore}
        threadRegistry={threadRegistry}
        threadId="thread-1"
        workspaceId={workspaceId}
        environmentId="environment-1"
        environmentIds={["environment-1"]}
        environmentTintEnabled={false}
        renderChat={(controls, visible) => (
          <Chat controls={controls} visible={visible} />
        )}
      />
    );
    const view = render(layout());

    await act(async () => Promise.resolve());
    expect(store.intent("workspace-files")).toEqual(intent);

    view.rerender(layout("workspace-1"));
    await waitFor(() =>
      expect(store.intent("workspace-files")).toEqual(intent),
    );

    view.rerender(layout("workspace-2"));
    await waitFor(() =>
      expect(store.intent("workspace-files")).toBeUndefined(),
    );
  });
});

describe("PanelLayout mobile terminal dismissal", () => {
  it("does not close its terminal when a Settings traversal publishes before foreground cleanup", async () => {
    mobile = true;
    const store = setup();
    act(() => store.openTerminalTab(TERMINAL_ID, { focus: true }));
    await screen.findByRole("dialog", { name: "Terminals panel" });
    act(() => {
      pushHistoryEntry(null, "/settings/general");
      window.dispatchEvent(new PopStateEvent("popstate", { state: window.history.state }));
    });
    expect(store.terminalTab(TERMINAL_ID)).toBeDefined();
    act(() => store.setActive(false));
  });

  it("does not consume Settings Back while inactive or duplicate its terminal history entry on return", async () => {
    mobile = true;
    const store = setup();
    act(() => store.openTerminalTab(TERMINAL_ID, { focus: true }));
    await screen.findByRole("dialog", { name: "Terminals panel" });
    const terminalEntry = window.history.state;
    const entryCount = window.history.length;
    act(() => store.setActive(false));
    act(() => window.dispatchEvent(new PopStateEvent("popstate", { state: terminalEntry })));
    expect(store.terminalTab(TERMINAL_ID)).toBeDefined();
    act(() => store.setActive(true));
    expect(window.history.length).toBe(entryCount);
    expect(window.history.state).toEqual(terminalEntry);
    expect(store.terminalTab(TERMINAL_ID)).toBeDefined();
  });

  it("uses Escape to close only the local terminal panel", async () => {
    mobile = true;
    const store = setup();
    act(() => {
      store.openTerminalTab(TERMINAL_ID, { focus: true });
    });

    const terminalPanel = await screen.findByRole("dialog", {
      name: "Terminals panel",
    });
    const terminalTabs = screen.getByRole("tablist", {
      name: "Terminal tabs",
    });
    const terminalTab = screen.getByRole("tab", { name: "Terminal" });
    expect(terminalPanel).toContainElement(terminalTabs);
    expect(terminalTabs).toContainElement(terminalTab);
    expect(terminalTab).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("tabpanel", { name: "Terminal" })).toHaveAttribute(
      "aria-labelledby",
      terminalTab.id,
    );
    expect(terminalPanel).toHaveAttribute("data-mobile-terminal-panel", "true");
    expect(terminalPanel).toHaveAccessibleDescription(
      "Closing this panel detaches this client. It does not terminate the terminal process.",
    );

    fireEvent.keyDown(terminalPanel, { key: "Escape" });

    await waitFor(() => expect(store.terminalPanel()).toBeUndefined());
    expect(store.terminalTab(TERMINAL_ID)).toBeUndefined();
    expect(screen.getByRole("status")).toHaveTextContent(
      "Terminals panel closed. Its process was not terminated.",
    );
  });

  it("consumes browser Back before leaving the thread and detaches the viewer", async () => {
    mobile = true;
    const store = setup();
    act(() => {
      store.openTerminalTab(TERMINAL_ID, { focus: true });
    });
    const terminalPanel = await screen.findByRole("dialog", {
      name: "Terminals panel",
    });
    expect(terminalPanel).toContainElement(
      screen.getByRole("tablist", { name: "Terminal tabs" }),
    );
    expect(screen.getByRole("tab", { name: "Terminal" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    expect(window.location.pathname).toBe("/threads/thread-1");

    act(() => window.history.back());

    await waitFor(() => expect(store.terminalPanel()).toBeUndefined());
    expect(store.terminalTab(TERMINAL_ID)).toBeUndefined();
    expect(window.location.pathname).toBe("/threads/thread-1");
  });
});

function fakeTasksHost(overrides: Partial<TasksHost> = {}): TasksHost & {
  readonly docks: (TasksDock | undefined)[];
} {
  const docks: (TasksDock | undefined)[] = [];
  return {
    bodyTarget: document.createElement("div"),
    placement: undefined,
    sheetOpen: false,
    toggleSheet: vi.fn(),
    publishDock: (dock) => docks.push(dock),
    docks,
    ...overrides,
  };
}

describe("PanelLayout Tasks tenant", () => {
  const tasksToggle = () =>
    within(screen.getByTestId("workspace-workbench-bar")).getByTestId(
      "tasks-panel-toggle",
    );

  it("docks Tasks right of Chat from the toggle and closes it again", () => {
    const store = setup({ extraTenants: [tasksTenant] });
    expect(tasksToggle()).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(tasksToggle());
    const tree = store.getSnapshot().tree as SplitNode;
    expect(store.panels().map((panel) => panel.kind)).toEqual(["chat", "tasks"]);
    expect(panelDockEdge(tree, "tasks")).toBe("right");
    // The tenant renders its own header: the layout adds no PanelChrome.
    const leaf = screen.getByRole("region", { name: "Tasks panel" });
    expect(leaf.querySelector(".workspace-panel-chrome")).toBeNull();
    expect(
      screen.queryByRole("button", { name: "Collapse Tasks panel" }),
    ).toBeNull();
    expect(tasksToggle()).toHaveAttribute("aria-expanded", "true");
    expect(tasksToggle()).toHaveAccessibleName("Close Tasks panel");

    fireEvent.click(tasksToggle());
    expect(store.hasPanel("tasks")).toBe(false);
    expect(tasksToggle()).toHaveAttribute("aria-expanded", "false");
  });

  it("reveals a collapsed or solo-hidden Tasks panel instead of closing it", () => {
    const store = setup({ extraTenants: [tasksTenant] });
    act(() => {
      store.openPanel("tasks", { focus: false });
      store.collapsePanel("tasks");
    });
    expect(tasksToggle()).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(tasksToggle());
    expect(store.isCollapsed("tasks")).toBe(false);
    expect(store.isVisible("tasks")).toBe(true);

    // Under the single-panel presentation Tasks still docks beside Chat.
    act(() => {
      store.activatePanel("chat", { presentation: "single" });
    });
    expect(store.isVisible("tasks")).toBe(false);
    fireEvent.click(tasksToggle());
    expect(store.getSnapshot().soloPanelInstanceId).toBeUndefined();
    expect(store.isVisible("tasks")).toBe(true);
    expect(store.isVisible("chat")).toBe(true);
  });

  it("keeps Tasks out of the Panels menu and the panel shortcuts", async () => {
    const store = setup({ extraTenants: [tasksTenant] });
    await openPanelsMenu();
    expect(screen.queryByRole("menuitem", { name: /^Tasks/ })).toBeNull();
    fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" });
    fireEvent.click(tasksToggle());
    expect(store.isVisible("tasks")).toBe(true);
    expect(
      screen.queryByRole("button", { name: "Open Tasks panel" }),
    ).toBeNull();
    expect(
      within(screen.getByRole("group", { name: "Panel shortcuts" }))
        .getAllByRole("button")
        .map((button) => button.getAttribute("aria-label")),
    ).toEqual(["Open Chat panel"]);
  });

  it("publishes the docked panel and its controls to the Tasks host", () => {
    const host = fakeTasksHost();
    const store = setup({ extraTenants: [tasksTenant], tasksHost: host });
    expect(host.docks.at(-1)).toMatchObject({ present: false, visible: false });
    fireEvent.click(tasksToggle());
    const dock = host.docks.at(-1)!;
    expect(dock).toMatchObject({
      present: true,
      visible: true,
      controls: { active: true, dockEdge: "right" },
    });
    const published = host.docks.length;
    publishThreadState({ ...threadState, status: "loading" });
    expect(host.docks).toHaveLength(published);

    act(() => dock.controls.onDock("bottom"));
    expect(panelDockEdge(store.getSnapshot().tree, "tasks")).toBe("bottom");
    expect(host.docks.at(-1)?.controls.dockEdge).toBe("bottom");
    act(() => host.docks.at(-1)!.controls.onCollapse());
    expect(store.isCollapsed("tasks")).toBe(true);
    expect(host.docks.at(-1)).toMatchObject({ present: true, visible: false });
    act(() => host.docks.at(-1)!.open({ focus: false }));
    expect(store.isVisible("tasks")).toBe(true);
    act(() => host.docks.at(-1)!.close());
    expect(store.hasPanel("tasks")).toBe(false);
    expect(host.docks.at(-1)).toMatchObject({ present: false });

    cleanup();
    expect(host.docks.at(-1)).toBeUndefined();
  });

  it("opens the host's sheet from the toggle on phones, never a stage panel", async () => {
    mobile = true;
    const host = fakeTasksHost({ sheetOpen: true });
    const store = setup({ extraTenants: [tasksTenant], tasksHost: host });
    expect(tasksToggle()).toHaveAttribute("aria-expanded", "true");
    fireEvent.click(tasksToggle());
    expect(host.toggleSheet).toHaveBeenCalledTimes(1);
    expect(store.hasPanel("tasks")).toBe(false);

    // A Tasks panel left in the layout from a wider window stays off stage.
    act(() => {
      store.openPanel("tasks", { focus: true });
    });
    expect(screen.queryByRole("region", { name: "Tasks panel" })).toBeNull();
    expect(screen.getByRole("region", { name: "Chat panel" })).toBeInTheDocument();
    await openPanelsMenu();
    expect(screen.queryByRole("menuitem", { name: /^Tasks/ })).toBeNull();
  });

  it("hosts the retained Tasks body in the docked panel with one header", () => {
    applicationState = {
      ...applicationState,
      snapshot: {
        threads: [{ id: "thread-1", workspaceId: "workspace-1", title: { text: "Thread" }, inventoryState: "active" }],
        workspaces: [{ id: "workspace-1", label: { text: "Workspace" }, displayPath: { text: "/workspace" } }],
        environments: [],
        tasks: [makeThreadTask({ id: "open-1" })],
      },
    };
    const store = setup({ extraTenants: [tasksTenant], withTasksPanel: true });
    fireEvent.click(tasksToggle());
    const leaf = screen.getByRole("region", { name: "Tasks panel" });
    const surface = within(leaf).getByRole("region", { name: "Tasks" });
    expect(surface).toHaveAttribute("data-presentation", "panel");
    expect(within(leaf).getByRole("button", { name: "Task open-1" })).toBeInTheDocument();
    expect(leaf.querySelectorAll("header")).toHaveLength(1);
    const body = leaf.querySelector(".tasks-content");

    fireEvent.click(within(leaf).getByRole("button", { name: "Collapse Tasks panel" }));
    expect(store.isCollapsed("tasks")).toBe(true);
    expect(tasksToggle()).toHaveAttribute("aria-expanded", "false");
    // Collapsed is not closed: the toggle says Tasks is open off stage.
    expect(tasksToggle()).toHaveAttribute("data-state", "collapsed");
    expect(tasksToggle()).toHaveAccessibleName("Show collapsed Tasks panel, 1 open task");
    // Collapsed surfaces stay mounted: the body keeps its state.
    expect(body).toBeInTheDocument();

    fireEvent.click(tasksToggle());
    const restored = screen.getByRole("region", { name: "Tasks panel" });
    expect(restored.querySelector(".tasks-content")).toBe(body);

    fireEvent.click(within(restored).getByRole("button", { name: "Close Tasks panel" }));
    expect(store.hasPanel("tasks")).toBe(false);
    expect(document.querySelector(".tasks-content")).toBeNull();
  });
});

describe("PanelLayout panel minimums", () => {
  const resizeCallbacks: ResizeObserverCallback[] = [];

  function measureStage(width: number) {
    vi.mocked(HTMLElement.prototype.getBoundingClientRect).mockReturnValue({
      x: 0,
      y: 0,
      left: 0,
      top: 0,
      right: width,
      bottom: 800,
      width,
      height: 800,
      toJSON: () => ({}),
    });
  }

  beforeEach(() => {
    resizeCallbacks.length = 0;
    vi.stubGlobal(
      "ResizeObserver",
      class {
        constructor(callback: ResizeObserverCallback) {
          resizeCallbacks.push(callback);
        }
        observe() {}
        disconnect() {}
      },
    );
  });

  const tasksToggle = () =>
    within(screen.getByTestId("workspace-workbench-bar")).getByTestId(
      "tasks-panel-toggle",
    );
  const splits = () => screen.getAllByTestId("workspace-panel-split");
  /** The divider of each split, outermost first. */
  const handles = () =>
    splits().map(
      (split) => split.querySelector<HTMLElement>(':scope > [role="separator"]')!,
    );

  it("keeps Chat and Files at their minimums when a wide Tasks takes the rest", () => {
    measureStage(1_185);
    const store = setup({ extraTenants: [tasksTenant] });
    fireEvent.click(tasksToggle());
    act(() => {
      store.openPanel("workspace-files", { availableWidth: 1_185, focus: false });
    });
    // Files opens inside Tasks, which stays the outer column.
    const root = store.getSnapshot().tree as SplitNode;
    expect(panelDockEdge(root, "tasks")).toBe("right");
    act(() => {
      store.resizeSplit(root.id, [0.2, 0.8]);
    });

    // Chat beside Files needs 360 + 5 + 280: the root holds that, not 20%.
    expect(splits()[0]!.style.gridTemplateColumns).toMatch(
      /^minmax\(645px, [\d.]+fr\) 5px minmax\(300px, [\d.]+fr\)$/,
    );
    expect(handles()[0]).toHaveAttribute("aria-valuenow", "645");
    expect(handles()[0]).toHaveAttribute("aria-valuemin", "645");
    expect(handles()[0]).toHaveAttribute("aria-valuemax", "880");
    expect(splits()[1]!.style.gridTemplateColumns).toMatch(
      /^minmax\(360px, [\d.]+fr\) 5px minmax\(280px, [\d.]+fr\)$/,
    );
    // The nested divider moves within its own split's 645px, not the stage.
    expect(handles()[1]).toHaveAttribute("aria-valuemin", "360");
    expect(handles()[1]).toHaveAttribute("aria-valuemax", "360");
    expect(store.isVisible("workspace-files")).toBe(true);
  });

  it("does not resize when a divider is released where it was", () => {
    measureStage(1_185);
    const store = setup({ extraTenants: [tasksTenant] });
    fireEvent.click(tasksToggle());
    act(() => {
      store.openPanel("workspace-files", { availableWidth: 1_185, focus: false });
    });
    const root = store.getSnapshot().tree as SplitNode;
    act(() => {
      store.resizeSplit(root.id, [0.2, 0.8]);
    });
    const resized = store.getSnapshot().tree;
    const capture = {
      hasPointerCapture: vi.fn(() => true),
      setPointerCapture: vi.fn(),
      releasePointerCapture: vi.fn(),
    };
    const prototype = HTMLElement.prototype as unknown as Record<string, unknown>;
    const originals = Object.keys(capture).map(
      (key) => [key, Object.getOwnPropertyDescriptor(prototype, key)] as const,
    );
    Object.assign(prototype, capture);
    try {
      // Chat and Files' minimums hold this divider at 645px, not at its 20%.
      expect(handles()[0]).toHaveAttribute("aria-valuenow", "645");
      fireEvent.pointerDown(handles()[0]!, {
        button: 0,
        isPrimary: true,
        pointerId: 1,
        clientX: 645,
      });
      fireEvent.pointerUp(handles()[0]!, { pointerId: 1, clientX: 645 });
    } finally {
      for (const [key, descriptor] of originals) {
        if (descriptor) Object.defineProperty(prototype, key, descriptor);
        else delete prototype[key];
      }
    }
    expect(store.getSnapshot().tree).toBe(resized);
  });

  it("collapses the least recently used side panel when an arriving panel cannot fit", () => {
    measureStage(764);
    const store = setup({ extraTenants: [tasksTenant] });
    act(() => {
      store.openPanel("workspace-files", { availableWidth: 764 });
    });
    // Chat 360 + Files 280 fit.
    expect(store.isVisible("workspace-files")).toBe(true);

    fireEvent.click(tasksToggle());

    // Adding Tasks (300) does not: Files, the least recently used, collapses.
    expect(store.isVisible("tasks")).toBe(true);
    expect(store.isVisible("chat")).toBe(true);
    expect(store.isCollapsed("workspace-files")).toBe(true);
    expect(screen.getByRole("status")).toHaveTextContent(
      "Files collapsed to make room.",
    );

    // Restoring Files makes room in turn: now Tasks is the least recent.
    act(() => {
      store.restorePanel("workspace-files");
    });
    expect(store.isVisible("workspace-files")).toBe(true);
    expect(store.isCollapsed("tasks")).toBe(true);
    expect(tasksToggle()).toHaveAttribute("aria-expanded", "false");
    expect(tasksToggle()).toHaveAttribute("data-state", "collapsed");

    // The toggle brings Tasks back and makes room again.
    fireEvent.click(tasksToggle());
    expect(store.isVisible("tasks")).toBe(true);
    expect(store.isCollapsed("workspace-files")).toBe(true);
    expect(tasksToggle()).toHaveAttribute("data-state", "open");
  });

  it("counts using the retained Tasks body as using its panel", () => {
    applicationState = {
      ...applicationState,
      snapshot: {
        threads: [{ id: "thread-1", workspaceId: "workspace-1", title: { text: "Thread" }, inventoryState: "active" }],
        workspaces: [{ id: "workspace-1", label: { text: "Workspace" }, displayPath: { text: "/workspace" } }],
        environments: [],
        tasks: [makeThreadTask({ id: "open-1" })],
      },
    };
    measureStage(1_000);
    const store = setup({
      extraTenants: [tasksTenant, { ...filesTenant(), id: "workpads", title: "Workpads", scope: "thread" }],
      withTasksPanel: true,
    });
    fireEvent.click(tasksToggle());
    act(() => {
      store.openPanel("workspace-files", { availableWidth: 1_000, focus: false });
    });
    // Chat 360 + Tasks 300 + Files 280 fit.
    expect(store.isVisible("tasks")).toBe(true);
    expect(store.isVisible("workspace-files")).toBe(true);

    // The Tasks body is portaled in from the Tasks host, outside the
    // layout's React tree; pressing in it still uses Tasks.
    const leaf = screen.getByRole("region", { name: "Tasks panel" });
    fireEvent.pointerDown(within(leaf).getByRole("textbox", { name: "Add a task" }));

    act(() => {
      store.openPanel("workpads", { availableWidth: 1_000, focus: false });
    });

    // Workpads does not fit beside the three: Files, used least recently,
    // makes room; Tasks stays.
    expect(store.isVisible("workpads")).toBe(true);
    expect(store.isVisible("tasks")).toBe(true);
    expect(store.isCollapsed("workspace-files")).toBe(true);
  });

  it("never collapses a panel when the window narrows; the minimums shrink together", () => {
    measureStage(1_200);
    const store = setup({ extraTenants: [tasksTenant] });
    act(() => {
      store.openPanel("workspace-files", { availableWidth: 1_200, focus: false });
    });
    fireEvent.click(tasksToggle());
    expect(store.isVisible("workspace-files")).toBe(true);

    measureStage(764);
    act(() => {
      for (const callback of resizeCallbacks)
        callback([], {} as ResizeObserver);
    });

    expect(store.isVisible("workspace-files")).toBe(true);
    expect(store.isVisible("tasks")).toBe(true);
    const [first, second] = [
      ...splits()[0]!.style.gridTemplateColumns.matchAll(/minmax\(([\d.]+)px/g),
    ].map((match) => Number(match[1]));
    // Chat, Files and Tasks need 950px; 759px is shared in proportion.
    expect(first! + second!).toBeCloseTo(759);
  });
});
