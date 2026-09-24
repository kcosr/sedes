// @vitest-environment jsdom

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
import { InventorySidebar } from "./InventorySidebar.js";
import { ThreadContextMenu } from "./ThreadContextMenu.js";
import { ArchiveDropdown } from "./thread/ArchiveThreadChoices.js";

// jsdom lacks the pointer-capture and scroll APIs Radix menus rely on.
beforeEach(() => {
  render(<OperationOverlayHost />);
  // The row-editing cases exercise the project hierarchy deliberately.
  localStorage.setItem(SIDEBAR_VIEW_STORAGE_KEY, JSON.stringify({ ...SIDEBAR_VIEW_DEFAULTS, groupBy: "project" }));
  window.dispatchEvent(new StorageEvent("storage", { key: SIDEBAR_VIEW_STORAGE_KEY }));
  // Desktop shell: the mobile media query reports no match, so archive
  // stays a submenu rather than the mobile dialog.
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
  getBlockingOperation()?.cancel();
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
    root: { items: [], total: rootTotal, omitted: rootTotal },
    descendants: {
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
    snapshot: {
      executionTargets: [
        {
          id: "target-1",
          workspaceExecution: { kind: "direct_only" },
        },
      ],
    },
  } as unknown as ApplicationClientState;
  return {
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
      affectedThreadIds: ["11111111-1111-4111-8111-111111111111"],
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
}

async function openMenu(trigger: HTMLElement): Promise<HTMLElement> {
  fireEvent.contextMenu(trigger);
  return await screen.findByTestId("thread-context-menu");
}

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
  await act(
    () =>
      new Promise<void>((resolve) => {
        setTimeout(resolve, 575);
      }),
  );
  return screen.getByRole("dialog", { name: "Thread actions" });
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

describe("ThreadContextMenu content per thread state", () => {
  it("loads isolated workspace actions for the selected row", async () => {
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
    store.getThreadExecutionWorkspace.mockResolvedValue({
      kind: "isolated",
      workspaceAccess: "writable_clone",
      state: "ready",
      allocationRevision: 2,
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
    });

    const menu = await openMenu(renderMenu(makeThread(), store));

    expect(
      await within(menu).findByRole("button", { name: "Copy workspace path" }),
    ).toBeVisible();
    expect(store.getThreadExecutionWorkspace).toHaveBeenCalledWith("thread-1");
  });

  it("closes the touch sheet before confirming isolated workspace deletion", async () => {
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
    store.getThreadExecutionWorkspace.mockResolvedValue({
      kind: "isolated",
      workspaceAccess: "writable_clone",
      state: "ready",
      allocationRevision: 2,
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
    });

    const sheet = await openTouchSheet(renderMenu(makeThread(), store));
    await userEvent.click(
      await within(sheet).findByRole("button", {
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
      screen.queryByRole("button", { name: "Copy workspace path" }),
    ).not.toBeInTheDocument();
  });

  it("presents mouse right-click as a bottom sheet on mobile layouts", async () => {
    const matchMedia = vi.fn(() => ({
      matches: true,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    }));
    vi.stubGlobal("matchMedia", matchMedia);
    const store = makeStore();
    render(
      <>
        <ThreadContextMenu thread={makeThread()} store={store}>
          <div data-testid="row-trigger-one">Row one</div>
        </ThreadContextMenu>
        <ThreadContextMenu
          thread={makeThread({ id: "thread-2" })}
          store={store}
        >
          <div data-testid="row-trigger-two">Row two</div>
        </ThreadContextMenu>
      </>,
    );

    fireEvent.contextMenu(screen.getByTestId("row-trigger-one"));
    expect(
      await screen.findByRole("dialog", { name: "Thread actions" }),
    ).toHaveClass("thread-actions-sheet");
    expect(matchMedia).toHaveBeenCalledWith("(max-width: 819px)");
    expect(screen.queryByTestId("thread-context-menu")).toBeNull();

    await userEvent.keyboard("{Escape}");
    await waitFor(() =>
      expect(
        screen.queryByRole("dialog", { name: "Thread actions" }),
      ).not.toBeInTheDocument(),
    );
  });

  it.each(["touch", "pen"])(
    "opens from a %s long press without navigating the row",
    async (pointerType) => {
      vi.stubGlobal(
        "matchMedia",
        vi.fn(() => ({
          matches: true,
          addEventListener: vi.fn(),
          removeEventListener: vi.fn(),
        })),
      );
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
      await act(
        () =>
          new Promise<void>((resolve) => {
            setTimeout(resolve, 575);
          }),
      );

      const sheet = screen.getByRole("dialog", { name: "Thread actions" });
      expect(sheet).toHaveAttribute("data-state", "open");
      expect(within(sheet).getByText("Force reset…")).toBeInTheDocument();
      expect(
        within(sheet).getByText("Review backend contract"),
      ).toHaveAttribute("title", "Review backend contract");
      expect(screen.queryByTestId("thread-context-menu")).toBeNull();
      await act(
        () =>
          new Promise<void>((resolve) => {
            setTimeout(resolve, 175);
          }),
      );
      expect(screen.queryByTestId("thread-context-menu")).toBeNull();
      fireEvent.pointerUp(trigger, {
        pointerType,
        button: 0,
        clientX: 40,
        clientY: 50,
      });
      fireEvent.click(trigger);
      expect(onClick).not.toHaveBeenCalled();
    },
  );

  it("keeps repeated Android synthetic contextmenu events on the touch sheet path", async () => {
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
      await act(
        () =>
          new Promise<void>((resolve) => {
            setTimeout(resolve, 300);
          }),
      );
      expect(fireEvent.contextMenu(trigger)).toBe(false);
      await act(
        () =>
          new Promise<void>((resolve) => {
            setTimeout(resolve, 275);
          }),
      );

      expect(
        screen.getByRole("dialog", { name: "Thread actions" }),
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
        expect(
          screen.queryByRole("dialog", { name: "Thread actions" }),
        ).not.toBeInTheDocument(),
      );
    }

    // A real mouse right-click remains available even during the touch
    // suppression window.
    fireEvent.pointerDown(trigger, {
      pointerType: "mouse",
      button: 2,
      clientX: 40,
      clientY: 50,
    });
    fireEvent.contextMenu(trigger);
    expect(await screen.findByTestId("thread-context-menu")).toBeInTheDocument();
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
    const trigger = renderMenu(makeThread(), makeStore(), {
      threadRegistry,
      onNavigate,
    });

    for (const childNumber of [1, 2]) {
      const sheet = await openTouchSheet(trigger);
      const forkButton = within(sheet).getByRole("button", { name: "Fork" });
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

    fireEvent.click(within(sheet).getByRole("button", { name: "Fork" }));
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

  it("offers pin, rename, settle, snooze, force reset, and destructive archive for an active thread", async () => {
    const trigger = renderMenu(makeThread(), makeStore(), {
      onRename: vi.fn(),
    });
    const menu = await openMenu(trigger);
    expect(within(menu).getByText("Pin")).toBeInTheDocument();
    expect(within(menu).getByText("Rename")).toBeInTheDocument();
    expect(within(menu).getByText("Settle")).toBeInTheDocument();
    expect(within(menu).getByText("Snooze…")).toBeInTheDocument();
    const forceReset = within(menu).getByText("Force reset…");
    expect(forceReset.closest("[data-variant=destructive]")).not.toBeNull();
    const archive = within(menu).getByText("Archive");
    expect(archive.closest("[data-variant=destructive]")).not.toBeNull();
    expect(within(menu).queryByText("Automation settings…")).toBeNull();
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

  it("adds automation settings only when the thread has an automation", async () => {
    const onNavigate = vi.fn();
    const trigger = renderMenu(
      makeThread({
        automation: {
          status: "enabled",
          runMode: "same_thread",
          scheduleKind: "interval",
          revision: 1,
          hasPrecheck: false,
        },
      }),
      makeStore(),
      { onNavigate },
    );
    const menu = await openMenu(trigger);
    await userEvent.click(within(menu).getByText("Automation settings…"));
    expect(window.location.pathname).toBe("/threads/thread-1/automation");
    expect(onNavigate).toHaveBeenCalled();
  });

  it.each([false, true])(
    "copies the summary backend ID without a thread snapshot or registry (touch: %s)",
    async (touch) => {
      const user = userEvent.setup();
      const writeText = vi.spyOn(navigator.clipboard, "writeText");
      const trigger = renderMenu(
        makeThread({ backendSessionId: "provider-session-123" }), makeStore(),
      );
      const menu = touch ? await openTouchSheet(trigger) : await openMenu(trigger);
      await user.click(
        within(menu).getByRole(touch ? "button" : "menuitem", {
          name: "Copy backend ID",
        }),
      );
      expect(writeText).toHaveBeenCalledWith("provider-session-123");
      expect(writeText).not.toHaveBeenCalledWith("thread-1");
    },
  );

  it("disables backend ID copying for an unbound summary even with a loaded snapshot", async () => {
    const registry = makeForkRegistry(vi.fn());
    registry.get("thread-1").getSnapshot().snapshot!.backendSessionId = "stale-session";
    const trigger = renderMenu(makeThread(), makeStore(), { threadRegistry: registry });
    const menu = await openMenu(trigger);
    expect(
      within(menu).getByRole("menuitem", { name: "Copy backend ID" }),
    ).toHaveAttribute("aria-disabled", "true");
  });

  it("keeps settings copy available beside restore for an archived thread", async () => {
    const store = makeStore();
    const thread = makeThread({ inventoryState: "archived" });
    const trigger = renderMenu(thread, store);
    const menu = await openMenu(trigger);
    const items = within(menu).getAllByRole("menuitem");
    expect(items.map((item) => item.textContent)).toEqual([
      "New",
      "Copy ID",
      "Copy backend ID",
      "Move to group",
      "Restore to Active",
    ]);
    await userEvent.click(
      within(menu).getByRole("menuitem", { name: "Restore to Active" }),
    );
    expect(store.mutateInventory).toHaveBeenCalledWith(thread, "restore");
  });

  it("shows group creation failures inside the open group dialog", async () => {
    const store = makeStore();
    const createThreadGroup = vi
      .fn()
      .mockRejectedValue(new Error("A group with this name already exists."));
    Object.assign(store, { createThreadGroup });
    const sheet = await openTouchSheet(renderMenu(makeThread(), store));
    await userEvent.click(
      within(sheet).getByRole("button", { name: "Move to group" }),
    );
    const dialog = await screen.findByTestId("thread-group-dialog");
    await userEvent.click(
      within(dialog).getByRole("button", { name: "Create and move" }),
    );
    expect(await within(dialog).findByRole("alert")).toHaveTextContent(
      "A group with this name already exists.",
    );
    expect(createThreadGroup).toHaveBeenCalledWith(
      expect.objectContaining({ id: "thread-1" }),
      "Review backend contract",
    );
  });

  it("uses the same lifecycle, creation, and destructive section order", async () => {
    const trigger = renderMenu(makeThread(), makeStore(), {
      onRename: vi.fn(),
      threadRegistry: makeForkRegistry(vi.fn()),
    });
    const menu = await openMenu(trigger);

    const labels = within(menu)
      .getAllByRole("menuitem")
      .map((item) => item.textContent?.trim());
    expect(labels).toEqual([
      "Copy ID",
      "Copy backend ID",
      "Pin",
      "Move to group",
      "Rename",
      "Settle",
      "Snooze…",
      "New",
      "Fork",
      "Force reset…",
      "Archive",
    ]);
    expect(
      menu.querySelectorAll('[data-slot="context-menu-separator"]'),
    ).toHaveLength(2);
    const create = within(menu).getByRole("menuitem", {
      name: "New thread with same settings",
    });
    expect(create).toHaveTextContent(/^New$/u);
    expect(create).toHaveAttribute(
      "title",
      "Create a new thread from these settings",
    );

    await userEvent.keyboard("{Escape}");
    const sheet = await openTouchSheet(trigger);
    expect(
      Array.from(
        sheet.querySelectorAll(
          ".thread-action-sheet-group > [data-slot='button']",
        ),
        (button) => button.textContent?.trim(),
      ),
    ).toEqual(labels);
    expect(
      sheet.querySelectorAll(".thread-action-sheet-group > [role='separator']"),
    ).toHaveLength(2);
  });

  it.each(["running", "failed", "reconciling"] as const)(
    "offers force reset while the projected run state is %s",
    async (runState) => {
      const trigger = renderMenu(makeThread({ runState }), makeStore());
      const menu = await openMenu(trigger);
      expect(within(menu).getByText("Force reset…")).toBeInTheDocument();
    },
  );
});

describe("searchable Move to group", () => {
  function groupFixture(groupId: string | null = "current") {
    const thread = makeThread({ groupId });
    const store = makeStore();
    const state = store.getSnapshot();
    store.getSnapshot.mockReturnValue({
      ...state,
      snapshot: {
        ...state.snapshot,
        groups: [
          { id: "current", name: "Current work", memberCount: 2 },
          { id: "backend", name: "Backend cleanup", memberCount: 4 },
          { id: "release", name: "Release planning", memberCount: 1 },
        ],
      },
    });
    const assignThreadGroup = vi.fn().mockResolvedValue(undefined);
    const createThreadGroup = vi.fn().mockResolvedValue(undefined);
    const removeThreadGroup = vi.fn().mockResolvedValue(undefined);
    Object.assign(store, { assignThreadGroup, createThreadGroup, removeThreadGroup });
    return { thread, store, assignThreadGroup, createThreadGroup, removeThreadGroup };
  }

  async function openGroups(trigger: HTMLElement) {
    const menu = await openMenu(trigger);
    const action = within(menu).getByRole("menuitem", { name: "Move to group" });
    action.focus();
    await userEvent.keyboard("{Enter}");
    return screen.findByRole("dialog", { name: "Move to group" });
  }

  it("focuses search from the desktop menu and assigns only the explicitly chosen match", async () => {
    const { thread, store, assignThreadGroup } = groupFixture();
    const dialog = await openGroups(renderMenu(thread, store));
    const search = within(dialog).getByRole("combobox", { name: "Search groups" });
    expect(search).toHaveFocus();
    expect(search).not.toHaveAttribute("aria-activedescendant");
    await userEvent.keyboard("{Enter}");
    expect(assignThreadGroup).not.toHaveBeenCalled();
    const current = within(dialog).getByRole("option", { name: /Current work/ });
    expect(current).toHaveAttribute("aria-disabled", "true");
    await userEvent.click(current);
    expect(assignThreadGroup).not.toHaveBeenCalled();
    await userEvent.type(search, " CLEANUP back ");
    expect(within(dialog).queryByRole("option", { name: /Release planning/ })).toBeNull();
    const match = within(dialog).getByRole("option", { name: /Backend cleanup/ });
    expect(match).toHaveTextContent("4");
    expect(assignThreadGroup).not.toHaveBeenCalled();
    await userEvent.keyboard("{Enter}");
    expect(assignThreadGroup).toHaveBeenCalledExactlyOnceWith(thread, "backend");
    await waitFor(() => expect(dialog).not.toBeInTheDocument());
  });

  it.each(["current", null])("requires navigation before choosing an unfiltered destination from %s", async (groupId) => {
    const { thread, store, assignThreadGroup } = groupFixture(groupId);
    const dialog = await openGroups(renderMenu(thread, store));
    const search = within(dialog).getByRole("combobox", { name: "Search groups" });
    expect(search).not.toHaveAttribute("aria-activedescendant");
    await userEvent.keyboard("{Enter}");
    expect(assignThreadGroup).not.toHaveBeenCalled();
    await userEvent.keyboard("{ArrowUp}{Enter}");
    expect(assignThreadGroup).toHaveBeenCalledExactlyOnceWith(thread, "release");
  });

  it("keeps create and ungroup reachable for an unmatched search without assigning on Enter", async () => {
    const { thread, store, assignThreadGroup, createThreadGroup, removeThreadGroup } = groupFixture();
    const dialog = await openGroups(renderMenu(thread, store));
    await userEvent.type(within(dialog).getByRole("combobox", { name: "Search groups" }), "unmatched{Enter}");
    expect(within(dialog).getByRole("status")).toHaveTextContent("No matching groups");
    expect(within(dialog).queryAllByRole("option")).toHaveLength(0);
    expect(assignThreadGroup).not.toHaveBeenCalled();
    expect(createThreadGroup).not.toHaveBeenCalled();
    expect(within(dialog).getByRole("textbox", { name: "Create group" })).toHaveValue(thread.title.text);
    expect(within(dialog).getByRole("button", { name: "Create and move" })).toBeEnabled();
    await userEvent.click(within(dialog).getByRole("button", { name: "Ungroup" }));
    expect(removeThreadGroup).toHaveBeenCalledExactlyOnceWith(thread);
    await waitFor(() => expect(dialog).not.toBeInTheDocument());
  });

  it("creates from the independent name field when no existing group matches", async () => {
    const { thread, store, assignThreadGroup, createThreadGroup } = groupFixture(null);
    const dialog = await openGroups(renderMenu(thread, store));
    await userEvent.type(within(dialog).getByRole("combobox", { name: "Search groups" }), "missing");
    const name = within(dialog).getByRole("textbox", { name: "Create group" });
    await userEvent.clear(name);
    await userEvent.type(name, "  New team  ");
    await userEvent.click(within(dialog).getByRole("button", { name: "Create and move" }));
    expect(createThreadGroup).toHaveBeenCalledExactlyOnceWith(thread, "New team");
    expect(assignThreadGroup).not.toHaveBeenCalled();
    await waitFor(() => expect(dialog).not.toBeInTheDocument());
  });

  it("keeps a failed assignment open with its query and allows retry", async () => {
    const { thread, store, assignThreadGroup } = groupFixture();
    assignThreadGroup.mockRejectedValueOnce(new Error("Group changed; try again."));
    const dialog = await openGroups(renderMenu(thread, store));
    const search = within(dialog).getByRole("combobox", { name: "Search groups" });
    await userEvent.type(search, "release");
    await userEvent.click(within(dialog).getByRole("option", { name: /Release planning/ }));
    expect(await within(dialog).findByRole("alert")).toHaveTextContent("Group changed; try again.");
    expect(search).toHaveValue("release");
    await userEvent.click(within(dialog).getByRole("option", { name: /Release planning/ }));
    expect(assignThreadGroup).toHaveBeenCalledTimes(2);
    expect(assignThreadGroup).toHaveBeenLastCalledWith(thread, "release");
    await waitFor(() => expect(dialog).not.toBeInTheDocument());
  });

  it("blocks duplicate assignments and other mutations while saving", async () => {
    const { thread, store, assignThreadGroup, createThreadGroup, removeThreadGroup } = groupFixture();
    const pending = deferred<void>();
    assignThreadGroup.mockReturnValueOnce(pending.promise);
    const dialog = await openGroups(renderMenu(thread, store));
    const choice = within(dialog).getByRole("option", { name: /Backend cleanup/ });
    await userEvent.click(choice);
    expect(choice).toHaveAttribute("aria-disabled", "true");
    expect(within(dialog).getByRole("button", { name: "Ungroup" })).toBeDisabled();
    expect(within(dialog).getByRole("button", { name: "Saving…" })).toBeDisabled();
    await userEvent.click(choice);
    expect(assignThreadGroup).toHaveBeenCalledOnce();
    expect(createThreadGroup).not.toHaveBeenCalled();
    expect(removeThreadGroup).not.toHaveBeenCalled();
    await act(async () => pending.resolve());
    await waitFor(() => expect(dialog).not.toBeInTheDocument());
  });

  it("returns focus to the row on cancellation and clears search when reopened", async () => {
    const { thread, store, assignThreadGroup } = groupFixture();
    const returnFocusRef = { current: null as HTMLButtonElement | null };
    render(
      <ThreadContextMenu thread={thread} store={store} returnFocusRef={returnFocusRef}>
        <button ref={returnFocusRef} type="button">Groupable thread</button>
      </ThreadContextMenu>,
    );
    const trigger = screen.getByRole("button", { name: "Groupable thread" });
    const dialog = await openGroups(trigger);
    await userEvent.type(within(dialog).getByRole("combobox", { name: "Search groups" }), "release{Escape}");
    await waitFor(() => expect(dialog).not.toBeInTheDocument());
    await waitFor(() => expect(trigger).toHaveFocus());
    const reopened = await openGroups(trigger);
    expect(within(reopened).getByRole("combobox", { name: "Search groups" })).toHaveValue("");
    expect(within(reopened).getAllByRole("option")).toHaveLength(3);
    expect(assignThreadGroup).not.toHaveBeenCalled();
  });

  it.each([false, true])("uses the searchable group dialog from the touch action sheet, keyboard override %s", async (keyboard) => {
    const viewport = Object.assign(new EventTarget(), { height: window.innerHeight, offsetTop: 0 });
    vi.stubGlobal("visualViewport", viewport);
    const { thread, store, assignThreadGroup } = groupFixture();
    const sheet = await openTouchSheet(renderMenu(thread, store));
    const move = within(sheet).getByRole("button", { name: "Move to group" });
    if (keyboard) {
      fireEvent.keyDown(move, { key: "Enter" });
      fireEvent.click(move);
    } else {
      await userEvent.pointer([{ keys: "[TouchA>]", target: move }, { keys: "[/TouchA]" }]);
    }
    const dialog = await screen.findByRole("dialog", { name: "Move to group" });
    await waitFor(() => expect(keyboard ? within(dialog).getByRole("combobox", { name: "Search groups" }) : dialog).toHaveFocus());
    await userEvent.type(within(dialog).getByRole("combobox", { name: "Search groups" }), "release");
    expect(within(dialog).getByRole("combobox", { name: "Search groups" })).toHaveFocus();
    act(() => {
      viewport.height = window.innerHeight - 300;
      viewport.dispatchEvent(new Event("resize"));
    });
    expect(dialog.style.getPropertyValue("--thread-group-keyboard-inset")).toBe("300px");
    expect(within(dialog).getAllByRole("option")).toHaveLength(1);
    await userEvent.click(within(dialog).getByRole("option", { name: /Release planning/ }));
    expect(assignThreadGroup).toHaveBeenCalledExactlyOnceWith(thread, "release");
    await waitFor(() => expect(dialog).not.toBeInTheDocument());
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
        name: "New thread with same settings",
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
        name: "New thread with same settings",
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
      name: "New thread with same settings",
    });
    expect(action).toHaveAttribute("aria-disabled", "true");
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
        name: "New thread with same settings",
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

    menu = await openMenu(trigger);
    await userEvent.click(within(menu).getByText("Archive"));
    await userEvent.click(await screen.findByText("Archive only this thread"));
    expect(store.getThreadArchiveImpact).toHaveBeenCalledWith(thread.id);
    expect(store.mutateInventory).toHaveBeenCalledWith(thread, "archive", {
      expectedStashedPromptCount: 0,
      executionWorkspaceDisposition: { kind: "keep" },
    });
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
        openTaskDisposition: "move_to_workspace",
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

  it("uses authoritative impact and single-thread wording when the snapshot count is zero", async () => {
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
    const trigger = renderMenu(thread, store);
    const menu = await openMenu(trigger);

    await userEvent.click(within(menu).getByText("Archive"));
    expect(await screen.findByText("Archive this thread")).toBeInTheDocument();
    expect(screen.queryByText(/Archive thread and/)).not.toBeInTheDocument();
    expect(store.mutateInventory).not.toHaveBeenCalled();
    await userEvent.click(screen.getByText("Archive this thread"));
    expect(store.mutateInventory).toHaveBeenCalledWith(thread, "archive", {
      expectedStashedPromptCount: 0,
      executionWorkspaceDisposition: { kind: "keep" },
    });
    await waitFor(() =>
      expect(
        screen.queryByTestId("thread-context-menu"),
      ).not.toBeInTheDocument(),
    );
  });

  it("opens archive choices as a submenu for a thread with descendants", async () => {
    const store = makeStore();
    store.getThreadArchiveImpact.mockResolvedValue({
      descendantCount: 2,
      pendingQuestions: { root: 0, descendants: 0 },
      stashedPrompts: { root: 1, descendants: 2 },
      openTasks: {
        root: {
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

    await userEvent.click(within(menu).getByText("Archive"));
    expect(
      await screen.findByText("Archive only this thread"),
    ).toBeInTheDocument();
    expect(screen.getByText("Root warning")).toBeVisible();
    expect(screen.getByText("Descendant warning")).toBeVisible();
    expect(screen.getByText("Thread thread-2")).toBeVisible();
    expect(screen.getByText("1 more task not shown")).toBeVisible();
    expect(
      screen.getByText("3 stashed prompts in this thread family"),
    ).toBeVisible();
    expect(
      screen.getByText(
        "1 on this thread; 2 on descendants. They will remain attached to whichever threads you archive.",
      ),
    ).toBeVisible();
    const deleteWorkspace = screen.getByRole("radio", { name: "Delete" });
    expect(deleteWorkspace).toBeEnabled();
    await userEvent.click(deleteWorkspace);
    const archiveFamily = screen.getByRole("menuitem", {
      name: "Archive thread and 2 descendants",
    });
    expect(archiveFamily).toHaveAttribute("data-disabled");
    expect(
      screen.getByText("Keep the isolated workspace to archive descendants."),
    ).toBeVisible();
    expect(
      screen.queryByText(
        "Archive only this thread to delete its isolated workspace.",
      ),
    ).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("menuitem", { name: "Cancel" }));
    const reopenedMenu = await openMenu(trigger);
    await userEvent.click(within(reopenedMenu).getByText("Archive"));
    const workspaceHandling = await screen.findByRole("radiogroup", {
      name: "Isolated workspace handling",
    });
    expect(
      within(workspaceHandling).getByRole("radio", { name: "Keep" }),
    ).toHaveAttribute("aria-checked", "true");
    const reopenedArchiveFamily = screen.getByRole("menuitem", {
      name: "Archive thread and 2 descendants",
    });
    expect(reopenedArchiveFamily).not.toHaveAttribute("data-disabled");
    expect(store.getThreadArchiveImpact).toHaveBeenCalledWith(thread.id);
    await userEvent.click(reopenedArchiveFamily);
    await waitFor(() =>
      expect(store.archiveThreadFamily).toHaveBeenCalledWith(thread, {
        expectedStashedPromptCount: 3,
        executionWorkspaceDisposition: { kind: "keep" },
        openTaskDisposition: "move_to_workspace",
      }),
    );
    expect(store.mutateInventory).not.toHaveBeenCalledWith(thread, "archive");
  });

  it("closes the touch sheet before handing archive to its choices dialog", async () => {
    const store = makeStore();
    const thread = makeThread();
    const trigger = renderMenu(thread, store, { familyDescendantCount: 2 });
    const sheet = await openTouchSheet(trigger);

    await userEvent.click(
      within(sheet).getByRole("button", { name: "Archive" }),
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
      const sheet = await openTouchSheet(renderMenu(makeThread(), makeStore()));

      await userEvent.click(
        within(sheet).getByRole("button", { name: actionLabel }),
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
    workspaces: [
      {
        id: "workspace-1",
        environmentId: "environment-1",
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
      expect(screen.queryByRole("dialog", { name: "Thread actions" })).toBeNull();
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
        executionWorkspaceDisposition: { kind: "keep" },
      }),
    );
    expect(store.archiveThreadFamily).not.toHaveBeenCalled();
    await waitFor(() =>
      expect(screen.queryByRole("menu")).not.toBeInTheDocument(),
    );
  });

  it("cancels a direct archive preflight without archiving or opening choices", async () => {
    const thread = makeThread();
    const { state, store } = sidebarFixture(thread, { descendantCount: 2 });
    const impact = await store.getThreadArchiveImpact(thread.id);
    const pending = deferred<typeof impact>();
    store.getThreadArchiveImpact.mockReturnValueOnce(pending.promise);
    render(<InventorySidebar state={state} store={store}
      onNavigate={() => undefined} onOpenSettings={() => undefined} />);
    await userEvent.click(screen.getByTestId("thread-row-archive"));
    expect(await screen.findByRole("status")).toHaveTextContent("Checking thread activity…");
    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await act(async () => { pending.resolve(impact); });
    expect(store.mutateInventory).not.toHaveBeenCalled();
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("keeps a reopened archive check visible until its shared read finishes", async () => {
    const thread = makeThread();
    const { state, store } = sidebarFixture(thread, { descendantCount: 2 });
    const impact = await store.getThreadArchiveImpact(thread.id);
    const pending = deferred<typeof impact>();
    store.getThreadArchiveImpact.mockClear();
    store.getThreadArchiveImpact.mockReturnValueOnce(pending.promise);
    render(<InventorySidebar state={state} store={store}
      onNavigate={() => undefined} onOpenSettings={() => undefined} />);
    await userEvent.click(screen.getByTestId("thread-row-archive"));
    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await userEvent.click(screen.getByTestId("thread-row-archive"));
    expect(screen.getByRole("status")).toHaveTextContent("Checking thread activity…");
    expect(store.getThreadArchiveImpact).toHaveBeenCalledOnce();
    await act(async () => { pending.resolve(impact); });
    expect(await screen.findByRole("menu")).toBeVisible();
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(store.mutateInventory).not.toHaveBeenCalled();
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
    const archiveAll = await screen.findByText(
      "Archive thread and 2 descendants",
    );
    await waitFor(() =>
      expect(archiveAll.closest('[role="menuitem"]')).toHaveAttribute(
        "data-disabled",
      ),
    );
    expect(
      screen.getByText("A descendant is running and cannot be archived."),
    ).toBeInTheDocument();
    await userEvent.click(screen.getByText("Archive only this thread"));
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
    await waitFor(() =>
      expect(store.mutateInventory).toHaveBeenCalledWith(thread, "archive", {
        expectedStashedPromptCount: 0,
        executionWorkspaceDisposition: { kind: "keep" },
      }),
    );
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
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

  it("closes the previous archive dropdown when another row opens", async () => {
    const store = makeStore();
    store.getThreadArchiveImpact.mockImplementation(
      async (threadId: string) => ({
        descendantCount: threadId === "thread-1" ? 1 : 3,
        pendingQuestions: { root: 0, descendants: 0 },
        stashedPrompts: { root: 0, descendants: 0 },
        openTasks: openTasks(),
        executionWorkspace: { kind: "direct" },
        archiveOnly: { available: true },
        archiveAll: { available: true },
      }),
    );
    render(
      <>
        <ArchiveDropdown
          thread={makeThread()}
          store={store}
          descendantCount={1}
        >
          <button type="button">Archive first</button>
        </ArchiveDropdown>
        <ArchiveDropdown
          thread={makeThread({ id: "thread-2", title: { text: "Second" } })}
          store={store}
          descendantCount={3}
        >
          <button type="button">Archive second</button>
        </ArchiveDropdown>
      </>,
    );

    await userEvent.click(
      screen.getByRole("button", { name: "Archive first" }),
    );
    expect(
      await screen.findByRole("menuitem", {
        name: "Archive thread and 1 descendant",
      }),
    ).toBeVisible();
    await userEvent.click(
      screen.getByRole("button", { name: "Archive second" }),
    );
    expect(
      await screen.findByRole("menuitem", {
        name: "Archive thread and 3 descendants",
      }),
    ).toBeVisible();
    expect(
      screen.queryByRole("menuitem", {
        name: "Archive thread and 1 descendant",
      }),
    ).not.toBeInTheDocument();
  });

  it("uses choice-neutral stash wording while preserving choice-scoped counts", async () => {
    const thread = makeThread();
    const store = makeStore();
    store.getThreadArchiveImpact.mockResolvedValue({
      descendantCount: 1,
      pendingQuestions: { root: 0, descendants: 0 },
      stashedPrompts: { root: 1, descendants: 2 },
      openTasks: openTasks(),
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
    render(
      <ArchiveDropdown thread={thread} store={store} descendantCount={1}>
        <button type="button">Archive thread</button>
      </ArchiveDropdown>,
    );

    const trigger = screen.getByRole("button", { name: "Archive thread" });
    await userEvent.click(trigger);

    expect(
      await screen.findByText("3 stashed prompts in this thread family"),
    ).toBeVisible();
    expect(
      screen.getByText(
        "1 on this thread; 2 on descendants. They will remain attached to whichever threads you archive.",
      ),
    ).toBeVisible();
    expect(
      screen.queryByText(/will remain attached to the archived threads/),
    ).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("radio", { name: "Delete" }));
    expect(
      screen.getByRole("menuitem", {
        name: "Archive thread and 1 descendant",
      }),
    ).toHaveAttribute("data-disabled");

    await userEvent.click(
      screen.getByRole("menuitem", { name: "Archive only this thread" }),
    );
    expect(store.mutateInventory).toHaveBeenCalledWith(thread, "archive", {
      expectedStashedPromptCount: 1,
      executionWorkspaceDisposition: {
        kind: "delete",
        expectedRevision: 5,
        operationId: expect.any(String),
      },
    });

    await userEvent.click(trigger);
    expect(
      within(
        screen.getByRole("radiogroup", {
          name: "Isolated workspace handling",
        }),
      ).getByRole("radio", { name: "Keep" }),
    ).toHaveAttribute("aria-checked", "true");
    await userEvent.click(
      await screen.findByRole("menuitem", {
        name: "Archive thread and 1 descendant",
      }),
    );
    expect(store.archiveThreadFamily).toHaveBeenCalledWith(thread, {
      expectedStashedPromptCount: 3,
      executionWorkspaceDisposition: { kind: "keep" },
    });
  });

  it("keeps stale archive choices disabled while a reopened menu refreshes", async () => {
    let resolveRefresh!: (impact: {
      descendantCount: number;
      pendingQuestions: { root: number; descendants: number };
      stashedPrompts: { root: number; descendants: number };
      openTasks: ReturnType<typeof openTasks>;
      executionWorkspace: { kind: "direct" };
      archiveOnly: { available: true };
      archiveAll: { available: true };
    }) => void;
    const refresh = new Promise<{
      descendantCount: number;
      pendingQuestions: { root: number; descendants: number };
      stashedPrompts: { root: number; descendants: number };
      openTasks: ReturnType<typeof openTasks>;
      executionWorkspace: { kind: "direct" };
      archiveOnly: { available: true };
      archiveAll: { available: true };
    }>((resolve) => {
      resolveRefresh = resolve;
    });
    const thread = makeThread();
    const store = makeStore();
    store.getThreadArchiveImpact
      .mockResolvedValueOnce({
        descendantCount: 1,
        pendingQuestions: { root: 0, descendants: 0 },
        stashedPrompts: { root: 0, descendants: 0 },
        openTasks: openTasks(),
        executionWorkspace: { kind: "direct" },
        archiveOnly: { available: true },
        archiveAll: { available: true },
      })
      .mockReturnValueOnce(refresh);
    render(
      <ArchiveDropdown thread={thread} store={store} descendantCount={1}>
        <button type="button">Archive thread</button>
      </ArchiveDropdown>,
    );

    const trigger = screen.getByRole("button", { name: "Archive thread" });
    await userEvent.click(trigger);
    const archiveOnly = await screen.findByRole("menuitem", {
      name: "Archive only this thread",
    });
    await waitFor(() =>
      expect(archiveOnly).not.toHaveAttribute("data-disabled"),
    );
    await userEvent.click(screen.getByRole("menuitem", { name: "Cancel" }));

    await userEvent.click(trigger);
    const refreshingChoice = await screen.findByRole("menuitem", {
      name: "Archive only this thread",
    });
    expect(refreshingChoice).toHaveAttribute("data-disabled");
    await userEvent.click(refreshingChoice);
    expect(store.mutateInventory).not.toHaveBeenCalled();
    expect(refreshingChoice).toBeVisible();

    resolveRefresh({
      descendantCount: 1,
      pendingQuestions: { root: 0, descendants: 0 },
      stashedPrompts: { root: 0, descendants: 0 },
      openTasks: openTasks(),
      executionWorkspace: { kind: "direct" },
      archiveOnly: { available: true },
      archiveAll: { available: true },
    });
    await waitFor(() =>
      expect(refreshingChoice).not.toHaveAttribute("data-disabled"),
    );
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
    await userEvent.click(
      await screen.findByText("Archive thread and 2 descendants"),
    );
    await waitFor(() => expect(window.location.pathname).toBe("/"));
  });
});
