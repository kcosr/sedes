// @vitest-environment jsdom

import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { NormalizedThreadSnapshot } from "../../../shared/index.js";
import type {
  ApplicationClientState,
  ApplicationClientStore,
} from "../../stores/ApplicationClientStore.js";
import type { ThreadClientStore } from "../../stores/ThreadClientStore.js";
import { UsageQueryCache } from "../../stores/UsageQueryCache.js";
import { ThreadHeader } from "./ThreadHeader.js";
import { NavigationControlsContext } from "../../app/navigation-controls.js";

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
  vi.stubGlobal(
    "matchMedia",
    vi.fn(() => ({
      matches: mobileMatches,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })),
  );
});

afterEach(() => {
  getBlockingOperation()?.cancel();
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
} {
  const applicationState: ApplicationClientState = {
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
  const applicationStore = {
    subscribe: () => () => undefined,
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
        root: { items: [], total: 0, omitted: 0 },
        descendants: { items: [], total: 0, omitted: 0 },
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
  return { applicationStore, threadStore };
}

function renderHeader(
  descendantCount: number,
  openDrawer = vi.fn(),
  inventoryState: "active" | "archived" = "active",
) {
  const { applicationStore, threadStore } = fixture(descendantCount);
  render(
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
  return { applicationStore, openDrawer };
}

describe("ThreadHeader archive action", () => {
  it("keeps New and Fork grouped above restore for an archived thread", () => {
    renderHeader(0, vi.fn(), "archived");
    fireEvent.click(screen.getByRole("button", { name: "Thread actions" }));
    const menu = screen.getByTestId("thread-actions-menu");
    const labels = within(menu)
      .getAllByRole("button")
      .map((button) => button.textContent?.trim());

    expect(labels.indexOf("New")).toBeLessThan(labels.indexOf("Fork"));
    expect(labels.indexOf("Fork")).toBeLessThan(
      labels.indexOf("Restore to Active"),
    );
    expect(
      within(menu).getByRole("button", {
        name: "New thread with same settings",
      }),
    ).toBeEnabled();
  });

  it("archives immediately on desktop when the thread has no descendants", async () => {
    const { applicationStore } = renderHeader(0);
    fireEvent.click(screen.getByRole("button", { name: "Thread actions" }));
    const archive = await screen.findByRole("button", { name: "Archive" });

    fireEvent.click(archive);

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

  it("keeps the choice dropdown on desktop when descendants exist", async () => {
    const { applicationStore } = renderHeader(2);
    fireEvent.click(screen.getByRole("button", { name: "Thread actions" }));
    const archive = await screen.findByRole("button", { name: "Archive" });

    await userEvent.click(archive);

    expect(
      await screen.findByRole("menuitem", { name: "Archive only this thread" }),
    ).toBeVisible();
    expect(applicationStore.mutateInventory).not.toHaveBeenCalled();
    expect(applicationStore.getThreadArchiveImpact).toHaveBeenCalledWith(
      "thread-1",
    );
  });

  it("requires confirmation before archiving a childless thread with unanswered questions", async () => {
    const { applicationStore } = renderHeader(0);
    applicationStore.getThreadArchiveImpact.mockResolvedValue({
      descendantCount: 0,
      pendingQuestions: { root: 2, descendants: 0 },
      stashedPrompts: { root: 0, descendants: 0 },
      openTasks: {
        root: { items: [], total: 0, omitted: 0 },
        descendants: { items: [], total: 0, omitted: 0 },
      },
      executionWorkspace: { kind: "direct" },
      archiveOnly: { available: true },
      archiveAll: { available: true },
    });
    fireEvent.click(screen.getByRole("button", { name: "Thread actions" }));
    await userEvent.click(
      await screen.findByRole("button", { name: "Archive" }),
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

  it("requires confirmation before archiving a childless thread with stashed prompts", async () => {
    const { applicationStore } = renderHeader(0);
    applicationStore.getThreadArchiveImpact.mockResolvedValue({
      descendantCount: 0,
      pendingQuestions: { root: 0, descendants: 0 },
      stashedPrompts: { root: 1, descendants: 0 },
      openTasks: {
        root: { items: [], total: 0, omitted: 0 },
        descendants: { items: [], total: 0, omitted: 0 },
      },
      executionWorkspace: { kind: "direct" },
      archiveOnly: { available: true },
      archiveAll: { available: true },
    });
    fireEvent.click(screen.getByRole("button", { name: "Thread actions" }));
    await userEvent.click(
      await screen.findByRole("button", { name: "Archive" }),
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

  it("opens the archive choices modal on mobile, even without descendants", async () => {
    mobileMatches = true;
    const { applicationStore, openDrawer } = renderHeader(0);
    fireEvent.click(
      screen.getByRole("button", { name: "Show thread toolbar" }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Thread actions" }));
    const archive = await screen.findByRole("button", { name: "Archive" });

    await userEvent.click(archive);

    const dialog = await screen.findByRole("dialog");
    expect(dialog).toBeVisible();
    const archiveOnly = await screen.findByRole("button", { name: "Archive" });
    expect(
      screen.queryByRole("menuitem", { name: /Archive/ }),
    ).not.toBeInTheDocument();
    await waitFor(() => expect(archiveOnly).not.toBeDisabled());
    await userEvent.click(archiveOnly);

    await waitFor(() =>
      expect(applicationStore.mutateInventory).toHaveBeenCalledWith(
        expect.objectContaining({ id: "thread-1" }),
        "archive",
        {
          expectedStashedPromptCount: 0,
          executionWorkspaceDisposition: { kind: "keep" },
        },
      ),
    );
    await waitFor(() => expect(window.location.pathname).toBe("/"));
    expect(openDrawer).toHaveBeenCalledOnce();
  });
});
