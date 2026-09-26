// @vitest-environment jsdom

import { OperationOverlayHost } from "../../operations/OperationOverlay.js";
vi.mock("../../operations/thread-readiness.js", () => ({ waitForOperationThreadReady: vi.fn(async () => undefined), setOperationThreadRegistry: vi.fn() }));

import { getBlockingOperation } from "../../operations/blocking-operation.js";

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
import type {
  NormalizedThreadSnapshot,
} from "../../../shared/index.js";
import type {
  ApplicationClientState,
  ApplicationClientStore,
} from "../../stores/ApplicationClientStore.js";
import type { ThreadClientStore } from "../../stores/ThreadClientStore.js";
import { UsageQueryCache } from "../../stores/UsageQueryCache.js";
import type { PanelChromeControls } from "../../workspace-panels/PanelChrome.js";
import { setEnvironmentColorsEnabled } from "../../app/environment-palette.js";
import { ThreadHeader } from "./ThreadHeader.js";
import {
  CONNECTION_INDICATOR_DELAY_MILLISECONDS,
} from "../../app/use-delayed-connection-status.js";

beforeEach(() => {
  render(<OperationOverlayHost />);
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe(): void {}
      disconnect(): void {}
      unobserve(): void {}
    },
  );
  vi.stubGlobal(
    "matchMedia",
    vi.fn(() => ({
      matches: false,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })),
  );
});

afterEach(() => {
  getBlockingOperation()?.cancel();
  cleanup();
  vi.useRealTimers();
  localStorage.clear();
  vi.unstubAllGlobals();
  window.history.replaceState(null, "", "/");
});

function makeSnapshot({
  renameAvailable = false,
  brand,
  backingState = "bound",
  runState = "idle",
  available = true,
  environmentKind = "ssh",
  automation = false,
}: {
  readonly automation?: boolean;
  readonly renameAvailable?: boolean;
  readonly brand?: "pi" | "codex" | "claude";
  readonly backingState?: "bound" | "unbound";
  readonly available?: boolean;
  readonly environmentKind?: "local" | "ssh";
  readonly runState?:
    "idle" | "running" | "failed" | "reconciling" | "disconnected";
} = {}): NormalizedThreadSnapshot {
  return {
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
      backingState,
      inventoryState: "active",
      inventoryRevision: 1,
      threadRevision: 1,
      runState,
      queuedInputCount: 0,
      available,
      lastActivityAt: "2026-07-30T15:00:00.000Z",
      stateChangedAt: "2026-07-30T15:00:00.000Z",
      automation: automation ? { status: "enabled" } : null,
    },
    executionWorkspace: { kind: "direct" },
    workspace: {
      id: "workspace-1",
      environmentId: "environment-1",
      label: { text: "sedes" },
      displayPath: { text: "/workspace" },
      available: true,
    },
    environment: {
      id: "environment-1",
      kind: environmentKind,
      label: { text: environmentKind === "local" ? "Local" : "Machine" },
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
      presentation: { surface: "cli", mode: "progressive" },
      presentationOptions: [
        { surface: "cli", modes: ["progressive", "individual"] },
      ],
      revision: 0,
    },
    runState,
    usage: {},
    capabilities: {
      revision: "capability-fixture",
      backend: { label: { text: "Pi" }, ...(brand ? { brand } : {}) },
      interactionMode: "interactive",
      runState,
      operations: [
        ...(renameAvailable
          ? [{ id: "rename", label: { text: "Rename" }, available: true }]
          : []),
        ...(backingState === "unbound"
          ? [
              {
                id: "move_draft",
                label: { text: "Move draft" },
                available: true,
              },
            ]
          : []),
      ],
      deliveryModes: [],
      settings: [],
      composerActions: [],
      interactions: [],
      providerFeatures: [],
      automation: { available: automation },
    },
  } as unknown as NormalizedThreadSnapshot;
}

function fixture(
  environmentCount: number,
  options: {
    readonly environmentKind?: "local" | "ssh";
    readonly forkOrigins?: readonly {
      readonly childThreadId: string;
      readonly sourceThreadId: string;
    }[];
  } = {},
): {
  readonly applicationStore: ApplicationClientStore & {
    createThreadFromSettings: ReturnType<typeof vi.fn>;
    getThreadForceResetImpact: ReturnType<typeof vi.fn>;
    forceResetThread: ReturnType<typeof vi.fn>;
  };
  readonly threadStore: ThreadClientStore;
} {
  const environmentKind = options.environmentKind ?? "ssh";
  const applicationState: ApplicationClientState = {
    status: "ready",
    connection: "connected",
    authoritative: true,
    search: "",
    descendantPages: {},
    pendingThreadConfigurationCopySourceIds: [],
    snapshot: {
      environments: Array.from({ length: environmentCount }, (_, index) => ({
        id: `environment-${index + 1}`,
        kind: index === 0 ? environmentKind : "ssh",
        label: {
          text:
            index === 0 && environmentKind === "local"
              ? "Local"
              : `Machine ${index + 1}`,
        },
        available: true,
      })),
      workspaces:
        environmentCount === 0
          ? []
          : [
              {
                id: "workspace-1",
                environmentId: "environment-1",
                label: { text: "sedes" },
                displayPath: { text: "/workspace" },
                available: true,
              },
              {
                id: "workspace-2",
                environmentId: "environment-1",
                label: { text: "second" },
                displayPath: { text: "/second" },
                available: true,
              },
            ],
      threads: [],
      forkOrigins: options.forkOrigins ?? [],
      lineagePlacements: [],
      lineageFamilies: [],
      executionTargets: [],
      defaultNewThreadTargetId: null,
      counts: { active: 1, snoozed: 0, settled: 0, archived: 0 },
      tasks: [],
    },
    visibleThreads: [],
  } as unknown as ApplicationClientState;
  const applicationStore = {
    api: {
      listWorkspaceFileRoots: vi.fn(async () => ({
        roots: [
          {
            kind: "primary",
            rootId: "primary",
            displayLabel: "Primary",
            displayPath: { text: "/workspace" },
            availability: "available",
            watchable: true,
            sortOrder: 0,
            revision: 0,
          },
        ],
      })),
      updateThreadPreferredWorktree: vi.fn(),
      deleteLinkedWorktree: vi.fn(),
    },
    subscribe: () => () => undefined,
    getSnapshot: () => applicationState,
    createThreadFromSettings: vi.fn(async () => ({
      threadId: "thread-copy",
      workspaceId: "workspace-1",
      targetId: "target-1",
    })),
    mutateInventory: vi.fn(async () => undefined),
    getThreadForceResetImpact: vi.fn(async () => ({
      blockerFingerprint: "a".repeat(64),
      resettable: true,
      blockers: [{ kind: "conversation_operation", count: 1 }],
      affectedThreadIds: ["thread-1"],
      warnings: [],
      backgroundActivity: { agents: 0, commands: 0, other: 0, unknownThreads: 0 },
    })),
    forceResetThread: vi.fn(async () => undefined),
  } as unknown as ApplicationClientStore & {
    createThreadFromSettings: ReturnType<typeof vi.fn>;
    getThreadForceResetImpact: ReturnType<typeof vi.fn>;
    forceResetThread: ReturnType<typeof vi.fn>;
  };
  const threadStore = {
    usage: new UsageQueryCache("thread", {getUsage: vi.fn(), getUsageAvailability: vi.fn()}),
    subscribe: () => () => undefined,
    getSnapshot: () => undefined,
    perform: vi.fn(async () => undefined),
    forkTurn: vi.fn(),
    forkLatestProviderSnapshot: vi.fn(),
  } as unknown as ThreadClientStore;
  return { applicationStore, threadStore };
}

function renderHeader({
  environmentCount = 0,
  environmentKind = "ssh",
  backingState = "bound",
  renameAvailable = false,
  connection = "connected",
  brand,
  runState = "idle",
  withPanelControls = false,
  available = true,
  forkOrigins,
  automation = false,
  findOpen = false,
  onFindOpenChange = vi.fn(),
}: {
  readonly automation?: boolean;
  readonly findOpen?: boolean;
  readonly onFindOpenChange?: (open: boolean) => void;
  readonly environmentCount?: number;
  readonly environmentKind?: "local" | "ssh";
  readonly backingState?: "bound" | "unbound";
  readonly renameAvailable?: boolean;
  readonly connection?: "connected" | "reconnecting" | "disconnected";
  readonly brand?: "pi" | "codex" | "claude";
  readonly withPanelControls?: boolean;
  readonly available?: boolean;
  readonly forkOrigins?: readonly {
    readonly childThreadId: string;
    readonly sourceThreadId: string;
  }[];
  readonly runState?:
    "idle" | "running" | "failed" | "reconciling" | "disconnected";
} = {}) {
  const { applicationStore, threadStore } = fixture(environmentCount, {
    environmentKind,
    ...(forkOrigins === undefined ? {} : { forkOrigins }),
  });
  const panelControls: PanelChromeControls | undefined = withPanelControls
    ? {
        onCollapse: vi.fn(),
        onClose: vi.fn(),
        onDock: vi.fn(),
      }
    : undefined;
  const view = render(
    <ThreadHeader
      store={threadStore}
      applicationStore={applicationStore}
      snapshot={makeSnapshot({
        automation,
        renameAvailable,
        brand,
        backingState,
        runState,
        available,
        environmentKind,
      })}
      connection={connection}
      authoritative
      forkAttempts={{}}
      actionPending={false}
      bookmarks={[]}
      bookmarkRevision={0}
      bookmarkStatus="ready"
      pendingBookmarkTurnIds={[]}
      onSelectBookmarkTurn={vi.fn()}
      panelControls={panelControls}
      findOpen={findOpen}
      findButtonRef={{ current: null }}
      onFindOpenChange={onFindOpenChange}
    />,
  );
  return { ...view, applicationStore, panelControls };
}

describe("ThreadHeader panel chrome", () => {
  it("colors Chat by its environment only when environments are distinguishable", () => {
    renderHeader({ environmentCount: 2 });
    const tinted = screen.getByRole("banner", { name: "Chat panel header" });
    expect(tinted).toHaveAttribute("data-environment-tint", "true");
    expect(tinted.style.getPropertyValue("--environment-hue")).not.toBe("");
    expect(tinted.style.getPropertyValue("--environment-chroma")).not.toBe("");

    cleanup();
    setEnvironmentColorsEnabled(false);
    renderHeader({ environmentCount: 2 });
    expect(
      screen.getByRole("banner", { name: "Chat panel header" }),
    ).not.toHaveAttribute("data-environment-tint");

    cleanup();
    setEnvironmentColorsEnabled(true);
    renderHeader({ environmentCount: 1 });
    expect(
      screen.getByRole("banner", { name: "Chat panel header" }),
    ).not.toHaveAttribute("data-environment-tint");
  });

  it("puts thread-specific actions before the shared panel controls", () => {
    const { container } = renderHeader({
      withPanelControls: true,
      brand: "pi",
    });

    const header = screen.getByRole("banner", { name: "Chat panel header" });
    expect(header).toHaveClass("workspace-panel-chrome", "thread-header");
    expect(
      screen.getByRole("button", { name: "Collapse Chat panel" }),
    ).toBeVisible();
    expect(
      screen.getByRole("button", { name: "Chat panel actions" }),
    ).toBeVisible();
    expect(
      screen.getByRole("button", { name: "Close Chat panel" }),
    ).toBeVisible();

    const threadActions = screen.getByRole("button", {
      name: "Thread actions",
    });
    expect(threadActions.querySelector(".lucide-settings-2")).not.toBeNull();
    expect(threadActions.querySelector(".lucide-ellipsis")).toBeNull();
    expect(
      threadActions.compareDocumentPosition(
        screen.getByRole("button", { name: "Collapse Chat panel" }),
      ),
    ).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
    expect(header.querySelector(".thread-panel-identity")).toBeNull();
    expect(header.querySelector(".thread-panel-brand svg")).not.toBeNull();
    expect(header).not.toHaveTextContent("Chat");
    expect(screen.getByTestId("thread-heading").children).toHaveLength(2);
    const specificActions = container.querySelector(
      ".workspace-panel-specific-actions",
    );
    const commonActions = container.querySelector(".workspace-panel-actions");
    expect(specificActions?.compareDocumentPosition(commonActions!)).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    );
  });

  it("exposes find expanded state without application-level tools", () => {
    const onFindOpenChange = vi.fn();
    const { applicationStore, threadStore } = fixture(0);
    const { container, rerender } = render(
      <ThreadHeader
        store={threadStore}
        applicationStore={applicationStore}
        snapshot={makeSnapshot()}
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
        onFindOpenChange={onFindOpenChange}
      />,
    );
    const find = screen.getByRole("button", { name: "Find in thread" });
    expect(screen.queryByTestId("tasks-panel-toggle")).toBeNull();
    expect(screen.queryByRole("button", { name: /Terminals|Workpads|Files panel/ })).toBeNull();
    expect(find).toHaveAttribute("aria-expanded", "false");

    fireEvent.click(find);
    expect(onFindOpenChange).toHaveBeenCalledWith(true);

    rerender(
      <ThreadHeader
        store={threadStore}
        applicationStore={applicationStore}
        snapshot={makeSnapshot()}
        connection="connected"
        authoritative
        forkAttempts={{}}
        actionPending={false}
        bookmarks={[]}
        bookmarkRevision={0}
        bookmarkStatus="ready"
        pendingBookmarkTurnIds={[]}
        onSelectBookmarkTurn={vi.fn()}
        findOpen
        findButtonRef={{ current: null }}
        onFindOpenChange={onFindOpenChange}
      />,
    );
    expect(
      container.querySelector<HTMLButtonElement>(".thread-find-trigger"),
    ).toHaveAttribute("aria-expanded", "true");
  });

  it.each([false, true])("keeps mobile bookmarks, settings, and available automation before the toolbar toggle (automation: %s)", (automation) => {
    vi.stubGlobal(
      "matchMedia",
      vi.fn((query: string) => ({
        matches: query.includes("max-width: 819px"),
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      })),
    );
    renderHeader({ automation, withPanelControls: true });

    const toolbar = screen.getByTestId("thread-controls");
    expect(
      within(screen.getByTestId("thread-context")).queryByRole("button", {
        name: /Thread worktree:/,
      }),
    ).toBeNull();
    const toggle = screen.getByRole("button", { name: "Show thread toolbar" });
    const bookmarks = screen.getByRole("button", { name: "Bookmarks" });
    const settings = screen.getByRole("button", { name: "Thread actions" });
    const collapse = screen.getByRole("button", { name: "Collapse Chat panel" });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(toolbar).toHaveAttribute("hidden");
    expect(bookmarks).toBeVisible();
    expect(settings).toBeVisible();
    expect(toolbar).not.toContainElement(bookmarks);
    expect(toolbar).not.toContainElement(settings);
    const actions = [bookmarks];
    if (automation) {
      const automationButton = screen.getByRole("button", { name: "Automation settings" });
      expect(automationButton).toBeVisible();
      expect(toolbar).not.toContainElement(automationButton);
      actions.push(automationButton);
    } else {
      expect(screen.queryByRole("button", { name: "Automation settings" })).toBeNull();
    }
    actions.push(settings, toggle, collapse);
    for (let index = 1; index < actions.length; index += 1) {
      expect(actions[index - 1]!.compareDocumentPosition(actions[index]!)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
    }

    fireEvent.click(toggle);
    expect(screen.getByRole("button", { name: "Hide thread toolbar" })).toHaveAttribute("aria-expanded", "true");
    expect(toolbar).not.toHaveAttribute("hidden");
    const find = within(toolbar).getByRole("button", { name: "Find in thread" });
    const worktree = within(toolbar).getByRole("button", { name: "Thread worktree: Primary" });
    expect(find.compareDocumentPosition(worktree)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
    expect(within(toolbar).getAllByRole("button")).toHaveLength(2);
    fireEvent.click(screen.getByRole("button", { name: "Hide thread toolbar" }));
    expect(toolbar).toHaveAttribute("hidden");
    expect(bookmarks).toBeVisible();
    expect(settings).toBeVisible();
  });

  it("reveals the narrow toolbar for a find request and closes find when collapsing it", () => {
    vi.stubGlobal(
      "matchMedia",
      vi.fn((query: string) => ({
        matches: query.includes("max-width: 819px"),
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      })),
    );
    const onFindOpenChange = vi.fn();
    renderHeader({ findOpen: true, onFindOpenChange });
    expect(screen.getByTestId("thread-controls")).not.toHaveAttribute("hidden");
    expect(screen.getByRole("button", { name: "Find in thread" })).toHaveAttribute("aria-expanded", "true");
    fireEvent.click(screen.getByRole("button", { name: "Hide thread toolbar" }));
    expect(onFindOpenChange).toHaveBeenCalledWith(false);
    expect(screen.getByTestId("thread-controls")).toHaveAttribute("hidden");
  });


});

describe("ThreadHeader backend brand mark", () => {
  it("renders the Pi mark beside both detail rows, titled by the backend label", () => {
    const { container } = renderHeader({ brand: "pi" });

    const titleRow = container.querySelector(".thread-title-row");
    const mark = container.querySelector(".thread-panel-brand");
    const heading = container.querySelector(".thread-heading");
    expect(mark).not.toBeNull();
    expect(mark).toHaveAttribute("title", "Pi");
    expect(mark?.querySelector("svg")).toHaveAttribute(
      "viewBox",
      "47.93 165.29 704.15 586.79",
    );
    expect(
      [...(mark?.querySelectorAll("path") ?? [])].map((path) =>
        path.getAttribute("fill"),
      ),
    ).toEqual(["#5B7190", "#A54E39", "#DE9851", "#A8AA7C"]);
    expect(mark?.compareDocumentPosition(heading!)).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    );
    expect(titleRow?.querySelector(".thread-panel-brand")).toBeNull();
  });

  it("renders the Codex mark for the codex brand", () => {
    const { container } = renderHeader({ brand: "codex" });

    const mark = container.querySelector(".thread-panel-brand svg");
    expect(mark).toHaveAttribute("viewBox", "0 0 256 260");
  });

  it("renders the Claude mark for the claude brand", () => {
    const { container } = renderHeader({ brand: "claude" });

    const mark = container.querySelector(".thread-panel-brand svg");
    expect(mark).toHaveAttribute("viewBox", "0 0 256 257");
    expect(mark).toHaveAttribute("fill", "#D97757");
  });

  it("renders nothing when the backend advertises no brand", () => {
    const { container } = renderHeader();

    const titleRow = container.querySelector(".thread-title-row");
    expect(container.querySelector(".thread-panel-brand")).toBeNull();
    // No placeholder gap: the title remains the first element.
    expect(titleRow?.firstElementChild?.textContent).toBe("Header thread");
  });
});

describe("ThreadHeader project context row", () => {
  it("keeps mobile project and environment context while moving the target into settings", () => {
    vi.stubGlobal("matchMedia", vi.fn((query: string) => ({
      matches: query.includes("max-width: 819px"),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })));
    const viewport = Object.assign(new EventTarget(), { height: window.innerHeight, offsetTop: 0 });
    vi.stubGlobal("visualViewport", viewport);
    renderHeader({ environmentCount: 2, brand: "pi" });
    const project = screen.getByTestId("thread-context");
    expect(project).toHaveTextContent("sedes · Machine 1");
    expect(project).toHaveAttribute("title", "sedes · Machine 1");
    expect(screen.queryByTestId("thread-target-context")).toBeNull();
    expect(document.querySelector(".thread-panel-brand")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Thread actions" }));
    expect(screen.getByTestId("thread-settings-sheet")).toHaveTextContent("Execution target: Pi");
    act(() => {
      viewport.height = window.innerHeight - 300;
      viewport.dispatchEvent(new Event("resize"));
    });
    expect(screen.getByTestId("thread-settings-sheet").style.getPropertyValue("--thread-settings-keyboard-inset")).toBe("300px");
  });

  it("exposes the thread worktree without discovering until the picker opens", async () => {
    const { applicationStore } = renderHeader();

    const trigger = screen.getByRole("button", {
      name: "Thread worktree: Primary",
    });
    expect(trigger).toBeVisible();
    expect(applicationStore.api.listWorkspaceFileRoots).not.toHaveBeenCalled();

    fireEvent.click(trigger);
    await waitFor(() =>
      expect(applicationStore.api.listWorkspaceFileRoots).toHaveBeenCalledWith(
        "workspace-1",
      ),
    );
  });

  it("renders the workspace label with a folder icon and no chip styling hooks", () => {
    const { container } = renderHeader();

    const project = screen.getByTestId("thread-context");
    expect(project).toHaveClass("thread-project");
    expect(project).toHaveTextContent("sedes");
    expect(project).toHaveAttribute("title", "sedes · Pi");
    expect(screen.getByTestId("thread-target-context")).toHaveTextContent("Pi");
    expect(project.querySelector("svg")).not.toBeNull();
    // The old badge/chip format is gone entirely.
    expect(container.querySelector(".ws-chip")).toBeNull();
    expect(container.querySelector(".ws-chip-label")).toBeNull();
  });

  it("omits the environment suffix when only one environment exists", () => {
    renderHeader({ environmentCount: 1 });

    const project = screen.getByTestId("thread-context");
    expect(project).toHaveTextContent("sedes");
    expect(project).not.toHaveTextContent("Machine");
    expect(project).toHaveAttribute("title", "sedes · Pi");
  });

  it("appends the environment label when multiple environments exist", () => {
    renderHeader({ environmentCount: 2 });

    const project = screen.getByTestId("thread-context");
    expect(project.querySelector(".thread-project-name")).toHaveTextContent(
      "sedes · Machine 1",
    );
    expect(screen.getByTestId("thread-target-context")).toHaveTextContent("Pi");
    expect(project).toHaveAttribute("title", "sedes · Machine 1 · Pi");
  });

  it("omits the Local environment label between project and backend", () => {
    renderHeader({ environmentCount: 2, environmentKind: "local" });

    const project = screen.getByTestId("thread-context");
    expect(project.querySelector(".thread-project-name")).toHaveTextContent(
      "sedes",
    );
    expect(project).not.toHaveTextContent("Local");
    expect(screen.getByTestId("thread-target-context")).toHaveTextContent("Pi");
    expect(project).toHaveAttribute("title", "sedes · Pi");
  });

  it("omits Local from draft workspace choices while retaining remote qualifiers", () => {
    renderHeader({
      backingState: "unbound",
      environmentCount: 2,
      environmentKind: "local",
    });
    fireEvent.click(screen.getByRole("button", { name: "Thread actions" }));
    fireEvent.click(screen.getByRole("combobox", { name: "Draft workspace" }));

    const localChoices = screen.getAllByRole("option");
    expect(localChoices.map(({ textContent }) => textContent)).toEqual([
      "sedes",
      "second",
    ]);

    cleanup();
    renderHeader({
      backingState: "unbound",
      environmentCount: 2,
      environmentKind: "ssh",
    });
    fireEvent.click(screen.getByRole("button", { name: "Thread actions" }));
    fireEvent.click(screen.getByRole("combobox", { name: "Draft workspace" }));

    expect(
      screen.getAllByRole("option").map(({ textContent }) => textContent),
    ).toEqual(["sedes · Machine 1", "second · Machine 1"]);
  });

  it("does not render a fork provenance icon for forked threads", () => {
    const { container } = renderHeader({
      forkOrigins: [
        { childThreadId: "thread-1", sourceThreadId: "thread-source" },
      ],
    });

    expect(container.querySelector(".thread-provenance")).toBeNull();
    expect(container.querySelector(".fork-split-icon")).toBeNull();
    expect(screen.queryByRole("button", { name: /Forked from/ })).toBeNull();
  });

  it("keeps a healthy per-thread connection silent", () => {
    const { container } = renderHeader({ connection: "connected" });

    expect(container.querySelector(".connection-dot")).toBeNull();
  });

  it("delays a non-healthy per-thread connection dot on the title row", () => {
    vi.useFakeTimers();
    const { container } = renderHeader({ connection: "reconnecting" });

    const titleRow = container.querySelector(".thread-title-row");
    expect(titleRow).not.toBeNull();
    expect(titleRow!.querySelector(".connection-dot")).toBeNull();
    act(() => {
      vi.advanceTimersByTime(CONNECTION_INDICATOR_DELAY_MILLISECONDS - 1);
    });
    expect(titleRow!.querySelector(".connection-dot")).toBeNull();

    act(() => vi.advanceTimersByTime(1));
    const dot = titleRow!.querySelector(".connection-dot");
    expect(dot).not.toBeNull();
    expect(dot).toHaveClass("reconnecting");
    expect(dot).toHaveAccessibleName("Thread reconnecting");
    // The project row carries no connection dot.
    expect(
      screen.getByTestId("thread-context").querySelector(".connection-dot"),
    ).toBeNull();
    expect(
      screen.getByRole("button", { name: "Thread worktree: Primary" }),
    ).toBeEnabled();
  });

  it("hides the project row while renaming and restores it afterward", async () => {
    renderHeader({ renameAvailable: true });

    fireEvent.click(screen.getByRole("button", { name: "Header thread" }));

    expect(
      screen.getByRole("textbox", { name: "Thread title" }),
    ).toBeInTheDocument();
    expect(screen.queryByTestId("thread-context")).toBeNull();

    fireEvent.keyDown(screen.getByRole("textbox", { name: "Thread title" }), {
      key: "Escape",
    });

    await waitFor(() => {
      expect(screen.getByTestId("thread-context")).toHaveTextContent("sedes");
    });
    expect(screen.queryByRole("textbox", { name: "Thread title" })).toBeNull();
  });
});

describe("ThreadHeader agent tools", () => {
  it("opens the dedicated dialog from one summarized menu row and returns focus", async () => {
    renderHeader();
    const actions = screen.getByRole("button", { name: "Thread actions" });
    fireEvent.click(actions);
    expect(screen.getByTestId("thread-actions-menu")).toHaveClass(
      "thread-actions-popover",
    );
    const row = screen.getByRole("button", { name: /Agent tools…\s*Off/ });
    expect(row).toBeVisible();
    expect(row.querySelector(".agent-tool-menu-label")).toHaveTextContent(
      "Agent tools…",
    );
    expect(row.querySelector(".agent-tool-menu-summary")).toHaveTextContent(
      "Off",
    );
    expect(
      screen.queryByRole("checkbox", { name: "Enable agent tools" }),
    ).toBeNull();

    fireEvent.click(row);
    expect(screen.queryByTestId("thread-actions-menu")).toBeNull();
    expect(screen.getByRole("dialog", { name: "Agent tools" })).toBeVisible();
    fireEvent.keyDown(document, { key: "Escape" });
    await waitFor(() => expect(actions).toHaveFocus());
  });
});

describe("ThreadHeader action menu", () => {
  it("uses a bottom sheet on coarse pointers and closes it before dialogs", async () => {
    vi.stubGlobal(
      "matchMedia",
      vi.fn((query: string) => ({
        matches: query.includes("pointer: coarse"),
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      })),
    );
    renderHeader({ runState: "reconciling" });

    fireEvent.click(screen.getByRole("button", { name: "Thread actions" }));
    const sheet = screen.getByRole("dialog", { name: "Thread settings" });
    expect(sheet).toHaveAttribute("data-state", "open");
    expect(sheet).toHaveTextContent("Header thread");
    expect(within(sheet).getByTestId("thread-configuration")).toBeVisible();
    expect(screen.queryByTestId("thread-actions-menu")).toBeNull();
    const labels = within(sheet)
      .getAllByRole("button")
      .map((button) => button.textContent?.trim());
    expect(labels.indexOf("Session stats")).toBeLessThan(
      labels.indexOf("Force reset…"),
    );

    fireEvent.click(
      within(sheet).getByRole("button", { name: "Force reset…" }),
    );
    await waitFor(() =>
      expect(
        screen.queryByRole("dialog", { name: "Thread settings" }),
      ).not.toBeInTheDocument(),
    );
    expect(
      await screen.findByRole("dialog", { name: "Force reset Sedes state?" }),
    ).toBeVisible();
  });

  it("matches the sidebar lifecycle, creation, and destructive section order", () => {
    renderHeader();
    fireEvent.click(screen.getByRole("button", { name: "Thread actions" }));
    const menu = screen.getByTestId("thread-actions-menu");
    const labels = within(menu)
      .getAllByRole("button")
      .map((button) => button.textContent?.trim());

    const settle = labels.indexOf("Settle");
    const snooze = labels.indexOf("Snooze…");
    const create = labels.indexOf("New");
    const fork = labels.indexOf("Fork");
    const forceReset = labels.indexOf("Force reset…");
    const archive = labels.indexOf("Archive");
    expect([settle, snooze, create, fork, forceReset, archive]).not.toContain(
      -1,
    );
    expect([settle, snooze, create, fork, forceReset, archive]).toEqual(
      [...[settle, snooze, create, fork, forceReset, archive]].sort(
        (left, right) => left - right,
      ),
    );
    expect(menu.querySelectorAll(".thread-actions-separator")).toHaveLength(2);
    const createAction = within(menu).getByRole("button", {
      name: "New thread with same settings",
    });
    expect(createAction).toHaveTextContent(/^New$/u);
    expect(createAction).toHaveAttribute(
      "title",
      "Create a new thread from these settings",
    );
  });

  it("creates an independent thread from the source settings", async () => {
    const { applicationStore } = renderHeader();
    fireEvent.click(screen.getByRole("button", { name: "Thread actions" }));
    fireEvent.click(
      screen.getByRole("button", { name: "New thread with same settings" }),
    );

    await waitFor(() =>
      expect(applicationStore.createThreadFromSettings).toHaveBeenCalledWith(
        "thread-1",
        { title: "New thread" },
      ),
    );
    await waitFor(() =>
      expect(window.location.pathname).toBe("/threads/thread-copy"),
    );
  });

  it("keeps an unavailable source action visible with its reason", () => {
    renderHeader({ available: false });
    fireEvent.click(screen.getByRole("button", { name: "Thread actions" }));
    const action = screen.getByRole("button", {
      name: "New thread with same settings",
    });
    const descriptionId = action.getAttribute("aria-describedby");

    expect(action).toBeDisabled();
    expect(descriptionId).toBeTruthy();
    expect(document.getElementById(descriptionId!)).toHaveTextContent(
      "The source thread target is unavailable.",
    );
  });

  it("shows copy failures in the operation overlay", async () => {
    const { applicationStore } = renderHeader();
    applicationStore.createThreadFromSettings.mockRejectedValueOnce(
      new Error("The source settings changed."),
    );
    fireEvent.click(screen.getByRole("button", { name: "Thread actions" }));
    fireEvent.click(
      screen.getByRole("button", { name: "New thread with same settings" }),
    );

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "The source settings changed.",
    );
    expect(screen.queryByTestId("thread-actions-menu")).toBeNull();
    expect(window.location.pathname).toBe("/");
  });

  it("shows pending copy feedback and prevents a duplicate header action", async () => {
    let resolveCopy!: (result: {
      threadId: string;
      workspaceId: string;
      targetId: string;
    }) => void;
    const pendingCopy = new Promise<{
      threadId: string;
      workspaceId: string;
      targetId: string;
    }>((resolve) => {
      resolveCopy = resolve;
    });
    const { applicationStore } = renderHeader();
    applicationStore.createThreadFromSettings.mockReturnValue(pendingCopy);
    fireEvent.click(screen.getByRole("button", { name: "Thread actions" }));
    fireEvent.click(
      screen.getByRole("button", { name: "New thread with same settings" }),
    );

    expect(screen.getByRole("status")).toHaveTextContent("Creating thread…");
    expect(screen.queryByTestId("thread-actions-menu")).toBeNull();
    expect(applicationStore.createThreadFromSettings).toHaveBeenCalledOnce();

    resolveCopy({
      threadId: "thread-copy",
      workspaceId: "workspace-1",
      targetId: "target-1",
    });
    await waitFor(() =>
      expect(window.location.pathname).toBe("/threads/thread-copy"),
    );
  });
});

describe("ThreadHeader force reset", () => {
  it("previews and submits reset from thread actions while reconciling", async () => {
    const { applicationStore } = renderHeader({ runState: "reconciling" });
    fireEvent.click(screen.getByRole("button", { name: "Thread actions" }));

    const resetAction = screen.getByRole("button", { name: "Force reset…" });
    expect(resetAction).not.toBeDisabled();
    fireEvent.click(resetAction);

    const dialog = await screen.findByRole("dialog", {
      name: "Force reset Sedes state?",
    });
    expect(applicationStore.getThreadForceResetImpact).toHaveBeenCalledWith(
      "thread-1",
    );
    expect(dialog).toHaveTextContent("1 conversation operation");

    fireEvent.click(await screen.findByRole("button", { name: "Force reset" }));
    await waitFor(() =>
      expect(applicationStore.forceResetThread).toHaveBeenCalledWith(
        "thread-1",
        "a".repeat(64),
        expect.any(String),
      ),
    );
  });
});
