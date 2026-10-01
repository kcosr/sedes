// @vitest-environment jsdom

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
import type { NormalizedApplicationThreadSummary, NormalizedThreadSnapshot } from "../../../shared/index.js";
import type {
  ApplicationClientState,
  ApplicationClientStore,
} from "../../stores/ApplicationClientStore.js";
import type { ThreadClientStore } from "../../stores/ThreadClientStore.js";
import { UsageQueryCache } from "../../stores/UsageQueryCache.js";
import { ThreadHeader } from "./ThreadHeader.js";
import { NavigationControlsContext } from "../../app/navigation-controls.js";

import { ThreadArchiveOperationHost } from "../../operations/ThreadArchiveOperationHost.js";
import { OperationOverlayHost } from "../../operations/OperationOverlay.js";
import { getBlockingOperation } from "../../operations/blocking-operation.js";

let mobileMatches = false;

beforeEach(() => {
  mobileMatches = false;
  render(<OperationOverlayHost />);
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
  // A phone wide enough to keep the header's toolbar toggle (420px+).
  vi.stubGlobal(
    "matchMedia",
    vi.fn((query: string) => ({
      matches: mobileMatches && query !== "(max-width: 419px)",
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })),
  );
});

afterEach(() => {
  getBlockingOperation()?.dismiss();
  cleanup();
  vi.unstubAllGlobals();
  window.history.replaceState(null, "", "/");
});

function makeSnapshot(
  inventoryState: "active" | "archived" = "active",
): NormalizedThreadSnapshot {
  return {
    executionWorkspace: { kind: "direct" },
    forkSource: {
      selectedCompletedTurn: {
        available: false,
        unavailableReason: { text: "Forking is unavailable in this fixture." },
      },
      latestProviderSnapshot: {
        available: false,
        unavailableReason: { text: "Forking is unavailable in this fixture." },
      },
    },
    forksByTurnId: {},
    orderedTurnIds: [],
    turnsById: {},
    thread: {
      id: "thread-1",
      workspaceId: "workspace-1",
      title: { text: "Header thread" },
      backingState: "bound",
      inventoryState,
      inventoryRevision: 1,
      threadRevision: 1,
      runState: "idle",
      queuedInputCount: 0,
      available: true,
      lastActivityAt: "2026-07-30T15:00:00.000Z",
      stateChangedAt: "2026-07-30T15:00:00.000Z",
      automation: null,
    },
    workspace: {
      id: "workspace-1",
      environmentId: "environment-1",
      label: { text: "Workspace" },
      displayPath: { text: "/workspace" },
      available: true,
    },
    environment: {
      id: "environment-1",
      label: { text: "Machine" },
      available: true,
    },
    attention: {
      wake: false,
      automationContext: null,
      queueFailure: false,
    },
    stashes: [],
    agentTools: {
      enabled: false,
      accessBoundary: "environment",
      groups: [],
      presentation: { surface: "native", mode: "individual" },
      presentationOptions: [
        { surface: "native", modes: ["progressive", "individual"] },
        { surface: "cli", modes: ["progressive", "individual"] },
      ],
      revision: 0,
    },
    runState: "idle",
    usage: {},
    capabilities: {
      revision: "capability-fixture",
      backend: { label: { text: "Pi" } },
      interactionMode: "interactive",
      runState: "idle",
      operations: [
        {
          id: "archive",
          label: { text: "Archive" },
          destructive: true,
          available: true,
        },
      ],
      deliveryModes: [],
      settings: [],
      composerActions: [],
      interactions: [],
      providerFeatures: [],
      automation: { available: false },
    },
  } as unknown as NormalizedThreadSnapshot;
}

function fixture(descendantCount: number): {
  readonly applicationStore: ApplicationClientStore & {
    createThreadFromSettings: ReturnType<typeof vi.fn>;
    mutateInventory: ReturnType<typeof vi.fn>;
    archiveThreadFamily: ReturnType<typeof vi.fn>;
    getThreadArchiveImpact: ReturnType<typeof vi.fn>;
  };
  readonly threadStore: ThreadClientStore;
  readonly publishArchived: () => void;
} {
  let applicationState: ApplicationClientState = {
    status: "ready",
    connection: "connected",
    authoritative: true,
    search: "",
    descendantPages: {},
    pendingThreadConfigurationCopySourceIds: [],
    snapshot: {
      environments: [],
      workspaces: [],
      threads: [],
      forkOrigins: [],
      lineagePlacements: [],
      lineageFamilies:
        descendantCount > 0
          ? [{ sourceThreadId: "thread-1", descendantCount }]
          : [],
      executionTargets: [],
      defaultNewThreadTargetId: null,
      counts: { active: 1, snoozed: 0, settled: 0, archived: 0 },
      tasks: [],
    },
    visibleThreads: [],
  } as unknown as ApplicationClientState;
  const listeners = new Set<() => void>();
  const applicationStore = {
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    getSnapshot: () => applicationState,
    createThreadFromSettings: vi.fn(async () => ({
      threadId: "thread-copy",
      workspaceId: "workspace-1",
      targetId: "target-1",
    })),
    mutateInventory: vi.fn(async () => undefined),
    archiveThreadFamily: vi.fn(async () => ["thread-1", "thread-2"]),
    getThreadArchiveImpact: vi.fn(async () => ({
      descendantCount,
      pendingQuestions: { root: 0, descendants: 0 },
      stashedPrompts: { root: 0, descendants: 0 },
      openTasks: {
        familySnapshot: "b".repeat(64),
        root: { snapshot: "a".repeat(64), items: [], total: 0, omitted: 0 },
        descendants: { snapshot: "a".repeat(64), items: [], total: 0, omitted: 0 },
      },
      executionWorkspace: { kind: "direct" },
      archiveOnly: { available: true },
      archiveAll: { available: true },
    })),
  } as unknown as ApplicationClientStore & {
    createThreadFromSettings: ReturnType<typeof vi.fn>;
    mutateInventory: ReturnType<typeof vi.fn>;
    archiveThreadFamily: ReturnType<typeof vi.fn>;
    getThreadArchiveImpact: ReturnType<typeof vi.fn>;
  };
  const threadStore = {
    usage: new UsageQueryCache("thread", {getUsage: vi.fn(), getUsageAvailability: vi.fn()}),
    subscribe: () => () => undefined,
    getSnapshot: () => undefined,
    perform: vi.fn(async () => undefined),
    forkTurn: vi.fn(),
  } as unknown as ThreadClientStore;
  render(<ThreadArchiveOperationHost store={applicationStore} />);
  return {
    applicationStore,
    threadStore,
    publishArchived: () => {
      applicationState = {
        ...applicationState,
        snapshot: {
          ...applicationState.snapshot!,
          threads: [makeSnapshot("archived").thread as NormalizedApplicationThreadSummary],
        },
      };
      for (const listener of listeners) listener();
    },
  };
}

function renderHeader(
  descendantCount: number,
  openDrawer = vi.fn(),
  inventoryState: "active" | "archived" = "active",
) {
  const { applicationStore, threadStore, publishArchived } = fixture(descendantCount);
  const view = render(
    <NavigationControlsContext.Provider
      value={{
        openDrawer,
        toggleDrawer: vi.fn(),
        toggleSidebar: vi.fn(),
        sidebarCollapsed: false,
        drawerOpen: false,
        connection: "connected",
        triggerRef: { current: null },
      }}
    >
      <ThreadHeader
        store={threadStore}
        applicationStore={applicationStore}
        snapshot={makeSnapshot(inventoryState)}
        connection="connected"
        authoritative
        forkAttempts={{}}
        actionPending={false}
        bookmarks={[]}
        bookmarkRevision={0}
        bookmarkStatus="ready"
        pendingBookmarkTurnIds={[]}
        onSelectBookmarkTurn={vi.fn()}
        findOpen={false}
        findButtonRef={{ current: null }}
        onFindOpenChange={vi.fn()}
      />
    </NavigationControlsContext.Provider>,
  );
  return { applicationStore, openDrawer, publishArchived, unmount: view.unmount };
}

/** Opens the desktop Thread actions menu (Radix opens on pointer down). */
async function openThreadActions(): Promise<HTMLElement> {
  await userEvent.click(screen.getByRole("button", { name: "Thread actions" }));
  return await screen.findByRole("menu", { name: "Thread actions" });
}

const emptyImpact = (overrides: Record<string, unknown> = {}) => ({
  descendantCount: 0,
  pendingQuestions: { root: 0, descendants: 0 },
  stashedPrompts: { root: 0, descendants: 0 },
  openTasks: {
    familySnapshot: "b".repeat(64),
    root: { snapshot: "a".repeat(64), items: [], total: 0, omitted: 0 },
    descendants: { snapshot: "a".repeat(64), items: [], total: 0, omitted: 0 },
  },
  executionWorkspace: { kind: "direct" },
  archiveOnly: { available: true },
  archiveAll: { available: true },
  ...overrides,
});

describe("ThreadHeader archive action", () => {
  it("keeps New and Fork grouped after restore for an archived thread", async () => {
    renderHeader(0, vi.fn(), "archived");
    const menu = await openThreadActions();
    const labels = within(menu)
      .getAllByRole("menuitem")
      .map((row) => row.textContent?.trim());

    expect(labels.indexOf("Restore to Active")).toBeLessThan(
      labels.indexOf("New with same settings"),
    );
    expect(labels.indexOf("New with same settings")).toBeLessThan(
      labels.findIndex((label) => label?.startsWith("Fork")),
    );
    expect(labels).not.toContain("Archive");
    expect(
      within(menu).getByRole("menuitem", { name: "New with same settings" }),
    ).not.toHaveAttribute("data-disabled");
  });

  it("archives immediately on desktop when the thread has no descendants", async () => {
    const { applicationStore } = renderHeader(0);
    const menu = await openThreadActions();
    const archive = within(menu).getByRole("menuitem", { name: "Archive" });
    expect(archive).toHaveAttribute("data-variant", "default");
    expect(archive.querySelector("svg")).not.toBeNull();

    await userEvent.click(archive);

    await waitFor(() =>
      expect(applicationStore.mutateInventory).toHaveBeenCalledWith(
        expect.objectContaining({ id: "thread-1" }),
        "archive",
        { expectedStashedPromptCount: 0 },
      ),
    );
    expect(applicationStore.getThreadArchiveImpact).toHaveBeenCalledWith(
      "thread-1",
    );
    expect(
      screen.queryByRole("menuitem", { name: /Archive/ }),
    ).not.toBeInTheDocument();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    await waitFor(() => expect(window.location.pathname).toBe("/"));
  });

  it("opens the archive choices dialog on desktop when descendants exist", async () => {
    const { applicationStore } = renderHeader(2);
    applicationStore.getThreadArchiveImpact.mockResolvedValue(
      emptyImpact({ descendantCount: 2 }),
    );
    const menu = await openThreadActions();

    await userEvent.click(
      within(menu).getByRole("menuitem", { name: "Archive" }),
    );

    const dialog = await screen.findByRole("dialog", {
      name: "Archive this thread",
    });
    expect(
      within(dialog).getByRole("checkbox", {
        name: "Archive child and descendant forks",
      }),
    ).toBeVisible();
    expect(screen.queryByRole("menuitem", { name: /Archive only/ })).toBeNull();
    expect(applicationStore.mutateInventory).not.toHaveBeenCalled();
    expect(applicationStore.getThreadArchiveImpact).toHaveBeenCalledWith(
      "thread-1",
    );
  });

  it("requires confirmation before archiving a childless thread with unanswered questions", async () => {
    const { applicationStore } = renderHeader(0);
    applicationStore.getThreadArchiveImpact.mockResolvedValue(
      emptyImpact({ pendingQuestions: { root: 2, descendants: 0 } }),
    );
    const menu = await openThreadActions();
    await userEvent.click(
      within(menu).getByRole("menuitem", { name: "Archive" }),
    );

    const dialog = await screen.findByRole("dialog", {
      name: "Archive this thread",
    });
    expect(within(dialog).getByText("2 unanswered questions")).toBeVisible();
    expect(applicationStore.mutateInventory).not.toHaveBeenCalled();

    await userEvent.click(
      within(dialog).getByRole("button", { name: "Archive" }),
    );
    expect(applicationStore.mutateInventory).toHaveBeenCalledWith(
      expect.objectContaining({ id: "thread-1" }),
      "archive",
      {
        expectedStashedPromptCount: 0,
        executionWorkspaceDisposition: { kind: "keep" },
      },
    );
  });

  it("keeps choice completion and navigation when inventory updates before the archive response", async () => {
    const { applicationStore, publishArchived, unmount } = renderHeader(2);
    let finish!: () => void;
    applicationStore.mutateInventory.mockReturnValueOnce(new Promise<void>((resolve) => { finish = resolve; }));
    window.history.replaceState(null, "", "/threads/thread-1");
    const menu = await openThreadActions();
    await userEvent.click(within(menu).getByRole("menuitem", { name: "Archive" }));
    const dialog = await screen.findByRole("dialog", { name: "Archive this thread" });
    await userEvent.click(within(dialog).getByRole("button", { name: "Archive" }));
    act(() => { publishArchived(); });
    unmount();

    expect(within(dialog).getByRole("button", { name: "Archiving…" })).toBeDisabled();
    expect(screen.queryByRole("dialog", { name: "Could not archive thread" })).not.toBeInTheDocument();
    expect(window.location.pathname).toBe("/threads/thread-1");
    await act(async () => { finish(); });
    await waitFor(() => expect(dialog).not.toBeInTheDocument());
    expect(window.location.pathname).toBe("/");
    expect(applicationStore.mutateInventory).toHaveBeenCalledOnce();
  });

  it("requires confirmation before archiving a childless thread with stashed prompts", async () => {
    const { applicationStore } = renderHeader(0);
    applicationStore.getThreadArchiveImpact.mockResolvedValue(
      emptyImpact({ stashedPrompts: { root: 1, descendants: 0 } }),
    );
    const menu = await openThreadActions();
    await userEvent.click(
      within(menu).getByRole("menuitem", { name: "Archive" }),
    );

    const dialog = await screen.findByRole("dialog", {
      name: "Archive this thread",
    });
    expect(within(dialog).getByText("1 stashed prompt")).toBeVisible();
    expect(applicationStore.mutateInventory).not.toHaveBeenCalled();

    await userEvent.click(
      within(dialog).getByRole("button", { name: "Archive" }),
    );
    expect(applicationStore.mutateInventory).toHaveBeenCalledWith(
      expect.objectContaining({ id: "thread-1" }),
      "archive",
      {
        expectedStashedPromptCount: 1,
        executionWorkspaceDisposition: { kind: "keep" },
      },
    );
  });

  it("archives from the mobile sheet directly when nothing needs a choice", async () => {
    mobileMatches = true;
    const { applicationStore, openDrawer } = renderHeader(0);
    fireEvent.click(
      screen.getByRole("button", { name: "Show thread toolbar" }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Thread actions" }));
    const sheet = screen.getByRole("dialog", { name: "Header thread" });
    fireEvent.click(within(sheet).getByRole("menuitem", { name: "Archive" }));

    await waitFor(() =>
      expect(applicationStore.mutateInventory).toHaveBeenCalledWith(
        expect.objectContaining({ id: "thread-1" }),
        "archive",
        { expectedStashedPromptCount: 0 },
      ),
    );
    expect(
      screen.queryByRole("dialog", { name: "Archive this thread" }),
    ).not.toBeInTheDocument();
    await waitFor(() => expect(window.location.pathname).toBe("/"));
    expect(openDrawer).toHaveBeenCalledOnce();
  });

  it("hands the mobile sheet to the choices dialog when descendants exist", async () => {
    mobileMatches = true;
    const { applicationStore } = renderHeader(2);
    applicationStore.getThreadArchiveImpact.mockResolvedValue(
      emptyImpact({ descendantCount: 2 }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Thread actions" }));
    fireEvent.click(
      within(
        screen.getByRole("dialog", { name: "Header thread" }),
      ).getByRole("menuitem", { name: "Archive" }),
    );

    const dialog = await screen.findByRole("dialog", {
      name: "Archive this thread",
    });
    expect(
      screen.queryByRole("dialog", { name: "Header thread" }),
    ).not.toBeInTheDocument();
    await waitFor(() =>
      expect(
        within(dialog).getByRole("button", { name: "Archive" }),
      ).toBeEnabled(),
    );
    expect(applicationStore.mutateInventory).not.toHaveBeenCalled();
  });
});


describe("dismissed archive results after leaving a thread", () => {
  it("keeps required choices after the source header unmounts", async () => {
    const { applicationStore, unmount } = renderHeader(2);
    let finish!: (impact: unknown) => void;
    applicationStore.getThreadArchiveImpact.mockReturnValueOnce(new Promise((resolve) => { finish = resolve; }));
    const menu = await openThreadActions();
    await userEvent.click(within(menu).getByRole("menuitem", { name: "Archive" }));
    await userEvent.click(await screen.findByRole("button", { name: "Dismiss" }));
    unmount();
    window.history.pushState(null, "", "/threads/another-thread");
    await act(async () => { finish(emptyImpact({ descendantCount: 2 })); });
    const dialog = await screen.findByRole("dialog", { name: "Archive this thread" });
    expect(within(dialog).getByText("Header thread")).toBeVisible();
    await userEvent.click(within(dialog).getByRole("button", { name: "Archive" }));
    await waitFor(() => expect(applicationStore.mutateInventory).toHaveBeenCalledWith(
      expect.objectContaining({ id: "thread-1" }), "archive", expect.anything(),
    ));
    await waitFor(() => expect(dialog).not.toBeInTheDocument());
    expect(window.location.pathname).toBe("/threads/another-thread");
  });

  it.each(["check", "mutation"] as const)("keeps a late %s failure after the source header unmounts", async (phase) => {
    const { applicationStore, unmount } = renderHeader(0);
    let fail!: (error: Error) => void;
    const failure = new Promise((_, reject) => { fail = reject; });
    if (phase === "check") applicationStore.getThreadArchiveImpact.mockReturnValueOnce(failure);
    else applicationStore.mutateInventory.mockReturnValueOnce(failure);
    const menu = await openThreadActions();
    await userEvent.click(within(menu).getByRole("menuitem", { name: "Archive" }));
    if (phase === "mutation") await waitFor(() => expect(applicationStore.mutateInventory).toHaveBeenCalledOnce());
    await userEvent.click(await screen.findByRole("button", { name: "Dismiss" }));
    unmount();
    window.history.pushState(null, "", "/threads/another-thread");
    await act(async () => { fail(new Error("Archive service unavailable")); });
    const dialog = await screen.findByRole("dialog", { name: "Could not archive thread" });
    expect(within(dialog).getByRole("alert")).toHaveTextContent("Archive service unavailable");
    expect(within(dialog).getByText("Header thread")).toBeVisible();
    expect(window.location.pathname).toBe("/threads/another-thread");
  });
});
