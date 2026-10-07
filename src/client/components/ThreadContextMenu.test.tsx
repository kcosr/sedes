// @vitest-environment jsdom

import { ThreadArchiveOperationHost } from "../operations/ThreadArchiveOperationHost.js";
import { OperationOverlayHost } from "../operations/OperationOverlay.js";
vi.mock("../operations/thread-readiness.js", () => ({ waitForOperationThreadReady: vi.fn(async () => undefined), setOperationThreadRegistry: vi.fn() }));

import { getBlockingOperation } from "../operations/blocking-operation.js";

import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { NormalizedApplicationThreadSummary } from "../../shared/index.js";
import type {
  ApplicationClientState,
  ApplicationClientStore,
} from "../stores/ApplicationClientStore.js";
import type {
  ThreadClientState,
  ThreadClientStore,
} from "../stores/ThreadClientStore.js";
import type { ThreadStoreRegistry } from "../stores/ThreadStoreRegistry.js";
import { SIDEBAR_VIEW_DEFAULTS, SIDEBAR_VIEW_STORAGE_KEY } from "../app/sidebar-view-model.js";
import {
  TOUCH_DENSITY_QUERY,
  useTouchDensity,
} from "../app/use-touch-density.js";
import { InventorySidebar } from "./InventorySidebar.js";
import { ThreadContextMenu } from "./ThreadContextMenu.js";

// jsdom lacks the pointer-capture and scroll APIs Radix menus rely on.
beforeEach(() => {
  render(<OperationOverlayHost />);
  // The row-editing cases exercise the project hierarchy deliberately.
  localStorage.setItem(SIDEBAR_VIEW_STORAGE_KEY, JSON.stringify({ ...SIDEBAR_VIEW_DEFAULTS, groupBy: "project" }));
  window.dispatchEvent(new StorageEvent("storage", { key: SIDEBAR_VIEW_STORAGE_KEY }));
  // Desktop density: the density query reports no match, so the menu
  // floats rather than presenting as the bottom sheet.
  vi.stubGlobal(
    "matchMedia",
    vi.fn(() => ({
      matches: false,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })),
  );
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe(): void {}
      disconnect(): void {}
      unobserve(): void {}
    },
  );
  Object.assign(window.HTMLElement.prototype, {
    scrollIntoView: vi.fn(),
    hasPointerCapture: vi.fn(),
    setPointerCapture: vi.fn(),
    releasePointerCapture: vi.fn(),
  });
});

afterEach(() => {
  getBlockingOperation()?.dismiss();
  cleanup();
  localStorage.clear();
  window.dispatchEvent(new StorageEvent("storage", { key: null }));
  vi.unstubAllGlobals();
  window.history.replaceState(null, "", "/");
});

function makeThread(
  overrides: Partial<NormalizedApplicationThreadSummary> = {},
): NormalizedApplicationThreadSummary {
  return {
    id: "thread-1",
    workspaceId: "workspace-1",
    targetId: "target-1",
    title: { text: "Review backend contract" },
    backend: { label: { text: "Pi" }, brand: "pi" },
    backingState: "bound",
    inventoryState: "active",
    inventoryRevision: 2,
    pinned: false,
    pinRevision: 3,
    groupId: null,
    groupAssignmentRevision: 0,
    threadRevision: 4,
    runState: "idle",
    queuedInputCount: 0,
    terminalSummary: { runningCount: 0, retainedCount: 0 },
    available: true,
    lastActivityAt: "2026-07-30T15:00:00.000Z",
    stateChangedAt: "2026-07-30T15:00:00.000Z",
    automation: null,
    attention: {
      wake: false,
      automationContext: null,
      unseenCompletion: false,
      queueFailure: false,
    },
    ...overrides,
  } as NormalizedApplicationThreadSummary;
}

function openTasks(rootTotal = 0, descendantTotal = 0) {
  return {
    familySnapshot: "b".repeat(64),
    root: { snapshot: "a".repeat(64), items: [], total: rootTotal, omitted: rootTotal },
    descendants: {
      snapshot: "a".repeat(64),
      items: [],
      total: descendantTotal,
      omitted: descendantTotal,
    },
  };
}

function deferred<T>(): {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((accepted) => {
    resolve = accepted;
  });
  return { promise, resolve };
}

function makeStore(): ApplicationClientStore & {
  getSnapshot: ReturnType<typeof vi.fn>;
  createThreadFromSettings: ReturnType<typeof vi.fn>;
  mutateInventory: ReturnType<typeof vi.fn>;
  setThreadPinned: ReturnType<typeof vi.fn>;
  archiveThreadFamily: ReturnType<typeof vi.fn>;
  getThreadArchiveImpact: ReturnType<typeof vi.fn>;
  getThreadExecutionWorkspace: ReturnType<typeof vi.fn>;
  getThreadForceResetImpact: ReturnType<typeof vi.fn>;
  forceResetThread: ReturnType<typeof vi.fn>;
  renameThread: ReturnType<typeof vi.fn>;
  updateLineagePlacement: ReturnType<typeof vi.fn>;
} {
  const state = {
    connection: "connected",
    authoritative: true,
    snapshot: {
      threads: [],
      executionTargets: [
        {
          id: "target-1",
          workspaceExecution: { kind: "direct_only" },
        },
      ],
    },
  } as unknown as ApplicationClientState;
  const store = {
    subscribe: vi.fn(() => () => undefined),
    getSnapshot: vi.fn(() => state),
    createThread: vi.fn(),
    createThreadFromSettings: vi.fn().mockResolvedValue({
      threadId: "thread-copy",
      workspaceId: "workspace-1",
      targetId: "target-1",
    }),
    openWorkspace: vi.fn(),
    setSearch: vi.fn(),
    mutateInventory: vi.fn().mockResolvedValue(undefined),
    setThreadPinned: vi.fn().mockResolvedValue(undefined),
    archiveThreadFamily: vi
      .fn()
      .mockResolvedValue(["thread-1", "thread-2", "thread-3"]),
    getThreadArchiveImpact: vi.fn().mockResolvedValue({
      descendantCount: 2,
      pendingQuestions: { root: 0, descendants: 0 },
      stashedPrompts: { root: 0, descendants: 0 },
      openTasks: openTasks(),
      executionWorkspace: { kind: "direct" },
      archiveOnly: { available: true },
      archiveAll: { available: true },
    }),
    getThreadExecutionWorkspace: vi.fn().mockResolvedValue({ kind: "direct" }),
    getThreadForceResetImpact: vi.fn().mockResolvedValue({
      blockerFingerprint: "a".repeat(64),
      resettable: true,
      blockers: [{ kind: "queued_input", count: 1 }],
      affectedThreads: [{ threadId: "11111111-1111-4111-8111-111111111111", title: "Thread" }],
      warnings: [
        {
          code: "provider_side_effects_may_remain",
          message: "Provider-side effects may remain.",
        },
      ],
    }),
    forceResetThread: vi.fn().mockResolvedValue({
      resetAt: Date.now(),
      blockerFingerprint: "a".repeat(64),
      resetBlockers: [{ kind: "queued_input", count: 1 }],
      affectedThreadIds: ["11111111-1111-4111-8111-111111111111"],
    }),
    renameThread: vi.fn().mockResolvedValue(undefined),
    updateLineagePlacement: vi.fn().mockResolvedValue(undefined),
  } as unknown as ApplicationClientStore & {
    getSnapshot: ReturnType<typeof vi.fn>;
    createThreadFromSettings: ReturnType<typeof vi.fn>;
    mutateInventory: ReturnType<typeof vi.fn>;
    setThreadPinned: ReturnType<typeof vi.fn>;
    archiveThreadFamily: ReturnType<typeof vi.fn>;
    getThreadArchiveImpact: ReturnType<typeof vi.fn>;
    getThreadExecutionWorkspace: ReturnType<typeof vi.fn>;
    getThreadForceResetImpact: ReturnType<typeof vi.fn>;
    forceResetThread: ReturnType<typeof vi.fn>;
    renameThread: ReturnType<typeof vi.fn>;
    updateLineagePlacement: ReturnType<typeof vi.fn>;
  };
  render(<ThreadArchiveOperationHost store={store} />);
  return store;
}

async function openMenu(trigger: HTMLElement): Promise<HTMLElement> {
  fireEvent.contextMenu(trigger);
  return await screen.findByTestId("thread-context-menu");
}

/**
 * The touch density (narrow layout or coarse pointer): the menu presents as
 * the bottom sheet. Stub it before rendering; the density is read on render.
 */
function stubTouchDensity(): ReturnType<typeof vi.fn> {
  const matchMedia = vi.fn(() => ({
    matches: true,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  }));
  vi.stubGlobal("matchMedia", matchMedia);
  return matchMedia;
}

// The sheet opens after a 700ms hold (ui/menu-sheet.tsx LONG_PRESS_MS).
const LONG_PRESS_WAIT_MS = 750;

function wait(ms: number): Promise<void> {
  return act(
    () =>
      new Promise<void>((resolve) => {
        setTimeout(resolve, ms);
      }),
  );
}

/** Long-presses a row under the touch density and returns its action sheet. */
async function openTouchSheet(
  trigger: HTMLElement,
  pointerType: "touch" | "pen" = "touch",
): Promise<HTMLElement> {
  fireEvent.pointerDown(trigger, {
    pointerType,
    button: 0,
    clientX: 40,
    clientY: 50,
  });
  await wait(LONG_PRESS_WAIT_MS);
  const sheet = screen.getByTestId("thread-actions-sheet");
  expect(sheet).toHaveAttribute("role", "dialog");
  expect(sheet).toHaveAttribute("data-layout", "sheet");
  return sheet;
}

/** Opens a desktop submenu from its row and returns the submenu. */
async function openSubmenu(
  menu: HTMLElement,
  name: string,
): Promise<HTMLElement> {
  await userEvent.click(within(menu).getByRole("menuitem", { name }));
  return await screen.findByRole("menu", { name });
}

/** Drills into a sheet submenu; its rows replace the sheet's own. */
async function drillIn(sheet: HTMLElement, name: string): Promise<void> {
  await userEvent.click(within(sheet).getByRole("menuitem", { name }));
  // The back row carries the submenu's name.
  await waitFor(() =>
    expect(
      sheet.querySelector('[data-slot="menu-sheet-back"]'),
    ).toHaveTextContent(name),
  );
}

function isolatedWorkspace(allocationRevision = 2) {
  return {
    kind: "isolated" as const,
    workspaceAccess: "writable_clone" as const,
    state: "ready" as const,
    allocationRevision,
    networkProfile: "isolated" as const,
    hostPaths: { home: "/sandbox", workspace: "/sandbox/repo" },
    branch: "sedes/thread-1",
    gitStatus: {
      available: true as const,
      trackedChangeCount: 0,
      untrackedFileCount: 0,
      upstream: "origin/main",
      aheadCount: 0,
    },
  };
}

function renderMenu(
  thread: NormalizedApplicationThreadSummary,
  store: ApplicationClientStore,
  extra: {
    onRename?: () => void;
    onNavigate?: () => void;
    familyDescendantCount?: number;
    threadRegistry?: ThreadStoreRegistry;
  } = {},
) {
  render(
    <ThreadContextMenu thread={thread} store={store} {...extra}>
      <div data-testid="row-trigger">Row</div>
    </ThreadContextMenu>,
  );
  return screen.getByTestId("row-trigger");
}

function makeForkRegistry(
  forkTurn: ReturnType<typeof vi.fn>,
  stateOverrides: Partial<ThreadClientState> = {},
  forkLatestProviderSnapshot: ReturnType<typeof vi.fn> = vi.fn(),
  latestProviderSnapshotAvailable = false,
): ThreadStoreRegistry {
  const threadState = {
    status: "ready",
    connection: "connected",
    authoritative: true,
    forkAttempts: {},
    snapshot: {
      thread: { available: true },
      runState: "idle",
      capabilities: { automation: { available: false }, operations: [] },
      orderedTurnIds: ["turn-1", "turn-2"],
      turnsById: {
        "turn-1": {
          id: "turn-1",
          status: "completed",
          endedBy: "agent_settled",
        },
        "turn-2": {
          id: "turn-2",
          status: "completed",
          endedBy: "agent_settled",
        },
      },
      forksByTurnId: {
        "turn-1": {
          sourceTurnId: "turn-1",
          expectedTurnRevision: 1,
          available: true,
        },
        "turn-2": {
          sourceTurnId: "turn-2",
          expectedTurnRevision: 9,
          available: true,
        },
      },
      forkSource: {
        selectedCompletedTurn: { available: true },
        latestProviderSnapshot: latestProviderSnapshotAvailable
          ? { available: true }
          : {
              available: false,
              unavailableReason: {
                text: "Provider snapshots are unavailable.",
              },
            },
      },
    },
    ...stateOverrides,
  } as unknown as ThreadClientState;
  const threadStore = {
    getSnapshot: () => threadState,
    subscribe: () => () => undefined,
    forkTurn,
    forkLatestProviderSnapshot,
  } as unknown as ThreadClientStore;
  return {
    get: vi.fn(() => threadStore),
    retain: vi.fn(() => threadStore),
    release: vi.fn(),
  } as unknown as ThreadStoreRegistry;
}

/** A retained thread whose capabilities decide the "Automate…" row. */
function automationRegistry({
  automationAvailable = true,
  attachAvailable = true,
  connection = "connected",
}: {
  readonly automationAvailable?: boolean;
  readonly attachAvailable?: boolean;
  readonly connection?: ThreadClientState["connection"];
} = {}): ThreadStoreRegistry {
  return makeForkRegistry(vi.fn(), {
    connection,
    snapshot: {
      thread: { available: true },
      runState: "idle",
      capabilities: {
        automation: { available: automationAvailable },
        operations: [
          {
            id: "attach_automation",
            label: { text: "Add automation" },
            available: attachAvailable,
            ...(attachAvailable
              ? {}
              : {
                  unavailableReason: {
                    text: "Automation requires an inactive, unarchived thread.",
                  },
                }),
          },
        ],
      },
      orderedTurnIds: [],
      turnsById: {},
      forksByTurnId: {},
      forkSource: {
        selectedCompletedTurn: { available: false },
        latestProviderSnapshot: { available: false },
      },
    } as unknown as ThreadClientState["snapshot"],
  });
}

describe("ThreadContextMenu content per thread state", () => {
  it("loads isolated workspace actions for the selected row and confirms deletion", async () => {
    const store = makeStore();
    store.getSnapshot.mockReturnValue({
      snapshot: {
        executionTargets: [
          {
            id: "target-1",
            workspaceExecution: {
              kind: "selectable",
              default: { kind: "direct" },
              isolatedNetworkProfiles: ["isolated"],
            },
          },
        ],
      },
    } as unknown as ApplicationClientState);
    store.getThreadExecutionWorkspace.mockResolvedValue(isolatedWorkspace());
    const deleteThreadExecutionWorkspace = vi.fn().mockResolvedValue({
      state: "deleted",
      allocationRevision: 3,
      operationId: "10000000-0000-4000-8000-000000000001",
    });
    Object.assign(store, { deleteThreadExecutionWorkspace });

    const menu = await openMenu(renderMenu(makeThread(), store));
    await within(menu).findByRole("menuitem", { name: "Isolated workspace" });
    const workspace = await openSubmenu(menu, "Isolated workspace");

    expect(
      within(workspace).getByRole("menuitem", { name: "Copy workspace path" }),
    ).toBeVisible();
    expect(store.getThreadExecutionWorkspace).toHaveBeenCalledWith("thread-1");
    // The irreversible action is red and follows a separator.
    const remove = within(workspace).getByRole("menuitem", {
      name: "Delete isolated workspace…",
    });
    expect(remove).toHaveAttribute("data-variant", "destructive");
    expect(remove.previousElementSibling).toHaveAttribute(
      "data-slot",
      "context-menu-separator",
    );
    await userEvent.click(remove);
    const dialog = await screen.findByRole("dialog", {
      name: "Delete isolated workspace?",
    });
    await userEvent.click(
      within(dialog).getByRole("button", { name: "Delete permanently" }),
    );
    await waitFor(() =>
      expect(deleteThreadExecutionWorkspace).toHaveBeenCalledWith("thread-1", 2),
    );
  });

  it("closes the touch sheet before confirming isolated workspace deletion", async () => {
    stubTouchDensity();
    const store = makeStore();
    store.getSnapshot.mockReturnValue({
      snapshot: {
        executionTargets: [
          {
            id: "target-1",
            workspaceExecution: {
              kind: "selectable",
              default: { kind: "direct" },
              isolatedNetworkProfiles: ["isolated"],
            },
          },
        ],
      },
    } as unknown as ApplicationClientState);
    store.getThreadExecutionWorkspace.mockResolvedValue(isolatedWorkspace());

    const sheet = await openTouchSheet(renderMenu(makeThread(), store));
    await within(sheet).findByRole("menuitem", { name: "Isolated workspace" });
    await drillIn(sheet, "Isolated workspace");
    await userEvent.click(
      within(sheet).getByRole("menuitem", {
        name: "Delete isolated workspace…",
      }),
    );

    expect(
      await screen.findByRole("dialog", {
        name: "Delete isolated workspace?",
      }),
    ).toBeInTheDocument();
    expect(sheet).not.toBeInTheDocument();
  });

  it("does not request workspace status for a direct-only target", async () => {
    const store = makeStore();

    await openMenu(renderMenu(makeThread(), store));

    expect(store.getThreadExecutionWorkspace).not.toHaveBeenCalled();
    expect(
      screen.queryByRole("menuitem", { name: "Isolated workspace" }),
    ).not.toBeInTheDocument();
  });

  it("presents mouse right-click as a bottom sheet under the touch density", async () => {
    const matchMedia = stubTouchDensity();
    const store = makeStore();
    render(
      <>
        <ThreadContextMenu thread={makeThread()} store={store}>
          <div data-testid="row-trigger-one">Row one</div>
        </ThreadContextMenu>
        <ThreadContextMenu
          thread={makeThread({ id: "thread-2", title: { text: "Second row" } })}
          store={store}
        >
          <div data-testid="row-trigger-two">Row two</div>
        </ThreadContextMenu>
      </>,
    );

    fireEvent.contextMenu(screen.getByTestId("row-trigger-one"));
    const sheet = await screen.findByRole("dialog", {
      name: "Review backend contract",
    });
    expect(sheet).toHaveAttribute("data-testid", "thread-actions-sheet");
    expect(sheet).toHaveAttribute("data-layout", "sheet");
    expect(screen.getAllByRole("dialog")).toHaveLength(1);
    expect(matchMedia).toHaveBeenCalledWith(TOUCH_DENSITY_QUERY);
    expect(screen.queryByTestId("thread-context-menu")).toBeNull();

    await userEvent.keyboard("{Escape}");
    await waitFor(() =>
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
    );
  });

  it.each(["touch", "pen"])(
    "opens from a %s long press without navigating the row",
    async (pointerType) => {
      stubTouchDensity();
      const onClick = vi.fn();
      render(
        <ThreadContextMenu thread={makeThread()} store={makeStore()}>
          <button data-testid="row-trigger" onClick={onClick}>
            Row
          </button>
        </ThreadContextMenu>,
      );
      const trigger = screen.getByTestId("row-trigger");

      fireEvent.pointerDown(trigger, {
        pointerType,
        button: 0,
        clientX: 40,
        clientY: 50,
      });
      await wait(400);
      // A short hold is not a long press.
      expect(screen.queryByTestId("thread-actions-sheet")).toBeNull();
      await wait(LONG_PRESS_WAIT_MS - 400);

      const sheet = screen.getByRole("dialog", {
        name: "Review backend contract",
      });
      expect(sheet).toHaveAttribute("data-state", "open");
      expect(
        within(sheet).getByRole("menuitem", { name: "Force reset…" }),
      ).toBeInTheDocument();
      // The header is the thread's name over its meta line.
      expect(
        within(sheet).getByRole("heading", { name: "Review backend contract" }),
      ).toBeVisible();
      expect(sheet).toHaveAccessibleDescription(/^Pi · updated /);
      expect(screen.queryByTestId("thread-context-menu")).toBeNull();
      await wait(175);
      expect(screen.queryByTestId("thread-context-menu")).toBeNull();
      fireEvent.pointerUp(trigger, {
        pointerType,
        button: 0,
        clientX: 40,
        clientY: 50,
      });
      // The page behind the sheet takes no pointer events, but the pressed
      // row keeps the touch pointer captured, so the release clicks it; the
      // long press swallows that click.
      expect(screen.getByTestId("dialog-overlay")).toBeInTheDocument();
      expect(document.body.style.pointerEvents).toBe("none");
      fireEvent.click(trigger, { detail: 1 });
      expect(onClick).not.toHaveBeenCalled();
    },
  );

  it("opens the floating menu from a touch long press on desktop density", async () => {
    render(
      <ThreadContextMenu thread={makeThread()} store={makeStore()}>
        <button data-testid="row-trigger">Row</button>
      </ThreadContextMenu>,
    );
    fireEvent.pointerDown(screen.getByTestId("row-trigger"), {
      pointerType: "touch",
      button: 0,
      clientX: 40,
      clientY: 50,
    });
    await wait(LONG_PRESS_WAIT_MS);
    expect(screen.getByTestId("thread-context-menu")).toBeInTheDocument();
    expect(screen.queryByTestId("thread-actions-sheet")).toBeNull();
  });
  it("keeps repeated Android synthetic contextmenu events on the touch sheet path", async () => {
    stubTouchDensity();
    render(
      <ThreadContextMenu thread={makeThread()} store={makeStore()}>
        <button data-testid="row-trigger">Row</button>
      </ThreadContextMenu>,
    );
    const trigger = screen.getByTestId("row-trigger");

    for (let attempt = 0; attempt < 2; attempt += 1) {
      fireEvent.pointerDown(trigger, {
        pointerType: "touch",
        button: 0,
        clientX: 40,
        clientY: 50,
      });
      await wait(300);
      // Android's synthetic contextmenu mid-hold is consumed and opens the
      // sheet at once.
      expect(fireEvent.contextMenu(trigger)).toBe(false);
      expect(
        screen.getByRole("dialog", { name: "Review backend contract" }),
      ).toHaveAttribute("data-state", "open");
      // The hold's own timer is cancelled: nothing reopens or toggles.
      await wait(LONG_PRESS_WAIT_MS - 300);

      expect(screen.getAllByRole("dialog")).toHaveLength(1);
      expect(
        screen.getByRole("dialog", { name: "Review backend contract" }),
      ).toHaveAttribute("data-state", "open");
      expect(screen.queryByTestId("thread-context-menu")).toBeNull();
      fireEvent.pointerUp(trigger, {
        pointerType: "touch",
        button: 0,
        clientX: 40,
        clientY: 50,
      });
      await userEvent.keyboard("{Escape}");
      await waitFor(() =>
        expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
      );
    }

    // Under the touch density a mouse right-click opens the same sheet,
    // never the floating menu.
    fireEvent.pointerDown(trigger, {
      pointerType: "mouse",
      button: 2,
      clientX: 40,
      clientY: 50,
    });
    fireEvent.contextMenu(trigger);
    expect(await screen.findByTestId("thread-actions-sheet")).toBeInTheDocument();
    expect(screen.queryByTestId("thread-context-menu")).toBeNull();
  });

  it("forks from the exact latest capability and navigates to the empty child", async () => {
    const forkTurn = vi.fn(async () => ({
      status: "created" as const,
      childThreadId: "child-latest",
    }));
    const threadRegistry = makeForkRegistry(forkTurn);
    const onNavigate = vi.fn();
    render(
      <ThreadContextMenu
        thread={makeThread()}
        store={makeStore()}
        threadRegistry={threadRegistry}
        onNavigate={onNavigate}
      >
        <div data-testid="row-trigger">Row</div>
      </ThreadContextMenu>,
    );

    const menu = await openMenu(screen.getByTestId("row-trigger"));
    await userEvent.click(await within(menu).findByText("Fork"));
    expect(forkTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceTurnId: "turn-2",
        expectedTurnRevision: 9,
      }),
      { restart: false },
    );
    await waitFor(() =>
      expect(window.location.pathname).toBe("/threads/child-latest"),
    );
    expect(onNavigate).toHaveBeenCalled();
  });

  it("keeps the original source connected when forking again from its touch sheet after navigation", async () => {
    // The original view initially owns one lease. After navigation, only its
    // action sheet keeps the source stream connected for the second fork.
    let leases = 1;
    let connected = true;
    let forkCount = 0;
    const subscribers = new Set<() => void>();
    const forkTurn = vi.fn(async () => {
      if (!connected) throw new Error("Wait for the thread to reconnect before forking.");
      return {
        status: "created" as const,
        childThreadId: `child-${++forkCount}`,
      };
    });
    const threadRegistry = makeForkRegistry(forkTurn);
    const threadStore = threadRegistry.get(makeThread().id);
    const readyState = threadStore.getSnapshot();
    threadStore.getSnapshot = () => ({
      ...readyState,
      connection: connected ? "connected" : "reconnecting",
      authoritative: connected,
    });
    threadStore.subscribe = (listener) => {
      subscribers.add(listener);
      return () => subscribers.delete(listener);
    };
    vi.mocked(threadRegistry.retain).mockImplementation(() => {
      if (leases++ === 0) {
        // Reattaching a released stream requires a fresh authoritative snapshot.
        queueMicrotask(() => {
          connected = true;
          subscribers.forEach((listener) => listener());
        });
      }
      return threadStore;
    });
    vi.mocked(threadRegistry.release).mockImplementation(() => {
      if (--leases === 0) connected = false;
    });
    let originalViewAttached = true;
    const onNavigate = vi.fn(() => {
      if (originalViewAttached) {
        originalViewAttached = false;
        threadRegistry.release(makeThread().id);
      }
    });
    stubTouchDensity();
    const trigger = renderMenu(makeThread(), makeStore(), {
      threadRegistry,
      onNavigate,
    });

    for (const childNumber of [1, 2]) {
      const sheet = await openTouchSheet(trigger);
      const forkButton = within(sheet).getByRole("menuitem", { name: "Fork" });
      await waitFor(() => expect(forkButton).toBeEnabled());
      await userEvent.click(forkButton);
      await waitFor(() =>
        expect(window.location.pathname).toBe(`/threads/child-${childNumber}`),
      );
      await waitFor(() => expect(leases).toBe(0));
      expect(screen.queryByText(/Wait for the thread to reconnect/)).not.toBeInTheDocument();
    }
    expect(forkTurn).toHaveBeenCalledTimes(2);
    expect(onNavigate).toHaveBeenCalledTimes(2);
  });

  it("releases the source if the row unmounts during the touch sheet handoff", async () => {
    const forkTurn = vi.fn();
    const threadRegistry = makeForkRegistry(forkTurn);
    const threadStore = threadRegistry.get(makeThread().id);
    let leases = 0;
    vi.mocked(threadRegistry.retain).mockImplementation(() => {
      leases++;
      return threadStore;
    });
    vi.mocked(threadRegistry.release).mockImplementation(() => {
      leases--;
    });
    stubTouchDensity();
    const { unmount } = render(
      <ThreadContextMenu
        thread={makeThread()}
        store={makeStore()}
        threadRegistry={threadRegistry}
      >
        <div data-testid="row-trigger">Row</div>
      </ThreadContextMenu>,
    );
    const sheet = await openTouchSheet(screen.getByTestId("row-trigger"));
    expect(leases).toBe(1);

    fireEvent.click(within(sheet).getByRole("menuitem", { name: "Fork" }));
    expect(sheet).not.toBeInTheDocument();
    expect(leases).toBe(1);
    unmount();

    expect(leases).toBe(0);
    expect(forkTurn).not.toHaveBeenCalled();
    expect(getBlockingOperation()).toBeNull();
  });

  it("prefers the latest provider snapshot when the backend exposes it", async () => {
    const forkTurn = vi.fn();
    const forkLatestProviderSnapshot = vi.fn(async () => ({
      status: "created" as const,
      childThreadId: "child-snapshot",
    }));
    const threadRegistry = makeForkRegistry(
      forkTurn,
      {},
      forkLatestProviderSnapshot,
      true,
    );
    render(
      <ThreadContextMenu
        thread={makeThread()}
        store={makeStore()}
        threadRegistry={threadRegistry}
      >
        <div data-testid="row-trigger">Row</div>
      </ThreadContextMenu>,
    );

    const menu = await openMenu(screen.getByTestId("row-trigger"));
    await userEvent.click(await within(menu).findByText("Fork"));
    expect(forkLatestProviderSnapshot).toHaveBeenCalledWith({ restart: false });
    expect(forkTurn).not.toHaveBeenCalled();
    await waitFor(() =>
      expect(window.location.pathname).toBe("/threads/child-snapshot"),
    );
  });

  it("keeps a nonvisual reason on the disabled short Fork action", async () => {
    const threadRegistry = makeForkRegistry(vi.fn(), {
      connection: "reconnecting",
      authoritative: false,
    });
    render(
      <ThreadContextMenu
        thread={makeThread()}
        store={makeStore()}
        threadRegistry={threadRegistry}
      >
        <div data-testid="row-trigger">Row</div>
      </ThreadContextMenu>,
    );

    const menu = await openMenu(screen.getByTestId("row-trigger"));
    const fork = within(menu).getByRole("menuitem", {
      name: "Fork",
    });
    const descriptionId = fork.getAttribute("aria-describedby");
    expect(fork).toHaveAttribute("data-disabled");
    // The disabled row shows a short reason; the full one is its description.
    expect(fork).toHaveTextContent(/^ForkUnavailable$/u);
    expect(descriptionId).toBeTruthy();
    expect(document.getElementById(descriptionId!)).toHaveTextContent(
      "Wait for the thread to reconnect and receive authoritative history.",
    );
  });

  it("shows fork failures without navigating away from the current thread", async () => {
    window.history.pushState(null, "", "/threads/another-thread");
    const forkTurn = vi.fn(async () => {
      throw new Error(
        "The source Codex effective execution settings are not authoritatively confirmed.",
      );
    });
    render(
      <ThreadContextMenu
        thread={makeThread()}
        store={makeStore()}
        threadRegistry={makeForkRegistry(forkTurn)}
      >
        <div data-testid="row-trigger">Row</div>
      </ThreadContextMenu>,
    );

    const menu = await openMenu(screen.getByTestId("row-trigger"));
    await userEvent.click(await within(menu).findByText("Fork"));
    await waitFor(() => expect(forkTurn).toHaveBeenCalledOnce());
    expect(window.location.pathname).toBe("/threads/another-thread");
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "The source Codex effective execution settings are not authoritatively confirmed.",
    );
  });

  it("offers durable placement and normalized source actions", async () => {
    const store = makeStore();
    const thread = makeThread({ id: "child-1" });
    render(
      <ThreadContextMenu
        thread={thread}
        store={store}
        sourceTitle="Source title"
        origin={{
          childThreadId: "child-1",
          sourceThreadId: "source-1",
          sourceTurnId: "turn-1",
          sourceTurnCompletedAt: "2026-07-30T14:59:00.000Z",
          boundaryKind: "completed_turn_inclusive",
          originKind: "user_fork",
          initiatingAgentThreadId: null,
          initiatingToolClientId: null,
          branchMethod: "provider_native",
          createdAt: "2026-07-30T15:00:00.000Z",
        }}
        placement={{
          childThreadId: "child-1",
          mode: "nested_under_source",
          revision: 4,
          updatedAt: "2026-07-30T15:00:00.000Z",
        }}
      >
        <div data-testid="row-trigger">Row</div>
      </ThreadContextMenu>,
    );
    const menu = await openMenu(screen.getByTestId("row-trigger"));
    await userEvent.click(within(menu).getByText("Show as top-level"));
    expect(store.updateLineagePlacement).toHaveBeenCalledWith(
      expect.objectContaining({ childThreadId: "child-1", revision: 4 }),
      "top_level",
    );
  });

  it("names the menu after the thread it acts on", async () => {
    const trigger = renderMenu(makeThread(), makeStore(), {
      onRename: vi.fn(),
    });
    const menu = await openMenu(trigger);
    expect(menu).toHaveAttribute(
      "aria-label",
      "Actions for Review backend contract",
    );
  });

  it("offers pin, rename, settle, snooze, a neutral archive and a destructive force reset for an active thread", async () => {
    const trigger = renderMenu(makeThread(), makeStore(), {
      onRename: vi.fn(),
    });
    const menu = await openMenu(trigger);
    expect(within(menu).getByText("Pin")).toBeInTheDocument();
    expect(within(menu).getByText("Rename")).toBeInTheDocument();
    expect(within(menu).getByText("Settle")).toBeInTheDocument();
    expect(within(menu).getByText("Snooze…")).toBeInTheDocument();
    const rows = within(menu).getAllByRole("menuitem");
    // Force reset is the only red row, and the last one.
    const forceReset = within(menu).getByRole("menuitem", {
      name: "Force reset…",
    });
    expect(forceReset).toHaveAttribute("data-variant", "destructive");
    expect(rows.at(-1)).toBe(forceReset);
    expect(menu.querySelectorAll('[data-variant="destructive"]')).toHaveLength(1);
    // Archive is reversible, so it is neutral.
    expect(
      within(menu).getByRole("menuitem", { name: "Archive" }),
    ).toHaveAttribute("data-variant", "default");
    // Every row has an icon, so labels align.
    for (const row of rows) {
      expect(row.querySelector("svg")).not.toBeNull();
    }
    expect(within(menu).queryByText("Automation…")).toBeNull();
    expect(within(menu).queryByText("Wake now")).toBeNull();
    expect(within(menu).queryByText("Unsettle")).toBeNull();
    expect(within(menu).queryByText("Restore to Active")).toBeNull();
  });

  it("toggles pin state without navigating", async () => {
    const store = makeStore();
    const thread = makeThread({ pinned: true });
    const menu = await openMenu(renderMenu(thread, store));
    window.history.replaceState(null, "", "/threads/current");

    await userEvent.click(within(menu).getByText("Unpin"));

    expect(store.setThreadPinned).toHaveBeenCalledWith(thread, false);
    expect(window.location.pathname).toBe("/threads/current");
  });

  it("swaps snooze for wake on a snoozed thread", async () => {
    const trigger = renderMenu(
      makeThread({
        inventoryState: "snoozed",
        snoozedUntil: "2026-08-02T09:00:00.000Z",
      }),
      makeStore(),
    );
    const menu = await openMenu(trigger);
    expect(within(menu).getByText("Wake now")).toBeInTheDocument();
    expect(within(menu).queryByText("Snooze…")).toBeNull();
    expect(within(menu).getByText("Settle")).toBeInTheDocument();
    expect(within(menu).getByText("Archive")).toBeInTheDocument();
  });

  it("swaps settle for move-to-active on a settled thread", async () => {
    const trigger = renderMenu(
      makeThread({ inventoryState: "settled" }),
      makeStore(),
    );
    const menu = await openMenu(trigger);
    expect(within(menu).getByText("Unsettle")).toBeInTheDocument();
    expect(within(menu).queryByText("Settle")).toBeNull();
  });

  it("opens the automation page only when the thread has an automation", async () => {
    const onNavigate = vi.fn();
    const trigger = renderMenu(
      makeThread({
        automation: {
          status: "enabled",
          runMode: "same_thread",
          scheduleKind: "interval",
          schedule: {
            kind: "interval",
            anchorAt: "2026-07-30T00:00:00.000Z",
            everySeconds: 3_600,
          },
          misfirePolicy: "coalesce",
          promptPreview: "Review the repository.",
          revision: 1,
          hasPrecheck: false,
        },
      }),
      makeStore(),
      { onNavigate, threadRegistry: automationRegistry() },
    );
    const menu = await openMenu(trigger);
    expect(within(menu).queryByText("Automate…")).toBeNull();
    const item = within(menu).getByRole("menuitem", {
      name: "Automation…",
    });
    expect(item.querySelector(".lucide-repeat")).not.toBeNull();
    expect(item.querySelector(".lucide-calendar-clock")).toBeNull();
    await userEvent.click(item);
    expect(window.location.pathname).toBe("/automations/thread-1");
    expect(onNavigate).toHaveBeenCalled();
  });

  it("offers Automate… with the thread-actions gating and opens the editor to create one", async () => {
    const onNavigate = vi.fn();
    const menu = await openMenu(
      renderMenu(makeThread(), makeStore(), {
        onNavigate,
        threadRegistry: automationRegistry(),
      }),
    );
    const item = within(menu).getByRole("menuitem", { name: "Automate…" });
    expect(item).not.toHaveAttribute("data-disabled");
    expect(item.querySelector(".lucide-repeat")).not.toBeNull();
    await userEvent.click(item);
    expect(window.location.pathname).toBe("/automations/thread-1/edit");
    expect(onNavigate).toHaveBeenCalled();
  });

  it("disables Automate… with its reason when the thread cannot take an automation", async () => {
    const menu = await openMenu(
      renderMenu(makeThread(), makeStore(), {
        threadRegistry: automationRegistry({ attachAvailable: false }),
      }),
    );
    const item = within(menu).getByRole("menuitem", { name: /^Automate…/ });
    expect(item).toHaveAttribute("data-disabled");
    expect(item).toHaveAttribute(
      "title",
      "Automation requires an inactive, unarchived thread.",
    );
    expect(item).toHaveTextContent("Unavailable");
  });

  it("disables Automate… while the thread is offline or still loading", async () => {
    const offline = await openMenu(
      renderMenu(makeThread(), makeStore(), {
        threadRegistry: automationRegistry({ connection: "reconnecting" }),
      }),
    );
    expect(
      within(offline).getByRole("menuitem", { name: /^Automate…/ }),
    ).toHaveAttribute("data-disabled");
    cleanup();
    const loading = await openMenu(
      renderMenu(makeThread(), makeStore(), {
        threadRegistry: makeForkRegistry(vi.fn(), {
          status: "loading",
          snapshot: undefined,
        }),
      }),
    );
    const item = within(loading).getByRole("menuitem", { name: /^Automate…/ });
    expect(item).toHaveAttribute("data-disabled");
    expect(item).toHaveTextContent("Loading…");
  });

  it("leaves Automate… out where automation is unavailable or the row has no live thread", async () => {
    const unavailable = await openMenu(
      renderMenu(makeThread(), makeStore(), {
        threadRegistry: automationRegistry({ automationAvailable: false }),
      }),
    );
    expect(within(unavailable).queryByText("Automate…")).toBeNull();
    cleanup();
    const archiveOnly = await openMenu(renderMenu(makeThread(), makeStore()));
    expect(within(archiveOnly).queryByText("Automate…")).toBeNull();
  });

  it.each([false, true])(
    "copies the summary backend ID without a thread snapshot or registry (touch: %s)",
    async (touch) => {
      if (touch) stubTouchDensity();
      const user = userEvent.setup();
      const writeText = vi.spyOn(navigator.clipboard, "writeText");
      const trigger = renderMenu(
        makeThread({ backendSessionId: "provider-session-123" }), makeStore(),
      );
      let ids: HTMLElement;
      if (touch) {
        ids = await openTouchSheet(trigger);
        await drillIn(ids, "Copy ID");
      } else {
        ids = await openSubmenu(await openMenu(trigger), "Copy ID");
      }
      const backend = within(ids).getByRole("menuitem", { name: "Backend ID" });
      // A short preview of the ID trails the row.
      expect(backend).toHaveTextContent("provider");
      await user.click(backend);
      expect(writeText).toHaveBeenCalledWith("provider-session-123");
      expect(writeText).not.toHaveBeenCalledWith("thread-1");
    },
  );

  it("copies the Sedes thread ID from the Copy ID submenu", async () => {
    const user = userEvent.setup();
    const writeText = vi.spyOn(navigator.clipboard, "writeText");
    writeText.mockClear();
    const menu = await openMenu(
      renderMenu(makeThread({ backendSessionId: "provider-session-123" }), makeStore()),
    );
    const ids = await openSubmenu(menu, "Copy ID");
    expect(
      within(ids)
        .getAllByRole("menuitem")
        .map((row) => row.textContent),
    ).toEqual(["Thread IDthread-1", "Backend IDprovider"]);
    await user.click(within(ids).getByRole("menuitem", { name: "Thread ID" }));
    expect(writeText).toHaveBeenCalledWith("thread-1");
    expect(writeText).not.toHaveBeenCalledWith("provider-session-123");
  });
  it("disables backend ID copying for an unbound summary even with a loaded snapshot", async () => {
    const registry = makeForkRegistry(vi.fn());
    registry.get("thread-1").getSnapshot().snapshot!.backendSessionId = "stale-session";
    const trigger = renderMenu(makeThread(), makeStore(), { threadRegistry: registry });
    const ids = await openSubmenu(await openMenu(trigger), "Copy ID");
    const backend = within(ids).getByRole("menuitem", { name: "Backend ID" });
    expect(backend).toHaveAttribute("aria-disabled", "true");
    expect(backend).toHaveTextContent("Unavailable");
    expect(backend).not.toHaveTextContent("stale");
    expect(
      within(ids).getByRole("menuitem", { name: "Thread ID" }),
    ).not.toHaveAttribute("aria-disabled");
  });

  it("keeps settings copy available beside restore for an archived thread", async () => {
    const store = makeStore();
    const thread = makeThread({ inventoryState: "archived" });
    const trigger = renderMenu(thread, store);
    const menu = await openMenu(trigger);
    const items = within(menu).getAllByRole("menuitem");
    expect(items.map((item) => item.textContent)).toEqual([
      "Move to group",
      "Restore to Active",
      "New with same settings",
      "Copy ID",
    ]);
    expect(within(menu).queryByText("Archive")).toBeNull();
    expect(within(menu).queryByText("Force reset…")).toBeNull();
    await userEvent.click(
      within(menu).getByRole("menuitem", { name: "Restore to Active" }),
    );
    expect(store.mutateInventory).toHaveBeenCalledWith(thread, "restore");
  });

  it("shows group creation failures on the New group name field", async () => {
    stubTouchDensity();
    const store = makeStore();
    const createThreadGroup = vi
      .fn()
      .mockRejectedValue(new Error("A group with this name already exists."));
    Object.assign(store, { createThreadGroup });
    const sheet = await openTouchSheet(renderMenu(makeThread(), store));
    await drillIn(sheet, "Move to group");
    await userEvent.click(
      within(sheet).getByRole("menuitem", { name: "New group…" }),
    );
    const dialog = await screen.findByRole("dialog", { name: "New group" });
    await userEvent.click(within(dialog).getByRole("button", { name: "Create" }));
    const name = within(dialog).getByRole("textbox", { name: "Group name" });
    await waitFor(() =>
      expect(name).toHaveAccessibleDescription("A group with this name already exists."),
    );
    expect(createThreadGroup).toHaveBeenCalledWith(
      expect.objectContaining({ id: "thread-1" }),
      "Review backend contract",
    );
  });

  it("uses the same organize, lifecycle, creation, and archive section order", async () => {
    const renderRow = () =>
      render(
        <ThreadContextMenu
          thread={makeThread()}
          store={makeStore()}
          onRename={vi.fn()}
          threadRegistry={makeForkRegistry(vi.fn())}
        >
          <div data-testid="row-trigger">Row</div>
        </ThreadContextMenu>,
      );
    // Rows by label and separators as "|", in document order.
    const sequence = (container: Element) =>
      Array.from(container.children, (node) =>
        node.getAttribute("data-slot") === "context-menu-separator"
          ? "|"
          : node.getAttribute("role") === "menuitem"
            ? node.textContent?.trim()
            : node.getAttribute("data-slot"),
      );
    const rows = [
      "Rename",
      "Pin",
      "Move to group",
      "|",
      "Settle",
      "Snooze…",
      "|",
      "New with same settings",
      "Fork",
      "Copy ID",
      "|",
      "Archive",
      "Force reset…",
    ];

    const { unmount } = renderRow();
    const menu = await openMenu(screen.getByTestId("row-trigger"));
    // The header is the thread's name over its meta line, not "Thread actions".
    const header = menu.firstElementChild!;
    expect(header).toHaveAttribute("data-variant", "header");
    expect(header).toHaveTextContent(/^Review backend contractPi · updated /u);
    expect(sequence(menu)).toEqual(["context-menu-label", "|", ...rows]);
    const create = within(menu).getByRole("menuitem", {
      name: "New with same settings",
    });
    expect(create).toHaveTextContent(/^New with same settings$/u);
    expect(create).toHaveAttribute(
      "title",
      "Create a new thread from these settings",
    );

    await userEvent.keyboard("{Escape}");
    unmount();
    stubTouchDensity();
    renderRow();
    const sheet = await openTouchSheet(screen.getByTestId("row-trigger"));
    expect(
      within(sheet).getByRole("heading", { name: "Review backend contract" }),
    ).toBeVisible();
    const pane = sheet.querySelector('[data-slot="menu-sheet-pane"]')!;
    expect(sequence(pane)).toEqual(rows);
  });

  it.each(["running", "failed", "reconciling"] as const)(
    "offers force reset while the projected run state is %s",
    async (runState) => {
      const trigger = renderMenu(makeThread({ runState }), makeStore());
      const menu = await openMenu(trigger);
      expect(within(menu).getByText("Force reset…")).toBeInTheDocument();
    },
  );

  it("leads the meta line with the project and, when it needs one, the folder", async () => {
    const environment = {
      id: "environment-1",
      kind: "ssh" as const,
      label: { text: "Build host" },
      available: true,
      directoryBrowsing: "available" as const,
    };
    const location = {
      id: "workspace-1",
      environmentId: environment.id,
      projectId: "project-1",
      label: { text: "sedes-context" },
      displayPath: { text: "/src/sedes-context" },
      available: true,
    };
    const metaLineFor = async (
      workspaces: readonly (typeof location)[],
    ): Promise<string | null> => {
      const store = makeStore();
      const state = store.getSnapshot();
      store.getSnapshot.mockReturnValue({
        ...state,
        snapshot: {
          ...state.snapshot,
          environments: [environment, { ...environment, id: "environment-2" }],
          projects: [{ id: "project-1", name: "sedes", revision: 0 }],
          workspaces,
        },
      });
      const { unmount } = render(
        <ThreadContextMenu thread={makeThread()} store={store}>
          <div data-testid="row-trigger">Row</div>
        </ThreadContextMenu>,
      );
      const menu = await openMenu(screen.getByTestId("row-trigger"));
      const text = menu.firstElementChild!.textContent;
      await userEvent.keyboard("{Escape}");
      unmount();
      return text;
    };

    // The row's own environment never repeats in its meta line.
    expect(await metaLineFor([location])).toMatch(
      /^Review backend contractsedes · Pi · updated /u,
    );
    expect(
      await metaLineFor([
        location,
        {
          ...location,
          id: "workspace-2",
          label: { text: "sedes" },
          displayPath: { text: "/src/sedes" },
        },
      ]),
    ).toMatch(/^Review backend contractsedes › sedes-context · Pi · updated /u);
  });
});

describe("searchable Move to group", () => {
  function groupFixture(
    groupId: string | null = "current",
    groups = [
      { id: "current", name: "Current work", memberCount: 2 },
      { id: "backend", name: "Backend cleanup", memberCount: 4 },
      { id: "release", name: "Release planning", memberCount: 1 },
    ],
  ) {
    const thread = makeThread({ groupId });
    const store = makeStore();
    const state = store.getSnapshot();
    store.getSnapshot.mockReturnValue({
      ...state,
      snapshot: { ...state.snapshot, groups },
    });
    const assignThreadGroup = vi.fn().mockResolvedValue(undefined);
    const createThreadGroup = vi.fn().mockResolvedValue(undefined);
    const removeThreadGroup = vi.fn().mockResolvedValue(undefined);
    Object.assign(store, { assignThreadGroup, createThreadGroup, removeThreadGroup });
    return { thread, store, assignThreadGroup, createThreadGroup, removeThreadGroup };
  }

  /** Opens Move to group by keyboard and returns the submenu. */
  async function openGroups(trigger: HTMLElement) {
    const menu = await openMenu(trigger);
    within(menu).getByRole("menuitem", { name: "Move to group" }).focus();
    await userEvent.keyboard("{ArrowRight}");
    return screen.findByRole("menu", { name: "Move to group" });
  }

  const groupRows = (container: HTMLElement) =>
    within(container).queryAllByRole("menuitemradio").map((row) => row.textContent);

  it("lists the groups as radio rows, checks the current one, and assigns only a different group", async () => {
    const { thread, store, assignThreadGroup, removeThreadGroup } = groupFixture();
    const trigger = renderMenu(thread, store);
    let groups = await openSubmenu(await openMenu(trigger), "Move to group");
    expect(within(groups).getByRole("searchbox", { name: "Search groups" })).toHaveValue("");
    expect(groupRows(groups)).toEqual(["Current work", "Backend cleanup", "Release planning"]);
    expect(
      within(groups).getByRole("menuitemradio", { name: "Current work" }),
    ).toHaveAttribute("aria-checked", "true");
    expect(
      within(groups).getByRole("menuitemradio", { name: "Backend cleanup" }),
    ).toHaveAttribute("aria-checked", "false");
    expect(
      within(groups).getAllByRole("menuitem").map((row) => row.textContent),
    ).toEqual(["New group…", "Remove from group"]);
    // New group… leads the list, right under the search; Remove closes it.
    expect(
      Array.from(groups.querySelectorAll('[role="menuitem"], [role="menuitemradio"]'))
        .map((row) => row.textContent),
    ).toEqual(["New group…", "Current work", "Backend cleanup", "Release planning", "Remove from group"]);
    await userEvent.click(
      within(groups).getByRole("menuitemradio", { name: "Current work" }),
    );
    expect(assignThreadGroup).not.toHaveBeenCalled();

    groups = await openSubmenu(await openMenu(trigger), "Move to group");
    await userEvent.click(
      within(groups).getByRole("menuitemradio", { name: "Backend cleanup" }),
    );
    expect(assignThreadGroup).toHaveBeenCalledExactlyOnceWith(thread, "backend");
    expect(removeThreadGroup).not.toHaveBeenCalled();
  });

  it("removes the thread from its group, and offers removal only when grouped", async () => {
    const grouped = groupFixture();
    const trigger = renderMenu(grouped.thread, grouped.store);
    const groups = await openSubmenu(await openMenu(trigger), "Move to group");
    await userEvent.click(
      within(groups).getByRole("menuitem", { name: "Remove from group" }),
    );
    expect(grouped.removeThreadGroup).toHaveBeenCalledExactlyOnceWith(grouped.thread);
    expect(grouped.assignThreadGroup).not.toHaveBeenCalled();
    cleanup();

    const ungrouped = groupFixture(null);
    const ungroupedGroups = await openSubmenu(
      await openMenu(renderMenu(ungrouped.thread, ungrouped.store)),
      "Move to group",
    );
    expect(
      within(ungroupedGroups).queryByRole("menuitem", { name: "Remove from group" }),
    ).toBeNull();
    expect(
      within(ungroupedGroups)
        .getAllByRole("menuitemradio")
        .every((row) => row.getAttribute("aria-checked") === "false"),
    ).toBe(true);
  });

  it("focuses the search as the submenu opens and filters the groups as you type", async () => {
    const { thread, store, assignThreadGroup } = groupFixture();
    const groups = await openGroups(renderMenu(thread, store));
    const search = within(groups).getByRole("searchbox", { name: "Search groups" });
    await waitFor(() => expect(search).toHaveFocus());
    await userEvent.keyboard(" CLEANUP back ");
    expect(search).toHaveValue(" CLEANUP back ");
    expect(search).toHaveFocus();
    expect(groupRows(groups)).toEqual(["Backend cleanup"]);
    // New group… stays; nothing is chosen by typing alone.
    expect(within(groups).getByRole("menuitem", { name: "New group…" })).toBeVisible();
    expect(assignThreadGroup).not.toHaveBeenCalled();
    await userEvent.keyboard("{Enter}");
    expect(assignThreadGroup).toHaveBeenCalledExactlyOnceWith(thread, "backend");
    await waitFor(() => expect(groups).not.toBeInTheDocument());
  });

  it("picks nothing on Enter with an empty search", async () => {
    const { thread, store, assignThreadGroup, createThreadGroup } = groupFixture(null);
    const groups = await openGroups(renderMenu(thread, store));
    await waitFor(() =>
      expect(within(groups).getByRole("searchbox", { name: "Search groups" })).toHaveFocus(),
    );
    await userEvent.keyboard("{Enter}");
    expect(assignThreadGroup).not.toHaveBeenCalled();
    expect(createThreadGroup).not.toHaveBeenCalled();
    expect(groups).toBeInTheDocument();
  });

  it("moves between the search and the results with the arrow keys, and types from a row", async () => {
    const { thread, store, assignThreadGroup } = groupFixture(null);
    const groups = await openGroups(renderMenu(thread, store));
    const search = within(groups).getByRole("searchbox", { name: "Search groups" });
    await waitFor(() => expect(search).toHaveFocus());
    // The rows follow their order: New group… leads, then the groups.
    await userEvent.keyboard("{ArrowDown}");
    expect(within(groups).getByRole("menuitem", { name: "New group…" })).toHaveFocus();
    await userEvent.keyboard("{ArrowDown}");
    expect(within(groups).getByRole("menuitemradio", { name: "Current work" })).toHaveFocus();
    await userEvent.keyboard("{ArrowDown}");
    expect(within(groups).getByRole("menuitemradio", { name: "Backend cleanup" })).toHaveFocus();
    // Typing on a row goes to the search, not to the menu's typeahead.
    await userEvent.keyboard("r");
    expect(search).toHaveFocus();
    expect(search).toHaveValue("r");
    expect(groupRows(groups)).toEqual(["Current work", "Release planning"]);
    await userEvent.keyboard("{ArrowDown}");
    expect(within(groups).getByRole("menuitem", { name: "New group…" })).toHaveFocus();
    await userEvent.keyboard("{ArrowUp}");
    expect(search).toHaveFocus();
    // Up from the search wraps to the last row.
    await userEvent.keyboard("{ArrowUp}");
    expect(within(groups).getByRole("menuitemradio", { name: "Release planning" })).toHaveFocus();
    await userEvent.keyboard("{Enter}");
    expect(assignThreadGroup).toHaveBeenCalledExactlyOnceWith(thread, "release");
  });

  it("creates a group from a search that matches none, and moves the thread in one step", async () => {
    const { thread, store, assignThreadGroup, createThreadGroup } = groupFixture();
    const trigger = renderMenu(thread, store);
    let groups = await openGroups(trigger);
    await userEvent.type(within(groups).getByRole("searchbox", { name: "Search groups" }), "  Design review ");
    expect(groupRows(groups)).toEqual([]);
    const create = within(groups).getByRole("menuitem", { name: "Create group “Design review”" });
    expect(
      within(groups).getAllByRole("menuitem").map((row) => row.textContent),
    ).toEqual(["Create group “Design review”", "New group…", "Remove from group"]);
    await userEvent.click(create);
    expect(createThreadGroup).toHaveBeenCalledExactlyOnceWith(thread, "Design review");
    expect(assignThreadGroup).not.toHaveBeenCalled();
    await waitFor(() => expect(groups).not.toBeInTheDocument());

    // Enter from the search takes the Create row too.
    groups = await openGroups(trigger);
    await userEvent.type(within(groups).getByRole("searchbox", { name: "Search groups" }), "Ops{Enter}");
    expect(createThreadGroup).toHaveBeenLastCalledWith(thread, "Ops");
    expect(createThreadGroup).toHaveBeenCalledTimes(2);
  });

  it("shows a failed move under the row, keeping the menu's other actions", async () => {
    const { thread, store, assignThreadGroup } = groupFixture();
    assignThreadGroup.mockRejectedValueOnce(new Error("Group changed; try again."));
    const trigger = renderMenu(thread, store);
    const groups = await openSubmenu(await openMenu(trigger), "Move to group");
    await userEvent.click(within(groups).getByRole("menuitemradio", { name: "Release planning" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Group changed; try again.");
    const retry = await openSubmenu(await openMenu(trigger), "Move to group");
    await userEvent.click(within(retry).getByRole("menuitemradio", { name: "Release planning" }));
    expect(assignThreadGroup).toHaveBeenCalledTimes(2);
    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
  });

  it("blocks group changes while one is saving", async () => {
    const { thread, store, assignThreadGroup, createThreadGroup, removeThreadGroup } = groupFixture();
    const pending = deferred<void>();
    assignThreadGroup.mockReturnValueOnce(pending.promise);
    const trigger = renderMenu(thread, store);
    const groups = await openSubmenu(await openMenu(trigger), "Move to group");
    await userEvent.click(within(groups).getByRole("menuitemradio", { name: "Backend cleanup" }));
    const menu = await openMenu(trigger);
    expect(within(menu).getByRole("menuitem", { name: "Move to group" })).toHaveAttribute(
      "aria-disabled",
      "true",
    );
    expect(assignThreadGroup).toHaveBeenCalledOnce();
    expect(createThreadGroup).not.toHaveBeenCalled();
    expect(removeThreadGroup).not.toHaveBeenCalled();
    await act(async () => pending.resolve());
    await userEvent.keyboard("{Escape}");
    const reopened = await openMenu(trigger);
    expect(within(reopened).getByRole("menuitem", { name: "Move to group" })).not.toHaveAttribute(
      "aria-disabled",
    );
  });

  it("opens New group… as a create-only dialog prefilled with the search text", async () => {
    const { thread, store, createThreadGroup, assignThreadGroup } = groupFixture();
    const groups = await openGroups(renderMenu(thread, store));
    await userEvent.type(within(groups).getByRole("searchbox", { name: "Search groups" }), "Ops");
    await userEvent.click(within(groups).getByRole("menuitem", { name: "New group…" }));
    const dialog = await screen.findByRole("dialog", { name: "New group" });
    const name = within(dialog).getByRole("textbox", { name: "Group name" });
    expect(name).toHaveValue("Ops");
    await waitFor(() => expect(name).toHaveFocus());
    // Only the name: no existing groups, no search.
    expect(within(dialog).queryByRole("searchbox")).toBeNull();
    expect(within(dialog).queryByRole("combobox")).toBeNull();
    expect(within(dialog).queryByRole("option")).toBeNull();
    expect(within(dialog).queryByText("Backend cleanup")).toBeNull();
    const footer = dialog.querySelector<HTMLElement>('[data-slot="dialog-footer"]')!;
    expect(
      within(footer).getAllByRole("button").map((button) => button.textContent),
    ).toEqual(["Cancel", "Create"]);
    await userEvent.clear(name);
    await userEvent.type(name, "  Ops rotation {Enter}");
    expect(createThreadGroup).toHaveBeenCalledExactlyOnceWith(thread, "Ops rotation");
    expect(assignThreadGroup).not.toHaveBeenCalled();
    await waitFor(() => expect(dialog).not.toBeInTheDocument());
  });

  it("prefills New group… with the thread title and keeps empty and duplicate names on the field", async () => {
    const { thread, store, createThreadGroup } = groupFixture(null);
    const groups = await openGroups(renderMenu(thread, store));
    await userEvent.click(within(groups).getByRole("menuitem", { name: "New group…" }));
    const dialog = await screen.findByRole("dialog", { name: "New group" });
    const name = within(dialog).getByRole("textbox", { name: "Group name" });
    expect(name).toHaveValue(thread.title.text);
    await userEvent.clear(name);
    await userEvent.click(within(dialog).getByRole("button", { name: "Create" }));
    expect(name).toHaveAttribute("aria-invalid", "true");
    expect(name).toHaveAccessibleDescription("Enter a name for the group.");
    await userEvent.type(name, "backend CLEANUP ");
    expect(name).not.toHaveAttribute("aria-invalid");
    await userEvent.click(within(dialog).getByRole("button", { name: "Create" }));
    expect(name).toHaveAccessibleDescription("A group named “backend CLEANUP” already exists.");
    expect(name).toHaveFocus();
    expect(createThreadGroup).not.toHaveBeenCalled();
    expect(dialog).toBeInTheDocument();
  });

  it("shows the server's rejection on the name field and returns focus to the row on cancel", async () => {
    const { thread, store, createThreadGroup } = groupFixture();
    createThreadGroup.mockRejectedValueOnce(new Error("A group with this name already exists."));
    const returnFocusRef = { current: null as HTMLButtonElement | null };
    render(
      <ThreadContextMenu thread={thread} store={store} returnFocusRef={returnFocusRef}>
        <button ref={returnFocusRef} type="button">Groupable thread</button>
      </ThreadContextMenu>,
    );
    const trigger = screen.getByRole("button", { name: "Groupable thread" });
    const groups = await openGroups(trigger);
    await userEvent.click(within(groups).getByRole("menuitem", { name: "New group…" }));
    const dialog = await screen.findByRole("dialog", { name: "New group" });
    await userEvent.click(within(dialog).getByRole("button", { name: "Create" }));
    const name = within(dialog).getByRole("textbox", { name: "Group name" });
    await waitFor(() =>
      expect(name).toHaveAccessibleDescription("A group with this name already exists."),
    );
    expect(name).toHaveAttribute("aria-invalid", "true");
    await userEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(dialog).not.toBeInTheDocument());
    await waitFor(() => expect(trigger).toHaveFocus());
    // Reopening starts with an empty search.
    const reopened = await openGroups(trigger);
    expect(within(reopened).getByRole("searchbox", { name: "Search groups" })).toHaveValue("");
    expect(groupRows(reopened)).toHaveLength(3);
  });

  it("searches, creates from the search and opens New group… from the touch sheet", async () => {
    stubTouchDensity();
    const { thread, store, assignThreadGroup, createThreadGroup } = groupFixture();
    const trigger = renderMenu(thread, store);
    let sheet = await openTouchSheet(trigger);
    await drillIn(sheet, "Move to group");
    const search = within(sheet).getByRole("searchbox", { name: "Search groups" });
    // The sheet opens for browsing: the search waits for a tap.
    expect(search).not.toHaveFocus();
    await userEvent.type(search, "release");
    expect(groupRows(sheet)).toEqual(["Release planning"]);
    await userEvent.click(within(sheet).getByRole("menuitemradio", { name: "Release planning" }));
    expect(assignThreadGroup).toHaveBeenCalledExactlyOnceWith(thread, "release");
    await waitFor(() => expect(sheet).not.toBeInTheDocument());

    sheet = await openTouchSheet(trigger);
    await drillIn(sheet, "Move to group");
    await userEvent.type(within(sheet).getByRole("searchbox", { name: "Search groups" }), "Ops");
    await userEvent.click(within(sheet).getByRole("menuitem", { name: "Create group “Ops”" }));
    expect(createThreadGroup).toHaveBeenCalledExactlyOnceWith(thread, "Ops");
    await waitFor(() => expect(sheet).not.toBeInTheDocument());

    sheet = await openTouchSheet(trigger);
    await drillIn(sheet, "Move to group");
    await userEvent.type(within(sheet).getByRole("searchbox", { name: "Search groups" }), "Night");
    await userEvent.click(within(sheet).getByRole("menuitem", { name: "New group…" }));
    const dialog = await screen.findByRole("dialog", { name: "New group" });
    expect(sheet).not.toBeInTheDocument();
    expect(within(dialog).getByRole("textbox", { name: "Group name" })).toHaveValue("Night");
    expect(within(dialog).queryByRole("searchbox")).toBeNull();
  });
});

describe("ThreadContextMenu actions", () => {
  it("creates an independent thread with the source settings and navigates to it", async () => {
    const store = makeStore();
    const onNavigate = vi.fn();
    const thread = makeThread();
    const menu = await openMenu(renderMenu(thread, store, { onNavigate }));

    await userEvent.click(
      within(menu).getByRole("menuitem", {
        name: "New with same settings",
      }),
    );

    await waitFor(() =>
      expect(store.createThreadFromSettings).toHaveBeenCalledWith(thread.id, {
        title: "New thread",
      }),
    );
    await waitFor(() =>
      expect(window.location.pathname).toBe("/threads/thread-copy"),
    );
    expect(onNavigate).toHaveBeenCalledOnce();
  });

  it("shows a settings-copy failure in the overlay without navigating", async () => {
    const store = makeStore();
    store.createThreadFromSettings.mockRejectedValueOnce(
      new Error("The source settings changed."),
    );
    const thread = makeThread();
    const menu = await openMenu(renderMenu(thread, store));

    await userEvent.click(
      within(menu).getByRole("menuitem", {
        name: "New with same settings",
      }),
    );

    expect(
      await screen.findByRole("alert", {
        name: "",
      }),
    ).toHaveTextContent("The source settings changed.");
    expect(window.location.pathname).toBe("/");
  });

  it("disables settings copy when the source target is unavailable", async () => {
    const store = makeStore();
    const menu = await openMenu(
      renderMenu(makeThread({ available: false }), store),
    );

    const action = within(menu).getByRole("menuitem", {
      name: "New with same settings",
    });
    expect(action).toHaveAttribute("aria-disabled", "true");
    // A short reason on the row; the full one is its description.
    expect(action).toHaveTextContent("Unavailable");
    expect(action).toHaveAccessibleDescription(
      "The source thread target is unavailable.",
    );
    await userEvent.click(action);
    expect(store.createThreadFromSettings).not.toHaveBeenCalled();
  });

  it("shows pending feedback and blocks a duplicate settings copy", async () => {
    const pending = deferred<{
      threadId: string;
      workspaceId: string;
      targetId: string;
    }>();
    const store = makeStore();
    store.createThreadFromSettings.mockReturnValue(pending.promise);
    const thread = makeThread();
    const trigger = renderMenu(thread, store);
    const menu = await openMenu(trigger);

    await userEvent.click(
      within(menu).getByRole("menuitem", {
        name: "New with same settings",
      }),
    );
    expect(await screen.findByRole("status")).toHaveTextContent(
      "Creating thread…",
    );

    expect(document.querySelector(".thread-row-status")).toBeNull();
    expect(screen.getByRole("dialog")).toHaveTextContent("Creating thread…");
    expect(store.createThreadFromSettings).toHaveBeenCalledOnce();

    pending.resolve({
      threadId: "thread-copy",
      workspaceId: "workspace-1",
      targetId: "target-1",
    });
    await waitFor(() =>
      expect(window.location.pathname).toBe("/threads/thread-copy"),
    );
  });

  it("previews authoritative blockers and force resets with their fingerprint", async () => {
    const store = makeStore();
    const thread = makeThread({ runState: "running" });
    const trigger = renderMenu(thread, store);
    const menu = await openMenu(trigger);

    await userEvent.click(within(menu).getByText("Force reset…"));
    const dialog = await screen.findByRole("dialog", {
      name: "Force reset Sedes state?",
    });
    expect(store.getThreadForceResetImpact).toHaveBeenCalledWith(thread.id);
    expect(within(dialog).getByText("1 queued input")).toBeInTheDocument();
    expect(
      within(dialog).getByText("Provider-side effects may remain."),
    ).toBeInTheDocument();

    await userEvent.click(
      within(dialog).getByRole("button", { name: "Force reset" }),
    );
    await waitFor(() =>
      expect(store.forceResetThread).toHaveBeenCalledWith(
        thread.id,
        "a".repeat(64),
        expect.any(String),
      ),
    );
  });

  it("offers a compact settle action for an active sidebar row", async () => {
    const thread = makeThread();
    const { state, store } = sidebarFixture(thread);
    render(
      <InventorySidebar
        state={state}
        store={store}
        onNavigate={() => undefined}
        onOpenSettings={() => undefined}
      />,
    );

    const settle = screen.getByRole("button", {
      name: "Settle Review backend contract",
    });
    expect(settle.querySelector("svg")).not.toBeNull();
    await userEvent.click(settle);
    expect(store.mutateInventory).toHaveBeenCalledWith(thread, "settle", {
      expectedStashedPromptCount: 0,
    });
  });

  it("delivers lifecycle actions through mutateInventory", async () => {
    const store = makeStore();
    const thread = makeThread();
    const trigger = renderMenu(thread, store);
    let menu = await openMenu(trigger);
    await userEvent.click(within(menu).getByText("Settle"));
    expect(store.mutateInventory).toHaveBeenCalledWith(thread, "settle", {
      expectedStashedPromptCount: 0,
    });

    // Two descendants leave a choice: Archive hands the checked impact to
    // the choices dialog, which archives only this thread by default.
    menu = await openMenu(trigger);
    await userEvent.click(within(menu).getByRole("menuitem", { name: "Archive" }));
    const dialog = await screen.findByRole("dialog", {
      name: "Archive this thread",
    });
    expect(store.getThreadArchiveImpact).toHaveBeenCalledWith(thread.id);
    expect(store.mutateInventory).not.toHaveBeenCalledWith(
      thread,
      "archive",
      expect.anything(),
    );
    await userEvent.click(within(dialog).getByRole("button", { name: "Archive" }));
    await waitFor(() =>
      expect(store.mutateInventory).toHaveBeenCalledWith(thread, "archive", {
        expectedStashedPromptCount: 0,
        executionWorkspaceDisposition: { kind: "keep" },
      }),
    );
    expect(store.archiveThreadFamily).not.toHaveBeenCalled();
  });

  it("prompts for open-task disposition before settling", async () => {
    const store = makeStore();
    store.getThreadArchiveImpact.mockResolvedValueOnce({
      descendantCount: 0,
      pendingQuestions: { root: 0, descendants: 0 },
      stashedPrompts: { root: 0, descendants: 0 },
      openTasks: openTasks(2),
      executionWorkspace: { kind: "direct" },
      archiveOnly: { available: true },
      archiveAll: { available: true },
    });
    const thread = makeThread();
    const trigger = renderMenu(thread, store);
    const menu = await openMenu(trigger);

    await userEvent.click(within(menu).getByText("Settle"));
    const dialog = await screen.findByRole("dialog", {
      name: "Settle this thread",
    });
    expect(within(dialog).getByText(/2 open tasks/)).toBeInTheDocument();
    expect(store.mutateInventory).not.toHaveBeenCalledWith(thread, "settle");
    await userEvent.click(
      within(dialog).getByRole("button", { name: "Settle" }),
    );
    await waitFor(() =>
      expect(store.mutateInventory).toHaveBeenCalledWith(thread, "settle", {
        expectedStashedPromptCount: 0,
        openTaskDisposition: "move_to_project",
      }),
    );
  });

  it("requires confirmation before settling a thread with stashed prompts", async () => {
    const store = makeStore();
    store.getThreadArchiveImpact.mockResolvedValueOnce({
      descendantCount: 0,
      pendingQuestions: { root: 0, descendants: 0 },
      stashedPrompts: { root: 2, descendants: 0 },
      openTasks: openTasks(),
      executionWorkspace: { kind: "direct" },
      archiveOnly: { available: true },
      archiveAll: { available: true },
    });
    const thread = makeThread();
    const menu = await openMenu(renderMenu(thread, store));

    await userEvent.click(within(menu).getByText("Settle"));

    const dialog = await screen.findByRole("dialog", {
      name: "Settle this thread",
    });
    expect(within(dialog).getByText("2 stashed prompts")).toBeVisible();
    expect(
      within(dialog).queryByRole("radiogroup", { name: "Open task handling" }),
    ).not.toBeInTheDocument();
    expect(store.mutateInventory).not.toHaveBeenCalled();

    await userEvent.click(
      within(dialog).getByRole("button", { name: "Settle" }),
    );
    expect(store.mutateInventory).toHaveBeenCalledWith(thread, "settle", {
      expectedStashedPromptCount: 2,
    });
  });

  it("archives directly from the authoritative impact when there is nothing to choose", async () => {
    const store = makeStore();
    store.getThreadArchiveImpact.mockResolvedValueOnce({
      descendantCount: 0,
      pendingQuestions: { root: 0, descendants: 0 },
      stashedPrompts: { root: 0, descendants: 0 },
      openTasks: openTasks(),
      executionWorkspace: { kind: "direct" },
      archiveOnly: { available: true },
      archiveAll: { available: true },
    });
    const thread = makeThread();
    // The snapshot's count is stale; the authoritative impact decides.
    const trigger = renderMenu(thread, store, { familyDescendantCount: 2 });
    const menu = await openMenu(trigger);

    await userEvent.click(within(menu).getByRole("menuitem", { name: "Archive" }));
    await waitFor(() =>
      expect(store.mutateInventory).toHaveBeenCalledWith(thread, "archive", {
        expectedStashedPromptCount: 0,
      }),
    );
    expect(store.getThreadArchiveImpact).toHaveBeenCalledWith(thread.id);
    expect(
      screen.queryByRole("dialog", { name: "Archive this thread" }),
    ).not.toBeInTheDocument();
    expect(store.archiveThreadFamily).not.toHaveBeenCalled();
    await waitFor(() =>
      expect(
        screen.queryByTestId("thread-context-menu"),
      ).not.toBeInTheDocument(),
    );
  });

  it("uses single-thread wording when the authoritative impact has no descendants", async () => {
    const store = makeStore();
    store.getThreadArchiveImpact.mockResolvedValueOnce({
      descendantCount: 0,
      pendingQuestions: { root: 0, descendants: 0 },
      stashedPrompts: { root: 0, descendants: 0 },
      openTasks: openTasks(1),
      executionWorkspace: { kind: "direct" },
      archiveOnly: { available: true },
      archiveAll: { available: true },
    });
    const thread = makeThread();
    const menu = await openMenu(
      renderMenu(thread, store, { familyDescendantCount: 2 }),
    );

    await userEvent.click(within(menu).getByRole("menuitem", { name: "Archive" }));
    const dialog = await screen.findByRole("dialog", {
      name: "Archive this thread",
    });
    expect(dialog).toHaveAccessibleDescription(
      "Review backend contract. Archived threads leave the inventory until restored.",
    );
    expect(
      within(dialog).queryByRole("checkbox", {
        name: "Archive child and descendant forks",
      }),
    ).not.toBeInTheDocument();
    expect(screen.queryByText(/Archive thread and/)).not.toBeInTheDocument();
    expect(store.mutateInventory).not.toHaveBeenCalled();
    await userEvent.click(within(dialog).getByRole("button", { name: "Archive" }));
    await waitFor(() =>
      expect(store.mutateInventory).toHaveBeenCalledWith(thread, "archive", {
        expectedStashedPromptCount: 0,
        openTaskDisposition: "move_to_project",
        executionWorkspaceDisposition: { kind: "keep" },
      }),
    );
  });

  it.each(["row archive button", "context menu"] as const)(
    "resets Complete all after cancelling and reopening the archive dialog from the %s",
    async (surface) => {
      const thread = makeThread();
      const impact = {
        descendantCount: 1,
        pendingQuestions: { root: 0, descendants: 0 },
        stashedPrompts: { root: 0, descendants: 0 },
        openTasks: openTasks(1),
        executionWorkspace: { kind: "direct" },
        archiveOnly: { available: true },
        archiveAll: { available: true },
      };
      let store: ReturnType<typeof makeStore>;
      let openArchive: () => Promise<void>;
      if (surface === "row archive button") {
        const fixture = sidebarFixture(thread, { descendantCount: 1 });
        store = fixture.store;
        store.getThreadArchiveImpact.mockResolvedValue(impact);
        render(
          <InventorySidebar
            state={fixture.state}
            store={store}
            onNavigate={() => undefined}
            onOpenSettings={() => undefined}
          />,
        );
        openArchive = async () => {
          await userEvent.click(screen.getByTestId("thread-row-archive"));
        };
      } else {
        store = makeStore();
        store.getThreadArchiveImpact.mockResolvedValue(impact);
        const trigger = renderMenu(thread, store, { familyDescendantCount: 1 });
        openArchive = async () => {
          const menu = await openMenu(trigger);
          await userEvent.click(
            within(menu).getByRole("menuitem", { name: "Archive" }),
          );
        };
      }
      await openArchive();
      const dialog = await screen.findByRole("dialog", {
        name: "Archive this thread",
      });
      await userEvent.click(
        within(dialog).getByRole("radio", { name: "Complete all" }),
      );
      expect(
        within(dialog).getByRole("radio", { name: "Complete all" }),
      ).toBeChecked();
      await userEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
      await waitFor(() => expect(dialog).not.toBeInTheDocument());
      expect(store.mutateInventory).not.toHaveBeenCalled();
      expect(store.archiveThreadFamily).not.toHaveBeenCalled();

      await openArchive();
      const reopened = await screen.findByRole("dialog", {
        name: "Archive this thread",
      });
      expect(
        within(reopened).getByRole("radio", { name: "To project" }),
      ).toBeChecked();
      expect(
        within(reopened).getByRole("radio", { name: "Complete all" }),
      ).not.toBeChecked();
      await userEvent.click(
        within(reopened).getByRole("button", { name: "Archive" }),
      );
      await waitFor(() =>
        expect(store.mutateInventory).toHaveBeenCalledWith(thread, "archive", {
          expectedStashedPromptCount: 0,
          openTaskDisposition: "move_to_project",
          executionWorkspaceDisposition: { kind: "keep" },
        }),
      );
    },
  );
  it("opens archive choices in a dialog for a thread with descendants", async () => {
    const store = makeStore();
    store.getThreadArchiveImpact.mockResolvedValue({
      descendantCount: 2,
      pendingQuestions: { root: 0, descendants: 0 },
      stashedPrompts: { root: 1, descendants: 2 },
      openTasks: {
        familySnapshot: "b".repeat(64),
        root: {
          snapshot: "a".repeat(64),
          items: [
            {
              id: "task-root",
              title: "Root warning",
              threadId: "thread-1",
            },
          ],
          total: 1,
          omitted: 0,
        },
        descendants: {
          snapshot: "a".repeat(64),
          items: [
            {
              id: "task-child",
              title: "Descendant warning",
              threadId: "thread-2",
            },
          ],
          total: 2,
          omitted: 1,
        },
      },
      executionWorkspace: {
        kind: "isolated",
        workspaceAccess: "writable_clone",
        state: "ready",
        allocationRevision: 5,
        networkProfile: "isolated",
        hostPaths: { home: "/sandbox", workspace: "/sandbox/repo" },
        branch: "sedes/thread-1",
        gitStatus: {
          available: true,
          trackedChangeCount: 0,
          untrackedFileCount: 0,
          upstream: "origin/main",
          aheadCount: 0,
        },
      },
      archiveOnly: { available: true },
      archiveAll: { available: true },
    });
    const thread = makeThread();
    const trigger = renderMenu(thread, store, { familyDescendantCount: 2 });
    const menu = await openMenu(trigger);

    await userEvent.click(within(menu).getByRole("menuitem", { name: "Archive" }));
    const dialog = await screen.findByRole("dialog", {
      name: "Archive this thread",
    });
    expect(dialog).toHaveAccessibleDescription(
      "Review backend contract. Choose whether this thread's forked descendants should be archived too.",
    );
    // Only this thread by default: its own task, prompt and workspace.
    expect(within(dialog).getByText("Root warning")).toBeVisible();
    expect(within(dialog).queryByText("Descendant warning")).toBeNull();
    expect(within(dialog).getByText("1 stashed prompt")).toBeVisible();
    const deleteWorkspace = within(dialog).getByRole("radio", { name: "Delete" });
    expect(deleteWorkspace).toBeEnabled();
    await userEvent.click(deleteWorkspace);
    expect(deleteWorkspace).toHaveAttribute("aria-checked", "true");

    // Including descendants brings in their tasks and prompts and keeps the
    // isolated workspace, which only a single-thread archive may delete.
    const descendants = within(dialog).getByRole("checkbox", {
      name: "Archive child and descendant forks",
    });
    expect(descendants).not.toBeChecked();
    await userEvent.click(descendants);
    expect(within(dialog).getByText("Descendant warning")).toBeVisible();
    expect(within(dialog).getByText("Thread thread-2")).toBeVisible();
    expect(within(dialog).getByText("1 more task not shown")).toBeVisible();
    expect(
      within(dialog).getByText("3 stashed prompts, including 2 on descendants"),
    ).toBeVisible();
    expect(
      within(
        within(dialog).getByRole("radiogroup", {
          name: "Isolated workspace handling",
        }),
      ).getByRole("radio", { name: "Keep" }),
    ).toHaveAttribute("aria-checked", "true");
    expect(deleteWorkspace).toBeDisabled();
    expect(deleteWorkspace).toHaveAttribute(
      "title",
      "Delete is available when archiving only this thread",
    );
    await userEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(dialog).not.toBeInTheDocument());

    const reopenedMenu = await openMenu(trigger);
    await userEvent.click(
      within(reopenedMenu).getByRole("menuitem", { name: "Archive" }),
    );
    const reopened = await screen.findByRole("dialog", {
      name: "Archive this thread",
    });
    const workspaceHandling = within(reopened).getByRole("radiogroup", {
      name: "Isolated workspace handling",
    });
    expect(
      within(workspaceHandling).getByRole("radio", { name: "Keep" }),
    ).toHaveAttribute("aria-checked", "true");
    const reopenedDescendants = within(reopened).getByRole("checkbox", {
      name: "Archive child and descendant forks",
    });
    expect(reopenedDescendants).not.toBeChecked();
    await userEvent.click(reopenedDescendants);
    expect(store.getThreadArchiveImpact).toHaveBeenCalledTimes(2);
    expect(store.getThreadArchiveImpact).toHaveBeenCalledWith(thread.id);
    await userEvent.click(within(reopened).getByRole("button", { name: "Archive" }));
    await waitFor(() =>
      expect(store.archiveThreadFamily).toHaveBeenCalledWith(thread, {
        expectedStashedPromptCount: 3,
        executionWorkspaceDisposition: { kind: "keep" },
        openTaskDisposition: "move_to_project",
      }),
    );
    expect(store.mutateInventory).not.toHaveBeenCalledWith(
      thread,
      "archive",
      expect.anything(),
    );
  });

  it("closes the touch sheet before handing archive to its choices dialog", async () => {
    const store = makeStore();
    const thread = makeThread();
    stubTouchDensity();
    const trigger = renderMenu(thread, store, { familyDescendantCount: 2 });
    const sheet = await openTouchSheet(trigger);

    await userEvent.click(
      within(sheet).getByRole("menuitem", { name: "Archive" }),
    );
    const dialog = await screen.findByRole("dialog", {
      name: "Archive this thread",
    });
    expect(sheet).not.toBeInTheDocument();
    expect(store.getThreadArchiveImpact).toHaveBeenCalledWith(thread.id);
    const archiveDescendants = within(dialog).getByRole("checkbox", {
      name: "Archive child and descendant forks",
    });
    expect(archiveDescendants).not.toBeChecked();
    const archiveAll = within(dialog).getByRole("button", { name: "Archive" });
    await waitFor(() => expect(archiveAll).toBeEnabled());
    await userEvent.click(archiveDescendants);
    await userEvent.click(archiveAll);
    await waitFor(() =>
      expect(store.archiveThreadFamily).toHaveBeenCalledWith(thread, {
        expectedStashedPromptCount: 0,
        executionWorkspaceDisposition: { kind: "keep" },
      }),
    );
    expect(store.mutateInventory).not.toHaveBeenCalledWith(thread, "archive");
  });

  it.each([
    ["Snooze…", "Snooze this thread"],
    ["Force reset…", "Force reset Sedes state?"],
  ])(
    "closes the touch sheet before opening the %s confirmation",
    async (actionLabel, dialogName) => {
      stubTouchDensity();
      const sheet = await openTouchSheet(renderMenu(makeThread(), makeStore()));

      await userEvent.click(
        within(sheet).getByRole("menuitem", { name: actionLabel }),
      );

      expect(
        await screen.findByRole("dialog", { name: dialogName }),
      ).toBeInTheDocument();
      expect(sheet).not.toBeInTheDocument();
    },
  );

  it("guards repeated lifecycle activation and keeps rejection visible", async () => {
    let rejectMutation!: (reason: Error) => void;
    const mutation = new Promise<void>((_, reject) => {
      rejectMutation = reject;
    });
    const store = makeStore();
    store.mutateInventory.mockReturnValue(mutation);
    const trigger = renderMenu(makeThread(), store, { onRename: vi.fn() });

    const menu = await openMenu(trigger);
    await userEvent.click(within(menu).getByText("Settle"));
    const reopened = await openMenu(trigger);
    await userEvent.click(within(reopened).getByText("Settle"));
    expect(store.mutateInventory).toHaveBeenCalledTimes(1);

    rejectMutation(new Error("Inventory update failed."));
    await waitFor(() =>
      expect(screen.getByRole("alert")).toHaveTextContent(
        "Inventory update failed.",
      ),
    );
    expect(screen.getAllByRole("alert")).toHaveLength(1);
  });

  it("opens the snooze dialog and delivers the chosen deadline", async () => {
    const store = makeStore();
    const thread = makeThread();
    const trigger = renderMenu(thread, store);
    const menu = await openMenu(trigger);
    await userEvent.click(within(menu).getByText("Snooze…"));
    expect(await screen.findByText("Snooze this thread")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Snooze" }));
    await waitFor(() =>
      expect(store.mutateInventory).toHaveBeenCalledWith(
        thread,
        "snooze",
        expect.objectContaining({ snoozedUntil: expect.any(String) }),
      ),
    );
  });

  it("mounts no dialog roots for a row whose dialogs have never opened", () => {
    const matchMedia = vi.mocked(window.matchMedia);
    const densityReads = () =>
      matchMedia.mock.calls.filter(([query]) => query === TOUCH_DENSITY_QUERY)
        .length;
    // A lone density consumer is the floor: the menu's own presentation.
    function DensityProbe() {
      useTouchDensity();
      return null;
    }
    const probe = render(<DensityProbe />);
    const probeReads = densityReads();
    probe.unmount();
    matchMedia.mockClear();

    renderMenu(makeThread(), makeStore());

    // Every mounted DialogContent reads the density too.
    expect(densityReads()).toBe(probeReads);
  });

  it("keeps a dialog mounted after it closes, as it was before opening", async () => {
    const store = makeStore();
    const trigger = renderMenu(makeThread(), store);
    await userEvent.click(within(await openMenu(trigger)).getByText("Snooze…"));
    let dialog = await screen.findByRole("dialog", { name: "Snooze this thread" });
    await userEvent.type(
      within(dialog).getByPlaceholderText("What should I remember when I return?"),
      "Check the release notes",
    );
    await userEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(dialog).not.toBeInTheDocument());

    await userEvent.click(within(await openMenu(trigger)).getByText("Snooze…"));
    dialog = await screen.findByRole("dialog", { name: "Snooze this thread" });
    expect(
      within(dialog).getByPlaceholderText("What should I remember when I return?"),
    ).toHaveValue("Check the release notes");
    expect(store.mutateInventory).not.toHaveBeenCalled();
  });
});

function sidebarFixture(
  thread: NormalizedApplicationThreadSummary,
  options: { readonly descendantCount?: number } = {},
): {
  state: ApplicationClientState;
  store: ReturnType<typeof makeStore>;
} {
  const snapshot = {
    advisories: [],
    environments: [
      {
        id: "environment-1",
        kind: "local" as const,
        label: { text: "Machine" },
        available: true,
        directoryBrowsing: "unavailable" as const,
      },
    ],
    projects: [{ id: "project-1", name: "Project", revision: 0 }],
    workspaces: [
      {
        id: "workspace-1",
        environmentId: "environment-1",
        projectId: "project-1",
        label: { text: "Sedes" },
        displayPath: { text: "/workspace/sedes" },
        available: true,
      },
    ],
    threads: [thread],
    executionTargets: [
      {
        id: "target-1",
        environmentId: "environment-1",
        label: { text: "Local SDK" },
        backend: { label: { text: "Pi" }, brand: "pi" as const },
        workspaceExecution: { kind: "direct_only" as const },
        available: true,
      },
    ],
    defaultNewThreadTargetId: "target-1",
    forkOrigins: [],
    lineagePlacements: [],
    groups: [],
    lineageFamilies:
      (options.descendantCount ?? 0) > 0
        ? [
            {
              sourceThreadId: thread.id,
              descendantCount: options.descendantCount!,
            },
          ]
        : [],
    counts: { active: 1, snoozed: 0, settled: 0, archived: 0 },
    tasks: [],
  };
  const state: ApplicationClientState = {
    status: "ready",
    connection: "connected",
    authoritative: true,
    providerPulseEnabled: false, experimentalUsageEnabled: false,
    search: "",
    descendantPages: {},
    pendingThreadConfigurationCopySourceIds: [],
    snapshot: snapshot as ApplicationClientState["snapshot"],
    visibleThreads: [thread],
  };
  const store = makeStore();
  store.getSnapshot.mockReturnValue(state);
  store.getThreadArchiveImpact.mockResolvedValue({
    descendantCount: options.descendantCount ?? 0,
    pendingQuestions: { root: 0, descendants: 0 },
    stashedPrompts: { root: 0, descendants: 0 },
    openTasks: openTasks(),
    executionWorkspace: { kind: "direct" },
    archiveOnly: { available: true },
    archiveAll: { available: true },
  });
  return { state, store };
}

describe("sidebar row rename (context menu)", () => {
  async function startRename(thread = makeThread(), mobile = false) {
    vi.stubGlobal(
      "matchMedia",
      vi.fn(() => ({
        matches: mobile,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      })),
    );
    const { state, store } = sidebarFixture(thread);
    render(
      <InventorySidebar
        state={state}
        store={store}
        selectedThreadId="thread-1"
        onNavigate={() => undefined}
        onOpenSettings={() => undefined}
      />,
    );
    const row = screen.getByTestId("thread-row");
    const menu = mobile ? await openTouchSheet(row) : await openMenu(row);
    await userEvent.click(within(menu).getByText("Rename"));
    const input = await screen.findByTestId("thread-row-rename");
    expect(input).toHaveAccessibleName("Thread title");
    return { store, input, thread };
  }

  it.each([
    ["mouse", false],
    ["touch", false],
    ["pen", false],
    ["mouse", true],
    ["touch", true],
    ["pen", true],
  ] as const)(
    "preserves native rename gestures for %s (mobile: %s) without opening card actions",
    async (pointerType, mobile) => {
      const { input } = await startRename(makeThread(), mobile);
      expect(fireEvent.pointerDown(input, { pointerType, button: 0 })).toBe(true);
      await act(() => new Promise<void>((resolve) => setTimeout(resolve, 800)));
      expect(fireEvent.contextMenu(input)).toBe(true);
      fireEvent.pointerUp(input, { pointerType, button: 0 });
      expect(fireEvent.click(input)).toBe(true);
      expect(fireEvent.doubleClick(input)).toBe(true);
      expect(screen.queryByTestId("thread-context-menu")).toBeNull();
      expect(screen.queryByTestId("thread-actions-sheet")).toBeNull();
      expect(input).toHaveFocus();
    },
  );

  it("commits an edited title through the application store", async () => {
    const { store, input, thread } = await startRename();
    await userEvent.clear(input);
    await userEvent.type(input, "Sharper title{Enter}");
    expect(store.renameThread).toHaveBeenCalledWith(thread, "Sharper title");
    await waitFor(() =>
      expect(screen.queryByTestId("thread-row-rename")).toBeNull(),
    );
    expect(screen.getByText("Review backend contract")).toBeInTheDocument();
  });

  it("cancels with Escape without delivering a rename", async () => {
    const { store, input } = await startRename();
    await userEvent.clear(input);
    await userEvent.type(input, "Discarded title");
    fireEvent.keyDown(input, { key: "Escape" });
    expect(screen.queryByTestId("thread-row-rename")).toBeNull();
    expect(store.renameThread).not.toHaveBeenCalled();
    expect(screen.getByText("Review backend contract")).toBeInTheDocument();
  });

  // The input replaces the row link, so a keyboard commit/cancel would leave
  // focus on a removed node and drop the caret to <body> without this.
  it("returns focus to the row link after an Escape cancel", async () => {
    const { input } = await startRename();
    fireEvent.keyDown(input, { key: "Escape" });
    await waitFor(() =>
      expect(screen.getByTestId("thread-row-link")).toHaveFocus(),
    );
  });

  it("returns focus to the row link after an Enter commit", async () => {
    const { input } = await startRename();
    await userEvent.clear(input);
    await userEvent.type(input, "Sharper title{Enter}");
    await waitFor(() =>
      expect(screen.getByTestId("thread-row-link")).toHaveFocus(),
    );
  });

  it("leaves focus alone when the rename commits through a blur", async () => {
    const { input } = await startRename();
    const elsewhere = document.createElement("button");
    document.body.append(elsewhere);
    elsewhere.focus();
    fireEvent.blur(input);
    await waitFor(() =>
      expect(screen.queryByTestId("thread-row-rename")).toBeNull(),
    );
    expect(elsewhere).toHaveFocus();
    elsewhere.remove();
  });

  it("reverts the title and surfaces a quiet error when the rename fails", async () => {
    const { store, input } = await startRename();
    store.renameThread.mockRejectedValueOnce(
      new Error("The thread could not be renamed."),
    );
    await userEvent.clear(input);
    await userEvent.type(input, "Rejected title{Enter}");
    await waitFor(() =>
      expect(screen.queryByTestId("thread-row-rename")).toBeNull(),
    );
    expect(screen.getByRole("alert")).toHaveTextContent(
      "The thread could not be renamed.",
    );
    expect(screen.getByText("Review backend contract")).toBeInTheDocument();
  });
});

describe("sidebar row archive control", () => {
  it("exposes an accessible archive icon outside the row navigation link", () => {
    const thread = makeThread();
    const { state, store } = sidebarFixture(thread);
    render(
      <InventorySidebar
        state={state}
        store={store}
        selectedThreadId="thread-1"
        onNavigate={() => undefined}
        onOpenSettings={() => undefined}
      />,
    );

    const archive = screen.getByTestId("thread-row-archive");
    expect(archive).toHaveAccessibleName("Archive Review backend contract");
    expect(archive).toHaveAttribute("title", "Archive");
    // Outside the nav button so archive never triggers row navigation.
    expect(archive.closest("[data-testid=thread-row-link]")).toBeNull();
    expect(
      screen.getByTestId("thread-row").querySelector(".thread-row-trailing"),
    ).not.toBeNull();
  });

  it("archives a childless row immediately and navigates home when selected", async () => {
    window.history.pushState(null, "", "/threads/thread-1");
    const thread = makeThread();
    const { state, store } = sidebarFixture(thread);
    const onNavigate = vi.fn();
    render(
      <InventorySidebar
        state={state}
        store={store}
        selectedThreadId="thread-1"
        onNavigate={onNavigate}
        onOpenSettings={() => undefined}
      />,
    );

    await userEvent.click(screen.getByTestId("thread-row-archive"));
    // No descendants: the button archives directly without opening the
    // choice dropdown.
    expect(store.mutateInventory).toHaveBeenCalledWith(thread, "archive", {
      expectedStashedPromptCount: 0,
    });
    expect(store.getThreadArchiveImpact).toHaveBeenCalledWith(thread.id);
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    await waitFor(() => expect(window.location.pathname).toBe("/"));
    expect(onNavigate).toHaveBeenCalledOnce();
  });

  it("archives directly when the authoritative impact finds no unarchived descendants", async () => {
    const thread = makeThread();
    const { state, store } = sidebarFixture(thread, { descendantCount: 2 });
    store.getThreadArchiveImpact.mockResolvedValueOnce({
      descendantCount: 0,
      pendingQuestions: { root: 0, descendants: 0 },
      stashedPrompts: { root: 0, descendants: 0 },
      openTasks: openTasks(),
      executionWorkspace: { kind: "direct" },
      archiveOnly: { available: true },
      archiveAll: { available: true },
    });
    render(
      <InventorySidebar
        state={state}
        store={store}
        onNavigate={() => undefined}
        onOpenSettings={() => undefined}
      />,
    );

    await userEvent.click(screen.getByTestId("thread-row-archive"));

    await waitFor(() =>
      expect(store.mutateInventory).toHaveBeenCalledWith(thread, "archive", {
        expectedStashedPromptCount: 0,
      }),
    );
    expect(store.archiveThreadFamily).not.toHaveBeenCalled();
    expect(
      screen.queryByRole("dialog", { name: "Archive this thread" }),
    ).not.toBeInTheDocument();
  });

  it("retains a dismissed archive across drawer removal and another entry point", async () => {
    const thread = makeThread();
    const { state, store } = sidebarFixture(thread, { descendantCount: 2 });
    const impact = await store.getThreadArchiveImpact(thread.id);
    const pending = deferred<typeof impact>();
    store.getThreadArchiveImpact.mockClear();
    store.getThreadArchiveImpact.mockReturnValueOnce(pending.promise);
    const drawer = render(<InventorySidebar state={state} store={store}
      onNavigate={() => undefined} onOpenSettings={() => undefined} />);
    await userEvent.click(screen.getByTestId("thread-row-archive"));
    expect(await screen.findByRole("status")).toHaveTextContent("Archiving thread…");
    expect(screen.queryByRole("button", { name: "Cancel" })).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    drawer.unmount();
    // The row's hook is gone. A new context-menu instance must share its guard.
    const trigger = renderMenu(thread, store);
    const menu = await openMenu(trigger);
    await userEvent.click(within(menu).getByRole("menuitem", { name: "Archive" }));
    expect(store.getThreadArchiveImpact).toHaveBeenCalledTimes(1);
    await act(async () => { pending.resolve(impact); });
    const dialog = await screen.findByRole("dialog", { name: "Archive this thread" });
    expect(within(dialog).getByText(thread.title.text)).toBeVisible();
    expect(store.mutateInventory).not.toHaveBeenCalled();
    expect(store.archiveThreadFamily).not.toHaveBeenCalled();
  });

  it("preserves attached archive navigation when its inventory event removes the initiating row", async () => {
    window.history.pushState(null, "", "/threads/thread-1");
    const thread = makeThread();
    const { state, store } = sidebarFixture(thread);
    const mutation = deferred<void>();
    store.mutateInventory.mockReturnValueOnce(mutation.promise);
    const onNavigate = vi.fn();
    const view = render(<InventorySidebar state={state} store={store}
      selectedThreadId={thread.id} onNavigate={onNavigate} onOpenSettings={() => undefined} />);
    await userEvent.click(screen.getByTestId("thread-row-archive"));
    await waitFor(() => expect(store.mutateInventory).toHaveBeenCalledOnce());
    // Inventory publication can arrive before the HTTP mutation response.
    const archivedState = { ...state, visibleThreads: [], snapshot: { ...state.snapshot!, threads: [] } };
    view.rerender(<InventorySidebar state={archivedState} store={store}
      selectedThreadId={thread.id} onNavigate={onNavigate} onOpenSettings={() => undefined} />);
    expect(screen.queryByTestId("thread-row-archive")).toBeNull();
    await act(async () => { mutation.resolve(); });
    await waitFor(() => expect(window.location.pathname).toBe("/"));
    expect(onNavigate).toHaveBeenCalledOnce();
  });

  it("retains an archive failure after the drawer containing its row closes", async () => {
    const thread = makeThread();
    const { state, store } = sidebarFixture(thread);
    let fail!: (error: Error) => void;
    store.mutateInventory.mockReturnValueOnce(new Promise((_, reject) => { fail = reject; }));
    const drawer = render(<InventorySidebar state={state} store={store}
      onNavigate={() => undefined} onOpenSettings={() => undefined} />);
    await userEvent.click(screen.getByTestId("thread-row-archive"));
    await waitFor(() => expect(store.mutateInventory).toHaveBeenCalledOnce());
    await userEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    drawer.unmount();
    await act(async () => { fail(new Error("Archive request failed")); });
    expect(await screen.findByRole("alert")).toHaveTextContent("Archive request failed");
    expect(screen.getByRole("dialog", { name: "Could not archive thread" })).toHaveTextContent(thread.title.text);
  });

  it("disables family archive when the authoritative impact reports a blocked descendant", async () => {
    const thread = makeThread();
    const { state, store } = sidebarFixture(thread, { descendantCount: 2 });
    store.getThreadArchiveImpact.mockResolvedValueOnce({
      descendantCount: 2,
      pendingQuestions: { root: 0, descendants: 0 },
      stashedPrompts: { root: 0, descendants: 0 },
      openTasks: openTasks(),
      executionWorkspace: { kind: "direct" },
      archiveOnly: { available: true },
      archiveAll: {
        available: false,
        unavailableReason: "A descendant is running and cannot be archived.",
      },
    });
    render(
      <InventorySidebar
        state={state}
        store={store}
        onNavigate={() => undefined}
        onOpenSettings={() => undefined}
      />,
    );

    await userEvent.click(screen.getByTestId("thread-row-archive"));
    const dialog = await screen.findByRole("dialog", {
      name: "Archive this thread",
    });
    const archive = within(dialog).getByRole("button", { name: "Archive" });
    await userEvent.click(
      within(dialog).getByRole("checkbox", {
        name: "Archive child and descendant forks",
      }),
    );
    // The family choice is blocked, with its reason as the action's description.
    expect(archive).toBeDisabled();
    expect(within(dialog).getByRole("status")).toHaveTextContent(
      "A descendant is running and cannot be archived.",
    );
    expect(archive).toHaveAccessibleDescription(
      "A descendant is running and cannot be archived.",
    );
    await userEvent.click(archive);
    expect(store.archiveThreadFamily).not.toHaveBeenCalled();

    // Archiving only this thread stays available.
    await userEvent.click(
      within(dialog).getByRole("checkbox", {
        name: "Archive child and descendant forks",
      }),
    );
    expect(archive).toBeEnabled();
    await userEvent.click(archive);
    await waitFor(() =>
      expect(store.mutateInventory).toHaveBeenCalledWith(thread, "archive", {
        expectedStashedPromptCount: 0,
        executionWorkspaceDisposition: { kind: "keep" },
      }),
    );
    expect(store.archiveThreadFamily).not.toHaveBeenCalled();
  });

  it("uses the visible untitled fallback in the archive button name", () => {
    const { state, store } = sidebarFixture(
      makeThread({ title: { text: "" } }),
    );
    render(
      <InventorySidebar
        state={state}
        store={store}
        onNavigate={() => undefined}
        onOpenSettings={() => undefined}
      />,
    );

    expect(
      screen.getByRole("button", { name: "Archive Untitled thread" }),
    ).toBeInTheDocument();
  });

  it("surfaces a quiet error when archive fails and does not navigate", async () => {
    window.history.pushState(null, "", "/threads/thread-1");
    const thread = makeThread();
    const { state, store } = sidebarFixture(thread);
    store.mutateInventory.mockRejectedValueOnce(
      new Error("The thread could not be archived."),
    );
    render(
      <InventorySidebar
        state={state}
        store={store}
        selectedThreadId="thread-1"
        onNavigate={() => undefined}
        onOpenSettings={() => undefined}
      />,
    );

    await userEvent.click(screen.getByTestId("thread-row-archive"));
    await waitFor(() =>
      expect(screen.getByRole("alert")).toHaveTextContent(
        "The thread could not be archived.",
      ),
    );
    expect(window.location.pathname).toBe("/threads/thread-1");
  });

  it("explains a failed archive preflight and retries from the overlay", async () => {
    const thread = makeThread();
    const { state, store } = sidebarFixture(thread, { descendantCount: 2 });
    store.getThreadArchiveImpact
      .mockRejectedValueOnce(new Error("Activity check unavailable."))
      .mockResolvedValueOnce({
        descendantCount: 0,
        pendingQuestions: { root: 0, descendants: 0 },
        stashedPrompts: { root: 0, descendants: 0 },
        openTasks: openTasks(),
        executionWorkspace: { kind: "direct" },
        archiveOnly: { available: true },
        archiveAll: { available: true },
      });
    render(
      <InventorySidebar
        state={state}
        store={store}
        onNavigate={() => undefined}
        onOpenSettings={() => undefined}
      />,
    );

    await userEvent.click(screen.getByTestId("thread-row-archive"));
    const retry = await screen.findByRole("button", { name: "Retry" });
    expect(screen.getByRole("alert")).toHaveTextContent("Activity check unavailable.");
    await userEvent.click(retry);
    await waitFor(() =>
      expect(store.getThreadArchiveImpact).toHaveBeenCalledTimes(2),
    );
    // The retried check finds nothing to choose and archives directly.
    await waitFor(() =>
      expect(store.mutateInventory).toHaveBeenCalledWith(thread, "archive", {
        expectedStashedPromptCount: 0,
      }),
    );
    expect(screen.queryByRole("dialog", { name: "Archive this thread" })).not.toBeInTheDocument();
  });

  it("does not double-fire archive while a mutation is pending", async () => {
    let resolveMutation!: () => void;
    const mutation = new Promise<void>((resolve) => {
      resolveMutation = resolve;
    });
    const thread = makeThread();
    const { state, store } = sidebarFixture(thread);
    store.mutateInventory.mockReturnValue(mutation);
    render(
      <InventorySidebar
        state={state}
        store={store}
        selectedThreadId="thread-1"
        onNavigate={() => undefined}
        onOpenSettings={() => undefined}
      />,
    );

    const archive = screen.getByTestId("thread-row-archive");
    await userEvent.click(archive);
    expect(archive).toBeDisabled();
    fireEvent.click(archive);
    expect(store.mutateInventory).toHaveBeenCalledTimes(1);
    resolveMutation();
    await waitFor(() => expect(archive).not.toBeDisabled());
  });

  it("serializes quick and archive lifecycle actions for one row", async () => {
    let resolveFirst!: () => void;
    const first = new Promise<void>((resolve) => {
      resolveFirst = resolve;
    });
    const thread = makeThread({ inventoryState: "settled" });
    const { state, store } = sidebarFixture(thread);
    store.mutateInventory.mockReturnValueOnce(first);
    render(
      <InventorySidebar
        state={state}
        store={store}
        onNavigate={() => undefined}
        onOpenSettings={() => undefined}
      />,
    );

    const quick = screen.getByRole("button", {
      name: "Unsettle Review backend contract",
    });
    const archive = screen.getByRole("button", {
      name: "Archive Review backend contract",
    });
    await userEvent.click(quick);
    expect(quick).toBeDisabled();
    expect(archive).toBeDisabled();
    await userEvent.click(archive);
    expect(store.mutateInventory).toHaveBeenCalledTimes(1);
    resolveFirst();
    await waitFor(() => expect(archive).not.toBeDisabled());

    let resolveSecond!: () => void;
    store.mutateInventory.mockReturnValueOnce(
      new Promise<void>((resolve) => {
        resolveSecond = resolve;
      }),
    );
    await userEvent.click(archive);
    expect(quick).toBeDisabled();
    expect(store.mutateInventory).toHaveBeenCalledTimes(2);
    resolveSecond();
    await waitFor(() => expect(quick).not.toBeDisabled());
  });

  it("scopes stash wording and counts to the chosen archive in the dialog", async () => {
    const thread = makeThread();
    const { state, store } = sidebarFixture(thread, { descendantCount: 1 });
    store.getThreadArchiveImpact.mockResolvedValue({
      descendantCount: 1,
      pendingQuestions: { root: 0, descendants: 0 },
      stashedPrompts: { root: 1, descendants: 2 },
      openTasks: openTasks(),
      executionWorkspace: isolatedWorkspace(5),
      archiveOnly: { available: true },
      archiveAll: { available: true },
    });
    render(
      <InventorySidebar
        state={state}
        store={store}
        onNavigate={() => undefined}
        onOpenSettings={() => undefined}
      />,
    );

    const trigger = screen.getByTestId("thread-row-archive");
    await userEvent.click(trigger);
    const dialog = await screen.findByRole("dialog", {
      name: "Archive this thread",
    });
    // Only this thread: its one prompt, and the workspace may be deleted.
    expect(within(dialog).getByText("1 stashed prompt")).toBeVisible();
    expect(
      within(dialog).getByText("It will remain attached to the archived thread."),
    ).toBeVisible();
    expect(
      within(dialog).queryByText(/whichever threads you archive/),
    ).not.toBeInTheDocument();
    await userEvent.click(within(dialog).getByRole("radio", { name: "Delete" }));
    await userEvent.click(within(dialog).getByRole("button", { name: "Archive" }));
    await waitFor(() =>
      expect(store.mutateInventory).toHaveBeenCalledWith(thread, "archive", {
        expectedStashedPromptCount: 1,
        executionWorkspaceDisposition: {
          kind: "delete",
          expectedRevision: 5,
          operationId: expect.any(String),
        },
      }),
    );
    await waitFor(() => expect(dialog).not.toBeInTheDocument());

    await userEvent.click(trigger);
    const reopened = await screen.findByRole("dialog", {
      name: "Archive this thread",
    });
    expect(
      within(
        within(reopened).getByRole("radiogroup", {
          name: "Isolated workspace handling",
        }),
      ).getByRole("radio", { name: "Keep" }),
    ).toHaveAttribute("aria-checked", "true");
    // The family: all three prompts, and the workspace is kept.
    await userEvent.click(
      within(reopened).getByRole("checkbox", {
        name: "Archive child and descendant forks",
      }),
    );
    expect(
      within(reopened).getByText("3 stashed prompts, including 2 on descendants"),
    ).toBeVisible();
    expect(
      within(reopened).getByText("They will remain attached to the archived threads."),
    ).toBeVisible();
    expect(within(reopened).getByRole("radio", { name: "Delete" })).toBeDisabled();
    await userEvent.click(within(reopened).getByRole("button", { name: "Archive" }));
    await waitFor(() =>
      expect(store.archiveThreadFamily).toHaveBeenCalledWith(thread, {
        expectedStashedPromptCount: 3,
        executionWorkspaceDisposition: { kind: "keep" },
      }),
    );
  });

  it("re-checks the impact before offering choices again when reopened", async () => {
    const choices = {
      descendantCount: 1,
      pendingQuestions: { root: 0, descendants: 0 },
      stashedPrompts: { root: 0, descendants: 0 },
      openTasks: openTasks(),
      executionWorkspace: { kind: "direct" as const },
      archiveOnly: { available: true as const },
      archiveAll: { available: true as const },
    };
    const refresh = deferred<typeof choices>();
    const thread = makeThread();
    const { state, store } = sidebarFixture(thread, { descendantCount: 1 });
    store.getThreadArchiveImpact
      .mockResolvedValueOnce(choices)
      .mockReturnValueOnce(refresh.promise);
    render(
      <InventorySidebar
        state={state}
        store={store}
        onNavigate={() => undefined}
        onOpenSettings={() => undefined}
      />,
    );

    const trigger = screen.getByTestId("thread-row-archive");
    await userEvent.click(trigger);
    const dialog = await screen.findByRole("dialog", {
      name: "Archive this thread",
    });
    await waitFor(() =>
      expect(within(dialog).getByRole("button", { name: "Archive" })).toBeEnabled(),
    );
    await userEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(dialog).not.toBeInTheDocument());

    // Reopening shows the check, never the earlier (possibly stale) choices.
    await userEvent.click(trigger);
    expect(await screen.findByRole("status")).toHaveTextContent(
      "Archiving thread…",
    );
    expect(
      screen.queryByRole("dialog", { name: "Archive this thread" }),
    ).not.toBeInTheDocument();
    expect(store.mutateInventory).not.toHaveBeenCalled();

    await act(async () => refresh.resolve(choices));
    const reopened = await screen.findByRole("dialog", {
      name: "Archive this thread",
    });
    expect(within(reopened).getByRole("button", { name: "Archive" })).toBeEnabled();
    expect(store.getThreadArchiveImpact).toHaveBeenCalledTimes(2);
    expect(store.mutateInventory).not.toHaveBeenCalled();
  });

  it("leaves an archived deep route using server-resolved family membership", async () => {
    window.history.pushState(null, "", "/threads/deep-hidden-thread");
    const thread = makeThread();
    const { state, store } = sidebarFixture(thread, { descendantCount: 2 });
    store.archiveThreadFamily.mockResolvedValueOnce([
      thread.id,
      "deep-hidden-thread",
    ]);
    render(
      <InventorySidebar
        state={state}
        store={store}
        selectedThreadId="deep-hidden-thread"
        onNavigate={() => undefined}
        onOpenSettings={() => undefined}
      />,
    );

    await userEvent.click(screen.getByTestId("thread-row-archive"));
    const dialog = await screen.findByRole("dialog", {
      name: "Archive this thread",
    });
    await userEvent.click(
      within(dialog).getByRole("checkbox", {
        name: "Archive child and descendant forks",
      }),
    );
    await userEvent.click(within(dialog).getByRole("button", { name: "Archive" }));
    await waitFor(() =>
      expect(store.archiveThreadFamily).toHaveBeenCalledWith(thread, {
        expectedStashedPromptCount: 0,
        executionWorkspaceDisposition: { kind: "keep" },
      }),
    );
    await waitFor(() => expect(window.location.pathname).toBe("/"));
  });
});
