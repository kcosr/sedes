// @vitest-environment jsdom

import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Profiler } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  ApplicationClientState,
  ApplicationClientStore,
} from "../stores/ApplicationClientStore.js";
import {
  SIDEBAR_VIEW_DEFAULTS,
  SIDEBAR_VIEW_STORAGE_KEY,
} from "../app/sidebar-view-model.js";
import { ARCHIVE_VIEW_STORAGE_KEY } from "../archive/archive-view-preferences.js";
import { ArchivedView } from "./ArchivedView.js";
import { installThreadPanelOpenRequestListener } from "../workspace-panels/thread-panel-navigation.js";

type Snapshot = NonNullable<ApplicationClientState["snapshot"]>;
type Thread = Snapshot["threads"][number];

function resetStorage() {
  localStorage.clear();
  window.dispatchEvent(new StorageEvent("storage", { key: null }));
}

afterEach(() => {
  cleanup();
  resetStorage();
  vi.unstubAllGlobals();
});
beforeEach(() => {
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

const hoursAgo = (hours: number) =>
  new Date(Date.now() - hours * 3_600_000).toISOString();

function makeThread(
  id: string,
  title: string,
  overrides: Partial<Thread> = {},
): Thread {
  return {
    id,
    workspaceId: "ws-sedes",
    targetId: "t-codex",
    title: { text: title },
    backend: { label: { text: "Codex" }, brand: "codex" },
    backingState: "bound",
    inventoryState: "archived",
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
    runState: "idle",
    terminalSummary: { runningCount: 0, retainedCount: 0 },
    queuedInputCount: 0,
    pendingQuestionCount: 0,
    stashedPromptCount: 0,
    available: true,
    lastActivityAt: hoursAgo(5),
    stateChangedAt: hoursAgo(2),
    automation: null,
    attention: {
      wake: false,
      automationContext: null,
      unseenCompletion: false,
      queueFailure: false,
    },
    ...overrides,
  } as Thread;
}

function makeSnapshot(
  threads: readonly Thread[],
  overrides: Partial<Snapshot> = {},
): Snapshot {
  return {
    advisories: [],
    environments: [
      {
        id: "env-local",
        kind: "local",
        label: { text: "Local" },
        available: true,
        directoryBrowsing: "available",
      },
    ],
    workspaces: [
      {
        id: "ws-sedes",
        environmentId: "env-local",
        label: { text: "sedes" },
        displayPath: { text: "/src/sedes" },
        available: true,
      },
      {
        id: "ws-acme",
        environmentId: "env-local",
        label: { text: "acme-web" },
        displayPath: { text: "/src/acme-web" },
        available: true,
      },
    ],
    executionTargets: [
      {
        id: "t-codex",
        environmentId: "env-local",
        label: { text: "Codex" },
        backend: { label: { text: "Codex" }, brand: "codex" },
        workspaceExecution: { kind: "direct_only" },
        available: true,
      },
    ],
    threads: [...threads],
    forkOrigins: [],
    lineagePlacements: [],
    groups: [],
    lineageFamilies: [],
    defaultNewThreadTargetId: null,
    counts: { active: 0, snoozed: 0, settled: 0, archived: threads.length },
    tasks: [],
    ...overrides,
  } as Snapshot;
}

function createStore(snapshot: Snapshot, search = "") {
  let state: ApplicationClientState = {
    status: "ready",
    connection: "connected",
    authoritative: true,
    providerPulseEnabled: false,
    experimentalUsageEnabled: false,
    search,
    descendantPages: {},
    pendingThreadConfigurationCopySourceIds: [],
    visibleThreads: snapshot.threads,
    snapshot,
  };
  const listeners = new Set<() => void>();
  const publish = (patch: Partial<ApplicationClientState>) => {
    state = { ...state, ...patch };
    act(() => {
      for (const listener of listeners) listener();
    });
  };
  const store = {
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    getSnapshot: () => state,
    setSearch: vi.fn((next: string) => {
      state = { ...state, search: next };
      for (const listener of listeners) listener();
    }),
    mutateInventory: vi.fn(async (): Promise<void> => undefined),
  };
  return {
    store: store as typeof store & ApplicationClientStore,
    publish,
    state: () => state,
  };
}

function seedScope(patch: Record<string, unknown>) {
  localStorage.setItem(
    SIDEBAR_VIEW_STORAGE_KEY,
    JSON.stringify({ ...SIDEBAR_VIEW_DEFAULTS, ...patch }),
  );
  window.dispatchEvent(
    new StorageEvent("storage", { key: SIDEBAR_VIEW_STORAGE_KEY }),
  );
}

const rowTitles = () =>
  screen
    .queryAllByTestId("archive-row")
    .map((row) => row.querySelector(".archive-row-title")?.textContent);

describe("ArchivedView rows", () => {
  it("marks historical identities and Shift-opens the archived thread in single-panel mode", () => {
    const thread = makeThread("thread-1", "Archived work", {
      workspaceId: "workspace-1",
      targetId: "target-1",
      available: false,
      lastActivityAt: "2026-08-09T12:00:00.000Z",
      stateChangedAt: "2026-08-09T12:00:00.000Z",
    });
    const { store } = createStore(
      makeSnapshot([thread], {
        environments: [
          {
            id: "environment-1",
            kind: "local",
            label: { text: "Retired host" },
            available: false,
            directoryBrowsing: "unavailable",
          },
          {
            id: "environment-2",
            kind: "ssh",
            label: { text: "Remote" },
            available: true,
            directoryBrowsing: "available",
          },
        ],
        workspaces: [
          {
            id: "workspace-1",
            environmentId: "environment-1",
            label: { text: "sedes" },
            displayPath: { text: "/srv/sedes" },
            available: false,
          },
        ],
        executionTargets: [
          {
            id: "target-1",
            environmentId: "environment-1",
            label: { text: "Codex SSH" },
            backend: { label: { text: "Codex" }, brand: "codex" },
            workspaceExecution: { kind: "direct_only" },
            available: false,
            unavailableReason: { text: "Target retired" },
          },
        ],
      }),
    );

    const onOpen = vi.fn();
    const removeOpenListener = installThreadPanelOpenRequestListener(
      window,
      onOpen,
    );
    render(<ArchivedView store={store} />);
    const row = screen.getByTestId("archive-row");
    expect(row).toHaveTextContent("sedes");
    expect(row).not.toHaveTextContent("Local");
    expect(row).not.toHaveTextContent("Retired host");
    expect(
      within(row).getByTitle("Project and environment unavailable"),
    ).toHaveTextContent("Project and environment Unavailable");
    expect(row).toHaveTextContent("Codex SSH");
    expect(row).not.toHaveTextContent("Codex SSH · Codex");
    expect(within(row).getByTitle("Target unavailable")).toBeInTheDocument();
    // The backend brand mark, not an archive glyph, identifies the row.
    expect(within(row).getByRole("img", { name: "Codex" })).toBeInTheDocument();
    const age = row.querySelector("time")!;
    expect(age).toHaveAttribute("dateTime", "2026-08-09T12:00:00.000Z");
    const open = screen.getByRole("button", { name: "Archived work" });
    expect(open.title).toMatch(/^Archived work\nArchived .+ · Last active .+$/u);
    expect(open).toHaveAccessibleDescription(
      /sedes.*Project and environment.*Unavailable.*Codex SSH.*Target.*Unavailable.*Codex\. Archived .+ · Last active/u,
    );
    fireEvent.click(open, {
      shiftKey: true,
    });
    expect(onOpen).toHaveBeenCalledWith({
      threadId: "thread-1",
      presentation: "single",
    });
    expect(window.location.pathname).toBe("/threads/thread-1");
    removeOpenListener();
  });

  it("shows the full title, a fork control, and the worktree branch", () => {
    const longTitle =
      "Rework archived threads page so titles and details are not truncated on mobile";
    const { store } = createStore(
      makeSnapshot(
        [
          makeThread("source", "Source work", { inventoryState: "active" }),
          makeThread("fork", longTitle, {
            preferredWorktree: {
              rootId: "root-1",
              displayLabel: "sedes-wt",
              branch: "feat/archive",
              availability: "available",
            },
          } as Partial<Thread>),
        ],
        {
          forkOrigins: [
            {
              childThreadId: "fork",
              sourceThreadId: "source",
              sourceTurnId: null,
              sourceTurnCompletedAt: null,
              boundaryKind: "completed_turn_inclusive",
              originKind: "user_fork",
              initiatingAgentThreadId: null,
              initiatingToolClientId: null,
              branchMethod: "provider_native",
              createdAt: hoursAgo(3),
            },
          ],
        },
      ),
    );
    const onOpen = vi.fn();
    const removeOpenListener = installThreadPanelOpenRequestListener(
      window,
      onOpen,
    );
    render(<ArchivedView store={store} />);
    const row = screen.getByTestId("archive-row");
    expect(row.querySelector(".archive-row-open")?.getAttribute("title")).toMatch(
      new RegExp(`^${longTitle}\n`, "u"),
    );
    expect(row.querySelector(".archive-row-title")).toHaveTextContent(
      longTitle,
    );
    expect(
      screen.getByRole("button", { name: longTitle }),
    ).toHaveAccessibleDescription(/Fork of Source work/u);
    // The fork mark is its own control: it opens the fork source.
    fireEvent.click(
      within(row).getByRole("button", { name: /^Forked from “Source work”/u }),
    );
    expect(onOpen).toHaveBeenCalledWith(
      expect.objectContaining({ threadId: "source" }),
    );
    removeOpenListener();
    expect(row).toHaveTextContent("feat/archive");
    expect(row.querySelector("time")).toHaveTextContent("2h");
    const status = screen.getByTestId("archive-status");
    expect(status).toHaveTextContent("All threads");
    expect(status).toHaveTextContent("Recently archived");
  });
});

describe("ArchivedView scope and search", () => {
  const threads = [
    makeThread("s1", "Sedes alpha"),
    makeThread("s2", "Sedes beta"),
    makeThread("a1", "Acme alpha", { workspaceId: "ws-acme" }),
    makeThread("live", "Live alpha", { inventoryState: "active" }),
  ];

  it("honors the sidebar scope and clears it from the status line", async () => {
    seedScope({ projectFilterName: "acme-web" });
    const { store } = createStore(makeSnapshot(threads));
    render(<ArchivedView store={store} />);
    expect(rowTitles()).toEqual(["Acme alpha"]);
    const status = screen.getByTestId("archive-status");
    expect(status).toHaveTextContent("1 of 3");
    expect(status).toHaveTextContent("Scope: acme-web");
    expect(screen.getByTestId("archive-count")).toHaveTextContent("3");
    await userEvent
      .setup()
      .click(within(status).getByRole("button", { name: "Clear scope" }));
    expect(rowTitles()).toHaveLength(3);
    expect(
      JSON.parse(localStorage.getItem(SIDEBAR_VIEW_STORAGE_KEY)!)
        .projectFilterName,
    ).toBeNull();
    expect(
      screen.getByRole("searchbox", { name: "Search archived threads" }),
    ).toHaveFocus();
    expect(status).toHaveTextContent("All threads");
  });

  it("offers Clear scope when nothing archived is in scope", async () => {
    seedScope({ projectFilterName: "acme-web" });
    const { store } = createStore(makeSnapshot(threads.slice(0, 2)));
    render(<ArchivedView store={store} />);
    expect(screen.getByText("No archived threads in this scope")).toBeVisible();
    await userEvent
      .setup()
      .click(screen.getAllByRole("button", { name: "Clear scope" })[0]!);
    expect(rowTitles()).toEqual(["Sedes alpha", "Sedes beta"]);
  });

  it("lists only true search matches and never nested ancestors", async () => {
    const parent = makeThread("parent", "Planning");
    const child = makeThread("child", "Refactor archive page");
    const snapshot = makeSnapshot([parent, child], {
      forkOrigins: [
        {
          childThreadId: "child",
          sourceThreadId: "parent",
          sourceTurnId: null,
          sourceTurnCompletedAt: null,
          boundaryKind: "completed_turn_inclusive",
          originKind: "user_fork",
          initiatingAgentThreadId: null,
          initiatingToolClientId: null,
          branchMethod: "provider_native",
          createdAt: hoursAgo(3),
        },
      ],
      lineagePlacements: [
        {
          childThreadId: "child",
          mode: "nested_under_source",
          revision: 0,
          updatedAt: hoursAgo(3),
        },
      ],
    });
    const { store } = createStore(snapshot, "refactor");
    render(<ArchivedView store={store} />);
    expect(rowTitles()).toEqual(["Refactor archive page"]);
    const status = screen.getByTestId("archive-status");
    expect(status).toHaveTextContent("1 of 2");
    expect(status).toHaveTextContent("matching “refactor”");
    // Search is shared with the sidebar.
    const input = screen.getByRole("searchbox", {
      name: "Search archived threads",
    });
    fireEvent.change(input, { target: { value: "nothing" } });
    expect(store.setSearch).toHaveBeenLastCalledWith("nothing");
    expect(screen.getByText("No matching archived threads")).toBeVisible();
    await userEvent
      .setup()
      .click(screen.getByRole("button", { name: "Clear search" }));
    expect(store.setSearch).toHaveBeenLastCalledWith("");
    expect(rowTitles()).toHaveLength(2);
    expect(input).toHaveFocus();
  });

  it("explains an empty archive", () => {
    const { store } = createStore(makeSnapshot([threads[3]!]));
    render(<ArchivedView store={store} />);
    expect(screen.getByText("No archived threads")).toBeVisible();
    expect(screen.queryByTestId("archive-row")).toBeNull();
  });
});

describe("ArchivedView restore", () => {
  const threads = [
    makeThread("t1", "First", { stateChangedAt: hoursAgo(1) }),
    makeThread("t2", "Second", { stateChangedAt: hoursAgo(2) }),
    makeThread("t3", "Third", { stateChangedAt: hoursAgo(3) }),
  ];

  it("shows progress, then moves focus to the next row and announces it", async () => {
    const snapshot = makeSnapshot(threads);
    const { store, publish } = createStore(snapshot);
    let accept!: () => void;
    store.mutateInventory.mockImplementation(
      () => new Promise<void>((resolve) => (accept = resolve)),
    );
    render(<ArchivedView store={store} />);
    const restore = screen.getByRole("button", { name: "Restore Second" });
    restore.focus();
    fireEvent.click(restore);
    expect(store.mutateInventory).toHaveBeenCalledWith(threads[1], "restore");
    expect(restore).toHaveAttribute("aria-disabled", "true");
    fireEvent.click(restore);
    expect(store.mutateInventory).toHaveBeenCalledTimes(1);
    await act(async () => accept());
    expect(screen.getByRole("status")).toHaveTextContent("Restored Second");
    // Still listed until the stream reports the restore.
    expect(restore).toHaveAttribute("aria-disabled", "true");
    publish({
      snapshot: {
        ...snapshot,
        threads: [
          threads[0]!,
          { ...threads[1]!, inventoryState: "active" },
          threads[2]!,
        ],
      },
    });
    expect(rowTitles()).toEqual(["First", "Third"]);
    expect(document.activeElement).toHaveClass("archive-row-open");
    expect(document.activeElement).toHaveTextContent("Third");
  });

  it("falls back to the previous row, then the search", async () => {
    const snapshot = makeSnapshot(threads.slice(0, 2));
    const { store, publish } = createStore(snapshot);
    render(<ArchivedView store={store} />);
    fireEvent.click(screen.getByRole("button", { name: "Restore Second" }));
    await act(async () => undefined);
    publish({
      snapshot: {
        ...snapshot,
        threads: [threads[0]!, { ...threads[1]!, inventoryState: "active" }],
      },
    });
    expect(document.activeElement).toHaveTextContent("First");
    fireEvent.click(screen.getByRole("button", { name: "Restore First" }));
    await act(async () => undefined);
    publish({
      snapshot: {
        ...snapshot,
        threads: [
          { ...threads[0]!, inventoryState: "active" },
          { ...threads[1]!, inventoryState: "active" },
        ],
      },
    });
    expect(
      screen.getByRole("searchbox", { name: "Search archived threads" }),
    ).toHaveFocus();
  });

  it("ignores a late restore response once the row has changed", async () => {
    const snapshot = makeSnapshot(threads);
    const { store, publish } = createStore(snapshot);
    let accept!: () => void;
    store.mutateInventory.mockImplementation(
      () => new Promise<void>((resolve) => (accept = resolve)),
    );
    render(<ArchivedView store={store} />);
    fireEvent.click(screen.getByRole("button", { name: "Restore Second" }));
    // The stream reports the restore, then another client archives the
    // thread again, before this response arrives.
    publish({
      snapshot: {
        ...snapshot,
        threads: [
          threads[0]!,
          { ...threads[1]!, inventoryState: "active", inventoryRevision: 2 },
          threads[2]!,
        ],
      },
    });
    publish({
      snapshot: {
        ...snapshot,
        threads: [
          threads[0]!,
          { ...threads[1]!, inventoryRevision: 3 },
          threads[2]!,
        ],
      },
    });
    await act(async () => accept());
    expect(
      screen.getByRole("button", { name: "Restore Second" }),
    ).not.toHaveAttribute("aria-disabled");
  });

  it("treats a Restore accepted from the actions menu like the row's own", async () => {
    const snapshot = makeSnapshot(threads);
    const { store, publish } = createStore(snapshot);
    render(<ArchivedView store={store} />);
    const row = screen
      .getAllByTestId("archive-row")
      .find((candidate) => candidate.textContent?.includes("Second"))!;
    fireEvent.contextMenu(row);
    await userEvent
      .setup()
      .click(await screen.findByRole("menuitem", { name: "Restore to Active" }));
    expect(store.mutateInventory).toHaveBeenCalledWith(threads[1], "restore");
    expect(screen.getByRole("status")).toHaveTextContent("Restored Second");
    expect(
      screen.getByRole("button", { name: "Restore Second" }),
    ).toHaveAttribute("aria-disabled", "true");
    publish({
      snapshot: {
        ...snapshot,
        threads: [
          threads[0]!,
          { ...threads[1]!, inventoryState: "active", inventoryRevision: 2 },
          threads[2]!,
        ],
      },
    });
    expect(rowTitles()).toEqual(["First", "Third"]);
  });

  it("reports a failed restore inline without a pop-up", async () => {
    const { store } = createStore(makeSnapshot(threads));
    store.mutateInventory.mockRejectedValueOnce(
      new Error("Inventory revision changed."),
    );
    render(<ArchivedView store={store} />);
    const restore = screen.getByRole("button", { name: "Restore Third" });
    fireEvent.click(restore);
    await act(async () => undefined);
    const alert = screen.getByRole("alert");
    expect(alert).toHaveTextContent("Couldn’t restore Third");
    expect(alert).toHaveTextContent("Inventory revision changed.");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(restore).not.toHaveAttribute("aria-disabled");
    fireEvent.click(restore);
    await act(async () => undefined);
    expect(store.mutateInventory).toHaveBeenCalledTimes(2);
    expect(screen.queryByRole("alert")).toBeNull();
  });
});

describe("ArchivedView paging and view options", () => {
  const many = Array.from({ length: 150 }, (_, index) =>
    makeThread(`t${String(index).padStart(3, "0")}`, `Thread ${index}`, {
      stateChangedAt: hoursAgo(1 + index / 100),
    }),
  );

  it("renders 100 rows, appends more on request, and resets on search", async () => {
    const { store } = createStore(makeSnapshot(many));
    render(<ArchivedView store={store} />);
    expect(screen.getAllByTestId("archive-row")).toHaveLength(100);
    // Group headers count the whole group, not just the rendered page.
    expect(screen.getByRole("heading", { level: 2 })).toHaveTextContent(
      "Today · 150",
    );
    const more = screen.getByRole("button", {
      name: "Show 50 more · 50 remaining",
    });
    await userEvent.setup().click(more);
    expect(screen.getAllByTestId("archive-row")).toHaveLength(150);
    expect(screen.queryByTestId("archive-show-more")).toBeNull();
    fireEvent.change(screen.getByRole("searchbox"), {
      target: { value: "Thread" },
    });
    expect(screen.getAllByTestId("archive-row")).toHaveLength(100);
    // Returning to the earlier listing starts from its first page too.
    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "" } });
    expect(screen.getAllByTestId("archive-row")).toHaveLength(100);
  });

  it("moves keyboard focus to the first added row when the last page loads", async () => {
    const { store } = createStore(makeSnapshot(many));
    render(<ArchivedView store={store} />);
    const more = screen.getByTestId("archive-show-more");
    more.focus();
    await userEvent.setup().keyboard("{Enter}");
    expect(screen.queryByTestId("archive-show-more")).toBeNull();
    expect(document.activeElement).toHaveClass("archive-row-open");
    expect(document.activeElement).toHaveTextContent("Thread 100");
  });

  it("sorts and groups from View options and remembers the choice", async () => {
    const user = userEvent.setup();
    const threads = [
      makeThread("b", "beta", {
        stateChangedAt: hoursAgo(1),
        lastActivityAt: hoursAgo(50),
      }),
      makeThread("a", "Alpha", {
        workspaceId: "ws-acme",
        stateChangedAt: hoursAgo(30),
        lastActivityAt: hoursAgo(1),
      }),
      makeThread("c", "Charlie", {
        stateChangedAt: hoursAgo(2),
        lastActivityAt: hoursAgo(2),
      }),
    ];
    const { store } = createStore(makeSnapshot(threads));
    render(<ArchivedView store={store} />);
    expect(rowTitles()).toEqual(["beta", "Charlie", "Alpha"]);
    expect(
      screen
        .getAllByRole("heading", { level: 2 })
        .map((heading) => heading.textContent),
    ).toEqual(["Today · 2", "Yesterday · 1"]);

    await user.click(screen.getByRole("button", { name: "View options" }));
    await user.click(
      screen.getByRole("menuitemradio", { name: "Last active" }),
    );
    expect(rowTitles()).toEqual(["Alpha", "Charlie", "beta"]);

    await user.click(screen.getByRole("button", { name: "View options" }));
    await user.click(screen.getByRole("menuitemradio", { name: "Title" }));
    expect(rowTitles()).toEqual(["Alpha", "beta", "Charlie"]);
    // Title order has no date grouping.
    expect(screen.queryAllByRole("heading", { level: 2 })).toHaveLength(0);

    await user.click(screen.getByRole("button", { name: "View options" }));
    const dateOption = screen.getByRole("menuitemradio", { name: /Date/ });
    expect(dateOption).toHaveAttribute("aria-disabled", "true");
    expect(screen.getByRole("menuitemradio", { name: "None" })).toHaveAttribute(
      "aria-checked",
      "true",
    );
    await user.click(screen.getByRole("menuitemradio", { name: "Project" }));
    expect(
      screen
        .getAllByRole("heading", { level: 2 })
        .map((heading) => heading.textContent),
    ).toEqual(["acme-web · 1", "sedes · 2"]);
    // The heading names the project, so rows do not repeat it.
    expect(screen.getAllByTestId("archive-row")[0]).not.toHaveTextContent(
      "acme-web",
    );
    expect(JSON.parse(localStorage.getItem(ARCHIVE_VIEW_STORAGE_KEY)!)).toEqual(
      {
        version: 1,
        sort: "title",
        groupBy: "project",
      },
    );
  });
});

describe("ArchivedView render isolation", () => {
  it("does not re-render for events that leave the archive unchanged", () => {
    const threads = [
      makeThread("a", "Archived A"),
      makeThread("live", "Live thread", { inventoryState: "active" }),
    ];
    const snapshot = makeSnapshot(threads);
    const { store, publish } = createStore(snapshot);
    const commits = vi.fn();
    render(
      <Profiler id="archive" onRender={commits}>
        <ArchivedView store={store} />
      </Profiler>,
    );
    commits.mockClear();
    // A re-parsed snapshot with equal values (new object identities).
    publish({ snapshot: structuredClone(snapshot) });
    // An active thread starts running; the connection flickers.
    const running = structuredClone(snapshot);
    running.threads[1] = { ...running.threads[1]!, runState: "running" };
    publish({ snapshot: running, connection: "reconnecting" });
    expect(commits).not.toHaveBeenCalled();
    // An archived thread's title is archive state.
    const renamed = structuredClone(running);
    renamed.threads[0] = { ...renamed.threads[0]!, title: { text: "Renamed" } };
    publish({ snapshot: renamed });
    expect(commits).toHaveBeenCalled();
    expect(rowTitles()).toEqual(["Renamed"]);
  });
});
