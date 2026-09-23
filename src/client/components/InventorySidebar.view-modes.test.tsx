// @vitest-environment jsdom
import { OperationOverlayHost } from "../operations/OperationOverlay.js";
import { getBlockingOperation } from "../operations/blocking-operation.js";


import type { ThreadStoreRegistry } from "../stores/ThreadStoreRegistry.js";
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
import {
  SIDEBAR_VIEW_DEFAULTS,
  SIDEBAR_VIEW_STORAGE_KEY,
  type SidebarViewPreferences,
} from "../app/sidebar-view-model.js";
import { clearActiveSidebarFilters, hasActiveSidebarFilters, setSidebarInventoryScope } from "../app/sidebar-view-store.js";
import type {
  ApplicationClientState,
  ApplicationClientStore,
} from "../stores/ApplicationClientStore.js";
import {
  setEnvironmentColorsEnabled,
  setEnvironmentPalette,
} from "../app/environment-palette.js";
import {
  SIDEBAR_QUICK_SWITCH_CONFIRMATION_MS,
  SIDEBAR_QUICK_SWITCH_HOLD_DELAY_MS,
} from "../app/keyboard-shortcuts.js";
import { setClickNamesToFilter } from "../app/settings.js";
import { InventorySidebar } from "./InventorySidebar.js";
import type { PanelPresentation } from "../workspace-panels/panel-presentation.js";
import {
  TASK_DRAG_MIME,
  TaskDragProvider,
  useTaskDrag,
} from "../tasks/task-drag.js";

type ThreadSummary = ApplicationClientState["visibleThreads"][number];
type TaskSummary = NonNullable<
  ApplicationClientState["snapshot"]
>["tasks"][number];

// jsdom lacks the observer, pointer-capture, and scroll APIs the Radix
// popover and the view-switch selection anchor touch.
beforeEach(() => {
  render(<OperationOverlayHost />);
  seedViewPreferences({ groupBy: "project" });
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
  // Same-window storage writes never fire "storage", so the view store's
  // snapshot cache must be invalidated explicitly between tests.
  window.dispatchEvent(new StorageEvent("storage", { key: null }));
  vi.unstubAllGlobals();
});

function seedViewPreferences(overrides: Partial<SidebarViewPreferences>): void {
  localStorage.setItem(
    SIDEBAR_VIEW_STORAGE_KEY,
    JSON.stringify({ ...SIDEBAR_VIEW_DEFAULTS, groupBy: "project", ...overrides }),
  );
  window.dispatchEvent(
    new StorageEvent("storage", { key: SIDEBAR_VIEW_STORAGE_KEY }),
  );
}

/** Noon keeps the stamp inside its calendar day whatever the current time. */
function isoAtNoon(dayOffset: number): string {
  const now = new Date();
  return new Date(
    now.getFullYear(),
    now.getMonth(),
    now.getDate() + dayOffset,
    12,
  ).toISOString();
}

function makeThread(
  id: string,
  title: string,
  overrides: Partial<ThreadSummary> = {},
): ThreadSummary {
  return {
    id,
    workspaceId: "workspace-1",
    targetId: "target-1",
    title: { text: title },
    backend: { label: { text: "Pi" }, brand: "pi" as const },
    backingState: "bound" as const,
    inventoryState: "active" as const,
    inventoryRevision: 1,
    pinned: false,
    pinRevision: 0,
    groupId: null,
    groupAssignmentRevision: 0,
    bookmarkRevision: 0,
    turnBookmarkCount: 0,
    threadRevision: 1,
    runState: "idle" as const,
    queuedInputCount: 0,
    stashedPromptCount: 0,
    pendingQuestionCount: 0,
    terminalSummary: { runningCount: 0, retainedCount: 0 },
    available: true,
    lastActivityAt: isoAtNoon(0),
    stateChangedAt: isoAtNoon(0),
    automation: null,
    attention: {
      wake: false,
      automationContext: null,
      unseenCompletion: false,
      queueFailure: false,
    },
    ...overrides,
    preferredWorktreeRevision: overrides.preferredWorktreeRevision ?? 0,
    preferredWorktree: overrides.preferredWorktree ?? null,
  };
}

interface StateOptions {
  readonly search?: string;
  readonly environments?: NonNullable<
    ApplicationClientState["snapshot"]
  >["environments"];
  readonly workspaces?: NonNullable<
    ApplicationClientState["snapshot"]
  >["workspaces"];
  readonly executionTargets?: NonNullable<
    ApplicationClientState["snapshot"]
  >["executionTargets"];
  readonly tasks?: readonly TaskSummary[];
  readonly selectedThreadId?: string;
  readonly groups?: NonNullable<ApplicationClientState["snapshot"]>["groups"];
  readonly descendantPages?: ApplicationClientState["descendantPages"];
  readonly forkOrigins?: readonly ReturnType<typeof forkOrigin>[];
  readonly lineagePlacements?: readonly ReturnType<typeof nestedPlacement>[];
  readonly lineageFamilies?: readonly {
    sourceThreadId: string;
    descendantCount: number;
  }[];
}

function forkOrigin(childThreadId: string, sourceThreadId: string) {
  return {
    childThreadId,
    sourceThreadId,
    sourceTurnId: "turn-1",
    sourceTurnCompletedAt: isoAtNoon(-1),
    boundaryKind: "completed_turn_inclusive" as const,
    originKind: "user_fork" as const,
    initiatingAgentThreadId: null,
    initiatingToolClientId: null,
    branchMethod: "provider_native" as const,
    createdAt: isoAtNoon(-1),
  };
}

function nestedPlacement(childThreadId: string) {
  return {
    childThreadId,
    mode: "nested_under_source" as const,
    revision: 1,
    updatedAt: isoAtNoon(-1),
  };
}

function makeTask(
  id: string,
  scope: TaskSummary["scope"],
  completedAt: string | null = null,
): TaskSummary {
  return {
    id,
    scope,
    associatedWorkspaceId:
      scope.kind === "global"
        ? null
        : scope.kind === "workspace"
          ? scope.workspaceId
          : "workspace-1",
    title: `Task ${id}`,
    details: "",
    pinned: false,
    files: [],
    completedAt,
    revision: 0,
    createdAt: isoAtNoon(-1),
    updatedAt: isoAtNoon(-1),
  };
}

function TaskDragTestSource({ task }: { readonly task: TaskSummary }) {
  const taskDrag = useTaskDrag();
  return (
    <button
      type="button"
      draggable
      aria-label="Task drag source"
      onDragStart={(event) => taskDrag?.beginTaskDrag(task, event.dataTransfer)}
      onDragEnd={() => taskDrag?.endTaskDrag()}
    >
      Task
    </button>
  );
}

function makeState(
  threads: readonly ThreadSummary[],
  options: StateOptions = {},
): ApplicationClientState {
  const snapshot = {
    environments: options.environments ?? [
      {
        id: "environment-1",
        kind: "local" as const,
        label: { text: "Machine" },
        available: true,
        directoryBrowsing: "unavailable" as const,
      },
    ],
    workspaces: options.workspaces ?? [
      {
        id: "workspace-1",
        environmentId: "environment-1",
        label: { text: "Sedes" },
        displayPath: { text: "/workspace/sedes" },
        available: true,
      },
    ],
    threads: [...threads],
    groups: [...(options.groups ?? [])],
    executionTargets: [
      ...(options.executionTargets ?? [
        {
          id: "target-1",
          environmentId: "environment-1",
          label: { text: "Pi" },
          backend: { label: { text: "Pi" }, brand: "pi" as const },
          workspaceExecution: { kind: "direct_only" as const },
          available: true,
        },
      ]),
    ],
    defaultNewThreadTargetId: null,
    forkOrigins: [...(options.forkOrigins ?? [])],
    lineagePlacements: [...(options.lineagePlacements ?? [])],
    lineageFamilies: [...(options.lineageFamilies ?? [])],
    counts: { active: threads.length, snoozed: 0, settled: 0, archived: 0 },
    tasks: [...(options.tasks ?? [])],
  };
  return {
    status: "ready",
    connection: "connected",
    authoritative: true,
    providerPulseEnabled: false,
    search: options.search ?? "",
    descendantPages: options.descendantPages ?? {},
    pendingThreadConfigurationCopySourceIds: [],
    snapshot: snapshot as ApplicationClientState["snapshot"],
    visibleThreads: threads,
  };
}

function renderSidebar(
  threads: readonly ThreadSummary[],
  options: StateOptions = {},
  peekEnabled = true,
  onSelectThread?: (threadId: string, presentation: PanelPresentation) => void,
  withTaskDragProvider = false,
  threadRegistry?: ThreadStoreRegistry,
) {
  const state = makeState(threads, options);
  const store = {
    normalized: {
      replayCursor: "00000000-0000-4000-8000-000000000001.0",
    },
    api: {
      browseExecutionEnvironmentDirectories: vi.fn(async () => ({
        location: { kind: "roots" as const },
        entries: [],
        truncated: false,
      })),
    },
    createThread: vi.fn(),
    openWorkspace: vi.fn().mockResolvedValue("workspace-new"),
    refresh: vi.fn().mockResolvedValue(undefined),
    getSnapshot: vi.fn(() => state),
    getTasks: vi.fn(() => state.snapshot?.tasks ?? []),
    moveTask: vi.fn().mockResolvedValue(undefined),
    setSearch: vi.fn(),
    mutateInventory: vi.fn().mockResolvedValue(undefined),
    setThreadPinned: vi.fn().mockResolvedValue(undefined),
    renameThread: vi.fn().mockResolvedValue(undefined),
    archiveThreadFamily: vi.fn().mockResolvedValue([]),
    loadMoreDescendants: vi.fn().mockResolvedValue(undefined),
    getThreadArchiveImpact: vi.fn().mockResolvedValue({
      descendantCount: 0,
      pendingQuestions: { root: 0, descendants: 0 },
      stashedPrompts: { root: 0, descendants: 0 },
      openTasks: {
        root: { items: [], total: 0, omitted: 0 },
        descendants: { items: [], total: 0, omitted: 0 },
      },
      executionWorkspace: { kind: "direct" },
      archiveOnly: { available: true },
      archiveAll: { available: true },
    }),
    getBulkInventoryImpact: vi.fn(
      async (
        action: "settle" | "unsettle" | "archive",
        threadIds: string[],
      ) => ({
        action,
        targets: threadIds.map((threadId) => ({
          threadId,
          expectedRevision:
            threads.find(({ id }) => id === threadId)?.inventoryRevision ?? 0,
        })),
        targetCount: threadIds.length,
        affectedCount: threadIds.length,
        pendingQuestionCount: 0,
        unchangedCount: 0,
        blockers: { items: [], total: 0, omitted: 0 },
        openTasks: { items: [], total: 0, omitted: 0 },
        stashedPromptCount: 0,
        available: true,
      }),
    ),
    createBulkInventoryMutationRequest: vi.fn(
      (
        impact: Awaited<
          ReturnType<ApplicationClientStore["getBulkInventoryImpact"]>
        >,
      ) => ({
        action: impact.action,
        targets: impact.targets,
        ...(impact.action === "unsettle"
          ? {}
          : {
              expectedStashedPromptCount: impact.stashedPromptCount,
              expectedOpenTaskCount: impact.openTasks.total,
            }),
        mutationId: "11111111-1111-4111-8111-111111111111",
      }),
    ),
    mutateBulkInventory: vi.fn(
      async (
        request: Parameters<ApplicationClientStore["mutateBulkInventory"]>[0],
      ) => ({
        changedThreadIds: request.targets.map(({ threadId }) => threadId),
      }),
    ),
  } as unknown as ApplicationClientStore & {
    mutateInventory: ReturnType<typeof vi.fn>;
    openWorkspace: ReturnType<typeof vi.fn>;
    refresh: ReturnType<typeof vi.fn>;
    getSnapshot: ReturnType<typeof vi.fn>;
    renameThread: ReturnType<typeof vi.fn>;
    loadMoreDescendants: ReturnType<typeof vi.fn>;
    getBulkInventoryImpact: ReturnType<typeof vi.fn>;
    createBulkInventoryMutationRequest: ReturnType<typeof vi.fn>;
    mutateBulkInventory: ReturnType<typeof vi.fn>;
  };
  const content = (current: ApplicationClientState) => {
    const sidebar = (
      <InventorySidebar
        state={current}
        store={store}
        threadRegistry={threadRegistry}
        selectedThreadId={options.selectedThreadId}
        onSelectThread={onSelectThread}
        onNavigate={() => undefined}
        onOpenSettings={() => undefined}
        peekEnabled={peekEnabled}
      />
    );
    return withTaskDragProvider ? (
      <TaskDragProvider store={store} snapshot={current.snapshot!}>
        {current.snapshot!.tasks[0] ? (
          <TaskDragTestSource task={current.snapshot!.tasks[0]} />
        ) : null}
        {sidebar}
      </TaskDragProvider>
    ) : (
      sidebar
    );
  };
  const result = render(content(state));
  return {
    ...result,
    store,
    rerenderSidebar(current: ApplicationClientState) {
      store.getSnapshot.mockReturnValue(current);
      result.rerender(content(current));
    },
  };
}

describe("sidebar disclosure persistence", () => {
  it.each(["time", "state", "none", "project"] as const)("keeps Add project visible in %s with scope collapsed", async (groupBy) => {
    seedViewPreferences({ groupBy, scopeCollapsed: true });
    const user = userEvent.setup();
    renderSidebar([]);
    await user.click(screen.getByRole("button", { name: "Add project" }));
    expect(screen.getByRole("dialog", { name: "Add project" })).toBeVisible();
  });

  it("starts a fresh client in Timeline with Add project available", () => {
    localStorage.clear();
    window.dispatchEvent(new StorageEvent("storage", { key: null }));
    renderSidebar([makeThread("recent", "Recent thread")]);
    expect(screen.getByTestId("flat-thread-row")).toBeVisible();
    expect(screen.getByRole("button", { name: "Add project" })).toBeVisible();
    expect(screen.getByTestId("view-quick-toggle")).toHaveAccessibleName("Switch to Projects");
  });

  it("keeps the selected thread's project collapsed across remounts", () => {
    seedViewPreferences({ groupBy: "project" });
    const threads = [makeThread("selected", "Selected thread")];
    const view = renderSidebar(threads, { selectedThreadId: "selected" });
    const project = screen.getByTestId("project-row");
    expect(project).toHaveAttribute("aria-expanded", "true");
    fireEvent.click(project);
    expect(project).toHaveAttribute("aria-expanded", "false");
    view.unmount();
    renderSidebar(threads, { selectedThreadId: "selected" });
    expect(screen.getByTestId("project-row")).toHaveAttribute("aria-expanded", "false");
  });

  it.each(["time", "state", "project"] as const)("restores collapsed %s sections with a project filter", (groupBy) => {
    seedViewPreferences({ groupBy, stackBy: "group", projectFilterName: "Sedes" });
    const threads = [makeThread("active", "Active thread")];
    const view = renderSidebar(threads);
    const section = screen.getAllByTestId("flat-group").find((element) => element.querySelector(".shelf-trigger"))!;
    const key = section.dataset.group;
    fireEvent.click(section.querySelector(".shelf-trigger")!);
    expect(section).toHaveAttribute("data-state", "closed");
    view.unmount();
    renderSidebar(threads);
    expect(screen.getAllByTestId("flat-group").find((element) => element.dataset.group === key)).toHaveAttribute("data-state", "closed");
  });

  it("keeps inventory shelves collapsed across sidebar remounts", () => {
    seedViewPreferences({ groupBy: "project" });
    const threads = [makeThread("active", "Active thread")];
    const view = renderSidebar(threads);
    const shelf = screen.getAllByTestId("inventory-shelf").find((element) => element.dataset.shelf === "automations")!;
    fireEvent.click(within(shelf).getByRole("button", { name: /Automations/ }));
    expect(shelf).toHaveAttribute("data-state", "closed");
    view.unmount();
    renderSidebar(threads);
    expect(screen.getAllByTestId("inventory-shelf").find((element) => element.dataset.shelf === "automations")).toHaveAttribute("data-state", "closed");
  });
});

describe("sidebar footer destinations", () => {
  it("opens the Usage page and closes the drawer without Provider Pulse", async () => {
    window.history.replaceState({}, "", "/");
    const user = userEvent.setup();
    const onNavigate = vi.fn();
    const threads = [makeThread("thread-1", "Thread")];
    const view = renderSidebar(threads);
    view.rerender(
      <InventorySidebar
        state={makeState(threads)}
        store={view.store}
        onNavigate={onNavigate}
        onOpenSettings={() => undefined}
        peekEnabled
      />,
    );

    await user.click(screen.getByRole("button", { name: "More" }));
    expect(screen.queryByRole("menuitem", { name: "Accounts" })).toBeNull();
    await user.click(screen.getByRole("menuitem", { name: "Usage" }));

    expect(window.location.pathname).toBe("/usage");
    expect(onNavigate).toHaveBeenCalledOnce();
  });
});

describe("InventorySidebar view modes", () => {
  const groupId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const group = {
    id: groupId,
    name: "Design review",
    revision: 1,
    memberCount: 2,
    activeMemberCount: 2,
  };

  it("keeps the first organized member as the stack face when another member is selected", async () => {
    const user = userEvent.setup();
    const onSelectThread = vi.fn();
    seedViewPreferences({ groupBy: "time", stackBy: "group" });
    const older = makeThread("thread-older", "Older selected", {
      groupId,
      lastActivityAt: isoAtNoon(-2),
    });
    const newer = makeThread("thread-newer", "Newer member", {
      groupId,
      lastActivityAt: isoAtNoon(0),
    });
    renderSidebar(
      [older, newer],
      {
        groups: [group],
        selectedThreadId: older.id,
      },
      true,
      onSelectThread,
    );

    const stack = screen.getByTestId("thread-group-stack");
    expect(stack).toHaveAttribute("data-group-id", groupId);
    expect(stack).toHaveAttribute("data-representative-thread-id", newer.id);
    expect(stack).toHaveAttribute("data-density", "compact");
    expect(
      within(stack).getByRole("button", {
        name: "Filter threads by group Design review",
      }),
    ).toBeInTheDocument();
    expect(within(stack).queryByText(/2 threads?/i)).toBeNull();
    expect(
      within(stack).getByRole("button", {
        name: "Settle 2 threads in Design review",
      }),
    ).toBeInTheDocument();
    expect(
      within(stack).getByRole("button", {
        name: "Archive 2 threads in Design review",
      }),
    ).toBeInTheDocument();
    expect(
      within(stack).queryByRole("button", { name: `Pin ${newer.title.text}` }),
    ).toBeNull();

    const stackLink = within(stack).getByTestId("thread-row-link");
    expect(stackLink).toHaveAccessibleName(/Newer member$/u);
    expect(stackLink).not.toHaveAttribute("aria-haspopup");
    expect(stackLink).not.toHaveAttribute("aria-controls");
    stackLink.focus();
    expect(screen.queryByTestId("thread-group-roster")).toBeNull();
    await user.keyboard("{Enter}");
    expect(onSelectThread).toHaveBeenCalledWith(newer.id, "split");
    expect(screen.queryByTestId("thread-group-roster")).toBeNull();
    onSelectThread.mockClear();
    fireEvent.click(stackLink, { shiftKey: true });
    expect(onSelectThread).toHaveBeenCalledWith(newer.id, "single");

    fireEvent.pointerEnter(stack, { pointerType: "mouse" });
    const roster = await screen.findByTestId("thread-group-roster");
    const members = within(roster).getAllByTestId("thread-group-member");
    expect(members).toHaveLength(2);
    expect(
      members.find(
        (member) => member.getAttribute("data-thread-id") === newer.id,
      ),
    ).toHaveAttribute("data-representative", "true");
    expect(within(roster).getByText("Newer member")).toBeInTheDocument();

    await user.click(
      within(roster).getByRole("button", {
        name: "Manage group Design review",
      }),
    );
    expect(
      await screen.findByRole("menuitem", { name: "Rename group…" }),
    ).toBeVisible();
    expect(roster).toBeVisible();
    await user.keyboard("{Escape}");
    expect(
      screen.queryByRole("menuitem", { name: "Rename group…" }),
    ).toBeNull();
    expect(roster).toBeVisible();

    const newerMember = members.find(
      (member) => member.getAttribute("data-thread-id") === newer.id,
    )!;
    const newerRow = newerMember.querySelector<HTMLElement>(".flat-list-item")!;
    fireEvent.pointerEnter(newerRow, { pointerType: "mouse" });
    expect(await screen.findByTestId("thread-peek")).toBeVisible();
    await user.click(within(newerMember).getByTestId("thread-row-link"));
    expect(screen.queryByTestId("thread-peek")).toBeNull();
    expect(onSelectThread).toHaveBeenCalledWith(newer.id, "split");
  });

  it("confirms every stack lifecycle action against the exact displayed members", async () => {
    const user = userEvent.setup();
    seedViewPreferences({ groupBy: "none", stackBy: "group" });
    const active = makeThread("thread-active", "Active member", { groupId });
    const settled = makeThread("thread-settled", "Settled member", {
      groupId,
      inventoryState: "settled",
      lastActivityAt: isoAtNoon(-1),
    });
    const { store } = renderSidebar([active, settled], { groups: [group] });
    const stack = screen.getByTestId("thread-group-stack");

    for (const [action, count] of [
      ["settle", 1],
      ["unsettle", 1],
      ["archive", 2],
    ] as const) {
      await user.click(
        within(stack).getByRole("button", {
          name: `${action[0]!.toUpperCase()}${action.slice(1)} ${count} ${count === 1 ? "thread" : "threads"} in Design review`,
        }),
      );
      const dialog = await screen.findByRole("dialog", {
        name: `${action[0]!.toUpperCase()}${action.slice(1)} threads in Design review`,
      });
      expect(store.getBulkInventoryImpact).toHaveBeenLastCalledWith(action, [
        active.id,
        settled.id,
      ]);
      expect(store.mutateBulkInventory).toHaveBeenCalledTimes(
        action === "settle" ? 0 : action === "unsettle" ? 1 : 2,
      );
      await user.click(
        within(dialog).getByRole("button", {
          name: `${action[0]!.toUpperCase()}${action.slice(1)}`,
        }),
      );
      await waitFor(() =>
        expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
      );
    }

    expect(store.mutateBulkInventory).toHaveBeenCalledTimes(3);
  });

  it("uses stack-only actions in the stack face context menu", async () => {
    const user = userEvent.setup();
    seedViewPreferences({ groupBy: "none", stackBy: "group" });
    const active = makeThread("thread-active", "Active member", { groupId });
    const settled = makeThread("thread-settled", "Settled member", {
      groupId,
      inventoryState: "settled",
    });
    const { store } = renderSidebar([active, settled], { groups: [group] });

    fireEvent.contextMenu(
      within(screen.getByTestId("thread-group-stack")).getByTestId(
        "flat-thread-row",
      ),
    );
    const menu = await screen.findByTestId("thread-stack-context-menu");
    expect(within(menu).getByText("Settle stack")).toBeInTheDocument();
    expect(within(menu).getByText("Unsettle stack")).toBeInTheDocument();
    expect(within(menu).getByText("Archive stack")).toBeInTheDocument();
    expect(within(menu).queryByText("Rename")).toBeNull();
    expect(within(menu).queryByText("Snooze…")).toBeNull();

    await user.click(within(menu).getByText("Archive stack"));
    expect(
      await screen.findByRole("dialog", {
        name: "Archive threads in Design review",
      }),
    ).toBeInTheDocument();
    expect(store.getBulkInventoryImpact).toHaveBeenCalledWith("archive", [
      active.id,
      settled.id,
    ]);
  });

  it("opens the combined stack roster and actions sheet on mobile context gestures", async () => {
    seedViewPreferences({ groupBy: "none", stackBy: "group" });
    renderSidebar(
      [
        makeThread("thread-mobile-a", "First mobile member", { groupId }),
        makeThread("thread-mobile-b", "Second mobile member", { groupId }),
      ],
      { groups: [group] },
      false,
    );

    fireEvent.contextMenu(
      within(screen.getByTestId("thread-group-stack")).getByTestId(
        "flat-thread-row",
      ),
    );

    const sheet = await screen.findByTestId("thread-group-sheet");
    expect(
      within(sheet).getByText("Design review", {
        selector: ".thread-group-roster-title",
      }),
    ).toBeVisible();
    expect(within(sheet).getAllByTestId("thread-group-member")).toHaveLength(2);
    expect(
      within(sheet).getByRole("button", {
        name: "Settle 2 threads in Design review",
      }),
    ).toBeInTheDocument();
    expect(
      within(sheet).getByRole("button", {
        name: "Unsettle 0 threads in Design review",
      }),
    ).toBeDisabled();
    expect(
      within(sheet).getByRole("button", {
        name: "Archive 2 threads in Design review",
      }),
    ).toBeInTheDocument();
    expect(screen.queryByTestId("thread-stack-actions-sheet")).toBeNull();
    expect(screen.queryByTestId("thread-stack-context-menu")).toBeNull();
  });

  it("opens the combined stack roster and actions sheet on mobile long-press", async () => {
    vi.useFakeTimers();
    try {
      seedViewPreferences({ groupBy: "none", stackBy: "group" });
      renderSidebar(
        [
          makeThread("thread-mobile-a", "First mobile member", { groupId }),
          makeThread("thread-mobile-b", "Second mobile member", { groupId }),
        ],
        { groups: [group] },
        false,
      );
      const stack = screen.getByTestId("thread-group-stack");
      const trigger = within(stack).getByTestId("thread-row-link");

      fireEvent.pointerDown(trigger, {
        pointerId: 7,
        pointerType: "touch",
        button: 0,
        clientX: 20,
        clientY: 30,
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(575);
      });

      const sheet = screen.getByTestId("thread-group-sheet");
      expect(sheet).toBeVisible();
      expect(within(sheet).getAllByTestId("thread-group-member")).toHaveLength(
        2,
      );
      expect(screen.queryByTestId("thread-stack-actions-sheet")).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("bypasses group stacks while searching or filtering to one group", () => {
    const groupedThreads = [
      makeThread("thread-a", "Alpha match", { groupId }),
      makeThread("thread-b", "Beta member", { groupId }),
    ];
    seedViewPreferences({ groupBy: "time", stackBy: "group" });
    const { unmount } = renderSidebar(groupedThreads, {
      groups: [group],
      search: "Alpha",
    });
    expect(screen.queryByTestId("thread-group-stack")).toBeNull();
    expect(screen.getByText("Alpha match")).toBeInTheDocument();
    expect(screen.queryByText("Beta member")).toBeNull();

    unmount();
    seedViewPreferences({
      groupBy: "time",
      stackBy: "group",
      groupFilterId: groupId,
    });
    renderSidebar(groupedThreads, { groups: [group] });
    expect(screen.queryByTestId("thread-group-stack")).toBeNull();
    expect(screen.getByText("Alpha match")).toBeInTheDocument();
    expect(screen.getByText("Beta member")).toBeInTheDocument();
  });

  it("composes thread-group stacks with Projects organization", () => {
    seedViewPreferences({ groupBy: "project", stackBy: "group" });
    renderSidebar(
      [
        makeThread("thread-project-group-a", "Project group first", {
          groupId,
        }),
        makeThread("thread-project-group-b", "Project group second", {
          groupId,
          lastActivityAt: isoAtNoon(-1),
        }),
      ],
      { groups: [group] },
    );

    expect(screen.getByRole("heading", { name: "Projects" })).toBeVisible();
    const stack = screen.getByTestId("thread-group-stack");
    expect(stack).toHaveAttribute(
      "data-representative-thread-id",
      "thread-project-group-a",
    );
    expect(screen.getByText("Sedes")).toBeVisible();
  });

  it("projects existing workspaces into project stacks without adding group controls", async () => {
    seedViewPreferences({ groupBy: "none", stackBy: "project" });
    const selected = makeThread("thread-project-selected", "Selected work", {
      lastActivityAt: isoAtNoon(-2),
    });
    const recent = makeThread("thread-project-recent", "Recent work");
    const other = makeThread("thread-other-project", "Console work", {
      workspaceId: "workspace-2",
    });
    renderSidebar(
      [selected, recent, other],
      {
        selectedThreadId: selected.id,
        workspaces: [
          {
            id: "workspace-1",
            environmentId: "environment-1",
            label: { text: "Sedes" },
            displayPath: { text: "/workspace/sedes" },
            available: true,
          },
          {
            id: "workspace-2",
            environmentId: "environment-1",
            label: { text: "Console" },
            displayPath: { text: "/workspace/console" },
            available: true,
          },
        ],
      },
      true,
    );

    const stack = screen.getByTestId("project-stack");
    expect(stack).toHaveAttribute("data-workspace-id", "workspace-1");
    expect(stack).toHaveAttribute("data-representative-thread-id", recent.id);
    expect(
      within(stack).getByRole("button", {
        name: "Filter threads by project Sedes",
      }),
    ).toBeInTheDocument();
    expect(screen.getByText("Console work")).toBeInTheDocument();

    fireEvent.pointerEnter(stack, { pointerType: "mouse" });
    const roster = await screen.findByTestId("thread-group-roster");
    expect(within(roster).getByText("Sedes")).toBeInTheDocument();
    expect(within(roster).getAllByTestId("thread-group-member")).toHaveLength(
      2,
    );
    expect(
      within(roster).queryByRole("button", { name: /Manage group/u }),
    ).toBeNull();
  });

  it("opens a stack roster after a task drag hovers over its face", async () => {
    seedViewPreferences({ groupBy: "none", stackBy: "project" });
    renderSidebar(
      [
        makeThread("thread-project-a", "Alpha project member"),
        makeThread("thread-project-b", "Beta project member", {
          lastActivityAt: isoAtNoon(-1),
        }),
      ],
      {},
      true,
      undefined,
      true,
    );
    const stack = screen.getByTestId("project-stack");
    const dataTransfer = {
      types: [TASK_DRAG_MIME],
      getData: vi.fn(() => ""),
    } as unknown as DataTransfer;

    fireEvent.dragEnter(stack, { dataTransfer });

    const roster = await screen.findByTestId(
      "thread-group-roster",
      {},
      { timeout: 1_000 },
    );
    expect(within(roster).getAllByTestId("thread-group-member")).toHaveLength(
      2,
    );
  });

  it("cancels a pending stack roster open when the task drag ends", () => {
    vi.useFakeTimers();
    try {
      seedViewPreferences({ groupBy: "none", stackBy: "project" });
      const task = makeTask("task-drag", { kind: "global" });
      renderSidebar(
        [
          makeThread("thread-project-a", "Alpha project member"),
          makeThread("thread-project-b", "Beta project member", {
            lastActivityAt: isoAtNoon(-1),
          }),
        ],
        { tasks: [task] },
        true,
        undefined,
        true,
      );
      const values = new Map<string, string>();
      const types: string[] = [];
      const dataTransfer = {
        effectAllowed: "none",
        types,
        setData: vi.fn((type: string, value: string) => {
          values.set(type, value);
          if (!types.includes(type)) types.push(type);
        }),
        getData: vi.fn((type: string) => values.get(type) ?? ""),
      } as unknown as DataTransfer;
      const source = screen.getByRole("button", { name: "Task drag source" });

      fireEvent.dragStart(source, { dataTransfer });
      fireEvent.dragEnter(screen.getByTestId("project-stack"), {
        dataTransfer,
      });
      fireEvent.dragEnd(source, { dataTransfer });
      act(() => vi.advanceTimersByTime(200));

      expect(screen.queryByTestId("thread-group-roster")).toBeNull();
    } finally {
      vi.runOnlyPendingTimers();
      vi.useRealTimers();
    }
  });

  it("drops on a collapsed stack's visible representative", async () => {
    seedViewPreferences({ groupBy: "none", stackBy: "project" });
    const task = makeTask("task-drag", { kind: "global" });
    const { store } = renderSidebar(
      [
        makeThread("thread-project-a", "Alpha project member"),
        makeThread("thread-project-b", "Beta project member", {
          lastActivityAt: isoAtNoon(-1),
        }),
      ],
      { tasks: [task] },
      true,
      undefined,
      true,
    );
    const stack = screen.getByTestId("project-stack");
    const representativeId = stack.dataset.representativeThreadId!;
    const values = new Map<string, string>();
    const types: string[] = [];
    const dataTransfer = {
      types,
      effectAllowed: "none",
      dropEffect: "none",
      setData: vi.fn((type: string, value: string) => {
        values.set(type, value);
        if (!types.includes(type)) types.push(type);
      }),
      getData: vi.fn((type: string) => values.get(type) ?? ""),
    } as unknown as DataTransfer;

    fireEvent.dragStart(
      screen.getByRole("button", { name: "Task drag source" }),
      {
        dataTransfer,
      },
    );
    fireEvent.dragOver(stack, { dataTransfer });
    expect(stack).toHaveAttribute("data-task-drop-target", "true");
    fireEvent.drop(stack, { dataTransfer });

    await waitFor(() =>
      expect(store.moveTask).toHaveBeenCalledWith(
        task,
        { kind: "thread", threadId: representativeId },
        expect.any(String),
      ),
    );
  });

  it("retargets a dragged task to a member in the opened stack roster", async () => {
    seedViewPreferences({ groupBy: "none", stackBy: "project" });
    const task = makeTask("task-roster-drag", { kind: "global" });
    const { store } = renderSidebar(
      [
        makeThread("thread-roster-a", "Alpha roster member"),
        makeThread("thread-roster-b", "Beta roster member", {
          lastActivityAt: isoAtNoon(-1),
        }),
      ],
      { tasks: [task] },
      true,
      undefined,
      true,
    );
    const types: string[] = [];
    const values = new Map<string, string>();
    const dataTransfer = {
      types,
      effectAllowed: "none",
      dropEffect: "none",
      setData: vi.fn((type: string, value: string) => {
        values.set(type, value);
        if (!types.includes(type)) types.push(type);
      }),
      getData: vi.fn((type: string) => values.get(type) ?? ""),
    } as unknown as DataTransfer;
    fireEvent.dragStart(
      screen.getByRole("button", { name: "Task drag source" }),
      {
        dataTransfer,
      },
    );
    fireEvent.dragEnter(screen.getByTestId("project-stack"), { dataTransfer });
    const roster = await screen.findByTestId("thread-group-roster");
    const target = within(roster)
      .getAllByTestId("thread-group-member")
      .find((member) => member.dataset.threadId === "thread-roster-b")!;
    // Browsers dispatch dragenter on the roster before dragleave on the stack.
    // A subsequent dragover must cancel the close timer armed by that leave.
    fireEvent.dragEnter(roster, { dataTransfer });
    fireEvent.dragLeave(screen.getByTestId("project-stack"), {
      dataTransfer,
      relatedTarget: target,
    });
    fireEvent.dragOver(target, { dataTransfer });
    await new Promise((resolve) => window.setTimeout(resolve, 180));
    expect(screen.getByTestId("thread-group-roster")).toBeInTheDocument();
    expect(target).toHaveAttribute("data-task-drop-target", "true");
    fireEvent.drop(target, { dataTransfer });

    await waitFor(() =>
      expect(store.moveTask).toHaveBeenCalledWith(
        task,
        { kind: "thread", threadId: "thread-roster-b" },
        expect.any(String),
      ),
    );
  });

  it("bypasses project stacks for search but stacks after project scope filtering", () => {
    const projectThreads = [
      makeThread("thread-project-a", "Alpha project match"),
      makeThread("thread-project-b", "Beta project member"),
    ];
    seedViewPreferences({ groupBy: "none", stackBy: "project" });
    const searched = renderSidebar(projectThreads, { search: "Alpha" });
    expect(screen.queryByTestId("project-stack")).toBeNull();
    expect(screen.getByText("Alpha project match")).toBeInTheDocument();
    expect(screen.queryByText("Beta project member")).toBeNull();

    searched.unmount();
    seedViewPreferences({
      groupBy: "none",
      stackBy: "project",
      projectFilterName: "Sedes",
    });
    renderSidebar(projectThreads);
    expect(screen.getByTestId("project-stack")).toBeInTheDocument();
  });

  it("opens a mobile project representative on tap and the combined sheet on context", async () => {
    seedViewPreferences({ groupBy: "none", stackBy: "project" });
    const onSelectThread = vi.fn();
    renderSidebar(
      [
        makeThread("thread-project-a", "Alpha project member"),
        makeThread("thread-project-b", "Beta project member"),
      ],
      {},
      false,
      onSelectThread,
    );

    const stack = screen.getByTestId("project-stack");
    const representativeId = stack.getAttribute(
      "data-representative-thread-id",
    );
    fireEvent.click(within(stack).getByTestId("thread-row-link"));
    expect(onSelectThread).toHaveBeenCalledWith(representativeId, "split");
    expect(screen.queryByTestId("thread-group-sheet")).toBeNull();

    fireEvent.contextMenu(within(stack).getByTestId("thread-row-link"));
    const sheet = await screen.findByTestId("thread-group-sheet");
    expect(within(sheet).getAllByTestId("thread-group-member")).toHaveLength(2);
    expect(screen.queryByTestId("thread-stack-actions-sheet")).toBeNull();
  });

  it("opens a mobile group representative on tap and the combined sheet on context", async () => {
    seedViewPreferences({ groupBy: "none", stackBy: "group" });
    const onSelectThread = vi.fn();
    renderSidebar(
      [
        makeThread("thread-a", "Alpha member", { groupId }),
        makeThread("thread-b", "Beta member", { groupId }),
      ],
      { groups: [group] },
      false,
      onSelectThread,
    );

    const stack = screen.getByTestId("thread-group-stack");
    const representativeId = stack.getAttribute(
      "data-representative-thread-id",
    );
    fireEvent.click(within(stack).getByTestId("thread-row-link"));
    expect(onSelectThread).toHaveBeenCalledWith(representativeId, "split");
    expect(screen.queryByTestId("thread-group-sheet")).toBeNull();

    fireEvent.contextMenu(within(stack).getByTestId("thread-row-link"));
    const sheet = await screen.findByTestId("thread-group-sheet");
    expect(within(sheet).getAllByTestId("thread-group-member")).toHaveLength(2);
    expect(screen.queryByTestId("thread-stack-actions-sheet")).toBeNull();
  });

  it("moves environment color from rows to the sidebar as scope narrows", () => {
    seedViewPreferences({ groupBy: "none" });
    const environments: NonNullable<StateOptions["environments"]> = [
      {
        id: "environment-local",
        kind: "local" as const,
        label: { text: "Local" },
        available: true,
        directoryBrowsing: "unavailable",
      },
      {
        id: "environment-remote",
        kind: "ssh" as const,
        label: { text: "Remote" },
        available: true,
        directoryBrowsing: "unavailable",
      },
    ];
    const workspaces: NonNullable<StateOptions["workspaces"]> = [
      {
        id: "workspace-1",
        environmentId: "environment-local",
        label: { text: "Sedes" },
        displayPath: { text: "/workspace/sedes" },
        available: true,
      },
      {
        id: "workspace-remote",
        environmentId: "environment-remote",
        label: { text: "Sedes" },
        displayPath: { text: "/workspace/sedes" },
        available: true,
      },
    ];
    const executionTargets: NonNullable<StateOptions["executionTargets"]> = [
      {
        id: "target-1",
        environmentId: "environment-local",
        label: { text: "Pi" },
        backend: { label: { text: "Pi" }, brand: "pi" as const },
        workspaceExecution: { kind: "direct_only" },
        available: true,
      },
      {
        id: "target-remote",
        environmentId: "environment-remote",
        label: { text: "Codex" },
        backend: { label: { text: "Codex" }, brand: "codex" as const },
        workspaceExecution: { kind: "direct_only" },
        available: true,
      },
    ];
    renderSidebar(
      [
        makeThread("thread-local", "Local thread"),
        makeThread("thread-remote", "Remote thread", {
          workspaceId: "workspace-remote",
          targetId: "target-remote",
        }),
      ],
      { environments, workspaces, executionTargets },
    );

    const sidebar = document.querySelector<HTMLElement>(".sidebar-inner")!;
    expect(sidebar).toHaveAttribute("data-environment-tint-mode", "rows");
    expect(sidebar).toHaveAttribute("data-environment-palette", "gem");
    expect(
      document.querySelector('[data-thread-id="thread-local"]'),
    ).toHaveAttribute("data-environment-tint", "true");
    expect(
      document.querySelector('[data-thread-id="thread-remote"]'),
    ).toHaveAttribute("data-environment-tint", "true");

    act(() => {
      seedViewPreferences({
        groupBy: "none",
        environmentFilterId: "environment-remote",
      });
    });

    expect(sidebar).toHaveAttribute("data-environment-tint-mode", "sidebar");
    expect(sidebar.style.getPropertyValue("--environment-hue")).not.toBe("");
    expect(
      document.querySelector('[data-thread-id="thread-remote"]'),
    ).not.toHaveAttribute("data-environment-tint");
    expect(
      document.querySelector('[data-thread-id="thread-local"]'),
    ).toBeNull();

    act(() => setEnvironmentPalette("mineral"));
    expect(sidebar).toHaveAttribute("data-environment-palette", "mineral");
    expect(sidebar.style.getPropertyValue("--environment-chroma")).toBe(
      "0.075",
    );

    act(() => setEnvironmentColorsEnabled(false));
    expect(sidebar).toHaveAttribute("data-environment-tint-mode", "none");
    expect(sidebar.style.getPropertyValue("--environment-hue")).toBe("");
    expect(
      document.querySelector('[data-thread-id="thread-remote"]'),
    ).not.toHaveAttribute("data-environment-tint");
  });

  it("keeps single-environment inventory neutral", () => {
    seedViewPreferences({ groupBy: "none" });
    renderSidebar([makeThread("thread-1", "Thread")]);

    expect(document.querySelector(".sidebar-inner")).toHaveAttribute(
      "data-environment-tint-mode",
      "none",
    );
    expect(
      document.querySelector('[data-thread-id="thread-1"]'),
    ).not.toHaveAttribute("data-environment-tint");
  });

  it.each(["none", "state", "time"] as const)(
    "shows Local and remote environment labels but omits target names in %s rows",
    (groupBy) => {
      seedViewPreferences({
        groupBy,
        modes:
          groupBy === "none"
            ? { none: { density: "card" } }
            : groupBy === "state"
              ? { state: { density: "card" } }
              : { time: { density: "card" } },
      });
      const environments: NonNullable<StateOptions["environments"]> = [
        {
          id: "environment-local",
          kind: "local" as const,
          label: { text: "Local" },
          available: true,
          directoryBrowsing: "unavailable",
        },
        {
          id: "environment-remote",
          kind: "ssh" as const,
          label: { text: "Remote host" },
          available: true,
          directoryBrowsing: "unavailable",
        },
      ];
      const workspaces: NonNullable<StateOptions["workspaces"]> = [
        {
          id: "workspace-1",
          environmentId: "environment-local",
          label: { text: "Sedes" },
          displayPath: { text: "/workspace/sedes" },
          available: true,
        },
        {
          id: "workspace-remote",
          environmentId: "environment-remote",
          label: { text: "Sedes" },
          displayPath: { text: "/workspace/sedes" },
          available: true,
        },
      ];
      const executionTargets: NonNullable<StateOptions["executionTargets"]> = [
        {
          id: "target-1",
          environmentId: "environment-local",
          label: { text: "Pi" },
          backend: { label: { text: "Pi" }, brand: "pi" as const },
          workspaceExecution: { kind: "direct_only" },
          available: true,
        },
        {
          id: "target-remote",
          environmentId: "environment-remote",
          label: { text: "Codex" },
          backend: { label: { text: "Codex" }, brand: "codex" as const },
          workspaceExecution: { kind: "direct_only" },
          available: true,
        },
      ];

      renderSidebar(
        [
          makeThread("thread-local", "Local thread"),
          makeThread("thread-remote", "Remote thread", {
            workspaceId: "workspace-remote",
            targetId: "target-remote",
          }),
        ],
        { environments, workspaces, executionTargets },
      );

      const localRow = document.querySelector<HTMLElement>(
        '[data-thread-id="thread-local"]',
      )!;
      const remoteRow = document.querySelector<HTMLElement>(
        '[data-thread-id="thread-remote"]',
      )!;
      expect(within(localRow).getByText("Local")).toBeVisible();
      expect(within(localRow).queryByText("Pi")).toBeNull();
      expect(within(remoteRow).getByText("Remote host")).toBeVisible();
      expect(within(remoteRow).queryByText("Codex")).toBeNull();
    },
  );

  it("omits Local from project folder labels while retaining remote environments", () => {
    const environments: NonNullable<StateOptions["environments"]> = [
      {
        id: "environment-local",
        kind: "local" as const,
        label: { text: "Local" },
        available: true,
        directoryBrowsing: "unavailable",
      },
      {
        id: "environment-remote",
        kind: "ssh" as const,
        label: { text: "Remote host" },
        available: true,
        directoryBrowsing: "unavailable",
      },
    ];
    const workspaces: NonNullable<StateOptions["workspaces"]> = [
      {
        id: "workspace-1",
        environmentId: "environment-local",
        label: { text: "Sedes" },
        displayPath: { text: "/workspace/sedes" },
        available: true,
      },
      {
        id: "workspace-remote",
        environmentId: "environment-remote",
        label: { text: "Sedes" },
        displayPath: { text: "/workspace/sedes" },
        available: true,
      },
    ];
    const executionTargets: NonNullable<StateOptions["executionTargets"]> = [
      {
        id: "target-1",
        environmentId: "environment-local",
        label: { text: "Pi" },
        backend: { label: { text: "Pi" }, brand: "pi" as const },
        workspaceExecution: { kind: "direct_only" },
        available: true,
      },
      {
        id: "target-remote",
        environmentId: "environment-remote",
        label: { text: "Codex" },
        backend: { label: { text: "Codex" }, brand: "codex" as const },
        workspaceExecution: { kind: "direct_only" },
        available: true,
      },
    ];

    renderSidebar(
      [
        makeThread("thread-local", "Local thread"),
        makeThread("thread-remote", "Remote thread", {
          workspaceId: "workspace-remote",
          targetId: "target-remote",
        }),
      ],
      { environments, workspaces, executionTargets },
    );

    const projectRows = screen.getAllByTestId("project-row");
    expect(projectRows).toHaveLength(2);
    expect(projectRows[0]).toHaveTextContent("Sedes");
    expect(projectRows[0]).not.toHaveTextContent("Local");
    expect(projectRows[1]).toHaveTextContent("Sedes · Remote host");
  });

  it.each(["project", "none"] as const)(
    "resolves normal and Shift-click presentation before selecting threads in %s view",
    async (groupBy) => {
      seedViewPreferences({ groupBy });
      const user = userEvent.setup();
      const selections: {
        threadId: string;
        presentation: string;
        path: string;
      }[] = [];
      window.history.replaceState({}, "", "/threads/thread-current");
      renderSidebar(
        [
          makeThread("thread-current", "Current thread"),
          makeThread("thread-other", "Other thread"),
        ],
        { selectedThreadId: "thread-current" },
        true,
        (threadId, presentation) =>
          selections.push({
            threadId,
            presentation,
            path: window.location.pathname,
          }),
      );
      const rowLinkClass =
        groupBy === "project" ? "thread-row-link" : "flat-row-link";

      await user.click(
        document.querySelector<HTMLElement>(
          `[data-thread-id="thread-current"] .${rowLinkClass}`,
        )!,
      );
      await user.keyboard("{Shift>}");
      await user.click(
        document.querySelector<HTMLElement>(
          `[data-thread-id="thread-other"] .${rowLinkClass}`,
        )!,
      );
      await user.keyboard("{/Shift}");

      expect(selections).toEqual([
        {
          threadId: "thread-current",
          presentation: "split",
          path: "/threads/thread-current",
        },
        {
          threadId: "thread-other",
          presentation: "single",
          path: "/threads/thread-current",
        },
      ]);
      expect(window.location.pathname).toBe("/threads/thread-other");
    },
  );

  it.each(["project", "none"] as const)(
    "navigates adjacent rendered %s rows with Command or Control-Shift arrows",
    (groupBy) => {
      seedViewPreferences({ groupBy });
      const onSelectThread = vi.fn();
      const threads = Array.from({ length: 3 }, (_, index) =>
        makeThread(`thread-${index + 1}`, `Thread ${index + 1}`, {
          lastActivityAt: new Date(Date.now() - index * 60_000).toISOString(),
        }),
      );
      window.history.replaceState({}, "", "/threads/thread-2");
      renderSidebar(
        threads,
        { selectedThreadId: "thread-2" },
        true,
        onSelectThread,
      );
      const rows = [
        ...document.querySelectorAll<HTMLElement>("[data-thread-id]"),
      ];
      expect(rows.map((row) => row.dataset.threadId)).toEqual([
        "thread-1",
        "thread-2",
        "thread-3",
      ]);

      expect(
        fireEvent.keyDown(window, {
          key: "ArrowDown",
          metaKey: true,
          shiftKey: true,
        }),
      ).toBe(false);
      expect(onSelectThread).toHaveBeenLastCalledWith("thread-3", "split");
      expect(window.location.pathname).toBe("/threads/thread-3");

      expect(
        fireEvent.keyDown(window, {
          key: "ArrowUp",
          ctrlKey: true,
          shiftKey: true,
        }),
      ).toBe(false);
      expect(onSelectThread).toHaveBeenLastCalledWith("thread-2", "split");
      expect(window.location.pathname).toBe("/threads/thread-2");
      expect(onSelectThread).toHaveBeenCalledTimes(2);
    },
  );

  it("does not wrap sidebar arrow navigation or consume native editing chords", () => {
    seedViewPreferences({ groupBy: "none" });
    const onSelectThread = vi.fn();
    window.history.replaceState({}, "", "/threads/thread-1");
    renderSidebar(
      [
        makeThread("thread-1", "First thread", {
          lastActivityAt: isoAtNoon(0),
        }),
        makeThread("thread-2", "Second thread", {
          lastActivityAt: isoAtNoon(-1),
        }),
      ],
      { selectedThreadId: "thread-1" },
      true,
      onSelectThread,
    );

    expect(
      fireEvent.keyDown(window, {
        key: "ArrowUp",
        metaKey: true,
        shiftKey: true,
      }),
    ).toBe(true);
    expect(onSelectThread).not.toHaveBeenCalled();

    const search = screen.getByPlaceholderText("Search threads");
    expect(
      fireEvent.keyDown(search, {
        key: "ArrowDown",
        metaKey: true,
        shiftKey: true,
      }),
    ).toBe(true);
    expect(onSelectThread).not.toHaveBeenCalled();
    expect(window.location.pathname).toBe("/threads/thread-1");
  });

  it("navigates from an empty composer while preserving a nonempty draft", () => {
    seedViewPreferences({ groupBy: "none" });
    const onSelectThread = vi.fn();
    window.history.replaceState({}, "", "/threads/thread-1");
    renderSidebar(
      [
        makeThread("thread-1", "First thread", {
          lastActivityAt: isoAtNoon(0),
        }),
        makeThread("thread-2", "Second thread", {
          lastActivityAt: isoAtNoon(-1),
        }),
      ],
      { selectedThreadId: "thread-1" },
      true,
      onSelectThread,
    );
    const composer = document.createElement("textarea");
    composer.dataset.sidebarNavigationWhenEmpty = "true";
    document.body.append(composer);
    composer.focus();

    expect(
      fireEvent.keyDown(composer, {
        key: "ArrowDown",
        metaKey: true,
        shiftKey: true,
      }),
    ).toBe(false);
    expect(onSelectThread).toHaveBeenLastCalledWith("thread-2", "split");
    expect(window.location.pathname).toBe("/threads/thread-2");

    composer.value = "preserve this draft";
    delete composer.dataset.sidebarNavigationWhenEmpty;
    expect(
      fireEvent.keyDown(composer, {
        key: "ArrowUp",
        ctrlKey: true,
        shiftKey: true,
      }),
    ).toBe(true);
    expect(onSelectThread).toHaveBeenCalledTimes(1);
    expect(window.location.pathname).toBe("/threads/thread-2");
  });

  it("preserves an existing focused-surface shortcut that prevents default", () => {
    seedViewPreferences({ groupBy: "none" });
    const onSelectThread = vi.fn();
    renderSidebar(
      [
        makeThread("thread-1", "First thread", {
          lastActivityAt: isoAtNoon(0),
        }),
        makeThread("thread-2", "Second thread", {
          lastActivityAt: isoAtNoon(-1),
        }),
      ],
      { selectedThreadId: "thread-1" },
      true,
      onSelectThread,
    );
    const focusedSurface = document.createElement("div");
    focusedSurface.addEventListener("keydown", (event) =>
      event.preventDefault(),
    );
    document.body.append(focusedSurface);

    expect(
      fireEvent.keyDown(focusedSurface, {
        key: "ArrowDown",
        ctrlKey: true,
        shiftKey: true,
      }),
    ).toBe(false);
    expect(onSelectThread).not.toHaveBeenCalled();
  });

  it.each(["project", "none"] as const)(
    "reveals delayed Command-number hints and quick-switches in rendered %s row order",
    (groupBy) => {
      vi.useFakeTimers();
      try {
        seedViewPreferences({ groupBy });
        const onSelectThread = vi.fn();
        const threads = Array.from({ length: 10 }, (_, index) =>
          makeThread(`thread-${index + 1}`, `Thread ${index + 1}`, {
            lastActivityAt: new Date(Date.now() - index * 60_000).toISOString(),
          }),
        );
        window.history.replaceState({}, "", "/");
        renderSidebar(threads, {}, true, onSelectThread);
        const rows = [
          ...document.querySelectorAll<HTMLElement>("[data-thread-id]"),
        ];

        fireEvent.keyDown(window, { key: "Meta", metaKey: true });
        expect(rows[0]!.querySelector("[data-shortcut]")).toBeNull();
        act(() => {
          vi.advanceTimersByTime(SIDEBAR_QUICK_SWITCH_HOLD_DELAY_MS - 1);
        });
        expect(rows[0]!.querySelector("[data-shortcut]")).toBeNull();
        act(() => {
          vi.advanceTimersByTime(1);
        });

        expect(rows).toHaveLength(10);
        for (const [index, row] of rows.entries()) {
          const expectedHint = index < 9 ? `⌘${index + 1}` : undefined;
          const meta = row.querySelector<HTMLElement>(
            groupBy === "project" ? ".thread-meta" : ".flat-row-time",
          )!;
          const link = row.querySelector<HTMLElement>(
            groupBy === "project" ? ".thread-row-link" : ".flat-row-link",
          )!;
          if (expectedHint === undefined) {
            expect(meta).not.toHaveAttribute("data-shortcut");
            expect(link).not.toHaveAttribute("aria-keyshortcuts");
          } else {
            expect(meta).toHaveTextContent(expectedHint);
            expect(meta).toHaveAttribute("data-shortcut", "true");
            expect(link).toHaveAttribute(
              "aria-keyshortcuts",
              `Meta+${index + 1}`,
            );
          }
        }

        fireEvent.keyDown(window, { key: "3", metaKey: true });

        expect(onSelectThread).toHaveBeenCalledWith(
          rows[2]!.dataset.threadId,
          "split",
        );
        expect(window.location.pathname).toBe(
          `/threads/${rows[2]!.dataset.threadId}`,
        );

        for (const [index, row] of rows.entries()) {
          const shortcut = row.querySelector<HTMLElement>("[data-shortcut]");
          if (index === 2) {
            expect(shortcut).toHaveTextContent("⌘3");
            expect(shortcut).toHaveAttribute("data-shortcut", "confirmation");
          } else {
            expect(shortcut).toBeNull();
          }
        }

        fireEvent.keyUp(window, { key: "Meta" });
        expect(rows[2]!.querySelector("[data-shortcut]")).not.toBeNull();
        act(() => {
          vi.advanceTimersByTime(SIDEBAR_QUICK_SWITCH_CONFIRMATION_MS - 1);
        });
        expect(rows[2]!.querySelector("[data-shortcut]")).not.toBeNull();
        act(() => {
          vi.advanceTimersByTime(1);
        });
        expect(rows[2]!.querySelector("[data-shortcut]")).toBeNull();
      } finally {
        vi.useRealTimers();
      }
    },
  );

  it("cancels chord-triggered hints and recovers when a modifier key-up is missed", () => {
    vi.useFakeTimers();
    try {
      seedViewPreferences({ groupBy: "none" });
      const onSelectThread = vi.fn();
      renderSidebar(
        [makeThread("thread-1", "Thread 1")],
        {},
        true,
        onSelectThread,
      );
      const row = document.querySelector<HTMLElement>("[data-thread-id]")!;

      fireEvent.keyDown(window, { key: "Meta", metaKey: true });
      fireEvent.keyUp(window, { key: "Meta" });
      act(() => {
        vi.advanceTimersByTime(SIDEBAR_QUICK_SWITCH_HOLD_DELAY_MS);
      });
      expect(row.querySelector("[data-shortcut]")).toBeNull();

      // Quick-switching does not have to wait for the visual hint delay.
      fireEvent.keyDown(window, { key: "Meta", metaKey: true });
      fireEvent.keyDown(window, { key: "1", metaKey: true });
      expect(onSelectThread).toHaveBeenCalledWith("thread-1", "split");
      expect(row.querySelector("[data-shortcut]")).toHaveTextContent("⌘1");
      expect(row.querySelector("[data-shortcut]")).toHaveAttribute(
        "data-shortcut",
        "confirmation",
      );
      act(() => {
        vi.advanceTimersByTime(SIDEBAR_QUICK_SWITCH_CONFIRMATION_MS);
      });
      expect(row.querySelector("[data-shortcut]")).toBeNull();

      fireEvent.keyDown(window, { key: "Meta", metaKey: true });
      fireEvent.keyDown(window, { key: "k", metaKey: true });
      act(() => {
        vi.advanceTimersByTime(SIDEBAR_QUICK_SWITCH_HOLD_DELAY_MS);
      });
      expect(row.querySelector("[data-shortcut]")).toBeNull();

      fireEvent.keyDown(window, { key: "Meta", metaKey: true });
      act(() => {
        vi.advanceTimersByTime(SIDEBAR_QUICK_SWITCH_HOLD_DELAY_MS);
      });
      expect(row.querySelector("[data-shortcut]")).not.toBeNull();

      fireEvent.keyDown(window, { key: "k", metaKey: true });
      expect(row.querySelector("[data-shortcut]")).toBeNull();

      // No Meta key-up arrives; the next trustworthy input repairs the state.
      fireEvent.keyDown(window, { key: "Meta", metaKey: true });
      act(() => {
        vi.advanceTimersByTime(SIDEBAR_QUICK_SWITCH_HOLD_DELAY_MS);
      });
      expect(row.querySelector("[data-shortcut]")).not.toBeNull();
      fireEvent.keyDown(window, { key: "a", metaKey: false });
      expect(row.querySelector("[data-shortcut]")).toBeNull();

      fireEvent.keyDown(window, { key: "Meta", metaKey: true });
      act(() => {
        vi.advanceTimersByTime(SIDEBAR_QUICK_SWITCH_HOLD_DELAY_MS);
      });
      expect(row.querySelector("[data-shortcut]")).not.toBeNull();
      fireEvent.focus(window);
      expect(row.querySelector("[data-shortcut]")).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("cancels hints when a second modifier starts an OS-owned chord", () => {
    vi.useFakeTimers();
    try {
      seedViewPreferences({ groupBy: "none" });
      renderSidebar([makeThread("thread-1", "Thread 1")], {}, true);
      const row = document.querySelector<HTMLElement>("[data-thread-id]")!;

      fireEvent.keyDown(window, { key: "Meta", metaKey: true });
      act(() => {
        vi.advanceTimersByTime(SIDEBAR_QUICK_SWITCH_HOLD_DELAY_MS);
      });
      expect(row.querySelector("[data-shortcut]")).toHaveTextContent("⌘1");

      // macOS can consume the rest of a screenshot chord, including all
      // key-up events, after the browser observes Command+Control.
      fireEvent.keyDown(window, {
        key: "Control",
        metaKey: true,
        ctrlKey: true,
      });
      expect(row.querySelector("[data-shortcut]")).toBeNull();
      act(() => {
        vi.advanceTimersByTime(SIDEBAR_QUICK_SWITCH_HOLD_DELAY_MS);
      });
      expect(row.querySelector("[data-shortcut]")).toBeNull();

      // The same cancellation applies before the initial delay elapses and
      // must not replace Command hints with Control hints.
      fireEvent.keyDown(window, { key: "Meta", metaKey: true });
      fireEvent.keyDown(window, {
        key: "Control",
        metaKey: true,
        ctrlKey: true,
      });
      act(() => {
        vi.advanceTimersByTime(SIDEBAR_QUICK_SWITCH_HOLD_DELAY_MS);
      });
      expect(row.querySelector("[data-shortcut]")).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("preserves a pending hold across callback re-renders and uses the latest callbacks", () => {
    vi.useFakeTimers();
    try {
      seedViewPreferences({ groupBy: "none" });
      const initialSelectThread = vi.fn();
      const latestSelectThread = vi.fn();
      const latestNavigate = vi.fn();
      const { rerender, store } = renderSidebar(
        [makeThread("thread-1", "Thread 1")],
        {},
        true,
        initialSelectThread,
      );
      const row = document.querySelector<HTMLElement>("[data-thread-id]")!;

      fireEvent.keyDown(window, { key: "Meta", metaKey: true });
      act(() => {
        vi.advanceTimersByTime(SIDEBAR_QUICK_SWITCH_HOLD_DELAY_MS / 2);
      });
      rerender(
        <InventorySidebar
          state={makeState([makeThread("thread-1", "Thread 1")])}
          store={store}
          onSelectThread={latestSelectThread}
          onNavigate={latestNavigate}
          onOpenSettings={() => undefined}
          peekEnabled
        />,
      );
      act(() => {
        vi.advanceTimersByTime(SIDEBAR_QUICK_SWITCH_HOLD_DELAY_MS / 2);
      });

      expect(row.querySelector("[data-shortcut]")).not.toBeNull();
      fireEvent.keyDown(window, { key: "1", metaKey: true });
      expect(initialSelectThread).not.toHaveBeenCalled();
      expect(latestSelectThread).toHaveBeenCalledWith("thread-1", "split");
      expect(latestNavigate).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps the collapsed all-scope trigger to one quiet line", () => {
    seedViewPreferences({ scopeCollapsed: true });
    renderSidebar([makeThread("thread-1", "Thread")]);
    const trigger = screen.getByRole("button", { name: "Expand thread scope" });
    expect(trigger).toHaveTextContent("Scope");
    expect(trigger).not.toHaveTextContent("All threads");
    expect(trigger).not.toHaveAttribute("title");
  });

  it("collapses the scope stack while preserving an accessible active summary", async () => {
    seedViewPreferences({
      environmentFilterId: "environment-ssh",
      targetFilterId: "target-ssh",
      projectFilterName: "Sedes",
      scopeCollapsed: true,
    });
    const user = userEvent.setup();
    renderSidebar(
      [
        makeThread("thread-remote", "Remote work", {
          workspaceId: "workspace-remote",
          targetId: "target-ssh",
        }),
      ],
      {
        environments: [
          {
            id: "environment-local",
            kind: "local" as const,
            label: { text: "Local" },
            available: true,
            directoryBrowsing: "unavailable" as const,
          },
          {
            id: "environment-ssh",
            kind: "ssh" as const,
            label: { text: "Build host" },
            available: true,
            directoryBrowsing: "unavailable" as const,
          },
        ],
        workspaces: [
          {
            id: "workspace-remote",
            environmentId: "environment-ssh",
            label: { text: "Sedes" },
            displayPath: { text: "/srv/sedes" },
            available: true,
          },
        ],
        executionTargets: [
          {
            id: "target-ssh",
            environmentId: "environment-ssh",
            label: { text: "Codex SSH" },
            backend: { label: { text: "Codex" }, brand: "codex" },
            workspaceExecution: { kind: "direct_only" },
            available: false,
            unavailableReason: { text: "Host offline" },
          },
        ],
      },
    );

    const trigger = screen.getByRole("button", {
      name: /Expand thread scope, 3 active: Build host · Codex SSH · Codex — Unavailable · Sedes/,
    });
    expect(trigger).toHaveAttribute("aria-expanded", "false");
    expect(trigger).toHaveAttribute(
      "title",
      "Build host · Codex SSH · Codex — Unavailable · Sedes",
    );
    expect(trigger).toHaveTextContent(
      "Build host · Codex SSH · Codex — Unavailable +1",
    );
    expect(
      screen.queryByRole("combobox", { name: "Project filter" }),
    ).toBeNull();

    await user.click(trigger);
    expect(
      screen.getByRole("combobox", { name: "Project filter" }),
    ).toBeVisible();
    expect(trigger).toHaveAttribute("aria-expanded", "true");
  });

  it("cascades Environment and Target while deduplicating Project names", async () => {
    const user = userEvent.setup();
    renderSidebar(
      [
        makeThread("thread-local", "Local work"),
        makeThread("thread-remote", "Remote work", {
          workspaceId: "workspace-remote",
          targetId: "target-ssh",
        }),
        makeThread("thread-remote-pi", "Remote Pi work", {
          workspaceId: "workspace-remote",
          targetId: "target-remote-pi",
        }),
      ],
      {
        environments: [
          {
            id: "environment-local",
            kind: "local" as const,
            label: { text: "Local" },
            available: true,
            directoryBrowsing: "unavailable" as const,
          },
          {
            id: "environment-ssh",
            kind: "ssh" as const,
            label: { text: "Build host" },
            available: true,
            directoryBrowsing: "unavailable" as const,
          },
        ],
        workspaces: [
          {
            id: "workspace-1",
            environmentId: "environment-local",
            label: { text: "agent-workspaces" },
            displayPath: { text: "/home/me/agent-workspaces" },
            available: true,
          },
          {
            id: "workspace-remote",
            environmentId: "environment-ssh",
            label: { text: "agent-workspaces" },
            displayPath: { text: "/srv/agent-workspaces" },
            available: true,
          },
        ],
        executionTargets: [
          {
            id: "target-1",
            environmentId: "environment-local",
            label: { text: "Pi" },
            backend: { label: { text: "Pi" }, brand: "pi" },
            workspaceExecution: { kind: "direct_only" },
            available: true,
          },
          {
            id: "target-ssh",
            environmentId: "environment-ssh",
            label: { text: "Codex SSH" },
            backend: { label: { text: "Codex" }, brand: "codex" },
            workspaceExecution: { kind: "direct_only" },
            available: true,
          },
          {
            id: "target-remote-pi",
            environmentId: "environment-ssh",
            label: { text: "Pi" },
            backend: { label: { text: "Pi" }, brand: "pi" },
            workspaceExecution: { kind: "direct_only" },
            available: true,
          },
        ],
      },
    );

    await user.click(screen.getByRole("combobox", { name: "Project filter" }));
    expect(
      screen.getByRole("option", { name: "agent-workspaces" }),
    ).toBeVisible();
    expect(
      screen.queryByRole("option", { name: "agent-workspaces · Build host" }),
    ).toBeNull();
    await user.click(screen.getByRole("option", { name: "agent-workspaces" }));
    expect(screen.getAllByTestId("project-row")).toHaveLength(2);
    expect(screen.getByText("Local work")).toBeVisible();
    expect(screen.getByText("Remote work")).toBeVisible();
    expect(screen.getByText("Remote Pi work")).toBeVisible();
    expect(document.querySelector(".sidebar-inner")).toHaveAttribute("data-environment-tint-mode", "rows");
    expect(JSON.parse(localStorage.getItem(SIDEBAR_VIEW_STORAGE_KEY)!)).toMatchObject({
      projectFilterName: "agent-workspaces", environmentFilterId: null, targetFilterId: null,
    });

    await user.click(screen.getByRole("combobox", { name: "Target filter" }));
    expect(screen.getByRole("option", { name: "Pi" })).toBeVisible();
    expect(
      screen.getByRole("option", {
        name: "Codex SSH · Codex · Build host",
      }),
    ).toBeVisible();
    expect(
      screen.getByRole("option", { name: "Pi · Build host" }),
    ).toBeVisible();
    await user.keyboard("{Escape}");

    await user.click(
      screen.getByRole("combobox", { name: "Environment filter" }),
    );
    const remoteEnvironment = screen.getByRole("option", {
      name: "Build host",
    });
    expect(
      remoteEnvironment.querySelector('[data-environment-kind="ssh"]'),
    ).not.toBeNull();
    await user.click(remoteEnvironment);
    expect(
      screen
        .getByRole("combobox", { name: "Environment filter" })
        .querySelector('[data-environment-kind="ssh"]'),
    ).not.toBeNull();
    expect(
      screen
        .getByRole("combobox", { name: "Environment filter" })
        .querySelector(
          '.searchable-select-value [data-environment-kind="ssh"]',
        ),
    ).not.toBeNull();
    expect(screen.queryByText("Local work")).toBeNull();
    expect(screen.getByText("Remote work")).toBeVisible();
    expect(screen.getByText("Remote Pi work")).toBeVisible();

    await user.click(screen.getByRole("combobox", { name: "Target filter" }));
    const codexTarget = screen.getByRole("option", {
      name: "Codex SSH · Codex",
    });
    expect(
      codexTarget.querySelector('[data-backend-brand="codex"]'),
    ).not.toBeNull();
    await user.click(codexTarget);
    expect(
      screen
        .getByRole("combobox", { name: "Target filter" })
        .querySelector('[data-backend-brand="codex"]'),
    ).not.toBeNull();
    expect(
      screen
        .getByRole("combobox", { name: "Target filter" })
        .querySelector(
          '.searchable-select-value [data-backend-brand="codex"]',
        ),
    ).not.toBeNull();
    expect(screen.getByText("Remote work")).toBeVisible();
    expect(screen.queryByText("Remote Pi work")).toBeNull();

    await user.click(screen.getByRole("combobox", { name: "Project filter" }));
    expect(
      screen.getByRole("option", { name: "agent-workspaces" }),
    ).toBeVisible();
  });

  it("filters project stack label taps by name while keeping workspace stacks separate", async () => {
    seedViewPreferences({ groupBy: "none", stackBy: "project" });
    setClickNamesToFilter(true);
    const user = userEvent.setup();
    renderSidebar([
      makeThread("local-1", "Local one"), makeThread("local-2", "Local two"),
      makeThread("remote-1", "Remote one", { workspaceId: "remote", targetId: "remote-target" }),
      makeThread("remote-2", "Remote two", { workspaceId: "remote", targetId: "remote-target" }),
      makeThread("other", "Unrelated project", { workspaceId: "other" }),
    ], {
      environments: [
        { id: "environment-1", kind: "local", label: { text: "Local" }, available: true, directoryBrowsing: "unavailable" },
        { id: "remote-env", kind: "ssh", label: { text: "Remote host" }, available: false, directoryBrowsing: "unavailable" },
      ],
      workspaces: [
        { id: "workspace-1", environmentId: "environment-1", label: { text: "Sedes" }, displayPath: { text: "/code/sedes" }, available: true },
        { id: "remote", environmentId: "remote-env", label: { text: "Sedes" }, displayPath: { text: "/srv/sedes" }, available: false },
        { id: "other", environmentId: "environment-1", label: { text: "Other" }, displayPath: { text: "/code/other" }, available: true },
      ],
    });
    expect(screen.getAllByTestId("project-stack")).toHaveLength(2);
    const remoteStack = screen.getAllByTestId("project-stack").find((stack) => stack.dataset.workspaceId === "remote")!;
    await user.click(within(remoteStack).getByRole("button", { name: "Filter threads by project Sedes" }));
    expect(screen.queryByText("Unrelated project")).toBeNull();
    expect(screen.getAllByTestId("project-stack").map((stack) => stack.dataset.workspaceId).sort())
      .toEqual(["remote", "workspace-1"]);
    expect(screen.getByRole("combobox", { name: "Environment filter" })).toHaveTextContent("All environments");
    expect(JSON.parse(localStorage.getItem(SIDEBAR_VIEW_STORAGE_KEY)!)).toMatchObject({ projectFilterName: "Sedes" });
    await user.click(screen.getByRole("combobox", { name: "Environment filter" }));
    await user.click(screen.getByRole("option", { name: "Remote host — Unavailable" }));
    expect(screen.getAllByTestId("project-stack")).toHaveLength(1);
    expect(screen.getByTestId("project-stack")).toHaveAttribute("data-workspace-id", "remote");
    expect(JSON.parse(localStorage.getItem(SIDEBAR_VIEW_STORAGE_KEY)!)).toMatchObject({ projectFilterName: "Sedes", environmentFilterId: "remote-env" });
  });

  it("retains an unmatched selected name when the environment changes", async () => {
    seedViewPreferences({ groupBy: "none", projectFilterName: "Remote only" });
    const user = userEvent.setup();
    renderSidebar([
      makeThread("local", "Local work"),
      makeThread("remote", "Remote work", { workspaceId: "remote" }),
    ], {
      environments: [
        { id: "environment-1", kind: "local", label: { text: "Local" }, available: true, directoryBrowsing: "unavailable" },
        { id: "remote-env", kind: "ssh", label: { text: "Remote" }, available: true, directoryBrowsing: "unavailable" },
      ],
      workspaces: [
        { id: "workspace-1", environmentId: "environment-1", label: { text: "Local only" }, displayPath: { text: "/code/local" }, available: true },
        { id: "remote", environmentId: "remote-env", label: { text: "Remote only" }, displayPath: { text: "/srv/remote" }, available: true },
      ],
    });
    expect(screen.getByText("Remote work")).toBeVisible();
    await user.click(screen.getByRole("combobox", { name: "Environment filter" }));
    await user.click(screen.getByRole("option", { name: "Local" }));
    expect(screen.getByRole("combobox", { name: "Project filter" })).toHaveTextContent("Remote only");
    expect(screen.queryByText("Local work")).toBeNull();
    expect(screen.queryByText("Remote work")).toBeNull();
    expect(JSON.parse(localStorage.getItem(SIDEBAR_VIEW_STORAGE_KEY)!)).toMatchObject({ projectFilterName: "Remote only" });
  });

  it("keeps project names distinct from the All projects control value", async () => {
    seedViewPreferences({ groupBy: "none" });
    const user = userEvent.setup();
    renderSidebar([
      makeThread("named", "Sentinel-named work"),
      makeThread("other", "Other work", { workspaceId: "other" }),
    ], { workspaces: [
      { id: "workspace-1", environmentId: "environment-1", label: { text: "__all_projects__" }, displayPath: { text: "/repo/__all_projects__" }, available: true },
      { id: "other", environmentId: "environment-1", label: { text: "Other" }, displayPath: { text: "/repo/other" }, available: true },
    ] });
    const picker = screen.getByRole("combobox", { name: "Project filter" });
    await user.click(picker);
    await user.click(screen.getByRole("option", { name: "__all_projects__" }));
    expect(picker).toHaveTextContent("__all_projects__");
    expect(screen.getByText("Sentinel-named work")).toBeVisible();
    expect(screen.queryByText("Other work")).toBeNull();
    expect(JSON.parse(localStorage.getItem(SIDEBAR_VIEW_STORAGE_KEY)!)).toMatchObject({ projectFilterName: "__all_projects__" });
    await user.click(picker);
    await user.click(screen.getByRole("option", { name: "All projects" }));
    expect(screen.getByText("Other work")).toBeVisible();
  });

  it("searches scope context locally and permits selecting unavailable inventory", async () => {
    const user = userEvent.setup();
    renderSidebar([makeThread("thread-1", "Existing work")], {
      workspaces: [
        { id: "workspace-1", environmentId: "environment-1", label: { text: "Sedes" }, displayPath: { text: "/srv/code/sedes" }, available: false },
        { id: "workspace-other", environmentId: "environment-1", label: { text: "Other" }, displayPath: { text: "/srv/other" }, available: true },
      ],
    });
    const project = screen.getByRole("combobox", { name: "Project filter" });
    await user.click(project);
    await user.type(screen.getByRole("combobox", { name: "Search projects" }), "MACHINE /CODE/SEDES");
    expect(screen.queryByRole("option", { name: "Other" })).toBeNull();
    expect(project).toHaveTextContent("All projects");
    expect(screen.getByText("Existing work")).toBeVisible();
    const unavailable = screen.getByRole("option", { name: "Sedes — Unavailable" });
    expect(unavailable).not.toHaveAttribute("aria-disabled", "true");
    await user.click(unavailable);
    expect(project).toHaveAttribute("data-scope-value", "project-name:Sedes");
    await user.click(project);
    expect(screen.getByRole("combobox", { name: "Search projects" })).toHaveValue("");
    await user.click(screen.getByRole("option", { name: "All projects" }));
    expect(project).toHaveTextContent("All projects");
  });

  it("keeps a selected singleton Environment visible so it can be cleared", () => {
    seedViewPreferences({ environmentFilterId: "environment-1" });
    renderSidebar([makeThread("thread-1", "Scoped thread")]);
    expect(
      screen.getByRole("combobox", { name: "Environment filter" }),
    ).toHaveTextContent("Machine");
  });

  it("suppresses Target per singleton-target project even when another project differs", () => {
    renderSidebar(
      [
        makeThread("local-thread", "Local thread"),
        makeThread("remote-thread", "Remote thread", {
          workspaceId: "workspace-remote",
          targetId: "target-remote",
        }),
      ],
      {
        workspaces: [
          {
            id: "workspace-1",
            environmentId: "environment-1",
            label: { text: "Local project" },
            displayPath: { text: "/local" },
            available: true,
          },
          {
            id: "workspace-remote",
            environmentId: "environment-1",
            label: { text: "Remote project" },
            displayPath: { text: "/remote" },
            available: true,
          },
        ],
        executionTargets: [
          {
            id: "target-1",
            environmentId: "environment-1",
            label: { text: "Pi" },
            backend: { label: { text: "Pi" }, brand: "pi" },
            workspaceExecution: { kind: "direct_only" },
            available: true,
          },
          {
            id: "target-remote",
            environmentId: "environment-1",
            label: { text: "Codex" },
            backend: { label: { text: "Codex" }, brand: "codex" },
            workspaceExecution: { kind: "direct_only" },
            available: true,
          },
        ],
      },
    );
    expect(screen.queryByTestId("thread-row-location")).toBeNull();
  });

  it("does not add target names to mixed-target project tree rows", () => {
    const root = makeThread("root-target", "Root target");
    const descendant = makeThread("descendant-target", "Descendant target", {
      targetId: "target-2",
    });
    renderSidebar([root], {
      executionTargets: [
        {
          id: "target-1",
          environmentId: "environment-1",
          label: { text: "Pi" },
          backend: { label: { text: "Pi" }, brand: "pi" },
          workspaceExecution: { kind: "direct_only" },
          available: true,
        },
        {
          id: "target-2",
          environmentId: "environment-1",
          label: { text: "Codex" },
          backend: { label: { text: "Codex" }, brand: "codex" },
          workspaceExecution: { kind: "direct_only" },
          available: true,
        },
      ],
      descendantPages: {
        "root-target": {
          descendants: [
            {
              thread: descendant,
              origin: forkOrigin("descendant-target", "root-target"),
              placement: nestedPlacement("descendant-target"),
            },
          ],
          loading: false,
          loaded: true,
        },
      },
      lineageFamilies: [{ sourceThreadId: "root-target", descendantCount: 1 }],
    });
    expect(screen.queryByTestId("thread-row-location")).toBeNull();
    expect(screen.queryByText("Pi")).toBeNull();
    expect(screen.queryByText("Codex")).toBeNull();
  });

  it("shows Local beside remote environments and filters by either name without selecting a thread", async () => {
    const user = userEvent.setup();
    seedViewPreferences({ groupBy: "time", modes: { time: { density: "card" } } });
    const onSelectThread = vi.fn();
    const environments = [
      { id: "local", kind: "local" as const, label: { text: "Local" }, available: true, directoryBrowsing: "unavailable" as const },
      { id: "remote", kind: "ssh" as const, label: { text: "AW personal" }, available: true, directoryBrowsing: "unavailable" as const },
    ];
    const workspaces = [
      { id: "local-one", environmentId: "local", label: { text: "One" }, displayPath: { text: "/one" }, available: true },
      { id: "local-two", environmentId: "local", label: { text: "Two" }, displayPath: { text: "/two" }, available: true },
      { id: "remote-one", environmentId: "remote", label: { text: "Remote" }, displayPath: { text: "/remote" }, available: true },
    ];
    const executionTargets = environments.map((environment) => ({
      id: `target-${environment.id}`, environmentId: environment.id,
      label: { text: "Pi" }, backend: { label: { text: "Pi" }, brand: "pi" as const },
      workspaceExecution: { kind: "direct_only" as const }, available: true as const,
    }));
    renderSidebar(workspaces.map((workspace) => makeThread(workspace.id, `${workspace.label.text} thread`, {
      workspaceId: workspace.id, targetId: `target-${workspace.environmentId}`,
    })), { environments, workspaces, executionTargets }, false, onSelectThread);

    expect(screen.getAllByTestId("flat-row-environment").map((element) => element.textContent).sort()).toEqual(["AW personal", "Local", "Local"]);
    expect(screen.queryByRole("button", { name: "Filter threads by environment Local" })).toBeNull();
    act(() => setClickNamesToFilter(true));
    await user.click(screen.getAllByRole("button", { name: "Filter threads by environment Local" })[0]!);
    expect(screen.getByText("One thread")).toBeVisible();
    expect(screen.getByText("Two thread")).toBeVisible();
    expect(screen.queryByText("Remote thread")).toBeNull();
    expect(screen.getByRole("combobox", { name: "Environment filter" })).toHaveTextContent("Local");
    expect(screen.queryByTestId("flat-row-environment")).toBeNull();
    expect(onSelectThread).not.toHaveBeenCalled();

    act(() => clearActiveSidebarFilters());
    await user.click(screen.getByRole("button", { name: "Filter threads by environment AW personal" }));
    expect(screen.queryByText("One thread")).toBeNull();
    expect(screen.queryByText("Two thread")).toBeNull();
    expect(screen.getByText("Remote thread")).toBeVisible();
    expect(onSelectThread).not.toHaveBeenCalled();
    act(() => clearActiveSidebarFilters());
    expect(screen.getAllByTestId("flat-row-environment")).toHaveLength(3);
    act(() => setClickNamesToFilter(false));
    expect(screen.queryByRole("button", { name: "Filter threads by environment AW personal" })).toBeNull();
    expect(screen.getAllByTestId("flat-row-environment")).toHaveLength(3);
  });

  it("omits the sole local environment even when name shortcuts are enabled", () => {
    seedViewPreferences({ groupBy: "time", modes: { time: { density: "card" } } });
    setClickNamesToFilter(true);
    renderSidebar([makeThread("only", "Only thread")]);
    expect(screen.queryByTestId("flat-row-environment")).toBeNull();
    expect(screen.getByRole("button", { name: "Filter threads by project Sedes" })).toBeVisible();
  });

  it("filters from a card project name and clears through the existing Back action", async () => {
    const user = userEvent.setup();
    seedViewPreferences({ groupBy: "time", modes: { time: { density: "card" } } });
    const onSelectThread = vi.fn();
    const workspaces = ["Alpha", "Beta"].map((name) => ({
      id: `workspace-${name}`,
      environmentId: "environment-1",
      label: { text: name },
      displayPath: { text: `/workspace/${name}` },
      available: true,
    }));
    renderSidebar(
      workspaces.map((workspace) => makeThread(workspace.id, `${workspace.label.text} thread`, {
        workspaceId: workspace.id,
      })),
      { workspaces },
      false,
      onSelectThread,
    );
    expect(screen.queryByRole("button", { name: "Filter threads by project Alpha" })).toBeNull();
    act(() => setClickNamesToFilter(true));
    await user.click(screen.getByRole("button", { name: "Filter threads by project Alpha" }));
    expect(screen.queryByText("Beta thread")).toBeNull();
    expect(screen.getByText("Alpha thread")).toBeVisible();
    expect(onSelectThread).not.toHaveBeenCalled();
    expect(hasActiveSidebarFilters()).toBe(true);
    act(() => clearActiveSidebarFilters());
    expect(hasActiveSidebarFilters()).toBe(false);
    expect(screen.getByText("Beta thread")).toBeVisible();
    act(() => setClickNamesToFilter(false));
    expect(screen.queryByRole("button", { name: "Filter threads by project Alpha" })).toBeNull();
  });

  it("persists one project filter across project and flat views and clears it", async () => {
    const user = userEvent.setup();
    const workspaces = [
      {
        id: "workspace-a",
        environmentId: "environment-1",
        label: { text: "Alpha" },
        displayPath: { text: "/workspace/alpha" },
        available: true,
      },
      {
        id: "workspace-b",
        environmentId: "environment-1",
        label: { text: "Beta" },
        displayPath: { text: "/workspace/beta" },
        available: true,
      },
    ];
    renderSidebar(
      [
        makeThread("thread-a", "Alpha thread", {
          workspaceId: "workspace-a",
        }),
        makeThread("thread-b", "Beta thread", {
          workspaceId: "workspace-b",
        }),
      ],
      { workspaces },
    );

    await user.click(screen.getByRole("combobox", { name: "Project filter" }));
    await user.click(screen.getByRole("option", { name: "Beta" }));

    expect(screen.queryByText("Alpha thread")).toBeNull();
    expect(screen.getByText("Beta thread")).toBeInTheDocument();
    expect(
      JSON.parse(localStorage.getItem(SIDEBAR_VIEW_STORAGE_KEY) ?? "{}"),
    ).toMatchObject({ projectFilterName: "Beta" });

    await user.click(screen.getByTestId("view-quick-toggle"));
    expect(screen.queryByText("Alpha thread")).toBeNull();
    expect(screen.getByText("Beta thread")).toBeInTheDocument();

    await user.click(screen.getByRole("combobox", { name: "Project filter" }));
    await user.click(screen.getByRole("option", { name: "All projects" }));
    expect(screen.getByText("Alpha thread")).toBeInTheDocument();
    expect(screen.getByText("Beta thread")).toBeInTheDocument();
  });

  it("filters from a folder shortcut without coupling disclosure to selection", async () => {
    const user = userEvent.setup();
    renderSidebar(
      [
        makeThread("thread-a", "Alpha thread", {
          workspaceId: "workspace-a",
        }),
        makeThread("thread-b", "Beta thread", {
          workspaceId: "workspace-b",
        }),
      ],
      {
        workspaces: [
          {
            id: "workspace-a",
            environmentId: "environment-1",
            label: { text: "Alpha" },
            displayPath: { text: "/workspace/alpha" },
            available: true,
          },
          {
            id: "workspace-b",
            environmentId: "environment-1",
            label: { text: "Beta" },
            displayPath: { text: "/workspace/beta" },
            available: true,
          },
        ],
      },
    );

    const betaDisclosure = screen.getAllByTestId("project-row")[1]!;
    expect(betaDisclosure).toHaveAttribute("data-state", "closed");
    await user.click(screen.getByRole("button", { name: "Filter to Beta" }));

    expect(screen.queryByText("Alpha thread")).toBeNull();
    expect(screen.getByText("Beta thread")).toBeInTheDocument();
    expect(screen.getByTestId("project-row")).toHaveAttribute(
      "data-state",
      "open",
    );

    await user.click(screen.getByRole("button", { name: "Clear Beta filter" }));
    expect(
      screen.getByRole("combobox", { name: "Project filter" }),
    ).toHaveTextContent("All projects");
    expect(screen.getAllByTestId("project-row")).toHaveLength(2);

    const betaDisclosureAfterClear = screen.getAllByTestId("project-row")[1]!;
    await user.click(betaDisclosureAfterClear);
    expect(betaDisclosureAfterClear).toHaveAttribute("data-state", "closed");
    expect(
      screen.getByRole("combobox", { name: "Project filter" }),
    ).toHaveTextContent("All projects");
    expect(screen.getAllByTestId("project-row")).toHaveLength(2);
  });

  it("scopes shelves and paged descendants and repairs a stale stored filter", async () => {
    const workspaces = [
      {
        id: "workspace-a",
        environmentId: "environment-1",
        label: { text: "Alpha" },
        displayPath: { text: "/workspace/alpha" },
        available: true,
      },
      {
        id: "workspace-b",
        environmentId: "environment-1",
        label: { text: "Beta" },
        displayPath: { text: "/workspace/beta" },
        available: true,
      },
    ];
    const betaRoot = makeThread("beta-root", "Beta root", {
      workspaceId: "workspace-b",
    });
    const alphaPaged = makeThread("alpha-paged", "Alpha paged fork", {
      workspaceId: "workspace-a",
    });
    seedViewPreferences({
      projectFilterName: "Beta",
    });
    const view = renderSidebar(
      [
        betaRoot,
        makeThread("alpha-snoozed", "Alpha snoozed", {
          workspaceId: "workspace-a",
          inventoryState: "snoozed",
        }),
        makeThread("beta-snoozed", "Beta snoozed", {
          workspaceId: "workspace-b",
          inventoryState: "snoozed",
        }),
      ],
      {
        workspaces,
        descendantPages: {
          "beta-root": {
            descendants: [
              {
                thread: alphaPaged,
                origin: forkOrigin("alpha-paged", "beta-root"),
                placement: nestedPlacement("alpha-paged"),
              },
            ],
            loading: false,
            loaded: false,
            nextCursor: "more-global-descendants",
          },
        },
        lineageFamilies: [{ sourceThreadId: "beta-root", descendantCount: 1 }],
      },
    );

    expect(screen.getByText("Beta root")).toBeInTheDocument();
    expect(screen.getByText("Beta snoozed")).toBeInTheDocument();
    expect(screen.queryByText("Alpha snoozed")).toBeNull();
    expect(screen.queryByText("Alpha paged fork")).toBeNull();
    expect(
      screen.queryByRole("button", {
        name: "Expand fork family for Beta root",
      }),
    ).toBeNull();
    expect(
      screen.queryByRole("button", { name: "Show all runs/forks" }),
    ).toBeNull();
    expect(
      screen
        .getAllByTestId("inventory-shelf")
        .find((shelf) => shelf.getAttribute("data-shelf") === "automations"),
    ).toHaveTextContent("Automations · 0");
    expect(
      screen
        .getAllByTestId("inventory-shelf")
        .find((shelf) => shelf.getAttribute("data-shelf") === "snoozed"),
    ).toHaveTextContent("Snoozed · 1");

    await userEvent.setup().click(screen.getByTestId("view-quick-toggle"));
    expect(screen.getByText("Beta root")).toBeInTheDocument();
    expect(screen.queryByText("Alpha paged fork")).toBeNull();
    expect(
      screen.queryByRole("button", { name: "Show all runs/forks" }),
    ).toBeNull();

    seedViewPreferences({ projectFilterName: "workspace-missing" });
    view.rerender(
      <InventorySidebar
        state={makeState([betaRoot], { workspaces })}
        store={view.store}
        onNavigate={() => undefined}
        onOpenSettings={() => undefined}
      />,
    );
    await waitFor(() =>
      expect(
        JSON.parse(localStorage.getItem(SIDEBAR_VIEW_STORAGE_KEY) ?? "{}"),
      ).toMatchObject({ projectFilterName: null }),
    );
    expect(
      screen.getByRole("combobox", { name: "Project filter" }),
    ).toHaveTextContent("All projects");
  });

  it("opens questions from both hierarchy and flat sidebar indicators", async () => {
    const user = userEvent.setup();
    const requestQuestionInboxOpen = vi.fn();
    const registry = { get: vi.fn(() => ({ requestQuestionInboxOpen })) } as unknown as ThreadStoreRegistry;
    const onSelectThread = vi.fn();
    renderSidebar([
      makeThread("thread-a", "Questions pending", { pendingQuestionCount: 2 }),
      makeThread("thread-b", "No questions"),
    ], {}, false, onSelectThread, false, registry);
    expect(screen.getAllByRole("button", { name: "2 unanswered questions" })).toHaveLength(1);
    await user.click(screen.getByTestId("thread-row-question-indicator"));
    expect(requestQuestionInboxOpen).toHaveBeenCalledTimes(1);
    expect(onSelectThread).toHaveBeenCalledWith("thread-a", "split");
    await user.click(screen.getByTestId("view-quick-toggle"));
    await user.click(screen.getByTestId("flat-row-question-indicator"));
    expect(requestQuestionInboxOpen).toHaveBeenCalledTimes(2);
    expect(registry.get).toHaveBeenLastCalledWith("thread-a");
    expect(onSelectThread).toHaveBeenCalledTimes(2);
  });

  it("shows only open direct thread tasks in project and flat rows", async () => {
    const user = userEvent.setup();
    const completedAt = isoAtNoon(0);
    const threads = [
      makeThread("thread-a", "Thread with tasks", {
        stashedPromptCount: 1,
        pendingQuestionCount: 0,
        turnBookmarkCount: 2,
      }),
      makeThread("thread-b", "Thread without direct tasks"),
      makeThread("thread-c", "Thread with completed tasks"),
    ];
    const view = renderSidebar(threads, {
      tasks: [
        makeTask("open-a", { kind: "thread", threadId: "thread-a" }),
        makeTask(
          "done-a",
          { kind: "thread", threadId: "thread-a" },
          completedAt,
        ),
        makeTask("workspace-task", {
          kind: "workspace",
          workspaceId: "workspace-1",
        }),
        makeTask("global-task", { kind: "global" }),
        makeTask(
          "done-c",
          { kind: "thread", threadId: "thread-c" },
          completedAt,
        ),
      ],
    });

    const projectTaskRow = document.querySelector<HTMLElement>(
      '[data-thread-id="thread-a"]',
    )!;
    expect(
      within(projectTaskRow).getByRole("img", {
        name: "1 open task",
      }),
    ).toBeInTheDocument();
    expect(
      within(projectTaskRow).getByRole("img", {
        name: "1 stashed prompt",
      }),
    ).toBeInTheDocument();
    expect(
      within(projectTaskRow).getByRole("img", {
        name: "2 bookmarked turns",
      }),
    ).toBeInTheDocument();
    expect(
      projectTaskRow.querySelector(
        ".thread-row-default-trailing > .thread-row-indicators",
      ),
    ).not.toBeNull();
    expect(
      projectTaskRow.querySelector(".thread-row-link .thread-row-indicators"),
    ).toBeNull();
    const plainProjectRow = document.querySelector<HTMLElement>(
      '[data-thread-id="thread-b"]',
    )!;
    expect(
      within(plainProjectRow).queryByRole("img", { name: /task/i }),
    ).toBeNull();
    expect(
      within(plainProjectRow).queryByRole("img", { name: /stashed prompt/i }),
    ).toBeNull();
    const completedProjectRow = document.querySelector<HTMLElement>(
      '[data-thread-id="thread-c"]',
    )!;
    expect(
      within(completedProjectRow).queryByRole("img", { name: /task/i }),
    ).toBeNull();

    await user.click(screen.getByTestId("view-quick-toggle"));
    const flatTaskRow = document.querySelector<HTMLElement>(
      '[data-thread-id="thread-a"]',
    )!;
    expect(
      within(flatTaskRow).getByRole("img", {
        name: "1 open task",
      }),
    ).toBeInTheDocument();
    expect(
      within(flatTaskRow).getByRole("img", {
        name: "2 bookmarked turns",
      }),
    ).toBeInTheDocument();
    expect(
      flatTaskRow.querySelector(
        ".flat-row-default-trailing > .flat-row-indicators",
      ),
    ).not.toBeNull();
    expect(
      flatTaskRow.querySelector(".flat-row-link .flat-row-indicators"),
    ).toBeNull();
    const plainFlatRow = document.querySelector<HTMLElement>(
      '[data-thread-id="thread-b"]',
    )!;
    expect(
      within(plainFlatRow).queryByRole("img", { name: /task/i }),
    ).toBeNull();
    const completedFlatRow = document.querySelector<HTMLElement>(
      '[data-thread-id="thread-c"]',
    )!;
    expect(
      within(completedFlatRow).queryByRole("img", { name: /task/i }),
    ).toBeNull();

    view.rerender(
      <InventorySidebar
        state={makeState(threads, { tasks: [] })}
        store={view.store}
        onNavigate={() => undefined}
        onOpenSettings={() => undefined}
      />,
    );
    expect(
      within(
        document.querySelector<HTMLElement>('[data-thread-id="thread-a"]')!,
      ).queryByRole("img", { name: /task/i }),
    ).toBeNull();

    await user.click(screen.getByTestId("view-quick-toggle"));
    expect(
      within(
        document.querySelector<HTMLElement>('[data-thread-id="thread-a"]')!,
      ).queryByRole("img", { name: /task/i }),
    ).toBeNull();
  });

  it("opens a path in the selected workspace's environment", async () => {
    const user = userEvent.setup();
    const { store, rerenderSidebar } = renderSidebar([], {
      environments: [
        {
          id: "environment-local",
          kind: "local" as const,
          label: { text: "This machine" },
          available: true,
          directoryBrowsing: "unavailable" as const,
        },
        {
          id: "environment-ssh",
          kind: "ssh" as const,
          label: { text: "Build host" },
          available: true,
          directoryBrowsing: "unavailable" as const,
        },
      ],
      workspaces: [
        {
          id: "workspace-remote",
          environmentId: "environment-ssh",
          label: { text: "Remote project" },
          displayPath: { text: "/srv/project" },
          available: true,
        },
      ],
    });

    await user.click(screen.getByRole("button", { name: "Add project" }));
    await user.type(
      screen.getByRole("textbox", { name: "Absolute directory path" }),
      "/local/stale",
    );
    await user.click(
      screen.getByRole("combobox", { name: "Directory environment" }),
    );
    await user.click(screen.getByRole("option", { name: "Build host" }));
    await user.type(screen.getByLabelText("Absolute directory path"), "/srv/new");
    const published = makeState([], {
        environments: [
          {
            id: "environment-ssh",
            kind: "ssh" as const,
            label: { text: "Build host" },
            available: true,
            directoryBrowsing: "unavailable" as const,
          },
        ],
        workspaces: [
          {
            id: "workspace-remote",
            environmentId: "environment-ssh",
            label: { text: "Remote project" },
            displayPath: { text: "/srv/project" },
            available: true,
          },
          {
            id: "workspace-new",
            environmentId: "environment-ssh",
            label: { text: "New remote project" },
            displayPath: { text: "/srv/new" },
            available: true,
          },
        ],
      });
    await user.click(within(screen.getByRole("dialog", { name: "Add project" })).getByRole("button", { name: "Add project" }));

    expect(store.openWorkspace).toHaveBeenCalledWith(
      "/srv/new",
      "environment-ssh",
    );
    expect(
      JSON.parse(localStorage.getItem(SIDEBAR_VIEW_STORAGE_KEY) ?? "{}"),
    ).not.toMatchObject({ projectFilterName: "New remote project" });
    rerenderSidebar(published);
    await waitFor(() =>
      expect(
        JSON.parse(localStorage.getItem(SIDEBAR_VIEW_STORAGE_KEY) ?? "{}"),
      ).toMatchObject({ projectFilterName: "New remote project" }),
    );
    expect(store.refresh).not.toHaveBeenCalled();
  });

  it("does not replace a newer project selection when an opened workspace publishes late", async () => {
    const user = userEvent.setup();
    const environments = [
      {
        id: "environment-local",
        kind: "local" as const,
        label: { text: "This machine" },
        available: true,
        directoryBrowsing: "unavailable" as const,
      },
      {
        id: "environment-ssh",
        kind: "ssh" as const,
        label: { text: "Build host" },
        available: true,
        directoryBrowsing: "unavailable" as const,
      },
    ];
    const remoteWorkspace = {
      id: "workspace-remote",
      environmentId: "environment-ssh",
      label: { text: "Remote project" },
      displayPath: { text: "/srv/project" },
      available: true,
    };
    const { rerenderSidebar } = renderSidebar([], {
      environments,
      workspaces: [remoteWorkspace],
    });

    await user.click(screen.getByRole("button", { name: "Add project" }));
    await user.click(
      screen.getByRole("combobox", { name: "Directory environment" }),
    );
    await user.click(screen.getByRole("option", { name: "Build host" }));
    await user.type(screen.getByLabelText("Absolute directory path"), "/srv/new");
    await user.click(within(screen.getByRole("dialog", { name: "Add project" })).getByRole("button", { name: "Add project" }));

    setSidebarInventoryScope({
      projectFilterName: "Remote project",
    });
    rerenderSidebar(
      makeState([], {
        environments,
        workspaces: [
          remoteWorkspace,
          {
            id: "workspace-new",
            environmentId: "environment-ssh",
            label: { text: "New remote project" },
            displayPath: { text: "/srv/new" },
            available: true,
          },
        ],
      }),
    );

    await waitFor(() =>
      expect(
        JSON.parse(localStorage.getItem(SIDEBAR_VIEW_STORAGE_KEY) ?? "{}"),
      ).toMatchObject({ projectFilterName: "Remote project" }),
    );
    expect(
      JSON.parse(localStorage.getItem(SIDEBAR_VIEW_STORAGE_KEY) ?? "{}"),
    ).not.toMatchObject({ projectFilterName: "New remote project" });
  });

  it("retains a pending opened workspace across delayed publications", async () => {
    const now = vi.spyOn(Date, "now").mockReturnValue(100_000);
    try {
      const user = userEvent.setup();
      const environment = {
        id: "environment-local",
        kind: "local" as const,
        label: { text: "This machine" },
        available: true,
        directoryBrowsing: "unavailable" as const,
      };
      const { rerenderSidebar } = renderSidebar([], {
        environments: [environment],
      });

      await user.click(screen.getByRole("button", { name: "Add project" }));
      await user.type(
        screen.getByRole("textbox", { name: "Absolute directory path" }),
        "/srv/new",
      );
      await user.click(within(screen.getByRole("dialog", { name: "Add project" })).getByRole("button", { name: "Add project" }));

      now.mockReturnValue(106_000);
      rerenderSidebar(makeState([], { environments: [environment] }));
      rerenderSidebar(
        makeState([], {
          environments: [environment],
          workspaces: [
            {
              id: "workspace-new",
              environmentId: environment.id,
              label: { text: "New project" },
              displayPath: { text: "/srv/new" },
              available: true,
            },
          ],
        }),
      );

      await waitFor(() =>
        expect(
          JSON.parse(localStorage.getItem(SIDEBAR_VIEW_STORAGE_KEY) ?? "{}"),
        ).toMatchObject({ projectFilterName: "New project" }),
      );
    } finally {
      now.mockRestore();
    }
  });

  it("browses directories in the explicitly selected project environment", async () => {
    const user = userEvent.setup();
    const { store } = renderSidebar([], {
      environments: [
        {
          id: "environment-local",
          kind: "local" as const,
          label: { text: "This machine" },
          available: true,
          directoryBrowsing: "available" as const,
        },
        {
          id: "environment-ssh",
          kind: "ssh" as const,
          label: { text: "Build host" },
          available: false,
          directoryBrowsing: "available" as const,
        },
      ],
    });
    const browse = vi.mocked(store.api.browseExecutionEnvironmentDirectories);
    browse.mockResolvedValueOnce({
      location: { kind: "roots" },
      entries: [{ name: "projects", path: "/srv/projects" }],
      truncated: false,
    });

    await user.click(screen.getByRole("button", { name: "Add project" }));
    await user.click(
      screen.getByRole("combobox", { name: "Directory environment" }),
    );
    await user.click(
      screen.getByRole("option", { name: "Build host — Unavailable" }),
    );
    expect(
      screen.getByRole("textbox", { name: "Absolute directory path" }),
    ).toHaveValue("");

    expect(
      await screen.findByRole("dialog", { name: "Add project" }),
    ).toBeVisible();
    expect(
      screen.getByRole("combobox", { name: "Directory environment" }),
    ).toHaveTextContent("Build host");
    expect(
      await screen.findByRole("button", { name: /projects/ }),
    ).toBeVisible();
    expect(browse).toHaveBeenCalledWith(
      "environment-ssh",
      expect.objectContaining({ location: { kind: "roots" } }),
      expect.any(AbortSignal),
    );
  });

  it("renders Upcoming and day buckets without workspace monograms in timeline mode", () => {
    seedViewPreferences({ groupBy: "time", lastAltGroupBy: "time" });
    renderSidebar([
      makeThread("snoozed-1", "Snoozed research", {
        inventoryState: "snoozed" as const,
        snoozedUntil: new Date(Date.now() + 3_600_000).toISOString(),
      }),
      makeThread("today-1", "Today thread"),
      makeThread("yesterday-1", "Yesterday thread", {
        lastActivityAt: isoAtNoon(-1),
        stateChangedAt: isoAtNoon(-1),
      }),
    ]);

    const groups = screen.getAllByTestId("flat-group");
    expect(groups.map((group) => group.getAttribute("data-group"))).toEqual([
      "upcoming",
      "today",
      "yesterday",
    ]);
    expect(groups[0]).toHaveTextContent("Upcoming · 1");
    expect(groups[1]).toHaveTextContent("Today · 1");
    expect(groups[2]).toHaveTextContent("Yesterday · 1");
    expect(screen.getAllByTestId("flat-thread-row")).toHaveLength(3);
    // Compact density omits the project label that card density shows on
    // line 2.
    expect(screen.queryByTestId("flat-row-project")).toBeNull();
    expect(screen.queryByRole("heading", { name: "Projects" })).toBeNull();
  });

  it("extracts pinned threads into an expanded top shelf", () => {
    seedViewPreferences({ groupBy: "time", lastAltGroupBy: "time" });
    renderSidebar([
      makeThread("plain", "Plain thread"),
      makeThread("pinned", "Pinned thread", { pinned: true }),
    ]);

    const groups = screen.getAllByTestId("flat-group");
    expect(groups.map((group) => group.getAttribute("data-group"))).toEqual([
      "pinned",
      "today",
    ]);
    expect(groups[0]).toHaveTextContent("Pinned · 1");
    expect(within(groups[0]!).getByText("Pinned thread")).toBeVisible();
    expect(within(groups[1]!).queryByText("Pinned thread")).toBeNull();
    expect(
      within(groups[0]!).getByRole("button", { name: "Unpin Pinned thread" }),
    ).toHaveAttribute("aria-pressed", "true");
    expect(
      within(groups[0]!).queryByRole("img", { name: "Pinned" }),
    ).toBeNull();
  });

  it("never caps the curated pinned shelf", () => {
    seedViewPreferences({ groupBy: "state", lastAltGroupBy: "state" });
    renderSidebar(
      Array.from({ length: 25 }, (_, index) =>
        makeThread(`pinned-${index}`, `Pinned ${index}`, { pinned: true }),
      ),
    );

    expect(screen.getAllByTestId("flat-thread-row")).toHaveLength(25);
    expect(screen.queryByRole("button", { name: /more…/ })).toBeNull();
  });

  it("filters a non-project view to pinned threads only", async () => {
    const user = userEvent.setup();
    seedViewPreferences({ groupBy: "none", lastAltGroupBy: "none" });
    renderSidebar([
      makeThread("plain", "Plain thread"),
      makeThread("pinned", "Pinned thread", { pinned: true }),
    ]);

    await user.click(screen.getByTestId("view-options-trigger"));
    await user.click(
      await screen.findByRole("checkbox", { name: "Pinned only" }),
    );

    await waitFor(() => expect(screen.queryByText("Plain thread")).toBeNull());
    expect(screen.getByText("Pinned thread")).toBeVisible();
  });

  it("explains an empty pinned-only projection", async () => {
    const user = userEvent.setup();
    seedViewPreferences({ groupBy: "none", lastAltGroupBy: "none" });
    renderSidebar([makeThread("plain", "Plain thread")]);

    await user.click(screen.getByTestId("view-options-trigger"));
    await user.click(
      await screen.findByRole("checkbox", { name: "Pinned only" }),
    );

    expect(
      await screen.findByText("No pinned threads in this scope"),
    ).toBeVisible();
  });

  it("pins from the first project-row action without navigating", async () => {
    const user = userEvent.setup();
    const { store } = renderSidebar([makeThread("thread-1", "Pin me")]);
    window.history.replaceState(null, "", "/threads/current");

    const pinButton = screen.getByRole("button", { name: "Pin Pin me" });
    expect(pinButton).toHaveAttribute("aria-pressed", "false");
    await user.click(pinButton);

    expect(store.setThreadPinned).toHaveBeenCalledWith(
      expect.objectContaining({ id: "thread-1" }),
      true,
    );
    expect(window.location.pathname).toBe("/threads/current");
  });

  it("shows pinned state through hover actions without persistent row metadata", async () => {
    const user = userEvent.setup();
    renderSidebar([makeThread("thread-1", "Pinned thread", { pinned: true })]);

    const projectRow = document.querySelector<HTMLElement>(
      '[data-thread-id="thread-1"]',
    )!;
    expect(
      within(projectRow).getByRole("button", { name: "Unpin Pinned thread" }),
    ).toHaveAttribute("aria-pressed", "true");
    expect(
      within(projectRow).queryByRole("img", { name: "Pinned" }),
    ).toBeNull();

    await user.click(screen.getByTestId("view-quick-toggle"));
    const flatRow = document.querySelector<HTMLElement>(
      '[data-thread-id="thread-1"]',
    )!;
    expect(
      within(flatRow).getByRole("button", { name: "Unpin Pinned thread" }),
    ).toHaveAttribute("aria-pressed", "true");
    expect(within(flatRow).queryByRole("img", { name: "Pinned" })).toBeNull();
  });

  it("quick toggle returns to the project view", async () => {
    const user = userEvent.setup();
    seedViewPreferences({ groupBy: "time", lastAltGroupBy: "time" });
    renderSidebar([makeThread("today-1", "Today thread")]);
    expect(screen.getAllByTestId("flat-group")).not.toHaveLength(0);

    await user.click(screen.getByTestId("view-quick-toggle"));

    expect(
      await screen.findByRole("heading", { name: "Projects" }),
    ).toBeInTheDocument();
    expect(screen.getByTestId("project-row")).toHaveTextContent("Sedes");
    expect(screen.queryByTestId("flat-group")).toBeNull();
    expect(screen.queryByTestId("flat-thread-row")).toBeNull();
  });

  it("density switch in the options popover flips flat row structure", async () => {
    const user = userEvent.setup();
    seedViewPreferences({ groupBy: "time", lastAltGroupBy: "time" });
    renderSidebar([makeThread("today-1", "Today thread")]);
    expect(screen.getByTestId("flat-thread-row")).toHaveAttribute(
      "data-density",
      "compact",
    );

    await user.click(screen.getByTestId("view-options-trigger"));
    await user.click(await screen.findByRole("radio", { name: "Card" }));

    const row = screen.getByTestId("flat-thread-row");
    expect(row).toHaveAttribute("data-density", "card");
    expect(row.querySelector(".flat-row-line2")).not.toBeNull();
  });

  it("parks settled threads below time buckets in timeline mode", () => {
    seedViewPreferences({ groupBy: "time", lastAltGroupBy: "time" });
    renderSidebar([
      makeThread("today-1", "Active thread"),
      makeThread("settled-1", "Settled exploration", {
        inventoryState: "settled" as const,
        lastActivityAt: isoAtNoon(-1),
        stateChangedAt: isoAtNoon(-1),
      }),
    ]);

    const groups = screen.getAllByTestId("flat-group");
    expect(groups.map((group) => group.getAttribute("data-group"))).toEqual([
      "today",
      "settled",
    ]);
    expect(groups[1]).toHaveTextContent("Settled · 1");
    expect(within(groups[0]!).queryByText("Settled exploration")).toBeNull();
    expect(within(groups[1]!).getByText("Settled exploration")).toBeVisible();
  });

  it("parks settled threads below the working list in flat mode", () => {
    seedViewPreferences({ groupBy: "none", lastAltGroupBy: "none" });
    renderSidebar([
      makeThread("today-1", "Active thread"),
      makeThread("settled-1", "Settled exploration", {
        inventoryState: "settled" as const,
      }),
    ]);

    const groups = screen.getAllByTestId("flat-group");
    expect(groups.map((group) => group.getAttribute("data-group"))).toEqual([
      "all",
      "settled",
    ]);
    expect(groups[1]).toHaveTextContent("Settled · 1");
    expect(within(groups[0]!).getByText("Active thread")).toBeVisible();
    expect(within(groups[1]!).getByText("Settled exploration")).toBeVisible();
  });

  it("hides settled threads in flat mode when Show settled is off", async () => {
    const user = userEvent.setup();
    seedViewPreferences({ groupBy: "time", lastAltGroupBy: "time" });
    renderSidebar([
      makeThread("today-1", "Active thread"),
      makeThread("settled-1", "Settled exploration", {
        inventoryState: "settled" as const,
      }),
    ]);
    expect(screen.getByText("Settled exploration")).toBeInTheDocument();

    await user.click(screen.getByTestId("view-options-trigger"));
    await user.click(await screen.findByRole("checkbox", { name: "Settled" }));

    await waitFor(() =>
      expect(screen.queryByText("Settled exploration")).toBeNull(),
    );
    expect(screen.getByText("Active thread")).toBeInTheDocument();
  });

  it("hides snoozed threads in flat mode when Show snoozed is off", async () => {
    const user = userEvent.setup();
    seedViewPreferences({ groupBy: "state", lastAltGroupBy: "state" });
    renderSidebar([
      makeThread("active-1", "Active thread"),
      makeThread("snoozed-1", "Snoozed exploration", {
        inventoryState: "snoozed" as const,
      }),
    ]);
    expect(screen.getByText("Snoozed exploration")).toBeInTheDocument();

    await user.click(screen.getByTestId("view-options-trigger"));
    await user.click(await screen.findByRole("checkbox", { name: "Snoozed" }));

    await waitFor(() =>
      expect(screen.queryByText("Snoozed exploration")).toBeNull(),
    );
    expect(screen.getByText("Active thread")).toBeInTheDocument();
  });

  it("caps Upcoming at five rows behind an expander", async () => {
    const user = userEvent.setup();
    seedViewPreferences({ groupBy: "time", lastAltGroupBy: "time" });
    renderSidebar(
      Array.from({ length: 7 }, (_, index) =>
        makeThread(`snoozed-${index}`, `Snoozed ${index}`, {
          inventoryState: "snoozed" as const,
          snoozedUntil: new Date(
            Date.now() + (index + 1) * 3_600_000,
          ).toISOString(),
        }),
      ),
    );

    const upcoming = screen
      .getAllByTestId("flat-group")
      .find((group) => group.getAttribute("data-group") === "upcoming");
    expect(upcoming).toBeDefined();
    expect(within(upcoming!).getAllByTestId("flat-thread-row")).toHaveLength(5);

    await user.click(
      within(upcoming!).getByRole("button", { name: "2 more…" }),
    );
    expect(within(upcoming!).getAllByTestId("flat-thread-row")).toHaveLength(7);
  });

  it("bounds large flat groups independently while keeping the selected row visible", async () => {
    const user = userEvent.setup();
    seedViewPreferences({ groupBy: "state", lastAltGroupBy: "state" });
    const idleThreads = Array.from({ length: 25 }, (_, index) =>
      makeThread(`idle-${String(index).padStart(3, "0")}`, `Idle ${index}`),
    );
    const settledThreads = Array.from({ length: 25 }, (_, index) =>
      makeThread(
        `settled-${String(index).padStart(3, "0")}`,
        `Settled ${index}`,
        { inventoryState: "settled" as const },
      ),
    );
    renderSidebar([...idleThreads, ...settledThreads], {
      selectedThreadId: "settled-024",
    });

    const groups = screen.getAllByTestId("flat-group");
    const idle = groups.find(
      (group) => group.getAttribute("data-group") === "idle",
    );
    const settled = groups.find(
      (group) => group.getAttribute("data-group") === "settled",
    );
    expect(idle).toBeDefined();
    expect(settled).toBeDefined();
    expect(within(idle!).getAllByTestId("flat-thread-row")).toHaveLength(20);
    expect(
      within(idle!).getByRole("button", { name: "5 more…" }),
    ).toBeVisible();
    expect(within(settled!).getAllByTestId("flat-thread-row")).toHaveLength(21);
    expect(within(settled!).getByText("Settled 24")).toBeVisible();
    expect(
      within(settled!).getByRole("button", { name: "4 more…" }),
    ).toBeVisible();

    await user.click(within(idle!).getByRole("button", { name: "5 more…" }));
    expect(within(idle!).getAllByTestId("flat-thread-row")).toHaveLength(25);
    expect(within(settled!).getAllByTestId("flat-thread-row")).toHaveLength(21);
  });

  it("does not cap flat groups while search is active", () => {
    seedViewPreferences({ groupBy: "state", lastAltGroupBy: "state" });
    renderSidebar(
      Array.from({ length: 25 }, (_, index) =>
        makeThread(
          `idle-${String(index).padStart(3, "0")}`,
          `Matching idle ${index}`,
        ),
      ),
      { search: "Matching" },
    );

    expect(screen.getAllByTestId("flat-thread-row")).toHaveLength(25);
    expect(screen.queryByRole("button", { name: /more…/ })).toBeNull();
  });

  it("gives flat rows the same context menu as project rows, with working rename", async () => {
    const user = userEvent.setup();
    seedViewPreferences({ groupBy: "none", lastAltGroupBy: "none" });
    const thread = makeThread("today-1", "Today thread");
    const { store } = renderSidebar([thread]);

    fireEvent.contextMenu(screen.getByTestId("flat-thread-row"));
    const menu = await screen.findByTestId("thread-context-menu");
    // Spot-check the established items carry over from the project view.
    expect(within(menu).getByText("Rename")).toBeInTheDocument();
    expect(within(menu).getByText("Archive")).toBeInTheDocument();
    expect(within(menu).getByText("Settle")).toBeInTheDocument();
    expect(within(menu).getByText("Snooze…")).toBeInTheDocument();

    await user.click(within(menu).getByText("Rename"));
    const input = await screen.findByTestId("thread-row-rename");
    expect(input).toHaveAccessibleName("Thread title");
    expect(fireEvent.pointerDown(input, { pointerType: "touch", button: 0 })).toBe(true);
    fireEvent.pointerUp(input, { pointerType: "touch", button: 0 });
    expect(fireEvent.contextMenu(input)).toBe(true);
    expect(screen.queryByTestId("thread-context-menu")).toBeNull();
    await user.clear(input);
    await user.type(input, "Sharper title{Enter}");
    expect(store.renameThread).toHaveBeenCalledWith(thread, "Sharper title");
    await waitFor(() =>
      expect(screen.queryByTestId("thread-row-rename")).toBeNull(),
    );
    // Scope to the row: the pointer travel above can open the hover peek,
    // which repeats the title in its own overlay.
    expect(screen.getByTestId("flat-thread-row")).toHaveTextContent(
      "Today thread",
    );
  });

  it("archives through the flat-row context menu", async () => {
    const user = userEvent.setup();
    seedViewPreferences({ groupBy: "none", lastAltGroupBy: "none" });
    const thread = makeThread("today-1", "Today thread");
    const { store } = renderSidebar([thread]);

    fireEvent.contextMenu(screen.getByTestId("flat-thread-row"));
    const menu = await screen.findByTestId("thread-context-menu");
    await user.click(within(menu).getByText("Archive"));
    const archiveItem = await screen.findByRole("menuitem", {
      name: "Archive this thread",
    });
    await waitFor(() =>
      expect(archiveItem).not.toHaveAttribute("data-disabled"),
    );
    await userEvent.click(archiveItem);
    await waitFor(() =>
      expect(store.mutateInventory).toHaveBeenCalledWith(thread, "archive", {
        expectedStashedPromptCount: 0,
        executionWorkspaceDisposition: { kind: "keep" },
      }),
    );
  });

  it("archives a childless project-view row immediately from its archive button", async () => {
    const user = userEvent.setup();
    // This fixture explicitly uses Projects grouping; no descendants means there
    // is no family choice, so the row button archives directly.
    const thread = makeThread("solo-1", "Solo thread");
    const { store } = renderSidebar([thread]);

    await user.click(
      screen.getByRole("button", { name: "Archive Solo thread" }),
    );

    await waitFor(() =>
      expect(store.mutateInventory).toHaveBeenCalledWith(thread, "archive", {
        expectedStashedPromptCount: 0,
      }),
    );
    expect(store.getThreadArchiveImpact).toHaveBeenCalledWith(thread.id);
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("prompts for task disposition from a childless project-row archive shortcut", async () => {
    const user = userEvent.setup();
    const thread = makeThread("project-task-1", "Project task thread");
    const { store } = renderSidebar([thread]);
    store.getThreadArchiveImpact = vi.fn().mockResolvedValue({
      descendantCount: 0,
      pendingQuestions: { root: 0, descendants: 0 },
      stashedPrompts: { root: 0, descendants: 0 },
      openTasks: {
        root: {
          items: [
            {
              id: "task-project-1",
              title: "Project task",
              threadId: thread.id,
            },
          ],
          total: 1,
          omitted: 0,
        },
        descendants: { items: [], total: 0, omitted: 0 },
      },
      executionWorkspace: { kind: "direct" },
      archiveOnly: { available: true },
      archiveAll: { available: true },
    });

    await user.click(
      screen.getByRole("button", { name: "Archive Project task thread" }),
    );

    const dialog = await screen.findByRole("dialog", {
      name: "Archive this thread",
    });
    expect(within(dialog).getByText("1 open task")).toBeInTheDocument();
    expect(store.mutateInventory).not.toHaveBeenCalled();
    await user.click(within(dialog).getByRole("button", { name: "Archive" }));
    await waitFor(() =>
      expect(store.mutateInventory).toHaveBeenCalledWith(thread, "archive", {
        expectedStashedPromptCount: 0,
        openTaskDisposition: "move_to_workspace",
        executionWorkspaceDisposition: { kind: "keep" },
      }),
    );
  });

  it("prompts for task disposition from a childless flat-row archive shortcut", async () => {
    const user = userEvent.setup();
    seedViewPreferences({ groupBy: "none", lastAltGroupBy: "none" });
    const thread = makeThread("flat-task-1", "Flat task thread");
    const { store } = renderSidebar([thread]);
    store.getThreadArchiveImpact = vi.fn().mockResolvedValue({
      descendantCount: 0,
      pendingQuestions: { root: 0, descendants: 0 },
      stashedPrompts: { root: 0, descendants: 0 },
      openTasks: {
        root: {
          items: [
            {
              id: "task-flat-1",
              title: "First flat task",
              threadId: thread.id,
            },
            {
              id: "task-flat-2",
              title: "Second flat task",
              threadId: thread.id,
            },
          ],
          total: 2,
          omitted: 0,
        },
        descendants: { items: [], total: 0, omitted: 0 },
      },
      executionWorkspace: { kind: "direct" },
      archiveOnly: { available: true },
      archiveAll: { available: true },
    });

    await user.click(
      screen.getByRole("button", { name: "Archive Flat task thread" }),
    );

    const dialog = await screen.findByRole("dialog", {
      name: "Archive this thread",
    });
    expect(within(dialog).getByText("2 open tasks")).toBeInTheDocument();
    expect(store.mutateInventory).not.toHaveBeenCalled();
    await user.click(within(dialog).getByRole("button", { name: "Archive" }));
    await waitFor(() =>
      expect(store.mutateInventory).toHaveBeenCalledWith(thread, "archive", {
        expectedStashedPromptCount: 0,
        openTaskDisposition: "move_to_workspace",
        executionWorkspaceDisposition: { kind: "keep" },
      }),
    );
  });

  it("places Settle, Snooze, then Pin in project and flat hover actions", async () => {
    const user = userEvent.setup();
    const thread = makeThread("hover-actions-1", "Hover actions");
    renderSidebar([thread]);

    const assertActionOrder = (row: HTMLElement, actionClass: string) => {
      const actions = row.querySelector<HTMLElement>(actionClass)!;
      const labels = within(actions)
        .getAllByRole("button")
        .map((button) => button.getAttribute("aria-label"));
      const settleIndex = labels.indexOf("Settle Hover actions");
      const snoozeIndex = labels.indexOf("Snooze Hover actions");
      const pinIndex = labels.indexOf("Pin Hover actions");
      expect(snoozeIndex).toBe(settleIndex + 1);
      expect(pinIndex).toBe(snoozeIndex + 1);
    };

    const projectRow = document.querySelector<HTMLElement>(
      '[data-thread-id="hover-actions-1"]',
    )!;
    assertActionOrder(projectRow, ".thread-row-actions");
    await user.click(
      within(projectRow).getByRole("button", { name: "Snooze Hover actions" }),
    );
    expect(
      await screen.findByRole("dialog", { name: "Snooze this thread" }),
    ).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Cancel" }));

    await user.click(screen.getByTestId("view-quick-toggle"));
    const flatRow = document.querySelector<HTMLElement>(
      '[data-thread-id="hover-actions-1"]',
    )!;
    assertActionOrder(flatRow, ".flat-row-actions");
  });

  it("keeps the archive choice dropdown on a project-view row with descendants", async () => {
    const user = userEvent.setup();
    const thread = makeThread("parent-1", "Parent thread");
    const { store } = renderSidebar([thread], {
      lineageFamilies: [{ sourceThreadId: "parent-1", descendantCount: 2 }],
    });
    store.getThreadArchiveImpact = vi.fn().mockResolvedValue({
      descendantCount: 2,
      pendingQuestions: { root: 0, descendants: 0 },
      stashedPrompts: { root: 0, descendants: 0 },
      openTasks: {
        root: { items: [], total: 0, omitted: 0 },
        descendants: { items: [], total: 0, omitted: 0 },
      },
      executionWorkspace: { kind: "direct" },
      archiveOnly: { available: true },
      archiveAll: { available: true },
    });

    const row = document.querySelector<HTMLElement>(
      '[data-thread-id="parent-1"]',
    )!;
    const archive = within(row).getByRole("button", {
      name: "Archive Parent thread",
    });
    expect(row.querySelector(".thread-row-actions")?.lastElementChild).toBe(
      archive,
    );

    await user.click(archive);

    expect(
      await screen.findByRole("menuitem", { name: "Archive only this thread" }),
    ).toBeVisible();
    expect(
      screen.getByRole("menuitem", {
        name: "Archive thread and 2 descendants",
      }),
    ).toBeVisible();
    expect(store.mutateInventory).not.toHaveBeenCalled();
  });

  it("hides the Settled shelf and settled roots in project view when Show settled is off", () => {
    seedViewPreferences({
      show: { snoozed: true, settled: false, drafts: true },
    });
    renderSidebar([
      makeThread("active-1", "Active thread"),
      makeThread("settled-1", "Settled exploration", {
        inventoryState: "settled" as const,
      }),
    ]);

    expect(document.querySelector('[data-shelf="settled"]')).toBeNull();
    expect(screen.queryByText("Settled exploration")).toBeNull();
    expect(screen.getByText("Active thread")).toBeInTheDocument();
    // The other shelves are untouched by the settled filter.
    expect(document.querySelector('[data-shelf="snoozed"]')).not.toBeNull();
    expect(document.querySelector('[data-shelf="automations"]')).not.toBeNull();
  });

  it("hides the Snoozed shelf and snoozed roots in project view when Show snoozed is off", () => {
    seedViewPreferences({
      show: { snoozed: false, settled: true, drafts: true },
    });
    renderSidebar([
      makeThread("active-1", "Active thread"),
      makeThread("snoozed-1", "Snoozed exploration", {
        inventoryState: "snoozed" as const,
      }),
    ]);

    expect(document.querySelector('[data-shelf="snoozed"]')).toBeNull();
    expect(screen.queryByText("Snoozed exploration")).toBeNull();
    expect(screen.getByText("Active thread")).toBeInTheDocument();
    expect(document.querySelector('[data-shelf="settled"]')).not.toBeNull();
    expect(document.querySelector('[data-shelf="automations"]')).not.toBeNull();
  });

  it("orders project-view workspace roots by the alpha sort axis", () => {
    seedViewPreferences({
      modes: { project: { sortBy: "alpha", direction: "asc" } },
    });
    renderSidebar([
      // Most recent activity first would put Zeta on top; alpha must not.
      makeThread("thread-zeta", "Zeta work"),
      makeThread("thread-alpha", "Alpha work", {
        lastActivityAt: isoAtNoon(-1),
        stateChangedAt: isoAtNoon(-1),
      }),
    ]);

    const ids = [
      ...document.querySelectorAll(".projects-section [data-thread-id]"),
    ].map((node) => node.getAttribute("data-thread-id"));
    expect(ids).toEqual(["thread-alpha", "thread-zeta"]);
  });

  it("applies the Projects sort axis to nested and shelf rows", () => {
    seedViewPreferences({
      modes: { project: { sortBy: "alpha", direction: "asc" } },
    });
    const automation = {
      status: "enabled" as const,
      runMode: "clone" as const,
      scheduleKind: "interval" as const,
      revision: 1,
      hasPrecheck: false,
    };
    renderSidebar(
      [
        makeThread("parent", "Parent"),
        makeThread("child-zeta", "Zeta child"),
        makeThread("child-alpha", "Alpha child"),
        makeThread("automation-zeta", "Zeta automation", { automation }),
        makeThread("automation-alpha", "Alpha automation", { automation }),
        makeThread("settled-zeta", "Zeta settled", {
          inventoryState: "settled",
        }),
        makeThread("settled-alpha", "Alpha settled", {
          inventoryState: "settled",
        }),
      ],
      {
        forkOrigins: [
          forkOrigin("child-zeta", "parent"),
          forkOrigin("child-alpha", "parent"),
        ],
        lineagePlacements: [
          nestedPlacement("child-zeta"),
          nestedPlacement("child-alpha"),
        ],
      },
    );

    const childIds = [
      ...document.querySelectorAll(
        '.projects-section [data-thread-id="parent"] .lineage-children > .lineage-list > [data-thread-id]',
      ),
    ].map((node) => node.getAttribute("data-thread-id"));
    expect(childIds).toEqual(["child-alpha", "child-zeta"]);

    for (const [shelf, expected] of [
      ["automations", ["automation-alpha", "automation-zeta"]],
      ["settled", ["settled-alpha", "settled-zeta"]],
    ] as const) {
      const ids = [
        ...document.querySelectorAll(
          `[data-shelf="${shelf}"] [data-thread-id]`,
        ),
      ].map((node) => node.getAttribute("data-thread-id"));
      expect(ids).toEqual(expected);
    }
  });

  it("excludes non-matching lineage ancestors from flat-view search results", () => {
    seedViewPreferences({ groupBy: "none", lastAltGroupBy: "none" });
    const parent = makeThread("parent-1", "Parent haystack");
    const child = makeThread("child-1", "Needle child");
    // The store appends the non-matching nested parent to visibleThreads for
    // Projects tree context; flat views must keep true matches only.
    renderSidebar([parent, child], {
      search: "needle",
      forkOrigins: [forkOrigin("child-1", "parent-1")],
      lineagePlacements: [nestedPlacement("child-1")],
    });

    expect(screen.getByText("Needle child")).toBeInTheDocument();
    expect(screen.queryByText("Parent haystack")).toBeNull();
  });

  it("merges paged lineage descendants into the timeline projection", () => {
    seedViewPreferences({ groupBy: "time", lastAltGroupBy: "time" });
    const root = makeThread("root-1", "Root thread");
    const descendant = makeThread("descendant-1", "Paged descendant");
    renderSidebar([root], {
      descendantPages: {
        "root-1": {
          descendants: [
            {
              thread: descendant,
              origin: forkOrigin("descendant-1", "root-1"),
              placement: nestedPlacement("descendant-1"),
            },
          ],
          loading: false,
          loaded: true,
        },
      },
    });

    expect(screen.getByText("Root thread")).toBeInTheDocument();
    expect(screen.getByText("Paged descendant")).toBeInTheDocument();
  });

  it("omits target names from loaded descendant rows in flat view", () => {
    seedViewPreferences({ groupBy: "none", lastAltGroupBy: "none" });
    const root = makeThread("root-1", "Root thread");
    const descendant = makeThread("descendant-1", "Paged descendant", {
      targetId: "target-2",
    });
    renderSidebar([root], {
      executionTargets: [
        {
          id: "target-1",
          environmentId: "environment-1",
          label: { text: "Pi" },
          backend: { label: { text: "Pi" }, brand: "pi" },
          workspaceExecution: { kind: "direct_only" },
          available: true,
        },
        {
          id: "target-2",
          environmentId: "environment-1",
          label: { text: "Codex" },
          backend: { label: { text: "Codex" }, brand: "codex" },
          workspaceExecution: { kind: "direct_only" },
          available: true,
        },
      ],
      descendantPages: {
        "root-1": {
          descendants: [
            {
              thread: descendant,
              origin: forkOrigin("descendant-1", "root-1"),
              placement: nestedPlacement("descendant-1"),
            },
          ],
          loading: false,
          loaded: true,
        },
      },
    });
    expect(screen.getByText("Root thread")).toBeInTheDocument();
    expect(screen.getByText("Paged descendant")).toBeInTheDocument();
    expect(screen.queryByTestId("flat-row-target")).toBeNull();
  });

  it("loads omitted descendants directly from a flat view", async () => {
    const user = userEvent.setup();
    seedViewPreferences({ groupBy: "none", lastAltGroupBy: "none" });
    const root = makeThread("root-1", "Root thread");
    const { store } = renderSidebar([root], {
      lineageFamilies: [{ sourceThreadId: root.id, descendantCount: 2 }],
    });

    await user.click(
      screen.getByRole("button", { name: "Show all runs/forks" }),
    );
    expect(store.loadMoreDescendants).toHaveBeenCalledExactlyOnceWith(root.id);
  });

  it("shows the empty state when the Show filters hide the only draft", () => {
    seedViewPreferences({
      show: { snoozed: true, settled: true, drafts: false },
    });
    renderSidebar([
      makeThread("draft-1", "Draft idea", { backingState: "unbound" }),
    ]);

    expect(screen.getByText("No active threads")).toBeInTheDocument();
    expect(screen.queryByText("Draft idea")).toBeNull();
  });

  it("refreshes relative timestamps while the sidebar is idle", async () => {
    vi.useFakeTimers();
    try {
      const now = new Date("2030-01-15T12:00:30.000Z");
      vi.setSystemTime(now);
      seedViewPreferences({ groupBy: "none", lastAltGroupBy: "none" });
      renderSidebar([
        makeThread("thread-1", "Clock thread", {
          lastActivityAt: new Date(now.getTime() - 30_000).toISOString(),
          stateChangedAt: new Date(now.getTime() - 30_000).toISOString(),
        }),
      ]);
      expect(document.querySelector(".flat-row-time")).toHaveTextContent("now");

      await act(async () => {
        await vi.advanceTimersByTimeAsync(61_000);
      });
      expect(document.querySelector(".flat-row-time")).toHaveTextContent("1m");
    } finally {
      vi.useRealTimers();
    }
  });

  it("opens peek from mouse hover and hides it on pointer leave", async () => {
    vi.useFakeTimers();
    try {
      seedViewPreferences({ groupBy: "none", lastAltGroupBy: "none" });
      renderSidebar([makeThread("thread-1", "Mouse peek")]);
      const item = document.querySelector<HTMLElement>(
        '[data-thread-id="thread-1"]',
      )!;

      fireEvent.pointerEnter(item, { pointerType: "mouse" });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(200);
      });
      expect(screen.getByTestId("thread-peek")).toBeInTheDocument();

      fireEvent.pointerLeave(item, { pointerType: "mouse" });
      expect(screen.queryByTestId("thread-peek")).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("opens peek only for keyboard-visible focus and hides it on blur", async () => {
    vi.useFakeTimers();
    try {
      seedViewPreferences({ groupBy: "none", lastAltGroupBy: "none" });
      renderSidebar([makeThread("thread-1", "Keyboard peek")]);
      const item = document.querySelector<HTMLElement>(
        '[data-thread-id="thread-1"]',
      )!;
      const link = item.querySelector<HTMLElement>(".flat-row-link")!;
      const nativeMatches = link.matches.bind(link);
      vi.spyOn(link, "matches").mockImplementation((selector) =>
        selector === ":focus-visible" ? true : nativeMatches(selector),
      );

      fireEvent.focus(link);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(200);
      });
      expect(screen.getByTestId("thread-peek")).toBeInTheDocument();

      fireEvent.blur(link);
      expect(screen.queryByTestId("thread-peek")).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("reserves touch long-press for the action sheet instead of peek", async () => {
    vi.useFakeTimers();
    try {
      seedViewPreferences({ groupBy: "none", lastAltGroupBy: "none" });
      renderSidebar([makeThread("thread-1", "Touch menu")]);
      const item = document.querySelector<HTMLElement>(
        '[data-thread-id="thread-1"]',
      )!;
      const trigger = item.querySelector<HTMLElement>(".flat-row-link")!;
      fireEvent.pointerDown(trigger, {
        pointerId: 7,
        pointerType: "touch",
        button: 0,
        clientX: 20,
        clientY: 30,
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(575);
      });
      expect(screen.queryByTestId("thread-peek")).toBeNull();
      expect(screen.getByTestId("thread-actions-sheet")).toBeInTheDocument();
      expect(screen.queryByTestId("thread-context-menu")).toBeNull();

      await act(async () => {
        await vi.advanceTimersByTimeAsync(1_500);
      });
      fireEvent.keyDown(document, { key: "Escape" });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(250);
      });
      expect(screen.queryByTestId("thread-peek")).toBeNull();

      fireEvent.pointerUp(trigger, {
        pointerId: 7,
        pointerType: "touch",
        button: 0,
        clientX: 20,
        clientY: 30,
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("never opens a peek when the full-screen mobile drawer disables it", async () => {
    vi.useFakeTimers();
    try {
      seedViewPreferences({ groupBy: "none", lastAltGroupBy: "none" });
      renderSidebar([makeThread("thread-1", "Mobile row")], {}, false);
      const item = document.querySelector<HTMLElement>(
        '[data-thread-id="thread-1"]',
      )!;
      const link = item.querySelector<HTMLElement>(".flat-row-link")!;
      const nativeMatches = link.matches.bind(link);
      vi.spyOn(link, "matches").mockImplementation((selector) =>
        selector === ":focus-visible" ? true : nativeMatches(selector),
      );

      fireEvent.pointerEnter(item, { pointerType: "mouse" });
      fireEvent.focus(link);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(500);
      });

      expect(screen.queryByTestId("thread-peek")).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});
