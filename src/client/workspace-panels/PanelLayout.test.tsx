// @vitest-environment jsdom

import { createRef, useEffect, useState } from "react";
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
import { setTasksPanelOpen } from "../app/tasks-panel-store.js";
import { NavigationControlsContext } from "../app/navigation-controls.js";
import type { ThreadClientState } from "../stores/ThreadClientStore.js";
import type { ThreadStoreRegistry } from "../stores/ThreadStoreRegistry.js";
import type { AssociatedTask, TerminalResource } from "../../shared/index.js";
import { PanelChrome, type PanelChromeControls } from "./PanelChrome.js";
import { PanelLayout } from "./PanelLayout.js";
import { PanelLayoutStore, type PanelLayoutStorage } from "./panel-state.js";
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
  setTasksPanelOpen(false);
  threadState = initialThreadState;
  threadListeners = new Set();
  applicationListeners = new Set();
  mobile = false;
  mediaListeners = new Set();
  toggleSidebar = vi.fn();
  terminalPanelInstanceSequence = 0;
  window.history.replaceState(null, "", "/threads/thread-1");
  Object.assign(applicationStore, {
    api: {
      readTerminal: vi.fn(() => new Promise(() => undefined)),
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
  const renderLayout = (workspaceId: string, active = true) => (
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
        threadId="thread-1"
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
    </NavigationControlsContext.Provider>
  );
  const view = render(renderLayout("workspace-1"));
  return Object.assign(store, {
    setActive: (active: boolean) => view.rerender(renderLayout("workspace-1", active)),
    rerenderWorkspace: (workspaceId: string) => view.rerender(renderLayout(workspaceId)),
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
    associatedWorkspaceId: "workspace-1",
    title: `Task ${id}`,
    details: "",
    pinned: false,
    files: [],
    completedAt: completed ? "2026-08-25T20:00:00.000Z" : null,
    revision: 0,
    createdAt: "2026-08-25T19:00:00.000Z",
    updatedAt: "2026-08-25T20:00:00.000Z",
  };
}

describe("PanelLayout singleton surfaces", () => {
  it("badges only open tasks scoped directly to the current thread in the application header", () => {
    applicationState = { ...applicationState, snapshot: { threads: [], tasks: [
      makeThreadTask({ id: "open-1" }),
      makeThreadTask({ id: "open-2" }),
      makeThreadTask({ id: "completed", completed: true }),
      makeThreadTask({ id: "other-thread", threadId: "thread-2" }),
      { ...makeThreadTask({ id: "project" }), scope: { kind: "workspace", workspaceId: "workspace-1" } },
      { ...makeThreadTask({ id: "global" }), scope: { kind: "global" } },
    ] } };
    setup();
    const toggle = within(screen.getByTestId("workspace-workbench-bar")).getByTestId("tasks-panel-toggle");
    expect(toggle).toHaveAccessibleName("Open Tasks panel, 2 open tasks for this thread");
    expect(toggle).toHaveAttribute("data-has-items", "true");
    fireEvent.click(toggle);
    expect(toggle).toHaveAccessibleName("Close Tasks panel, 2 open tasks for this thread");
    expect(toggle).toHaveAttribute("aria-expanded", "true");
  });

  it("keeps a fixed panel list and marks collapsed panels open", async () => {
    const store = setup({ extraTenants: [{ ...filesTenant(), id: "workpads", title: "Workpads", scope: "thread" }] });
    act(() => {
      store.openPanel("workpads");
      store.openPanel("workspace-files");
      store.dockPanel("workspace-files", "left");
      store.collapsePanel("workpads");
    });
    await openPanelsMenu();
    const entries = screen.getAllByRole("menuitem").filter(item => item.hasAttribute("data-panel-open"));
    expect(entries.map(item => item.textContent?.split(" —")[0])).toEqual(["Chat", "Files", "WorkpadsCollapsed", "Terminals"]);
    expect(entries.map(item => item.getAttribute("aria-description"))).toEqual(["Open", "Open", "Open", "Closed"]);
    expect(entries.map(item => Boolean(item.querySelector(".lucide-check")))).toEqual([true, true, true, false]);
    expect(entries[3]).not.toHaveAttribute("data-disabled");
    fireEvent.click(entries[2]!);
    expect(store.isCollapsed("workpads")).toBe(false);
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
    for (const [title, id] of [["Chat", "chat"], ["Files", "workspace-files"], ["Workpads", "workpads"]]) {
      await openPanelsMenu();
      const item = screen.getByRole("menuitem", { name: title });
      expect(item).toHaveAttribute("aria-description", "Closed");
      fireEvent.click(item);
      await waitFor(() => expect(store.isVisible(id!)).toBe(true));
    }
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
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
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

  it.each([false, true])("focuses Workpads content from the panels menu (mobile: %s)", async (narrow) => {
    mobile = narrow;
    const store = setup({ extraTenants: [{
      ...filesTenant(),
      id: "workpads",
      title: "Workpads",
      scope: "thread",
      render: () => <input aria-label="Workpad draft" />,
    }] });
    await openPanelsMenu();
    fireEvent.click(screen.getByRole("menuitem", { name: "Workpads" }));
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

  it("hosts Workpads through docking and collapse without losing dirty text", async () => {
    const unmounted = vi.fn();
    function WorkpadFixture({ context }: { context: Parameters<WorkspacePanelTenant["render"]>[0] }) {
      const [text, setText] = useState("");
      useEffect(() => () => unmounted(), []);
      return <input aria-label="Workpad draft" value={text} onChange={event => { setText(event.target.value); context.host.setDirty(true); }} />;
    }
    const store = setup({ extraTenants: [{ ...filesTenant(), id: "workpads", title: "Workpads", scope: "thread", render: context => <WorkpadFixture context={context} /> }] });
    await openPanelsMenu();
    fireEvent.click(screen.getByRole("menuitem", { name: /^Workpads(?: —|$)/ }));
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
    fireEvent.click(screen.getByRole("button", { name: "Close Workpads panel" }));
    expect(await screen.findByRole("dialog", { name: "Discard unsaved changes?" })).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(draft).toHaveValue("Keep this draft");
    expect(store.hasPanel("workpads")).toBe(true);
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
    fireEvent.click(screen.getByRole("button", { name: "Close Workpads panel" }));
    const closeDialog = await screen.findByRole("dialog", { name: "Discard unsaved changes?" });
    fireEvent.click(within(closeDialog).getByRole("button", { name: "Cancel" }));
    expect(draft).toHaveValue("Retain this across workspaces");
    expect(store.hasPanel("workpads")).toBe(true);
    await openPanelsMenu();
    fireEvent.click(screen.getByRole("menuitem", { name: "Reset layout" }));
    const resetDialog = await screen.findByRole("dialog", { name: "Discard unsaved changes?" });
    fireEvent.click(within(resetDialog).getByRole("button", { name: "Cancel" }));
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
    await openPanelsMenu();
    fireEvent.click(screen.getByRole("menuitem", { name: /^Workpads(?: —|$)/ }));
    const draft = await screen.findByRole("textbox", { name: "Workpad draft" });
    fireEvent.change(draft, { target: { value: "Unsynced draft" } });
    const tree = store.getSnapshot().tree;
    await openPanelsMenu();
    fireEvent.click(screen.getByRole("menuitem", { name: "Reset layout" }));
    expect(await screen.findByRole("dialog", { name: "Discard unsaved changes?" }))
      .toHaveTextContent("Resetting the layout will discard unsaved changes in Workpads.");
    expect(store.getSnapshot().tree).toBe(tree);
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
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

  it("disables terminals already displayed in the terminal tab add menu", async () => {
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

    expect(
      await screen.findByRole("menuitem", {
        name: /Remote shell.*Running · Open/u,
      }),
    ).toHaveAttribute("aria-disabled", "true");
    expect(
      screen.getByRole("menuitem", { name: /Other shell.*Running/u }),
    ).not.toHaveAttribute("aria-disabled", "true");
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

  it("does not carry cold-thread composer focus onto mobile", async () => {
    mobile = true;
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

  it("keeps Tasks available and open across Chat collapse and close", async () => {
    setup();
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
    expect(screen.getByTestId("workspace-panel-empty")).toHaveTextContent(
      "No panels are open",
    );
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
