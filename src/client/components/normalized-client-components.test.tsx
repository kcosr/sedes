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
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SIDEBAR_VIEW_DEFAULTS, SIDEBAR_VIEW_STORAGE_KEY } from "../app/sidebar-view-model.js";
import { InventorySidebar } from "./InventorySidebar.js";
import { setSidebarShowBackendIcons } from "../app/sidebar-view-store.js";
import type {
  ApplicationClientState,
  ApplicationClientStore,
} from "../stores/ApplicationClientStore.js";

// jsdom lacks the observer and pointer APIs Radix popovers (floating-ui)
// touch; the view-options popover renders through them.
beforeEach(() => {
  // These normalized-row and lineage tests deliberately exercise Projects.
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
  cleanup();
  localStorage.clear();
  // Same-window storage writes never fire "storage", so the view store's
  // snapshot cache must be invalidated explicitly between tests.
  window.dispatchEvent(new StorageEvent("storage", { key: null }));
  vi.unstubAllGlobals();
});

describe("normalized application components", () => {
  it("renders normalized thread titles, attention, and queue state", () => {
    const thread = {
      id: "thread-1",
      workspaceId: "workspace-1",
      targetId: "target-1",
      title: { text: "Review backend contract" },
      backend: { label: { text: "Pi" }, brand: "pi" as const },
      backingState: "bound" as const,
      inventoryState: "active" as const,
      inventoryRevision: 2,
      preferredWorktreeRevision: 0,
      preferredWorktree: null,
      pinned: false,
      pinRevision: 0,
      groupId: null,
      groupAssignmentRevision: 0,
      bookmarkRevision: 0,
      turnBookmarkCount: 0,
      threadRevision: 4,
      runState: "idle" as const,
      terminalSummary: { runningCount: 0, retainedCount: 0 },
      queuedInputCount: 2,
      pendingQuestionCount: 0,
      stashedPromptCount: 0,
      available: true,
      lastActivityAt: "2026-07-30T15:00:00.000Z",
      stateChangedAt: "2026-07-30T15:00:00.000Z",
      automation: null,
      attention: {
        wake: false,
        automationContext: null,
        unseenCompletion: true,
        queueFailure: false,
      },
    };
    const snapshot = {
      advisories: [],
      environments: [
        {
          id: "environment-1",
          kind: "local" as const,
          label: { text: "Machine" },
          available: true as const,
          directoryBrowsing: "unavailable" as const,
        },
      ],
      workspaces: [
        {
          id: "workspace-1",
          environmentId: "environment-1",
          label: { text: "Sedes" },
          displayPath: { text: "/workspace/sedes" },
          available: true as const,
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
          available: true as const,
        },
      ],
      defaultNewThreadTargetId: "target-1",
      forkOrigins: [],
      lineagePlacements: [],
      groups: [],
      lineageFamilies: [],
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
      snapshot,
      visibleThreads: [thread],
    };
    const store = {
      createThread: vi.fn(),
      openWorkspace: vi.fn(),
      setSearch: vi.fn(),
      mutateInventory: vi.fn(),
    } as unknown as ApplicationClientStore;

    const { rerender } = render(
      <InventorySidebar
        state={state}
        store={store}
        selectedThreadId="thread-1"
        onNavigate={() => undefined}
        onOpenSettings={() => undefined}
      />,
    );

    expect(screen.getByText("Review backend contract")).toBeInTheDocument();
    expect(screen.queryByRole("img", { name: "Sedes" })).toBeNull();
    expect(document.querySelector(".brand-name")).toBeNull();
    // Backend brand marks default on and follow the view preference.
    const brand = document.querySelector(".row-brand");
    expect(brand).not.toBeNull();
    expect(brand).toHaveAttribute("title", "Pi");
    expect(screen.getByRole("img", { name: "Pi" })).toBe(brand);
    act(() => {
      setSidebarShowBackendIcons(false);
    });
    expect(document.querySelector(".row-brand")).toBeNull();
    act(() => {
      setSidebarShowBackendIcons(true);
    });
    expect(document.querySelector(".row-brand")).not.toBeNull();
    const done = screen.getByRole("img", {
      name: "Finished while you were away",
    });
    expect(done).toHaveAttribute("data-testid", "thread-row-unseen-dot");
    expect(screen.queryByText("Done")).toBeNull();
    const queued = screen.getByRole("img", { name: "2 queued" });
    expect(queued).toHaveAttribute("data-chip", "queued");
    expect(queued).toHaveTextContent("");
    expect(screen.getByTestId("project-row")).toHaveTextContent("Sedes");
    expect(screen.getByText("No automations.")).toBeInTheDocument();
    expect(screen.getByText("Nothing snoozed.")).toBeInTheDocument();
    expect(screen.getByText("Nothing settled.")).toBeInTheDocument();

    const settledThread = {
      ...thread,
      inventoryState: "settled" as const,
    };
    rerender(
      <InventorySidebar
        state={{
          ...state,
          snapshot: {
            ...snapshot,
            threads: [settledThread],
            counts: { active: 0, snoozed: 0, settled: 1, archived: 0 },
          },
          visibleThreads: [settledThread],
        }}
        store={store}
        selectedThreadId="thread-1"
        onNavigate={() => undefined}
        onOpenSettings={() => undefined}
      />,
    );

    expect(
      screen.queryByRole("img", { name: "Finished while you were away" }),
    ).toBeNull();
    expect(
      screen.getByTestId("thread-row-link").querySelector(".lucide-check"),
    ).not.toBeNull();
  });

  // The run glyph replaced a text pill; `title` alone is not announced on a
  // generic span, so the state has to reach the row's accessible name the
  // same way the status chips do.
  it("carries run state into the row's accessible name, not just a tooltip", () => {
    const { rerender } = renderSidebar("running");
    const indicator = screen.getByTestId("run-indicator");
    expect(indicator).toHaveAttribute("role", "img");
    expect(indicator).toHaveAccessibleName("Running");
    expect(screen.getByTestId("thread-row-link")).toHaveAccessibleName(
      /Running/,
    );

    rerender(sidebarElement("waiting_for_input"));
    // Waiting states render the needs-input chip instead of the run glyph.
    expect(screen.queryByTestId("run-indicator")).toBeNull();
    expect(
      screen.getByRole("img", { name: "Needs input" }),
    ).toBeInTheDocument();
  });

  it("resyncs on navigation without overriding a deliberate workspace choice", async () => {
    const threadA = {
      id: "thread-a",
      workspaceId: "workspace-a",
      targetId: "target-1",
      title: { text: "Thread A" },
      backend: { label: { text: "Pi" }, brand: "pi" as const },
      backingState: "bound" as const,
      inventoryState: "active" as const,
      inventoryRevision: 1,
      preferredWorktreeRevision: 0,
      preferredWorktree: null,
      pinned: false,
      pinRevision: 0,
      groupId: null,
      groupAssignmentRevision: 0,
      bookmarkRevision: 0,
      turnBookmarkCount: 0,
      threadRevision: 1,
      runState: "idle" as const,
      terminalSummary: { runningCount: 0, retainedCount: 0 },
      queuedInputCount: 0,
      pendingQuestionCount: 0,
      stashedPromptCount: 0,
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
    };
    const threadB = {
      ...threadA,
      id: "thread-b",
      workspaceId: "workspace-b",
      title: { text: "Thread B" },
    };
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
          id: "workspace-a",
          environmentId: "environment-1",
          label: { text: "A" },
          displayPath: { text: "/a" },
          available: true,
        },
        {
          id: "workspace-b",
          environmentId: "environment-1",
          label: { text: "B" },
          displayPath: { text: "/b" },
          available: true,
        },
      ],
      threads: [threadA, threadB],
      executionTargets: [
        {
          id: "target-1",
          environmentId: "environment-1",
          label: { text: "Local SDK" },
          backend: { label: { text: "Pi" }, brand: "pi" as const },
          workspaceExecution: { kind: "direct_only" as const },
          available: true as const,
        },
      ],
      defaultNewThreadTargetId: "target-1",
      forkOrigins: [],
      lineagePlacements: [],
      groups: [],
      lineageFamilies: [],
      counts: { active: 2, snoozed: 0, settled: 0, archived: 0 },
      tasks: [],
    };
    const createThread = vi.fn().mockResolvedValue({
      threadId: "thread-new",
      workspaceId: "workspace-b",
      targetId: "target-1",
    });
    const store = {
      createThread,
      api: {
        listSavedAgents: vi.fn().mockResolvedValue({ items: [] }),
        getEnvironmentVariablePreview: vi.fn().mockResolvedValue({ snapshot: { version: 1, layers: { environment: {}, backend: {}, agent: {}, thread: {} } }, revision: { configurationRevision: 1 }, startup: { supported: true } }),
      },
      openWorkspace: vi.fn(),
      setSearch: vi.fn(),
      mutateInventory: vi.fn(),
    } as unknown as ApplicationClientStore;

    render(
      <InventorySidebar
        state={{
          status: "ready",
          connection: "connected",
          authoritative: true,
          providerPulseEnabled: false, experimentalUsageEnabled: false,
          search: "",
          descendantPages: {},
          pendingThreadConfigurationCopySourceIds: [],
          snapshot,
          visibleThreads: [threadA, threadB],
        }}
        store={store}
        selectedThreadId="thread-a"
        onNavigate={() => undefined}
        onOpenSettings={() => undefined}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Filter to B" }));
    fireEvent.click(screen.getByRole("button", { name: "New thread" }));
    fireEvent.click(screen.getByRole("combobox", { name: "Target" }));
    fireEvent.click(screen.getByRole("option", { name: "Local SDK · Pi" }));
    fireEvent.click(await screen.findByRole("button", { name: "Use Custom" }));
    fireEvent.click(screen.getByRole("button", { name: "Create thread" }));
    await waitFor(() =>
      expect(createThread).toHaveBeenCalledWith({
        workspaceId: "workspace-b",
        environmentVariables: {},
        environmentVariablesRevision: { configurationRevision: 1 },
        title: "New thread",
        executionWorkspace: { kind: "direct" },
        configuration: { kind: "custom", targetId: "target-1" },
      }),
    );
  });

  it("groups fork families, aggregates collapsed state, and keeps flat mode local", async () => {
    const root = makeSidebarThread("root", "Duplicate title", "idle");
    const child = makeSidebarThread(
      "child",
      "Duplicate title",
      "waiting_for_input",
    );
    const runningChild = makeSidebarThread(
      "running-child",
      "Duplicate title",
      "running",
    );
    const failedChild = {
      ...makeSidebarThread("failed-child", "Duplicate title", "failed"),
      attention: {
        ...root.attention,
        queueFailure: true,
      },
    };
    const doneChild = {
      ...makeSidebarThread("done-child", "Duplicate title", "idle"),
      attention: {
        ...root.attention,
        unseenCompletion: true,
      },
    };
    const children = [child, runningChild, failedChild, doneChild];
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
      threads: [root, ...children],
      forkOrigins: children.map(({ id }) => ({
        childThreadId: id,
        sourceThreadId: "root",
        sourceTurnId: "turn-root",
        sourceTurnCompletedAt: "2026-07-30T14:59:00.000Z",
        boundaryKind: "completed_turn_inclusive" as const,
        originKind: "user_fork" as const,
        initiatingAgentThreadId: null,
        initiatingToolClientId: null,
        branchMethod: "provider_native" as const,
        createdAt: "2026-07-30T15:00:00.000Z",
      })),
      lineagePlacements: children.map(({ id }) => ({
        childThreadId: id,
        mode: "nested_under_source" as const,
        revision: 2,
        updatedAt: "2026-07-30T15:00:00.000Z",
      })),
      groups: [],
      lineageFamilies: [],
      executionTargets: [],
      defaultNewThreadTargetId: null,
      counts: { active: 5, snoozed: 0, settled: 0, archived: 0 },
      tasks: [],
    };
    const updateLineagePlacement = vi.fn();
    const store = {
      createThread: vi.fn(),
      openWorkspace: vi.fn(),
      setSearch: vi.fn(),
      mutateInventory: vi.fn(),
      updateLineagePlacement,
      loadMoreDescendants: vi.fn(),
    } as unknown as ApplicationClientStore;
    const state: ApplicationClientState = {
      status: "ready",
      connection: "connected",
      authoritative: true,
      providerPulseEnabled: false, experimentalUsageEnabled: false,
      search: "",
      descendantPages: {},
      pendingThreadConfigurationCopySourceIds: [],
      snapshot,
      visibleThreads: [root, ...children],
    };

    const { rerender } = render(
      <InventorySidebar
        state={state}
        store={store}
        onNavigate={() => undefined}
        onOpenSettings={() => undefined}
      />,
    );

    expect(document.querySelector('[data-thread-id="child"]')).toHaveAttribute(
      "data-lineage-depth",
      "1",
    );
    expect(
      screen.queryByRole("button", { name: /Forked from “Duplicate title”/ }),
    ).not.toBeInTheDocument();
    fireEvent.click(
      screen.getByRole("button", {
        name: "Collapse fork family for Duplicate title",
      }),
    );
    expect(
      screen.getByRole("img", { name: "1 descendants need input" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("img", { name: "1 descendants running" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("img", { name: "1 descendants failed" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("img", { name: "1 descendants done" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("img", { name: "1 descendants need attention" }),
    ).toBeInTheDocument();

    // Fork grouping now lives in the view-options popover.
    fireEvent.click(screen.getByTestId("view-options-trigger"));
    fireEvent.click(
      await screen.findByRole("checkbox", { name: "Group fork families" }),
    );
    await waitFor(() => {
      expect(
        document.querySelector('[data-thread-id="child"]'),
      ).toHaveAttribute("data-lineage-depth", "0");
    });
    expect(
      screen.getAllByRole("button", { name: /Forked from “Duplicate title”/ }),
    ).toHaveLength(4);
    expect(updateLineagePlacement).not.toHaveBeenCalled();
    expect(
      JSON.parse(localStorage.getItem("sedes.sidebar.view") ?? "{}"),
    ).toMatchObject({ groupForks: false });

    const snoozedThreads = [root, ...children].map((candidate) => ({
      ...candidate,
      inventoryState: "snoozed" as const,
    }));
    const snoozedSnapshot = {
      ...snapshot,
      threads: snoozedThreads,
      counts: { active: 0, snoozed: 5, settled: 0, archived: 0 },
      tasks: [],
    };
    rerender(
      <InventorySidebar
        state={{
          ...state,
          snapshot: snoozedSnapshot,
          visibleThreads: snoozedThreads,
        }}
        store={store}
        onNavigate={() => undefined}
        onOpenSettings={() => undefined}
      />,
    );
    const snoozedShelf = screen
      .getAllByTestId("inventory-shelf")
      .find((shelf) => shelf.getAttribute("data-shelf") === "snoozed");
    expect(snoozedShelf).toBeDefined();
    expect(snoozedShelf!).toHaveTextContent("Snoozed · 5");
  });

  it("offers bounded paging for a recurring root with no bootstrap children", () => {
    const root = {
      ...makeSidebarThread("automation-root", "Recurring review", "idle"),
      automation: {
        status: "enabled" as const,
        runMode: "clone" as const,
        scheduleKind: "interval" as const,
        revision: 1,
        hasPrecheck: false,
      },
    };
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
      threads: [root],
      forkOrigins: [],
      lineagePlacements: [],
      groups: [],
      lineageFamilies: [{ sourceThreadId: root.id, descendantCount: 12 }],
      executionTargets: [],
      defaultNewThreadTargetId: null,
      counts: { active: 1, snoozed: 0, settled: 0, archived: 0 },
      tasks: [],
    };
    const loadMoreDescendants = vi.fn(async () => undefined);
    const store = {
      createThread: vi.fn(),
      openWorkspace: vi.fn(),
      setSearch: vi.fn(),
      mutateInventory: vi.fn(),
      loadMoreDescendants,
    } as unknown as ApplicationClientStore;

    render(
      <InventorySidebar
        state={{
          status: "ready",
          connection: "connected",
          authoritative: true,
          providerPulseEnabled: false, experimentalUsageEnabled: false,
          search: "",
          descendantPages: {},
          pendingThreadConfigurationCopySourceIds: [],
          snapshot,
          visibleThreads: [root],
        }}
        store={store}
        onNavigate={() => undefined}
        onOpenSettings={() => undefined}
      />,
    );

    expect(
      screen.getByRole("button", {
        name: "Collapse fork family for Recurring review",
      }),
    ).toBeInTheDocument();
    fireEvent.click(
      screen.getByRole("button", { name: "Show all runs/forks" }),
    );
    expect(loadMoreDescendants).toHaveBeenCalledWith("automation-root");
  });

  it("uses the authoritative family count to expose omitted manual descendants", () => {
    const root = makeSidebarThread(
      "manual-root",
      "Older manual family",
      "idle",
    );
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
      threads: [root],
      forkOrigins: [],
      lineagePlacements: [],
      groups: [],
      lineageFamilies: [{ sourceThreadId: root.id, descendantCount: 37 }],
      executionTargets: [],
      defaultNewThreadTargetId: null,
      counts: { active: 1, snoozed: 0, settled: 0, archived: 0 },
      tasks: [],
    };
    const loadMoreDescendants = vi.fn(async () => undefined);
    const store = {
      createThread: vi.fn(),
      openWorkspace: vi.fn(),
      setSearch: vi.fn(),
      mutateInventory: vi.fn(),
      loadMoreDescendants,
    } as unknown as ApplicationClientStore;

    render(
      <InventorySidebar
        state={{
          status: "ready",
          connection: "connected",
          authoritative: true,
          providerPulseEnabled: false, experimentalUsageEnabled: false,
          search: "",
          descendantPages: {},
          pendingThreadConfigurationCopySourceIds: [],
          snapshot,
          visibleThreads: [root],
        }}
        store={store}
        onNavigate={() => undefined}
        onOpenSettings={() => undefined}
      />,
    );

    fireEvent.click(
      screen.getByRole("button", { name: "Show all runs/forks" }),
    );
    expect(loadMoreDescendants).toHaveBeenCalledWith("manual-root");
    fireEvent.click(
      screen.getByRole("button", {
        name: "Collapse fork family for Older manual family",
      }),
    );
    expect(screen.getByLabelText(/37 lineage descendants/)).toBeInTheDocument();
  });

  it("keeps a collapsed lineage disclosure target present for assistive technology", () => {
    const root = makeSidebarThread("root", "Root thread", "idle");
    const child = makeSidebarThread("child", "Child thread", "idle");
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
      threads: [root, child],
      forkOrigins: [
        {
          childThreadId: child.id,
          sourceThreadId: root.id,
          sourceTurnId: "turn-root",
          sourceTurnCompletedAt: "2026-07-30T14:59:00.000Z",
          boundaryKind: "completed_turn_inclusive" as const,
          originKind: "user_fork" as const,
          initiatingAgentThreadId: null,
          initiatingToolClientId: null,
          branchMethod: "provider_native" as const,
          createdAt: "2026-07-30T15:00:00.000Z",
        },
      ],
      lineagePlacements: [
        {
          childThreadId: child.id,
          mode: "nested_under_source" as const,
          revision: 1,
          updatedAt: "2026-07-30T15:00:00.000Z",
        },
      ],
      groups: [],
      lineageFamilies: [],
      executionTargets: [],
      defaultNewThreadTargetId: null,
      counts: { active: 2, snoozed: 0, settled: 0, archived: 0 },
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
      snapshot,
      visibleThreads: [root, child],
    };

    render(
      <InventorySidebar
        state={state}
        store={
          {
            createThread: vi.fn(),
            openWorkspace: vi.fn(),
            setSearch: vi.fn(),
            mutateInventory: vi.fn(),
            updateLineagePlacement: vi.fn(),
          } as unknown as ApplicationClientStore
        }
        onNavigate={() => undefined}
        onOpenSettings={() => undefined}
      />,
    );

    const childRow = document.querySelector('[data-thread-id="child"]');
    const trailing = childRow?.querySelector(".thread-row-trailing");
    expect(trailing).not.toBeNull();
    expect(
      trailing?.querySelector(".thread-row-provenance .fork-split-icon"),
    ).toBeNull();
    expect(
      Array.from(
        trailing?.querySelector(".thread-row-default-trailing")?.children ?? [],
      ).map((element) => element.classList.contains("thread-row-provenance")),
    ).toEqual([false]);
    const detach = within(childRow as HTMLElement).getByRole("button", {
      name: "Show Child thread as top-level",
    });
    const archive = within(childRow as HTMLElement).getByRole("button", {
      name: "Archive Child thread",
    });
    expect(detach.querySelector(".lucide-arrow-up-wide-narrow")).not.toBeNull();
    expect(
      childRow?.querySelector(".thread-row-actions")?.lastElementChild,
    ).toBe(archive);
    expect(archive.previousElementSibling).toBe(detach);

    fireEvent.click(
      screen.getByRole("button", {
        name: "Collapse fork family for Root thread",
      }),
    );
    const disclosure = screen.getByRole("button", {
      name: "Expand fork family for Root thread",
    });
    const targetId = disclosure.getAttribute("aria-controls");
    expect(targetId).toBeTruthy();
    expect(document.getElementById(targetId!)).toHaveAttribute("hidden");
  });

  it("does not show an empty search state beside a matching paged descendant", () => {
    const root = makeSidebarThread("root", "Root thread", "idle");
    const child = makeSidebarThread("child", "Needle descendant", "idle");
    const origin = {
      childThreadId: child.id,
      sourceThreadId: root.id,
      sourceTurnId: "turn-root",
      sourceTurnCompletedAt: "2026-07-30T14:59:00.000Z",
      boundaryKind: "completed_turn_inclusive" as const,
      originKind: "user_fork" as const,
      initiatingAgentThreadId: null,
      initiatingToolClientId: null,
      branchMethod: "provider_native" as const,
      createdAt: "2026-07-30T15:00:00.000Z",
    };
    const placement = {
      childThreadId: child.id,
      mode: "nested_under_source" as const,
      revision: 1,
      updatedAt: "2026-07-30T15:00:00.000Z",
    };
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
      threads: [root],
      forkOrigins: [],
      lineagePlacements: [],
      groups: [],
      lineageFamilies: [{ sourceThreadId: root.id, descendantCount: 1 }],
      executionTargets: [],
      defaultNewThreadTargetId: null,
      counts: { active: 1, snoozed: 0, settled: 0, archived: 0 },
      tasks: [],
    };
    const state: ApplicationClientState = {
      status: "ready",
      connection: "connected",
      authoritative: true,
      providerPulseEnabled: false, experimentalUsageEnabled: false,
      search: "needle",
      pendingThreadConfigurationCopySourceIds: [],
      descendantPages: {
        [root.id]: {
          descendants: [{ thread: child, origin, placement }],
          loading: false,
          loaded: true,
        },
      },
      snapshot,
      visibleThreads: [],
    };

    render(
      <InventorySidebar
        state={state}
        store={
          {
            createThread: vi.fn(),
            openWorkspace: vi.fn(),
            setSearch: vi.fn(),
            mutateInventory: vi.fn(),
            updateLineagePlacement: vi.fn(),
          } as unknown as ApplicationClientStore
        }
        onNavigate={() => undefined}
        onOpenSettings={() => undefined}
      />,
    );

    expect(screen.getByText("Needle descendant")).toBeInTheDocument();
    expect(screen.queryByText("No matching threads")).toBeNull();
  });
});

function makeSidebarThread(
  id: string,
  title: string,
  runState: "idle" | "running" | "waiting_for_input" | "failed",
) {
  return {
    id,
    workspaceId: "workspace-1",
    targetId: "target-1",
    title: { text: title },
    backend: { label: { text: "Pi" }, brand: "pi" as const },
    backingState: "bound" as const,
    inventoryState: "active" as const,
    inventoryRevision: 1,
    preferredWorktreeRevision: 0,
    preferredWorktree: null,
    pinned: false,
    pinRevision: 0,
    groupId: null,
    groupAssignmentRevision: 0,
    bookmarkRevision: 0,
    turnBookmarkCount: 0,
    threadRevision: 1,
    runState,
    terminalSummary: { runningCount: 0, retainedCount: 0 },
    queuedInputCount: 0,
    pendingQuestionCount: 0,
    stashedPromptCount: 0,
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
  };
}

function sidebarElement(runState: "running" | "waiting_for_input") {
  const thread = {
    id: "thread-1",
    workspaceId: "workspace-1",
    targetId: "target-1",
    title: { text: "Review backend contract" },
    backend: { label: { text: "Pi" }, brand: "pi" as const },
    backingState: "bound" as const,
    inventoryState: "active" as const,
    inventoryRevision: 2,
    preferredWorktreeRevision: 0,
    preferredWorktree: null,
    pinned: false,
    pinRevision: 0,
    groupId: null,
    groupAssignmentRevision: 0,
    bookmarkRevision: 0,
    turnBookmarkCount: 0,
    threadRevision: 4,
    runState,
    terminalSummary: { runningCount: 0, retainedCount: 0 },
    queuedInputCount: 0,
    pendingQuestionCount: 0,
    stashedPromptCount: 0,
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
  };
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
    executionTargets: [],
    defaultNewThreadTargetId: null,
    forkOrigins: [],
    lineagePlacements: [],
    groups: [],
    lineageFamilies: [],
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
  const store = {
    createThread: vi.fn(),
    openWorkspace: vi.fn(),
    setSearch: vi.fn(),
    mutateInventory: vi.fn(),
  } as unknown as ApplicationClientStore;
  return (
    <InventorySidebar
      state={state}
      store={store}
      selectedThreadId="thread-1"
      onNavigate={() => undefined}
      onOpenSettings={() => undefined}
    />
  );
}

function renderSidebar(runState: "running" | "waiting_for_input") {
  return render(sidebarElement(runState));
}
