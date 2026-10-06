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
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  NormalizedApplicationSnapshot,
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
  getBlockingOperation()?.dismiss();
  cleanup();
  vi.useRealTimers();
  localStorage.clear();
  vi.unstubAllGlobals();
  window.history.replaceState(null, "", "/");
});

type HeaderAutomation = NonNullable<
  NormalizedThreadSnapshot["thread"]["automation"]
>;

function makeSnapshot({
  renameAvailable = false,
  brand,
  backingState = "bound",
  runState = "idle",
  available = true,
  environmentKind = "ssh",
  automation = false,
}: {
  readonly automation?: boolean | HeaderAutomation;
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
      automation:
        automation === true
          ? { status: "enabled" }
          : automation === false
            ? null
            : automation,
    },
    executionWorkspace: { kind: "direct" },
    workspace: {
      id: "workspace-1",
      environmentId: "environment-1",
      projectId: "project-1",
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
      automation: { available: automation !== false },
    },
  } as unknown as NormalizedThreadSnapshot;
}

type CatalogProject = NormalizedApplicationSnapshot["projects"][number];
type CatalogWorkspace = NormalizedApplicationSnapshot["workspaces"][number];

const firstLocation: CatalogWorkspace = {
  id: "workspace-1",
  environmentId: "environment-1",
  projectId: "project-1",
  label: { text: "sedes" },
  displayPath: { text: "/workspace" },
  available: true,
};
const secondLocation: CatalogWorkspace = {
  id: "workspace-2",
  environmentId: "environment-1",
  projectId: "project-1",
  label: { text: "second" },
  displayPath: { text: "/second" },
  available: true,
};

function fixture(
  environmentCount: number,
  options: {
    readonly environmentKind?: "local" | "ssh";
    readonly forkOrigins?: readonly {
      readonly childThreadId: string;
      readonly sourceThreadId: string;
    }[];
    readonly projects?: readonly CatalogProject[];
    readonly workspaces?: readonly CatalogWorkspace[];
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
      projects: options.projects ?? [
        { id: "project-1", name: "sedes", revision: 0 },
      ],
      workspaces:
        options.workspaces ??
        (environmentCount === 0 ? [] : [firstLocation, secondLocation]),
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
      affectedThreads: [{ threadId: "thread-1", title: "Thread" }],
      warnings: [],
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

/** A header whose thread offers Model and Thinking settings. */
function renderHeaderWithSettings() {
  window.HTMLElement.prototype.scrollIntoView = vi.fn();
  const perform = vi.fn(async () => undefined);
  const { applicationStore, threadStore } = fixture(0);
  Object.assign(threadStore, { perform });
  const snapshot = makeSnapshot();
  const withSettings = {
    ...snapshot,
    capabilities: {
      ...snapshot.capabilities,
      settings: [
        {
          id: "model",
          label: { text: "Model" },
          available: true,
          requiredForFirstSubmission: true,
          options: [
            { value: "model-a", label: { text: "Model A" }, available: true },
            { value: "model-b", label: { text: "Model B" }, available: true },
          ],
        },
        {
          id: "thinking_level",
          label: { text: "Thinking" },
          available: true,
          requiredForFirstSubmission: false,
          options: [
            { value: "low", label: { text: "Low" }, available: true },
            { value: "high", label: { text: "High" }, available: true },
          ],
        },
      ],
    },
    settings: {
      revision: 1,
      values: [
        { id: "model", desiredValue: "model-a", effectiveValue: "model-a", applicationState: "effective" },
        { id: "thinking_level", desiredValue: "low", effectiveValue: "low", applicationState: "effective" },
      ],
    },
  } as unknown as NormalizedThreadSnapshot;
  render(
    <ThreadHeader
      store={threadStore}
      applicationStore={applicationStore}
      snapshot={withSettings}
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
    />,
  );
  return { perform };
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
  projects,
  workspaces,
  automation = false,
  findOpen = false,
  onFindOpenChange = vi.fn(),
}: {
  readonly projects?: readonly CatalogProject[];
  readonly workspaces?: readonly CatalogWorkspace[];
  readonly automation?: boolean | HeaderAutomation;
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
    ...(projects === undefined ? {} : { projects }),
    ...(workspaces === undefined ? {} : { workspaces }),
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

/** Opens the desktop Thread actions menu (Radix opens on pointer down). */
async function openThreadActions(): Promise<HTMLElement> {
  await userEvent.click(screen.getByRole("button", { name: "Thread actions" }));
  return await screen.findByRole("menu", { name: "Thread actions" });
}

/** Visible row labels in order, without their trailing reasons or values. */
function rowLabels(menu: HTMLElement): string[] {
  return within(menu)
    .getAllByRole("menuitem")
    .map((row) =>
      Array.from(row.childNodes)
        .filter(
          (node) =>
            !(node instanceof Element) ||
            node.getAttribute("data-slot")?.endsWith("-item-value") !== true,
        )
        .map((node) => node.textContent ?? "")
        .join("")
        .trim(),
    );
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

  it("passes the chat panel's dock edge to its Dock menu", async () => {
    const { applicationStore, threadStore } = fixture(0);
    render(
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
        panelControls={{
          onCollapse: vi.fn(),
          onClose: vi.fn(),
          onDock: vi.fn(),
          dockEdge: "right",
        }}
        findOpen={false}
        findButtonRef={{ current: null }}
        onFindOpenChange={vi.fn()}
      />,
    );
    await userEvent.click(
      screen.getByRole("button", { name: "Chat panel actions" }),
    );
    const dock = await screen.findByRole("group", { name: "Dock" });
    expect(
      within(dock).getByRole("menuitemradio", { name: "Right" }),
    ).toHaveAttribute("aria-checked", "true");
    expect(
      within(dock).getByRole("menuitemradio", { name: "Left" }),
    ).toHaveAttribute("aria-checked", "false");
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

  it("gives the toolbar toggle to Thread actions on phones below 420px", async () => {
    vi.stubGlobal(
      "matchMedia",
      vi.fn((query: string) => ({
        matches: query.includes("max-width: 819px") || query === "(max-width: 419px)",
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      })),
    );
    const onFindOpenChange = vi.fn();
    renderHeader({ automation: true, withPanelControls: true, onFindOpenChange });

    const toolbar = screen.getByTestId("thread-controls");
    expect(screen.queryByRole("button", { name: "Show thread toolbar" })).toBeNull();
    expect(screen.getByRole("button", { name: "Bookmarks" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Automation settings" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Collapse Chat panel" })).toBeVisible();
    expect(toolbar).toHaveAttribute("hidden");

    await userEvent.click(screen.getByRole("button", { name: "Thread actions" }));
    const show = await screen.findByRole("menuitemcheckbox", { name: "Show thread toolbar" });
    expect(show).toHaveAttribute("aria-checked", "false");
    await userEvent.click(show);
    expect(toolbar).not.toHaveAttribute("hidden");
    expect(within(toolbar).getByRole("button", { name: "Find in thread" })).toBeVisible();

    await userEvent.click(screen.getByRole("button", { name: "Thread actions" }));
    const hide = await screen.findByRole("menuitemcheckbox", { name: "Show thread toolbar" });
    expect(hide).toHaveAttribute("aria-checked", "true");
    await userEvent.click(hide);
    expect(toolbar).toHaveAttribute("hidden");
    expect(onFindOpenChange).toHaveBeenCalledWith(false);
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
    const sheet = screen.getByTestId("thread-settings-sheet");
    expect(sheet).toHaveAccessibleName("Header thread");
    expect(sheet).toHaveAccessibleDescription("sedes · Machine 1 · Pi");
    act(() => {
      viewport.height = window.innerHeight - 300;
      viewport.dispatchEvent(new Event("resize"));
    });
    expect(sheet.style.getPropertyValue("--keyboard-inset")).toBe("300px");
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

  it("names a single-location project by its name alone", () => {
    renderHeader({
      environmentCount: 1,
      projects: [{ id: "project-1", name: "Harness", revision: 0 }],
      workspaces: [firstLocation],
    });

    const project = screen.getByTestId("thread-context");
    expect(project.querySelector(".thread-project-name")).toHaveTextContent(
      /^Harness$/u,
    );
    expect(project).toHaveAttribute("title", "Harness · Pi");
  });

  it("adds the folder when the project has another location on the environment", () => {
    renderHeader({
      environmentCount: 1,
      projects: [{ id: "project-1", name: "Harness", revision: 0 }],
    });

    expect(
      screen.getByTestId("thread-context").querySelector(".thread-project-name"),
    ).toHaveTextContent(/^Harness › sedes$/u);
  });

  it("keeps the remote environment qualifier after the project and folder", () => {
    renderHeader({
      environmentCount: 2,
      projects: [{ id: "project-1", name: "Harness", revision: 0 }],
    });

    const project = screen.getByTestId("thread-context");
    expect(project.querySelector(".thread-project-name")).toHaveTextContent(
      /^Harness › sedes · Machine 1$/u,
    );
    expect(project).toHaveAttribute("title", "Harness › sedes · Machine 1 · Pi");
  });

  it("keeps the thread's host when a same-named project's hint names several", () => {
    renderHeader({
      environmentCount: 3,
      projects: [
        { id: "project-1", name: "sedes", revision: 0 },
        { id: "project-2", name: "sedes", revision: 0 },
      ],
      workspaces: [
        firstLocation,
        { ...secondLocation, environmentId: "environment-2", label: { text: "sedes" } },
        { ...secondLocation, id: "workspace-3", projectId: "project-2", environmentId: "environment-3", label: { text: "sedes" } },
      ],
    });

    expect(
      screen.getByTestId("thread-context").querySelector(".thread-project-name"),
    ).toHaveTextContent(/^sedes · Machine 1, Machine 2 · Machine 1$/u);
  });

  it("names the project of a removed location while the project is active", () => {
    renderHeader({
      environmentCount: 1,
      projects: [{ id: "project-1", name: "Harness", revision: 0 }],
      workspaces: [secondLocation],
    });

    expect(
      screen.getByTestId("thread-context").querySelector(".thread-project-name"),
    ).toHaveTextContent(/^Harness › sedes$/u);
  });

  it("falls back to the folder when the project is not active", () => {
    renderHeader({ environmentCount: 1, projects: [], workspaces: [] });

    expect(
      screen.getByTestId("thread-context").querySelector(".thread-project-name"),
    ).toHaveTextContent(/^sedes$/u);
  });

  it("lists draft locations by project and path within the thread's environment", async () => {
    const user = userEvent.setup();
    renderHeader({
      backingState: "unbound",
      environmentCount: 2,
      environmentKind: "local",
    });
    await openThreadActions();
    // A location label is long by nature: the row shows no inline value,
    // and the current location is the checked row inside.
    const draftLocation = screen.getByRole("menuitem", { name: "Draft location" });
    expect(draftLocation).toHaveTextContent(/^Draft location$/u);
    expect(draftLocation.querySelector('[data-slot$="item-value"]')).toBeNull();
    await user.click(draftLocation);

    const localChoices = await screen.findAllByRole("menuitemradio");
    expect(localChoices.map(({ textContent }) => textContent)).toEqual([
      "sedes · /workspace",
      "sedes · /second",
    ]);
    expect(localChoices[0]).toHaveAttribute("aria-checked", "true");

    cleanup();
    renderHeader({
      backingState: "unbound",
      environmentCount: 2,
      environmentKind: "ssh",
      projects: [
        { id: "project-1", name: "sedes", revision: 0 },
        { id: "project-2", name: "Docs", revision: 0 },
      ],
      workspaces: [
        firstLocation,
        { ...secondLocation, projectId: "project-2", available: false },
        { ...secondLocation, id: "workspace-3", environmentId: "environment-2" },
      ],
    });
    await openThreadActions();
    await user.click(screen.getByRole("menuitem", { name: "Draft location" }));

    // The environment is the thread's own, so no choice repeats it.
    const remoteChoices = await screen.findAllByRole("menuitemradio");
    expect(remoteChoices.map(({ textContent }) => textContent)).toEqual([
      "sedes · /workspace",
      "Docs · /secondUnavailable",
    ]);
    expect(remoteChoices[1]).toHaveAttribute("aria-disabled", "true");
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
    const menu = await openThreadActions();
    expect(menu).toHaveAttribute("data-slot", "dropdown-menu-content");
    const row = within(menu).getByRole("menuitem", { name: "Agent tools… Off" });
    expect(row).toBeVisible();
    expect(row).toHaveTextContent("Agent tools…");
    expect(
      within(row).getByText("Off"),
    ).toHaveAttribute("data-slot", "dropdown-menu-item-description");
    expect(
      screen.queryByRole("switch", { name: "Enable agent tools" }),
    ).toBeNull();

    await userEvent.click(row);
    await waitFor(() =>
      expect(screen.queryByRole("menu", { name: "Thread actions" })).toBeNull(),
    );
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
    const sheet = screen.getByRole("dialog", { name: "Header thread" });
    expect(sheet).toHaveAttribute("data-state", "open");
    expect(sheet).toHaveAttribute("data-menu-sheet");
    expect(sheet).toHaveAttribute("data-testid", "thread-settings-sheet");
    expect(screen.queryByRole("menu", { name: "Thread actions" })).toBeVisible();
    const labels = rowLabels(sheet);
    expect(labels.indexOf("Session stats")).toBeLessThan(
      labels.indexOf("Force reset…"),
    );
    expect(labels.at(-1)).toBe("Force reset…");

    fireEvent.click(
      within(sheet).getByRole("menuitem", { name: "Force reset…" }),
    );
    await waitFor(() =>
      expect(
        screen.queryByRole("dialog", { name: "Header thread" }),
      ).not.toBeInTheDocument(),
    );
    expect(
      await screen.findByRole("dialog", { name: "Force reset Sedes state?" }),
    ).toBeVisible();
  });

  it("shows the thread settings as sheet rows and hands the model to its picker", async () => {
    vi.stubGlobal(
      "matchMedia",
      vi.fn((query: string) => ({
        matches: query.includes("pointer: coarse"),
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      })),
    );
    const { perform } = renderHeaderWithSettings();
    const trigger = screen.getByRole("button", { name: "Thread actions" });
    fireEvent.click(trigger);
    const sheet = screen.getByRole("dialog", { name: "Header thread" });
    const thinking = within(sheet).getByRole("menuitem", { name: /Thinking/ });
    expect(thinking).toHaveTextContent("Low");
    fireEvent.click(thinking);
    const high = await within(sheet).findByRole("menuitemradio", { name: "High" });
    expect(
      within(sheet).getByRole("menuitemradio", { name: "Low" }),
    ).toHaveAttribute("aria-checked", "true");
    fireEvent.click(high);
    expect(perform).toHaveBeenCalledWith({
      action: "set_setting",
      settingId: "thinking_level",
      value: "high",
    });
    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: "Header thread" })).toBeNull(),
    );

    fireEvent.click(trigger);
    const model = within(
      screen.getByRole("dialog", { name: "Header thread" }),
    ).getByRole("menuitem", { name: /Model/ });
    expect(model).toHaveAttribute("aria-haspopup", "dialog");
    expect(model).toHaveTextContent("Model A");
    fireEvent.click(model);
    const picker = await screen.findByRole("dialog", { name: "Choose model" });
    expect(screen.queryByRole("dialog", { name: "Header thread" })).toBeNull();
    fireEvent.click(within(picker).getByRole("option", { name: "Model B" }));
    expect(perform).toHaveBeenCalledWith({
      action: "set_setting",
      settingId: "model",
      value: "model-b",
    });
    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: "Choose model" })).toBeNull(),
    );
    await waitFor(() => expect(trigger).toHaveFocus());
  });

  it("shows the thread settings in the desktop menu, with the model picker as a dialog", async () => {
    const { perform } = renderHeaderWithSettings();
    const trigger = screen.getByRole("button", { name: "Thread actions" });
    // Model and Thinking lead the menu even though the composer also offers them.
    const menu = await openThreadActions();
    expect(rowLabels(menu).slice(0, 2)).toEqual(["Model", "Thinking"]);
    const thinking = within(menu).getByRole("menuitem", { name: /Thinking/ });
    expect(thinking).toHaveTextContent("Low");
    expect(thinking).toHaveAttribute("aria-haspopup", "menu");
    await userEvent.click(thinking);
    const levels = await screen.findByRole("menu", { name: /Thinking/ });
    expect(within(levels).getByRole("menuitemradio", { name: "Low" })).toHaveAttribute("aria-checked", "true");
    await userEvent.click(within(levels).getByRole("menuitemradio", { name: "High" }));
    expect(perform).toHaveBeenCalledWith({
      action: "set_setting",
      settingId: "thinking_level",
      value: "high",
    });
    await waitFor(() => expect(screen.queryByRole("menu", { name: "Thread actions" })).toBeNull());

    const model = within(await openThreadActions()).getByRole("menuitem", { name: /Model/ });
    expect(model).toHaveAttribute("aria-haspopup", "dialog");
    await userEvent.click(model);
    const picker = await screen.findByRole("dialog", { name: "Choose model" });
    // A centred dialog on desktop; touch keeps the sheet.
    expect(picker).toHaveAttribute("data-layout", "modal");
    expect(screen.queryByRole("menu", { name: "Thread actions" })).toBeNull();
    await userEvent.click(within(picker).getByRole("option", { name: "Model B" }));
    expect(perform).toHaveBeenCalledWith({
      action: "set_setting",
      settingId: "model",
      value: "model-b",
    });
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Choose model" })).toBeNull());
    await waitFor(() => expect(trigger).toHaveFocus());
  });

  it("matches the sidebar lifecycle, creation, and destructive section order", async () => {
    renderHeader();
    const menu = await openThreadActions();
    const labels = rowLabels(menu);

    const settle = labels.indexOf("Settle");
    const snooze = labels.indexOf("Snooze…");
    const create = labels.indexOf("New with same settings");
    const fork = labels.indexOf("Fork");
    const archive = labels.indexOf("Archive");
    const forceReset = labels.indexOf("Force reset…");
    expect([settle, snooze, create, fork, archive, forceReset]).not.toContain(
      -1,
    );
    expect([settle, snooze, create, fork, archive, forceReset]).toEqual(
      [...[settle, snooze, create, fork, archive, forceReset]].sort(
        (left, right) => left - right,
      ),
    );
    expect(forceReset).toBe(labels.length - 1);
    expect(
      within(menu).getByRole("menuitem", { name: "Force reset…" }),
    ).toHaveAttribute("data-variant", "destructive");
    expect(
      within(menu).getByRole("menuitem", { name: "Archive" }),
    ).toHaveAttribute("data-variant", "default");
    expect(within(menu).getAllByRole("separator")).toHaveLength(3);
    for (const row of within(menu).getAllByRole("menuitem")) {
      expect(row.querySelector("svg")).not.toBeNull();
    }
    expect(within(menu).queryByText("Thread actions")).toBeNull();
    const createAction = within(menu).getByRole("menuitem", {
      name: "New with same settings",
    });
    expect(createAction).toHaveAttribute(
      "title",
      "Create a new thread from these settings",
    );
    const forkAction = within(menu).getByRole("menuitem", { name: "Fork" });
    expect(forkAction).toHaveAttribute("data-disabled");
    expect(forkAction).toHaveTextContent("Unavailable");
  });

  it("creates an independent thread from the source settings", async () => {
    const { applicationStore } = renderHeader();
    const menu = await openThreadActions();
    await userEvent.click(
      within(menu).getByRole("menuitem", { name: "New with same settings" }),
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

  it("keeps an unavailable source action visible with its reason", async () => {
    renderHeader({ available: false });
    const menu = await openThreadActions();
    const action = within(menu).getByRole("menuitem", {
      name: "New with same settings",
    });
    const descriptionId = action.getAttribute("aria-describedby");

    expect(action).toHaveAttribute("data-disabled");
    expect(action).toHaveTextContent("Unavailable");
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
    const menu = await openThreadActions();
    await userEvent.click(
      within(menu).getByRole("menuitem", { name: "New with same settings" }),
    );

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "The source settings changed.",
    );
    expect(screen.queryByRole("menu", { name: "Thread actions" })).toBeNull();
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
    const menu = await openThreadActions();
    await userEvent.click(
      within(menu).getByRole("menuitem", { name: "New with same settings" }),
    );

    expect(await screen.findByRole("status")).toHaveTextContent(
      "Creating thread…",
    );
    expect(screen.queryByRole("menu", { name: "Thread actions" })).toBeNull();
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
    const menu = await openThreadActions();

    const resetAction = within(menu).getByRole("menuitem", {
      name: "Force reset…",
    });
    expect(resetAction).not.toHaveAttribute("data-disabled");
    expect(
      within(menu).getByRole("menuitem", { name: "Settle" }),
    ).toHaveTextContent("Syncing");
    await userEvent.click(resetAction);

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

describe("ThreadHeader automation chip", () => {
  const NOW = new Date("2026-10-06T03:40:00.000Z");
  type LastRun = NonNullable<HeaderAutomation["lastRun"]>;
  const run = (state: LastRun["state"], overrides: Partial<LastRun> = {}): LastRun => ({
    id: "run-1",
    state,
    occurrence: "scheduled",
    scheduledFor: "2026-10-05T06:30:00.000Z",
    ...overrides,
  });
  const automation = (overrides: Partial<HeaderAutomation>): HeaderAutomation => ({
    status: "enabled",
    runMode: "same_thread",
    scheduleKind: "cron",
    revision: 1,
    hasPrecheck: false,
    ...overrides,
  });

  it.each([
    {
      name: "active",
      automation: automation({ nextRunAt: "2026-10-07T02:00:00.000Z" }),
      health: "active",
      title: /^Automation · next Tmrw \d/u,
      icon: ".lucide-repeat",
    },
    {
      name: "failed",
      automation: automation({ lastRun: run("failed", { finishedAt: "2026-10-05T06:40:00.000Z" }) }),
      health: "failed",
      title: /^Automation · Failed 21h ago$/u,
      icon: ".lucide-repeat",
    },
    {
      name: "unknown",
      automation: automation({ status: "paused", lastRun: run("uncertain") }),
      health: "unknown",
      title: /^Automation · Outcome unknown$/u,
      icon: ".lucide-repeat",
    },
    {
      name: "sending",
      automation: automation({ lastRun: run("claimed") }),
      health: "sending",
      title: /^Automation · Sending$/u,
      icon: ".comet-spinner",
    },
    {
      name: "paused",
      automation: automation({ status: "paused", lastRun: run("completed") }),
      health: "paused",
      title: /^Automation · Paused$/u,
      icon: ".lucide-circle-pause",
    },
    {
      name: "not started",
      automation: automation({ status: "paused" }),
      health: "not_started",
      title: /^Automation · Not started$/u,
      icon: ".lucide-circle-pause",
    },
  ])("draws $name with the shared vocabulary", ({ automation, health, title, icon }) => {
    vi.useFakeTimers({ now: NOW, toFake: ["Date"] });
    try {
      renderHeader({ automation });
    } finally {
      vi.useRealTimers();
    }
    const chip = screen.getByRole("button", { name: "Automation settings" });
    expect(chip).toHaveAttribute("data-health", health);
    expect(chip).not.toHaveAttribute("data-status");
    expect(chip.getAttribute("title")).toMatch(title);
    expect(chip.querySelector(icon)).not.toBeNull();
    expect(chip.querySelector(".lucide-clock")).toBeNull();
  });

  it("opens the automation route from the chip", async () => {
    renderHeader({ automation: true });
    await userEvent.click(screen.getByRole("button", { name: "Automation settings" }));
    expect(window.location.pathname).toBe("/threads/thread-1/automation");
  });

  it("uses Repeat for the Thread actions automation item", async () => {
    renderHeader({ automation: true });
    const menu = await openThreadActions();
    const item = within(menu).getByRole("menuitem", { name: "Automation settings…" });
    expect(item.querySelector(".lucide-repeat")).not.toBeNull();
    expect(item.querySelector(".lucide-calendar-clock")).toBeNull();
  });
});
