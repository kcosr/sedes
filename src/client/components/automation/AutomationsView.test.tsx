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
} from "../../stores/ApplicationClientStore.js";
import {
  SIDEBAR_VIEW_DEFAULTS,
  SIDEBAR_VIEW_STORAGE_KEY,
} from "../../app/sidebar-view-model.js";
import { AUTOMATIONS_VIEW_STORAGE_KEY } from "../../automation/automations-view-preferences.js";
import type {
  SummaryAutomation,
  SummaryAutomationRun,
} from "../../automation/automation-health.js";
import { futureTimeLabel } from "../../lib/time.js";
import { installThreadPanelOpenRequestListener } from "../../workspace-panels/thread-panel-navigation.js";
import { AutomationsView } from "./AutomationsView.js";

type Snapshot = NonNullable<ApplicationClientState["snapshot"]>;
type Thread = Snapshot["threads"][number];

function resetStorage() {
  localStorage.clear();
  window.dispatchEvent(new StorageEvent("storage", { key: null }));
}

// Relative times and health read the clock; only Date is faked, so timers
// and the minute clock stay real.
const NOW = Date.parse("2026-10-06T03:40:00.000Z");
const minutesAgo = (minutes: number) =>
  new Date(NOW - minutes * 60_000).toISOString();
const hoursFromNow = (hours: number) =>
  new Date(NOW + hours * 3_600_000).toISOString();
const nextLabel = (hours: number) =>
  futureTimeLabel(hoursFromNow(hours), new Date(NOW));

afterEach(() => {
  cleanup();
  resetStorage();
  vi.unstubAllGlobals();
  vi.useRealTimers();
  window.history.replaceState(null, "", "/");
});
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"], now: NOW });
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

function run(
  state: SummaryAutomationRun["state"],
  overrides: Partial<SummaryAutomationRun> = {},
): SummaryAutomationRun {
  return {
    id: `run-${state}`,
    state,
    occurrence: "scheduled",
    scheduledFor: minutesAgo(30),
    finishedAt: minutesAgo(23),
    ...overrides,
  };
}

function automation(
  overrides: Partial<SummaryAutomation> = {},
): SummaryAutomation {
  return {
    status: "enabled",
    runMode: "same_thread",
    scheduleKind: "cron",
    schedule: { kind: "cron", expression: "0 2 * * *", timeZone: "UTC" },
    misfirePolicy: "coalesce",
    promptPreview: "Check dependencies for advisories",
    nextRunAt: hoursFromNow(22),
    revision: 4,
    runsRevision: 0,
    hasPrecheck: false,
    ...overrides,
  };
}

function makeThread(
  id: string,
  title: string,
  overrides: Partial<Thread> = {},
): Thread {
  return {
    id,
    workspaceId: "ws-acme",
    targetId: "t-pi",
    title: { text: title },
    backend: { label: { text: "Pi SDK" }, brand: "pi" },
    backingState: "bound",
    inventoryState: "active",
    inventoryRevision: 1,
    preferredWorktreeRevision: 0,
    preferredWorktree: null,
    pinned: false,
    pinRevision: 0,
    groupId: null,
    groupAssignmentRevision: 0,
    bookmarkRevision: 0,
    turnBookmarkCount: 0,
    nonArchivedWorkpadCount: 0,
    threadRevision: 1,
    runState: "idle",
    terminalSummary: { runningCount: 0, retainedCount: 0 },
    queuedInputCount: 0,
    pendingQuestionCount: 0,
    stashedPromptCount: 0,
    available: true,
    lastActivityAt: minutesAgo(60),
    stateChangedAt: minutesAgo(60),
    automation: automation(),
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
    projects: [
      { id: "project-acme", name: "acme-web", revision: 1 },
      { id: "project-billing", name: "billing-service", revision: 1 },
      { id: "project-docs", name: "docs", revision: 1 },
    ],
    workspaces: [
      {
        id: "ws-acme",
        environmentId: "env-local",
        projectId: "project-acme",
        label: { text: "acme-web" },
        displayPath: { text: "/src/acme-web" },
        available: true,
      },
      {
        id: "ws-billing",
        environmentId: "env-local",
        projectId: "project-billing",
        label: { text: "billing-service" },
        displayPath: { text: "/src/billing-service" },
        available: true,
      },
      {
        id: "ws-docs",
        environmentId: "env-local",
        projectId: "project-docs",
        label: { text: "docs" },
        displayPath: { text: "/src/docs" },
        available: true,
      },
    ],
    executionTargets: [],
    threads: [...threads],
    forkOrigins: [],
    lineagePlacements: [],
    groups: [],
    lineageFamilies: [],
    defaultNewThreadTargetId: null,
    counts: { active: threads.length, snoozed: 0, settled: 0, archived: 0 },
    tasks: [],
    ...overrides,
  } as Snapshot;
}

function createStore(snapshot: Snapshot) {
  let state: ApplicationClientState = {
    status: "ready",
    connection: "connected",
    authoritative: true,
    providerPulseEnabled: false,
    experimentalUsageEnabled: false,
    search: "",
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
  const api = {
    runThreadAutomationNow: vi.fn(async (): Promise<unknown> => ({})),
    setThreadAutomationState: vi.fn(async (): Promise<unknown> => ({})),
  };
  const store = {
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    getSnapshot: () => state,
    setSearch: vi.fn(),
    api,
  };
  return {
    store: store as typeof store & ApplicationClientStore,
    api,
    publish,
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

/** The mock world: one automation per list state. */
const world = [
  makeThread("triage", "Triage new billing issues", {
    workspaceId: "ws-billing",
    automation: automation({
      schedule: {
        kind: "interval",
        everySeconds: 14_400,
        anchorAt: "2026-10-01T00:00:00.000Z",
      },
      nextRunAt: hoursFromNow(4),
      lastRun: run("completed", { finishedAt: minutesAgo(25) }),
    }),
  }),
  makeThread("nightly", "Nightly dependency audit", {
    automation: automation({ lastRun: run("completed") }),
  }),
  makeThread("invoice", "Invoice reconciliation report", {
    workspaceId: "ws-billing",
    automation: automation({
      nextRunAt: hoursFromNow(3),
      lastRun: run("failed", {
        finishedAt: minutesAgo(21 * 60),
        errorCode: "automation_dispatch_failed",
      }),
    }),
  }),
  makeThread("sync", "Sync staging fixtures", {
    automation: automation({
      status: "paused",
      nextRunAt: undefined,
      lastRun: run("uncertain", {
        finishedAt: undefined,
        scheduledFor: minutesAgo(3 * 60),
        errorCode: "automation_dispatch_uncertain",
      }),
    }),
  }),
  makeThread("weekly", "Weekly release notes draft", {
    automation: automation({
      status: "paused",
      nextRunAt: undefined,
      promptPreview: "Draft the weekly release notes from merged PRs",
    }),
  }),
  makeThread("spike", "Spike: GraphQL gateway", {
    inventoryState: "archived",
    automation: automation({ lastRun: run("completed") }),
  }),
  makeThread("plain", "Plain thread", { automation: null }),
];

const groups = () => screen.queryAllByTestId("automations-group");
const headings = () =>
  screen
    .queryAllByRole("heading", { level: 2 })
    .map((heading) => heading.textContent);
const rowTitles = () =>
  screen
    .queryAllByTestId("automation-row")
    .map((row) => row.querySelector(".automation-row-title")?.textContent);
const row = (id: string) =>
  document.querySelector<HTMLElement>(
    `[data-testid="automation-row"][data-thread-id="${id}"]`,
  )!;
const text = (id: string, part: string) =>
  row(id).querySelector(`.automation-row-${part}`)?.textContent;

async function openRowMenu(
  user: ReturnType<typeof userEvent.setup>,
  title: string,
) {
  await user.click(
    screen.getByRole("button", { name: `Actions for ${title}` }),
  );
  return screen.getByRole("menu", { name: `Actions for ${title}` });
}

describe("AutomationsView list", () => {
  it("groups every automation by status with counts, Suspended collapsed", () => {
    const { store } = createStore(makeSnapshot(world));
    render(<AutomationsView store={store} />);
    expect(
      screen.getByRole("heading", { level: 1, name: "Automations" }),
    ).toBeVisible();
    expect(screen.getByTestId("automations-count")).toHaveTextContent("6");
    expect(headings()).toEqual([
      "Needs attention · 2",
      "Upcoming · 2",
      "Paused · 1",
      "Suspended · 1",
    ]);
    expect(rowTitles()).toEqual([
      "Sync staging fixtures",
      "Invoice reconciliation report",
      "Triage new billing issues",
      "Nightly dependency audit",
      "Weekly release notes draft",
    ]);
    const suspended = screen.getByRole("button", { name: "Suspended · 1" });
    expect(suspended).toHaveAttribute("aria-expanded", "false");
    expect(screen.getByRole("button", { name: "Upcoming · 2" })).toHaveAttribute(
      "aria-expanded",
      "true",
    );
    expect(
      within(screen.getByRole("list", { name: "Upcoming · 2" })).getAllByRole(
        "listitem",
      ),
    ).toHaveLength(2);
    const status = screen.getByTestId("automations-status");
    expect(status).toHaveTextContent("All projects");
    expect(status).toHaveTextContent("Grouped by status");
    expect(within(status).queryByRole("button")).toBeNull();
  });

  it("reads each row as title, schedule · project · backend, next run and last outcome", () => {
    const { store } = createStore(makeSnapshot(world));
    render(<AutomationsView store={store} />);
    const nightly = screen.getByRole("link", {
      name: "Nightly dependency audit",
    });
    expect(nightly).toHaveAttribute("href", "/automations/nightly");
    expect(text("nightly", "primary")).toBe(nextLabel(22));
    expect(row("nightly").querySelector('[data-layout="wide"]')).toHaveTextContent(
      "Every day at 2:00 AM UTC · acme-web · Pi SDK",
    );
    expect(text("nightly", "secondary")).toBe("Delivered 23m ago");
    expect(
      row("nightly").querySelector(".automation-row-secondary .lucide-check"),
    ).not.toBeNull();
    expect(nightly).toHaveAccessibleDescription(
      `Next run ${nextLabel(22)}. Every day at 2:00 AM UTC · acme-web · Pi SDK. Delivered 23m ago`,
    );
    // The glyph speaks through the description, not on its own.
    expect(
      row("nightly").querySelector('[data-automation-glyph="repeat"]'),
    ).toHaveAttribute("aria-hidden", "true");

    // Problems lead with the failure, its error text replaces the schedule,
    // and line 2 says whether scheduling continues.
    expect(text("invoice", "primary")).toBe("Failed 21h ago");
    expect(
      row("invoice").querySelector(".automation-row-primary"),
    ).toHaveAttribute("data-tone", "danger");
    expect(row("invoice").querySelector('[data-layout="wide"]')).toHaveTextContent(
      "The prompt could not be delivered to the agent · billing-service · Pi SDK",
    );
    expect(text("invoice", "secondary")).toBe(`next ${nextLabel(3)}`);
    expect(
      row("invoice").querySelector('[data-automation-glyph="triangle"]'),
    ).toHaveAttribute("data-tone", "danger");
    expect(text("sync", "primary")).toBe("Outcome unknown");
    expect(text("sync", "secondary")).toBe("Scheduling paused");
    expect(
      row("sync").querySelector('[data-automation-glyph="triangle"]'),
    ).toHaveAttribute("data-tone", "warning");
    expect(text("weekly", "primary")).toBe("Not started");
    expect(text("weekly", "secondary")).toBe("");
    expect(
      row("weekly").querySelector('[data-automation-glyph="pause"]'),
    ).not.toBeNull();

    // Phones read outcome · schedule with only the next run trailing.
    expect(
      row("nightly").querySelector('[data-layout="narrow"]'),
    ).toHaveTextContent("Delivered 23m ago · Every day at 2:00 AM UTC");
    expect(text("nightly", "next")).toBe(nextLabel(22));
    expect(
      row("invoice").querySelector('[data-layout="narrow"]'),
    ).toHaveTextContent(
      "Failed 21h ago · The prompt could not be delivered to the agent",
    );
    expect(
      row("weekly").querySelector('[data-layout="narrow"]'),
    ).toHaveTextContent("Not started · Every day at 2:00 AM UTC");
    expect(text("weekly", "next")).toBe("");
  });

  it("reads the last turn's ending in the row, and keeps each row in its group", () => {
    const turnWorld = [
      makeThread("finished", "Nightly dependency audit", {
        automation: automation({
          lastRun: run("completed", {
            finishedAt: minutesAgo(40),
            turn: { outcome: "completed", endedAt: minutesAgo(23) },
          }),
        }),
      }),
      makeThread("failed", "Invoice reconciliation report", {
        automation: automation({
          nextRunAt: hoursFromNow(3),
          lastRun: run("completed", {
            finishedAt: minutesAgo(125),
            turn: { outcome: "failed", endedAt: minutesAgo(120) },
          }),
        }),
      }),
      makeThread("interrupted", "Triage new billing issues", {
        automation: automation({
          status: "paused",
          nextRunAt: undefined,
          lastRun: run("completed", {
            finishedAt: minutesAgo(60),
            turn: { outcome: "interrupted" },
          }),
        }),
      }),
    ];
    const { store } = createStore(makeSnapshot(turnWorld));
    render(<AutomationsView store={store} />);
    // A failed turn adds no attention: no Needs attention group.
    expect(headings()).toEqual(["Upcoming · 2", "Paused · 1"]);
    expect(row("failed")).toHaveAttribute("data-group", "upcoming");

    expect(text("finished", "secondary")).toBe("Finished 23m ago");
    expect(
      row("finished").querySelector(".automation-row-secondary .lucide-check"),
    ).not.toBeNull();
    expect(row("finished").querySelector(".automation-row-secondary")).not.toHaveAttribute("data-tone");

    const failed = row("failed").querySelector(".automation-row-secondary");
    expect(failed).toHaveTextContent(/^Failed 2h ago$/u);
    expect(failed).toHaveAttribute("data-tone", "danger");
    expect(failed?.querySelector(".lucide-check")).toBeNull();
    expect(text("failed", "primary")).toBe(nextLabel(3));
    expect(
      row("failed").querySelector('[data-automation-glyph="repeat"]'),
    ).not.toBeNull();
    expect(
      screen.getByRole("link", { name: "Invoice reconciliation report" }),
    ).toHaveAccessibleDescription(
      `Next run ${nextLabel(3)}. Every day at 2:00 AM UTC · acme-web · Pi SDK. Failed 2h ago`,
    );
    expect(
      row("failed").querySelector('[data-layout="narrow"] .automation-row-outcome'),
    ).toHaveAttribute("data-tone", "danger");

    expect(text("interrupted", "primary")).toBe("Paused");
    expect(text("interrupted", "secondary")).toBe("Interrupted 1h ago");
    expect(row("interrupted").querySelector(".automation-row-secondary")).not.toHaveAttribute("data-tone");
  });

  it("opens the automation page from the whole row and leaves modified clicks to the browser", () => {
    const { store } = createStore(makeSnapshot(world));
    render(<AutomationsView store={store} />);
    const link = screen.getByRole("link", { name: "Nightly dependency audit" });
    // Whether the app took each click; jsdom cannot follow the rest.
    const taken: boolean[] = [];
    const record = (event: MouseEvent) => {
      taken.push(event.defaultPrevented);
      event.preventDefault();
    };
    window.addEventListener("click", record);
    fireEvent.click(link, { ctrlKey: true });
    expect(window.location.pathname).toBe("/");
    fireEvent.click(link);
    window.removeEventListener("click", record);
    expect(taken).toEqual([false, true]);
    expect(window.location.pathname).toBe("/automations/nightly");
  });

  it("expands and collapses groups and remembers the choice", async () => {
    const user = userEvent.setup();
    const { store } = createStore(makeSnapshot(world));
    const view = render(<AutomationsView store={store} />);
    await user.click(screen.getByRole("button", { name: "Suspended · 1" }));
    expect(rowTitles()).toContain("Spike: GraphQL gateway");
    expect(text("spike", "primary")).toBe("Thread archived");
    expect(
      row("spike").querySelector('[data-automation-glyph="archive"]'),
    ).not.toBeNull();
    await user.click(screen.getByRole("button", { name: "Upcoming · 2" }));
    expect(rowTitles()).not.toContain("Nightly dependency audit");
    expect(
      JSON.parse(localStorage.getItem(AUTOMATIONS_VIEW_STORAGE_KEY)!)
        .collapsed,
    ).toEqual({ "status:suspended": false, "status:upcoming": true });
    view.unmount();
    render(<AutomationsView store={store} />);
    expect(screen.getByRole("button", { name: "Upcoming · 2" })).toHaveAttribute(
      "aria-expanded",
      "false",
    );
    expect(rowTitles()).toContain("Spike: GraphQL gateway");
  });

  it("groups by project from View options; headings then name the project", async () => {
    const user = userEvent.setup();
    const { store } = createStore(makeSnapshot(world));
    render(<AutomationsView store={store} />);
    await user.click(screen.getByRole("button", { name: "View options" }));
    expect(
      screen.getByRole("menuitemradio", { name: "Status" }),
    ).toHaveAttribute("aria-checked", "true");
    await user.click(screen.getByRole("menuitemradio", { name: "Project" }));
    expect(headings()).toEqual(["acme-web · 4", "billing-service · 2"]);
    // Status order within each project.
    expect(rowTitles()).toEqual([
      "Sync staging fixtures",
      "Nightly dependency audit",
      "Weekly release notes draft",
      "Spike: GraphQL gateway",
      "Invoice reconciliation report",
      "Triage new billing issues",
    ]);
    expect(row("nightly").querySelector('[data-layout="wide"]')).toHaveTextContent(
      /^Every day at 2:00 AM UTC · Pi SDK$/u,
    );
    expect(screen.getByTestId("automations-status")).toHaveTextContent(
      "Grouped by project",
    );
    expect(
      JSON.parse(localStorage.getItem(AUTOMATIONS_VIEW_STORAGE_KEY)!).groupBy,
    ).toBe("project");
  });
});

describe("AutomationsView search and scope", () => {
  it("searches titles and prompt previews and explains no match", async () => {
    const user = userEvent.setup();
    const { store } = createStore(makeSnapshot(world));
    render(<AutomationsView store={store} />);
    const search = screen.getByRole("searchbox", { name: "Search automations" });
    fireEvent.change(search, { target: { value: "merged PRs" } });
    expect(rowTitles()).toEqual(["Weekly release notes draft"]);
    expect(headings()).toEqual(["Paused · 1"]);
    const status = screen.getByTestId("automations-status");
    expect(status).toHaveTextContent("1 of 6");
    expect(status).toHaveTextContent("matching “merged PRs”");
    // The page's search is its own; the sidebar search is untouched.
    expect(store.setSearch).not.toHaveBeenCalled();

    fireEvent.change(search, { target: { value: "nightly" } });
    expect(rowTitles()).toEqual(["Nightly dependency audit"]);

    fireEvent.change(search, { target: { value: "nothing like it" } });
    expect(screen.getByText("No matching automations")).toBeVisible();
    expect(screen.getByText("Nothing matches “nothing like it”.")).toBeVisible();
    expect(groups()).toHaveLength(0);
    await user.click(screen.getByRole("button", { name: "Clear search" }));
    expect(search).toHaveValue("");
    expect(search).toHaveFocus();
    expect(rowTitles()).toHaveLength(5);
  });

  it("honors the sidebar Scope and clears it from the status line", async () => {
    seedScope({ projectFilterId: "project-billing" });
    const { store } = createStore(makeSnapshot(world));
    render(<AutomationsView store={store} />);
    expect(rowTitles()).toEqual([
      "Invoice reconciliation report",
      "Triage new billing issues",
    ]);
    const status = screen.getByTestId("automations-status");
    expect(status).toHaveTextContent("2 of 6");
    expect(status).toHaveTextContent("Scope: billing-service");
    expect(status).not.toHaveTextContent("All projects");
    // The Scope names the project, so rows do not repeat it.
    expect(row("triage").querySelector('[data-layout="wide"]')).toHaveTextContent(
      /^Every 4 hours · Pi SDK$/u,
    );
    await userEvent
      .setup()
      .click(within(status).getByRole("button", { name: "Clear scope" }));
    expect(rowTitles()).toHaveLength(5);
    expect(
      JSON.parse(localStorage.getItem(SIDEBAR_VIEW_STORAGE_KEY)!)
        .projectFilterId,
    ).toBeNull();
    expect(
      screen.getByRole("searchbox", { name: "Search automations" }),
    ).toHaveFocus();
    expect(status).toHaveTextContent("All projects");
  });

  it("says when a scope has no automations and offers Clear scope", async () => {
    seedScope({ projectFilterId: "project-docs" });
    const { store } = createStore(makeSnapshot(world));
    render(<AutomationsView store={store} />);
    expect(screen.getByText("No automations in docs")).toBeVisible();
    expect(groups()).toHaveLength(0);
    await userEvent
      .setup()
      .click(screen.getAllByRole("button", { name: "Clear scope" })[0]!);
    expect(rowTitles()).toHaveLength(5);
  });

  it("explains an empty list", () => {
    const { store } = createStore(makeSnapshot([world[6]!]));
    render(<AutomationsView store={store} />);
    expect(screen.getByText("No automations yet")).toBeVisible();
    expect(
      screen.getByText(
        "Open a thread’s ⋯ menu and choose Automate… to send it a prompt on a schedule.",
      ),
    ).toBeVisible();
    expect(screen.getByTestId("automations-count")).toHaveTextContent("0");
    expect(screen.queryByTestId("automation-row")).toBeNull();
  });
});

describe("AutomationsView row actions", () => {
  it("runs, pauses and enables from the row menu and announces the result", async () => {
    const user = userEvent.setup();
    const { store, api } = createStore(makeSnapshot(world));
    render(<AutomationsView store={store} />);

    let menu = await openRowMenu(user, "Nightly dependency audit");
    expect(
      within(menu)
        .getAllByRole("menuitem")
        .map((item) => item.textContent),
    ).toEqual(["Run now", "Pause", "Edit…", "Open thread"]);
    await user.click(within(menu).getByRole("menuitem", { name: "Run now" }));
    expect(api.runThreadAutomationNow).toHaveBeenCalledExactlyOnceWith(
      "nightly",
      expect.stringMatching(/^[0-9a-f-]{36}$/u),
    );
    await act(async () => undefined);
    expect(screen.getByRole("status")).toHaveTextContent(
      "Started a run of Nightly dependency audit",
    );

    menu = await openRowMenu(user, "Nightly dependency audit");
    await user.click(within(menu).getByRole("menuitem", { name: "Pause" }));
    expect(api.setThreadAutomationState).toHaveBeenLastCalledWith(
      "nightly",
      "pause",
      4,
      expect.any(String),
    );
    await act(async () => undefined);
    expect(screen.getByRole("status")).toHaveTextContent(
      "Paused Nightly dependency audit",
    );

    menu = await openRowMenu(user, "Weekly release notes draft");
    await user.click(within(menu).getByRole("menuitem", { name: "Enable" }));
    expect(api.setThreadAutomationState).toHaveBeenLastCalledWith(
      "weekly",
      "enable",
      4,
      expect.any(String),
    );
  });

  it("disables Run now, Pause/Enable and Edit with the page's instructions", async () => {
    const user = userEvent.setup();
    const { store, api } = createStore(
      makeSnapshot([
        ...world,
        makeThread("sending", "Sending audit", {
          automation: automation({
            lastRun: run("running", { finishedAt: undefined }),
          }),
        }),
      ]),
    );
    render(<AutomationsView store={store} />);

    let menu = await openRowMenu(user, "Sync staging fixtures");
    const runNow = within(menu).getByRole("menuitem", { name: /^Run now/u });
    expect(runNow).toHaveAttribute("aria-disabled", "true");
    // A short hint shows; the instruction is the tooltip and description.
    expect(runNow).toHaveTextContent("Outcome unknown");
    expect(runNow).toHaveAccessibleDescription("Resolve the unknown run first");
    for (const name of [/^Enable/u, /^Edit…/u]) {
      const item = within(menu).getByRole("menuitem", { name });
      expect(item).toHaveAttribute("aria-disabled", "true");
      expect(item).toHaveAttribute("title", "Resolve the unknown run first");
    }
    await user.click(runNow);
    expect(api.runThreadAutomationNow).not.toHaveBeenCalled();
    await user.keyboard("{Escape}");

    menu = await openRowMenu(user, "Sending audit");
    expect(
      within(menu).getByRole("menuitem", { name: /^Run now/u }),
    ).toHaveAttribute("title", "Wait for the current run to finish");
    expect(
      within(menu).getByRole("menuitem", { name: /^Pause/u }),
    ).toHaveAttribute("aria-disabled", "true");
    await user.keyboard("{Escape}");

    // An archived anchor cannot run or be edited, but its schedule can
    // still be paused.
    await user.click(screen.getByRole("button", { name: "Suspended · 1" }));
    menu = await openRowMenu(user, "Spike: GraphQL gateway");
    expect(
      within(menu).getByRole("menuitem", { name: /^Run now/u }),
    ).toHaveAttribute("title", "Restore the thread first");
    expect(
      within(menu).getByRole("menuitem", { name: /^Edit…/u }),
    ).toHaveAttribute("title", "Restore the thread first");
    expect(
      within(menu).getByRole("menuitem", { name: "Pause" }),
    ).not.toHaveAttribute("aria-disabled");
  });

  it("opens the editor and the thread from the row menu", async () => {
    const user = userEvent.setup();
    const { store } = createStore(makeSnapshot(world));
    const onOpen = vi.fn();
    const removeOpenListener = installThreadPanelOpenRequestListener(
      window,
      onOpen,
    );
    render(<AutomationsView store={store} />);
    let menu = await openRowMenu(user, "Nightly dependency audit");
    await user.click(within(menu).getByRole("menuitem", { name: "Edit…" }));
    expect(window.location.pathname).toBe("/automations/nightly/edit");
    menu = await openRowMenu(user, "Invoice reconciliation report");
    await user.click(
      within(menu).getByRole("menuitem", { name: "Open thread" }),
    );
    expect(onOpen).toHaveBeenCalledWith(
      expect.objectContaining({ threadId: "invoice" }),
    );
    expect(window.location.pathname).toBe("/threads/invoice");
    removeOpenListener();
  });

  it("reports a failed action inline on the row until the next attempt", async () => {
    const user = userEvent.setup();
    const { store, api } = createStore(makeSnapshot(world));
    let reject!: (error: Error) => void;
    api.runThreadAutomationNow.mockImplementationOnce(
      () =>
        new Promise((_resolve, rejectRun) => {
          reject = rejectRun;
        }),
    );
    render(<AutomationsView store={store} />);
    let menu = await openRowMenu(user, "Invoice reconciliation report");
    await user.click(within(menu).getByRole("menuitem", { name: "Run now" }));
    expect(row("invoice")).toHaveAttribute("aria-busy", "true");
    // One action at a time per row.
    menu = await openRowMenu(user, "Invoice reconciliation report");
    expect(
      within(menu).getByRole("menuitem", { name: "Pause" }),
    ).toHaveAttribute("aria-disabled", "true");
    await user.keyboard("{Escape}");
    await act(async () => reject(new Error("The thread is busy.")));
    const alert = screen.getByRole("alert");
    expect(alert).toHaveTextContent(
      "Couldn’t run Invoice reconciliation report",
    );
    expect(alert).toHaveTextContent("The thread is busy.");
    expect(row("invoice")).not.toHaveAttribute("aria-busy");
    expect(row("invoice").closest("li")).toContainElement(alert);
    expect(screen.queryByRole("dialog")).toBeNull();

    menu = await openRowMenu(user, "Invoice reconciliation report");
    await user.click(within(menu).getByRole("menuitem", { name: "Pause" }));
    await act(async () => undefined);
    expect(screen.queryByRole("alert")).toBeNull();
    expect(api.setThreadAutomationState).toHaveBeenCalledOnce();
  });
});

describe("AutomationsView live updates", () => {
  it("follows thread summaries as they change", () => {
    const snapshot = makeSnapshot(world);
    const { store, publish } = createStore(snapshot);
    render(<AutomationsView store={store} />);
    expect(text("nightly", "primary")).toBe(nextLabel(22));

    // Paused elsewhere: the row moves to Paused.
    const paused = structuredClone(snapshot);
    paused.threads[1] = {
      ...paused.threads[1]!,
      automation: automation({
        status: "paused",
        nextRunAt: undefined,
        lastRun: run("completed"),
        revision: 5,
      }),
    };
    publish({ snapshot: paused });
    expect(headings()).toEqual([
      "Needs attention · 2",
      "Upcoming · 1",
      "Paused · 2",
      "Suspended · 1",
    ]);
    expect(text("nightly", "primary")).toBe("Paused");

    // A run starts: the spinner shows and it is upcoming again.
    const running = structuredClone(paused);
    running.threads[1] = {
      ...running.threads[1]!,
      automation: automation({
        status: "paused",
        nextRunAt: undefined,
        lastRun: run("claimed", { id: "run-2", finishedAt: undefined }),
        revision: 5,
      }),
    };
    publish({ snapshot: running });
    expect(text("nightly", "primary")).toBe("Starting");
    expect(
      row("nightly").querySelector('[data-automation-glyph="spinner"]'),
    ).not.toBeNull();

    // A new automation appears and a deleted one leaves; the title is live.
    const changed = structuredClone(running);
    changed.threads = [
      ...changed.threads.filter(({ id }) => id !== "weekly"),
      makeThread("fresh", "Fresh automation", {
        automation: automation({ status: "paused", nextRunAt: undefined }),
      }),
    ];
    changed.threads[0] = {
      ...changed.threads[0]!,
      title: { text: "Triage billing" },
    };
    publish({ snapshot: changed });
    expect(rowTitles()).toContain("Fresh automation");
    expect(rowTitles()).toContain("Triage billing");
    expect(rowTitles()).not.toContain("Weekly release notes draft");
    expect(screen.getByTestId("automations-count")).toHaveTextContent("6");
  });

  it("lists a fork loaded beyond the bootstrap, and opens its page", () => {
    const snapshot = makeSnapshot(world);
    const { store, publish } = createStore(snapshot);
    const commits = vi.fn();
    render(
      <Profiler id="automations" onRender={commits}>
        <AutomationsView store={store} />
      </Profiler>,
    );
    expect(rowTitles()).not.toContain("Nightly audit fork");
    const fork = makeThread("loaded-fork", "Nightly audit fork");
    const descendants = (loading: boolean) =>
      ({
        nightly: { descendants: [{ thread: fork }], loading, loaded: true },
      }) as unknown as ApplicationClientState["descendantPages"];
    publish({ descendantPages: descendants(false) });
    expect(rowTitles()).toContain("Nightly audit fork");
    expect(screen.getByTestId("automations-count")).toHaveTextContent("7");

    // Paging state alone leaves the list as it is.
    commits.mockClear();
    publish({ descendantPages: descendants(true) });
    expect(commits).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("link", { name: "Nightly audit fork" }));
    expect(window.location.pathname).toBe("/automations/loaded-fork");
  });

  it("does not re-render for events that leave the automations unchanged", () => {
    const snapshot = makeSnapshot(world);
    const { store, publish } = createStore(snapshot);
    const commits = vi.fn();
    render(
      <Profiler id="automations" onRender={commits}>
        <AutomationsView store={store} />
      </Profiler>,
    );
    commits.mockClear();
    // A re-parsed snapshot with equal values (new object identities).
    publish({ snapshot: structuredClone(snapshot) });
    // An anchor starts a turn; the connection flickers.
    const busy = structuredClone(snapshot);
    busy.threads[1] = {
      ...busy.threads[1]!,
      runState: "running",
      lastActivityAt: minutesAgo(0),
    };
    publish({ snapshot: busy, connection: "reconnecting" });
    expect(commits).not.toHaveBeenCalled();
    const renamed = structuredClone(busy);
    renamed.threads[1] = {
      ...renamed.threads[1]!,
      title: { text: "Renamed audit" },
    };
    publish({ snapshot: renamed });
    expect(commits).toHaveBeenCalled();
    expect(rowTitles()).toContain("Renamed audit");
  });
});
