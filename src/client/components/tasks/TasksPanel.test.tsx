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
import { useLayoutEffect, useState } from "react";
import type {
  AssociatedTask,
  NormalizedApplicationSnapshot,
  Task,
  WorkspaceFileLinkReference,
} from "../../../shared/index.js";
import type { ApplicationClientStore } from "../../stores/ApplicationClientStore.js";
import {
  navigate,
  threadPath,
  useRoute,
  type Route,
} from "../../app/router.js";
import {
  ComposerDraftProvider,
  useComposerDraftCoordinator,
} from "../../context-excerpts/coordinator.js";
import {
  consumeReveal,
  getPendingReveal,
  getTasksViewOptions,
  revealTask,
  setTasksLastView,
  setTasksViewOptions,
} from "../../app/tasks-panel-store.js";
import { TasksPanel, TasksPanelContent } from "./TasksPanel.js";
import { TasksDockSlot, usePublishTasksDock } from "./tasks-host.js";
import { useMediaQuery } from "../../app/use-media-query.js";
import type { PanelRegionStore } from "../../workspace-panels/region-store.js";

type PanelLayoutStore = Pick<PanelRegionStore, "open">;
import { TASK_DRAG_MIME, TaskDragProvider } from "../../tasks/task-drag.js";
import { CLOSE_TASK_DETAIL_EVENT } from "../../app/android-back.js";

const scrollIntoViewDescriptor = Object.getOwnPropertyDescriptor(
  HTMLElement.prototype,
  "scrollIntoView",
);

function stubDensity(touch: boolean) {
  vi.stubGlobal(
    "matchMedia",
    vi.fn(() => ({
      matches: touch,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })),
  );
}

function resetStorage() {
  window.localStorage.clear();
  // Module caches drop their snapshot on a storage event without a key.
  window.dispatchEvent(new StorageEvent("storage", { key: null }));
}

beforeEach(() => {
  HTMLElement.prototype.scrollIntoView = vi.fn();
  // Desktop shell: Tasks docks beside Chat rather than in front on a phone.
  stubDensity(false);
  resetStorage();
});

afterEach(() => {
  cleanup();
  if (scrollIntoViewDescriptor) {
    Object.defineProperty(HTMLElement.prototype, "scrollIntoView", scrollIntoViewDescriptor);
  } else {
    Reflect.deleteProperty(HTMLElement.prototype, "scrollIntoView");
  }
  const pending = getPendingReveal();
  if (pending) consumeReveal(pending.sequence);
  vi.unstubAllGlobals();
  resetStorage();
  navigate("/", { replace: true });
});

function makeTask(overrides: Partial<AssociatedTask> = {}): AssociatedTask {
  return {
    id: "task-1",
    scope: { kind: "global" },
    associatedProjectId: null,
    title: "Write docs",
    details: "",
    pinned: false,
    backlog: false,
    files: [],
    completedAt: null,
    revision: 0,
    createdAt: "2026-08-01T10:00:00.000Z",
    updatedAt: "2026-08-01T10:00:00.000Z",
    ...overrides,
  };
}

type StoreContext = {
  readonly threads?: readonly unknown[];
  readonly projects?: readonly unknown[];
  readonly workspaces?: readonly unknown[];
  readonly environments?: readonly unknown[];
  readonly resolveFileLink?: (absolutePath: string) =>
    | {
        readonly status: "resolved";
        readonly rootId: string;
        readonly path: string;
        readonly rootVisibility: "listed" | "link_only";
      }
    | { readonly status: "not_found" };
};

/** A store whose snapshot can be republished, so mutations can be reflected. */
function makeStore(
  initialTasks: readonly AssociatedTask[],
  context: StoreContext = {},
): ApplicationClientStore & { publish(tasks: readonly AssociatedTask[]): void } {
  let state = {
    snapshot: {
      threads: context.threads ?? [],
      projects: context.projects ?? [],
      workspaces: context.workspaces ?? [],
      environments: context.environments ?? [],
      tasks: initialTasks,
    },
  };
  const listeners = new Set<() => void>();
  const publish = (tasks: readonly AssociatedTask[]) => {
    state = { snapshot: { ...state.snapshot, tasks } };
    for (const listener of listeners) listener();
  };
  return {
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    getSnapshot: () => state,
    getTasks: () => state.snapshot.tasks,
    publish,
    createTask: vi.fn(
      async (
        title: string,
        scope: Task["scope"],
        details?: string,
        placement: { pinned?: boolean; backlog?: boolean } = {},
      ) =>
        makeTask({
          id: `created-${title}`,
          title,
          scope,
          details: details ?? "",
          pinned: placement.pinned ?? false,
          backlog: placement.backlog ?? false,
        }),
    ),
    updateTask: vi.fn(async (task: Task, changes: Partial<Task>) => ({
      ...task,
      ...changes,
      revision: task.revision + 1,
    })),
    moveTask: vi.fn(async (task: Task, scope: Task["scope"]) => ({
      ...task,
      scope,
      revision: task.revision + 1,
    })),
    deleteTask: vi.fn(async () => undefined),
    api: {
      resolveWorkspaceFileLink: vi.fn(
        async (_workspaceId: string, input: WorkspaceFileLinkReference) =>
          context.resolveFileLink?.(input.path) ?? {
            status: "resolved",
            rootId: "primary",
            path: input.path.replace(/^\/workspace\//, ""),
            rootVisibility: "listed",
          },
      ),
    },
  } as unknown as ApplicationClientStore & {
    publish(tasks: readonly AssociatedTask[]): void;
  };
}

function makePanelLayoutStore(): { open: ReturnType<typeof vi.fn> } & PanelLayoutStore {
  return { open: vi.fn(() => true) } as unknown as { open: ReturnType<typeof vi.fn> } & PanelLayoutStore;
}

function DraftConsumer({
  stageTaskReference,
}: {
  readonly stageTaskReference: (reference: unknown) => void;
}): null {
  const coordinator = useComposerDraftCoordinator();
  useLayoutEffect(
    () =>
      coordinator?.registerConsumer({
        stage: () => ({ ok: true }),
        attachAndSubmit: () => ({ ok: true }),
        stageTaskReference: (reference) => {
          stageTaskReference(reference);
          return { ok: true };
        },
        getSnapshot: () => ({ available: true }),
      }),
    [coordinator, stageTaskReference],
  );
  return null;
}

/**
 * Stands in for a thread workspace with the Tasks panel loaded in it: docked,
 * or in front on a phone, where Chat can come in front of it.
 */
function DockedTasks({ active }: { readonly active: boolean }): React.JSX.Element {
  const [present, setPresent] = useState(true);
  const [shown, setShown] = useState(true);
  const phone = useMediaQuery("(max-width: 819px)");
  usePublishTasksDock({
    present,
    visible: present && shown && active,
    presentation: phone ? "sheet" : "panel",
    controls: {
      active,
      onClose: () => setPresent(false),
    },
    open: () => {
      setPresent(true);
      setShown(true);
    },
    // Hides a shown panel, keeping it loaded; shows (or loads) otherwise.
    toggle: () => {
      if (present && shown) setShown(false);
      else {
        setPresent(true);
        setShown(true);
      }
    },
    close: () => setPresent(false),
    // Chat in front: Tasks leaves the stage and stays loaded.
    showChat: () => setShown(false),
  });
  // Settings hides the retained workspace (and so the docked panel).
  return (
    <div hidden={!active || !shown}>
      {present ? <TasksDockSlot /> : null}
    </div>
  );
}

/**
 * The Tasks host as the application shell mounts it, around a thread
 * workspace. Pages without a thread have no Tasks.
 */
function TasksHarness({
  store,
  panelLayoutStore,
  route: retainedRoute,
  active = true,
}: {
  readonly store: ApplicationClientStore;
  readonly panelLayoutStore: PanelLayoutStore;
  readonly route?: Route;
  readonly active?: boolean;
}): React.JSX.Element {
  const currentRoute = useRoute();
  const route = retainedRoute ?? currentRoute;
  return (
    <TasksPanel
      store={store}
      panelLayoutStore={panelLayoutStore}
      route={route}
      active={active}
    >
      {route.name === "thread" ? <DockedTasks active={active} /> : null}
    </TasksPanel>
  );
}

function renderPanel(
  store: ApplicationClientStore,
  options: {
    readonly panelLayoutStore?: PanelLayoutStore;
    readonly stageTaskReference?: (reference: unknown) => void;
    readonly drag?: boolean;
  } = {},
) {
  const panel = (
    <ComposerDraftProvider threadId="thread-9" workspaceId="workspace-1">
      {options.stageTaskReference && (
        <DraftConsumer stageTaskReference={options.stageTaskReference} />
      )}
      <TasksHarness
        store={store}
        panelLayoutStore={options.panelLayoutStore ?? makePanelLayoutStore()}
      />
    </ComposerDraftProvider>
  );
  const view = render(
    options.drag ? (
      <TaskDragProvider
        store={store}
        snapshot={store.getSnapshot().snapshot as NormalizedApplicationSnapshot}
      >
        {panel}
      </TaskDragProvider>
    ) : (
      panel
    ),
  );
  return view;
}

const THREADS = [
  {
    id: "thread-9",
    workspaceId: "workspace-1",
    title: { text: "Checkout flow refactor" },
    inventoryState: "active",
  },
  {
    id: "thread-2",
    workspaceId: "workspace-1",
    title: { text: "Sibling thread" },
    inventoryState: "active",
  },
  {
    id: "thread-other",
    workspaceId: "workspace-2",
    title: { text: "Invoice rounding bug" },
    inventoryState: "active",
  },
  {
    id: "thread-archived",
    workspaceId: "workspace-1",
    title: { text: "Archived thread" },
    inventoryState: "archived",
  },
];

const WORKSPACES = [
  {
    id: "workspace-1",
    environmentId: "local",
    projectId: "project-1",
    label: { text: "acme-web" },
    displayPath: { text: "/workspace" },
    available: true,
  },
  {
    id: "workspace-2",
    environmentId: "local",
    projectId: "project-2",
    label: { text: "billing-service" },
    displayPath: { text: "/billing" },
    available: true,
  },
];

const PROJECTS = [
  { id: "project-1", name: "acme-web", revision: 0 },
  { id: "project-2", name: "billing-service", revision: 0 },
];

const ENVIRONMENTS = [{ id: "local", kind: "local", label: { text: "Local" }, available: true }];

const threadTask = (overrides: Partial<AssociatedTask> = {}) =>
  makeTask({
    scope: { kind: "thread", threadId: "thread-9" },
    associatedProjectId: "project-1",
    ...overrides,
  });

/** A thread route in acme-web with tasks in every scope. */
function seededStore(extra: readonly AssociatedTask[] = []) {
  act(() => navigate(threadPath("thread-9")));
  return makeStore(
    [
      threadTask({ id: "t-audit", title: "Audit checkout error states", createdAt: "2026-08-03T10:00:00.000Z", details: "Walk every error branch.", files: ["/workspace/src/checkout.ts"], pinned: true }),
      threadTask({ id: "t-retry", title: "Add retry to the payment call", createdAt: "2026-08-02T10:00:00.000Z" }),
      threadTask({ id: "t-done", title: "Remove the legacy flag", completedAt: "2026-08-04T10:00:00.000Z" }),
      makeTask({ id: "p-upgrade", title: "Upgrade the test runner", scope: { kind: "project", projectId: "project-1" }, associatedProjectId: "project-1" }),
      makeTask({ id: "s-sibling", title: "Sibling thread task", scope: { kind: "thread", threadId: "thread-2" }, associatedProjectId: "project-1" }),
      makeTask({ id: "o-other", title: "Round invoices half-even", scope: { kind: "thread", threadId: "thread-other" }, associatedProjectId: "project-2" }),
      makeTask({ id: "g-rotate", title: "Rotate staging credentials" }),
      ...extra,
    ],
    { threads: THREADS, projects: PROJECTS, workspaces: WORKSPACES, environments: ENVIRONMENTS },
  );
}

const panel = () => screen.getByRole("region", { name: "Tasks" });
/** Whether a polite live region currently says `text`. */
const announced = (text: string) =>
  screen.queryAllByRole("status").some((region) => region.textContent === text);
const scope = () => screen.getByRole("radiogroup", { name: "Task scope view" });
const segment = (name: string) => within(scope()).getByRole("radio", { name });
const rowTitle = (title: string) => screen.getByRole("button", { name: title });
const rowOf = (title: string) => rowTitle(title).closest(".tasks-row") as HTMLElement;
const titles = () =>
  [...panel().querySelectorAll(".tasks-row-title")].map(
    (node) => (node.querySelector(".tasks-row-title-text") ?? node).textContent,
  );
const addInput = () => screen.getByRole("textbox", { name: "Add a task" });
/** What a task added with no Pinned or Backlog filter on is created with. */
const UNPLACED = { pinned: false, backlog: false };

/**
 * Opens a desktop submenu by keyboard from its row (pointer moves between
 * menus are not modelled by jsdom) and returns it.
 */
async function openSubmenu(
  user: ReturnType<typeof userEvent.setup>,
  menu: HTMLElement,
  name: string,
): Promise<HTMLElement> {
  within(menu).getByRole("menuitem", { name }).focus();
  await user.keyboard("{ArrowRight}");
  return screen.findByRole("menu", { name });
}

describe("TasksPanel scope", () => {
  it("follows the chat with one scope control showing open counts", () => {
    renderPanel(seededStore());

    expect(segment("Thread")).toHaveAttribute("aria-checked", "true");
    expect(segment("Thread")).toHaveAccessibleDescription("2 open");
    expect(segment("Project")).toHaveAccessibleDescription("1 open");
    expect(segment("Global")).toHaveAccessibleDescription("1 open");
    expect(segment("All")).toHaveAccessibleDescription("6 open");
    // Docked beside the chat: the title and count sit in the panel's header.
    expect(panel()).toHaveAttribute("data-presentation", "panel");
    expect(
      within(panel()).getByRole("banner", { name: "Tasks panel header" }),
    ).toHaveTextContent("Tasks2");
    expect(titles()).toEqual(["Audit checkout error states", "Add retry to the payment call"]);
    // One control: no destination pickers and no nested-scope checkbox.
    expect(screen.queryByRole("combobox")).not.toBeInTheDocument();
    expect(screen.queryByText("Include nested scopes")).not.toBeInTheDocument();
    expect(addInput()).toHaveAttribute("placeholder", "Add a task to this thread…");
  });

  it("switches views, remembers the last one and adds to the scope in view", async () => {
    const store = seededStore();
    const view = renderPanel(store);

    fireEvent.click(segment("Project"));
    expect(titles()).toEqual(["Upgrade the test runner"]);
    expect(addInput()).toHaveAttribute("placeholder", "Add a task to this project…");
    fireEvent.click(segment("Global"));
    expect(titles()).toEqual(["Rotate staging credentials"]);
    fireEvent.click(segment("All"));
    expect(addInput()).toHaveAttribute("placeholder", "Add a global task…");
    fireEvent.change(addInput(), { target: { value: "From All" } });
    fireEvent.keyDown(addInput(), { key: "Enter" });
    await vi.waitFor(() =>
      expect(store.createTask).toHaveBeenCalledWith("From All", { kind: "global" }, undefined, UNPLACED),
    );

    view.unmount();
    renderPanel(store);
    expect(segment("All")).toHaveAttribute("aria-checked", "true");
  });

  it("says why an archived thread has no Thread view", () => {
    act(() => navigate(threadPath("thread-archived")));
    const store = makeStore([makeTask()], { threads: THREADS, projects: PROJECTS, workspaces: WORKSPACES });
    renderPanel(store);

    const archived = "This thread is archived. Restore it to see its tasks.";
    expect(segment("Thread")).toBeDisabled();
    // The last view, Thread, narrows to the archived thread's project.
    expect(segment("Project")).toHaveAttribute("aria-checked", "true");
    expect(scope()).toHaveAccessibleDescription(`Thread: ${archived}`);
    // Each segment carries its own reason, and nothing relies on a native title.
    expect(segment("Thread")).toHaveAccessibleDescription(archived);
    expect(segment("Project")).toHaveAccessibleDescription("0 open");
    expect(segment("Global")).toHaveAccessibleDescription("1 open");
    expect(scope().querySelector("[title]")).toBeNull();
  });

  it("disables Thread and Project for a thread the snapshot does not hold", () => {
    act(() => navigate(threadPath("thread-missing")));
    const store = makeStore([makeTask()], { threads: THREADS, projects: PROJECTS, workspaces: WORKSPACES });
    renderPanel(store);

    expect(segment("Thread")).toBeDisabled();
    expect(segment("Project")).toBeDisabled();
    expect(segment("Global")).toHaveAttribute("aria-checked", "true");
    expect(scope()).toHaveAccessibleDescription(
      "Thread: This thread isn't available. Project: This thread's project isn't available.",
    );
    expect(segment("Thread")).toHaveAccessibleDescription("This thread isn't available.");
    expect(segment("Project")).toHaveAccessibleDescription(
      "This thread's project isn't available.",
    );
  });

  it("shows a disabled view's reason when its segment is tapped", async () => {
    act(() => navigate(threadPath("thread-archived")));
    const store = makeStore([makeTask()], { threads: THREADS, projects: PROJECTS, workspaces: WORKSPACES });
    // The tooltip's positioning measures its arrow.
    vi.stubGlobal("ResizeObserver", class { observe(): void {} unobserve(): void {} disconnect(): void {} });
    renderPanel(store);
    expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();

    // A disabled segment takes no pointer events: the tap lands on its slot.
    fireEvent.click(segment("Thread").parentElement!);

    expect(await screen.findByRole("tooltip")).toHaveTextContent(
      "This thread is archived. Restore it to see its tasks.",
    );
    expect(segment("Project")).toHaveAttribute("aria-checked", "true");
  });

  it("lists every task in All as one flat list, each row saying where it belongs", () => {
    renderPanel(seededStore());
    fireEvent.click(segment("All"));

    // No group headings, only the Completed section: every open task in
    // the view's order, pinned first, whatever its scope.
    expect(
      [...panel().querySelectorAll(".list-heading")].map((node) => node.textContent),
    ).toEqual(["Completed1"]);
    expect(titles()).toEqual([
      "Audit checkout error states",
      "Add retry to the payment call",
      "Rotate staging credentials",
      "Round invoices half-even",
      "Upgrade the test runner",
      "Sibling thread task",
    ]);
    expect(rowTitle("Rotate staging credentials")).toHaveAccessibleDescription("In Global");
    expect(rowTitle("Upgrade the test runner")).toHaveAccessibleDescription("In acme-web");
    // A thread task names its project too.
    expect(rowTitle("Add retry to the payment call")).toHaveAccessibleDescription(
      "In Checkout flow refactor · acme-web",
    );
    expect(rowOf("Round invoices half-even").querySelector(".scope-location")).toHaveTextContent(
      "Invoice rounding bug · billing-service",
    );
    expect(rowOf("Round invoices half-even").querySelector(".scope-location .lucide-message-square")).not.toBeNull();
    expect(rowOf("Rotate staging credentials").querySelector(".scope-location .lucide-globe")).not.toBeNull();
    expect(rowOf("Upgrade the test runner").querySelector(".scope-location .lucide-folder")).not.toBeNull();
  });

  it("includes a project's thread tasks only through the Project view option", async () => {
    const user = userEvent.setup();
    renderPanel(seededStore());
    await user.click(segment("Project"));
    expect(titles()).toEqual(["Upgrade the test runner"]);

    await user.click(screen.getByRole("button", { name: "View options" }));
    await user.click(screen.getByRole("menuitemcheckbox", { name: "Include thread tasks" }));
    await user.keyboard("{Escape}");
    expect(titles()).toEqual([
      "Audit checkout error states",
      "Add retry to the payment call",
      "Upgrade the test runner",
      "Sibling thread task",
    ]);
    expect(segment("Project")).toHaveAccessibleDescription("4 open");
    expect(titles()).not.toContain("Round invoices half-even");
    // Without group headings, each row says where it belongs on a second
    // line; its name stays the title.
    expect(rowTitle("Sibling thread task")).toHaveAccessibleDescription("In Sibling thread");
    expect(rowTitle("Upgrade the test runner")).toHaveAccessibleDescription("In acme-web");
    expect(rowOf("Sibling thread task").querySelector(".scope-location")).toHaveTextContent(
      "Sibling thread",
    );
    // The option shows while it is on: a chip, and the View options dot.
    // It adds tasks, so it is not a filter the empty list offers to reset.
    expect(screen.getByRole("button", { name: "View options" })).toHaveAttribute("data-filtering", "true");
    const chip = screen.getByRole("button", { name: "Remove filter: Thread tasks" });
    await user.click(chip);
    expect(titles()).toEqual(["Upgrade the test runner"]);
    expect(getTasksViewOptions("project").includeThreadTasks).toBe(false);
    expect(screen.queryByRole("group", { name: "View filters" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "View options" })).not.toHaveAttribute("data-filtering");
    // Removing the last chip leaves focus on the selected view.
    expect(segment("Project")).toHaveFocus();
  });

  it("keeps the thread-tasks chip out of the empty list's reset offer", () => {
    setTasksViewOptions("project", { includeThreadTasks: true });
    setTasksLastView("project");
    act(() => navigate(threadPath("thread-9")));
    renderPanel(makeStore([], { threads: THREADS, projects: PROJECTS, workspaces: WORKSPACES }));
    expect(screen.getByRole("button", { name: "Remove filter: Thread tasks" })).toBeInTheDocument();
    expect(screen.getByText("No tasks for this project yet.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Reset view options" })).not.toBeInTheDocument();
  });

  it("offers no grouping in All's View options", async () => {
    const user = userEvent.setup();
    renderPanel(seededStore());
    await user.click(segment("All"));
    await user.click(screen.getByRole("button", { name: "View options" }));
    expect(screen.queryByRole("menuitemcheckbox", { name: "Group by project" })).not.toBeInTheDocument();
    expect(screen.queryByRole("menuitemcheckbox", { name: "Include thread tasks" })).not.toBeInTheDocument();
    await user.keyboard("{Escape}");
    // Nor anything to collapse in the panel's menu.
    await user.click(screen.getByRole("button", { name: "Tasks panel actions" }));
    expect(screen.getByRole("menuitem", { name: "Add a task with notes" })).toBeInTheDocument();
    expect(screen.queryByRole("menuitem", { name: /all groups$/ })).not.toBeInTheDocument();
  });
});

// acme-web also has a checkout on a build host: one project, two locations.
const SHARED_ENVIRONMENTS = [
  ...ENVIRONMENTS,
  { id: "build", kind: "ssh", label: { text: "Build host" }, available: true },
];
const SHARED_WORKSPACES = [
  ...WORKSPACES,
  {
    id: "workspace-3",
    environmentId: "build",
    projectId: "project-1",
    label: { text: "acme-web" },
    displayPath: { text: "/srv/acme-web" },
    available: true,
  },
];
const SHARED_THREADS = [
  ...THREADS,
  {
    id: "thread-remote",
    workspaceId: "workspace-3",
    title: { text: "Remote checkout" },
    inventoryState: "active",
  },
];

/** A route on `threadId` with tasks from both of acme-web's locations. */
function sharedProjectStore(threadId: string) {
  act(() => navigate(threadPath(threadId)));
  return makeStore(
    [
      threadTask({ id: "t-retry", title: "Add retry to the payment call", createdAt: "2026-08-02T10:00:00.000Z" }),
      makeTask({ id: "p-upgrade", title: "Upgrade the test runner", scope: { kind: "project", projectId: "project-1" }, associatedProjectId: "project-1", createdAt: "2026-08-03T10:00:00.000Z", files: ["/workspace/package.json"] }),
      makeTask({ id: "r-deploy", title: "Deploy from the build host", scope: { kind: "thread", threadId: "thread-remote" }, associatedProjectId: "project-1", createdAt: "2026-08-04T10:00:00.000Z" }),
      makeTask({ id: "o-other", title: "Round invoices half-even", scope: { kind: "thread", threadId: "thread-other" }, associatedProjectId: "project-2" }),
    ],
    { threads: SHARED_THREADS, projects: PROJECTS, workspaces: SHARED_WORKSPACES, environments: SHARED_ENVIRONMENTS },
  );
}

describe("TasksPanel across a project's locations", () => {
  it("shows a thread on another host the tasks of its whole project", async () => {
    const user = userEvent.setup();
    const store = sharedProjectStore("thread-remote");
    renderPanel(store);

    await user.click(segment("Project"));
    expect(titles()).toEqual(["Upgrade the test runner"]);
    expect(segment("Project")).toHaveAccessibleDescription("1 open");

    await user.click(screen.getByRole("button", { name: "View options" }));
    await user.click(screen.getByRole("menuitemcheckbox", { name: "Include thread tasks" }));
    await user.keyboard("{Escape}");
    // Thread tasks of threads in every location, each saying where it runs.
    expect(titles()).toEqual([
      "Deploy from the build host",
      "Upgrade the test runner",
      "Add retry to the payment call",
    ]);
    expect(rowTitle("Deploy from the build host")).toHaveAccessibleDescription(
      "In Remote checkout · Build host",
    );
    expect(rowTitle("Add retry to the payment call")).toHaveAccessibleDescription(
      "In Checkout flow refactor",
    );
    expect(rowTitle("Upgrade the test runner")).toHaveAccessibleDescription("In acme-web");

    // Adding to the project never asks for a location.
    fireEvent.change(addInput(), { target: { value: "Share with every checkout" } });
    fireEvent.keyDown(addInput(), { key: "Enter" });
    await vi.waitFor(() =>
      expect(store.createTask).toHaveBeenCalledWith(
        "Share with every checkout",
        { kind: "project", projectId: "project-1" },
        undefined,
        UNPLACED,
      ),
    );
    expect(screen.queryByRole("combobox")).not.toBeInTheDocument();
  });

  it("names each thread's project in All, and where it runs", () => {
    renderPanel(sharedProjectStore("thread-9"));
    fireEvent.click(segment("All"));
    expect(rowTitle("Deploy from the build host")).toHaveAccessibleDescription(
      "In Remote checkout · acme-web · Build host",
    );
    expect(rowTitle("Upgrade the test runner")).toHaveAccessibleDescription("In acme-web");
  });

  it("offers each project once as a destination, described by its locations", async () => {
    const user = userEvent.setup();
    const store = sharedProjectStore("thread-other");
    renderPanel(store);

    await user.click(screen.getByRole("button", { name: 'Actions for "Round invoices half-even"' }));
    const moveMenu = await openSubmenu(user, screen.getByRole("menu"), "Move to");
    within(moveMenu).getByRole("menuitem", { name: "Choose…" }).focus();
    await user.keyboard("{Enter}");
    const dialog = screen.getByRole("dialog", { name: "Move task" });
    const projects = within(within(dialog).getByRole("group", { name: "Projects" })).getAllByRole("option");
    expect(projects.map((option) => option.textContent)).toEqual([
      "acme-web 2 locations · Local, Build host",
    ]);
    expect(projects[0]).toHaveAttribute("title", "acme-web\n2 locations · Local, Build host");
    const threads = within(within(dialog).getByRole("group", { name: "Threads" })).getAllByRole("option");
    expect(threads.map((option) => option.textContent)).toEqual([
      "Checkout flow refactor acme-web",
      "Remote checkout acme-web · Build host",
      "Sibling thread acme-web",
    ]);
    await user.click(projects[0]!);

    expect(store.moveTask).toHaveBeenCalledWith(
      expect.objectContaining({ id: "o-other" }),
      { kind: "project", projectId: "project-1" },
    );
  });

  it("moves a task with files between a project's locations without asking", async () => {
    const user = userEvent.setup();
    const store = sharedProjectStore("thread-remote");
    renderPanel(store);
    await user.click(segment("Project"));

    // The thread runs on the other host, but in the same project.
    await user.click(screen.getByRole("button", { name: 'Actions for "Upgrade the test runner"' }));
    const moveMenu = await openSubmenu(user, screen.getByRole("menu"), "Move to");
    within(moveMenu).getByRole("menuitem", { name: "This thread" }).focus();
    await user.keyboard("{Enter}");

    expect(screen.queryByRole("dialog", { name: "Move task with project files?" })).not.toBeInTheDocument();
    expect(store.moveTask).toHaveBeenCalledWith(
      expect.objectContaining({ id: "p-upgrade" }),
      { kind: "thread", threadId: "thread-remote" },
    );
  });
});

describe("TasksPanel add row", () => {
  it("adds with Enter, keeps focus and stays enabled while another task saves", async () => {
    const user = userEvent.setup();
    const store = seededStore();
    let finishFirst: (task: AssociatedTask) => void = () => undefined;
    vi.mocked(store.createTask).mockImplementationOnce(
      () => new Promise<Task>((resolve) => { finishFirst = resolve; }),
    );
    renderPanel(store);

    await user.click(addInput());
    await user.keyboard("First task{Enter}");
    expect(addInput()).toHaveFocus();
    expect(addInput()).toHaveValue("");
    expect(addInput()).toBeEnabled();
    const creating = panel().querySelector('.tasks-row[data-creating="true"]');
    expect(creating).toHaveTextContent("First task");

    await user.keyboard("Second task{Enter}");
    expect(store.createTask).toHaveBeenCalledTimes(2);
    expect(addInput()).toHaveFocus();
    // Other rows stay usable while the first creation is in flight.
    await user.click(screen.getByRole("checkbox", { name: 'Mark "Add retry to the payment call" as done' }));
    expect(store.updateTask).toHaveBeenCalledWith(
      expect.objectContaining({ id: "t-retry" }),
      { completed: true },
    );

    const created = threadTask({ id: "created-first", title: "First task" });
    await act(async () => {
      finishFirst(created);
      store.publish([...store.getTasks(), created]);
    });
    expect(panel().querySelectorAll('.tasks-row[data-creating="true"]')).toHaveLength(1);
    expect(rowTitle("First task")).toBeInTheDocument();
  });

  it("opens notes with Shift+Enter and creates the task with them", async () => {
    const user = userEvent.setup();
    const store = seededStore();
    renderPanel(store);

    await user.click(addInput());
    await user.keyboard("Profile the bundle{Shift>}{Enter}{/Shift}");
    const notes = screen.getByRole("textbox", { name: "New task notes" });
    await waitFor(() => expect(notes).toHaveFocus());
    await user.keyboard("Measure before and after.{Enter}Twice.");
    expect(store.createTask).not.toHaveBeenCalled();
    await user.keyboard("{Control>}{Enter}{/Control}");

    expect(store.createTask).toHaveBeenCalledWith(
      "Profile the bundle",
      { kind: "thread", threadId: "thread-9" },
      "Measure before and after.\nTwice.",
      UNPLACED,
    );
    expect(screen.queryByRole("textbox", { name: "New task notes" })).not.toBeInTheDocument();
    expect(addInput()).toHaveFocus();
  });

  it("asks before turning a multi-line paste into one task per line", async () => {
    const user = userEvent.setup();
    const store = seededStore();
    renderPanel(store);

    await user.click(addInput());
    await user.paste("- [ ] Write the migration\n\n2. Ship it\n* Tell support\n");
    expect(screen.getByRole("textbox", { name: "Add a task", hidden: true })).toHaveValue("");
    const dialog = screen.getByRole("dialog", { name: "Create 3 tasks?" });
    expect(within(dialog).getAllByRole("listitem").map((item) => item.textContent)).toEqual([
      "Write the migration",
      "Ship it",
      "Tell support",
    ]);
    await user.click(within(dialog).getByRole("button", { name: "Create 3 tasks" }));

    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Create 3 tasks?" })).not.toBeInTheDocument());
    // Created last line first, so newest-first reads in pasted order.
    expect(vi.mocked(store.createTask).mock.calls.map(([title]) => title)).toEqual([
      "Tell support",
      "Ship it",
      "Write the migration",
    ]);
    expect(store.createTask).toHaveBeenCalledWith("Ship it", { kind: "thread", threadId: "thread-9" }, undefined, UNPLACED);
  });

  it("keeps a single-line paste in the field", async () => {
    const user = userEvent.setup();
    renderPanel(seededStore());
    await user.click(addInput());
    await user.paste("Just one line");
    expect(addInput()).toHaveValue("Just one line");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("creates a pinned task from the add row and resets the choice for the next task", async () => {
    const user = userEvent.setup();
    const store = seededStore();
    renderPanel(store);
    const pin = screen.getByRole("button", { name: "Pin new task" });
    await user.click(pin);
    expect(pin).toHaveAttribute("aria-pressed", "true");
    await user.click(addInput());
    await user.keyboard("Keep this handy{Enter}");
    expect(store.createTask).toHaveBeenCalledWith("Keep this handy", { kind: "thread", threadId: "thread-9" }, undefined, { pinned: true, backlog: false });
    expect(pin).toHaveAttribute("aria-pressed", "false");
  });

  it("lets the paste dialog override the add row's pin choice", async () => {
    const user = userEvent.setup();
    const store = seededStore();
    renderPanel(store);
    await user.click(screen.getByRole("button", { name: "Pin new task" }));
    await user.click(addInput());
    await user.paste("First task\nSecond task");
    const dialog = screen.getByRole("dialog", { name: "Create 2 tasks?" });
    const pin = within(dialog).getByRole("switch", { name: "Pin these tasks" });
    expect(pin).toBeChecked();
    await user.click(pin);
    await user.click(within(dialog).getByRole("button", { name: "Create 2 tasks" }));
    await waitFor(() => expect(store.createTask).toHaveBeenCalledTimes(2));
    for (const call of vi.mocked(store.createTask).mock.calls) expect(call[3]).toEqual({ pinned: false, backlog: false });
  });

  it("gives the title back and explains when creation fails", async () => {
    const user = userEvent.setup();
    const store = seededStore();
    vi.mocked(store.createTask).mockRejectedValueOnce(new Error("Scope was archived."));
    renderPanel(store);

    await user.click(addInput());
    await user.keyboard("Doomed task{Enter}");

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Couldn't add “Doomed task”: Scope was archived.",
    );
    expect(addInput()).toHaveValue("Doomed task");
    expect(panel().querySelector('[data-creating="true"]')).toBeNull();
  });
});

describe("TasksPanel rows", () => {
  it("collapses completed tasks into a muted Completed section, where they reopen", async () => {
    const user = userEvent.setup();
    const store = seededStore();
    renderPanel(store);

    const completed = screen.getByRole("button", { name: /Completed/ });
    expect(completed).toHaveTextContent("Completed1");
    expect(completed).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByRole("button", { name: "Remove the legacy flag" })).not.toBeInTheDocument();
    await user.click(completed);
    expect(rowOf("Remove the legacy flag")).toHaveAttribute("data-completed", "true");
    expect(
      within(rowOf("Remove the legacy flag")).getByRole("checkbox", { name: 'Mark "Remove the legacy flag" as open' }),
    ).toBeChecked();

    await user.click(screen.getByRole("checkbox", { name: 'Mark "Add retry to the payment call" as done' }));
    expect(store.updateTask).toHaveBeenLastCalledWith(
      expect.objectContaining({ id: "t-retry", revision: 0 }),
      { completed: true },
    );
    store.publish(
      store.getTasks().map((task) =>
        task.id === "t-retry" ? { ...task, completedAt: "2026-08-05T10:00:00.000Z", revision: 1 } : task,
      ),
    );
    await waitFor(() => expect(completed).toHaveTextContent("Completed2"));
    // Most recently completed first.
    expect(titles()).toEqual([
      "Audit checkout error states",
      "Add retry to the payment call",
      "Remove the legacy flag",
    ]);

    // A completed task reopens from its row in the Completed section.
    await user.click(screen.getByRole("checkbox", { name: 'Mark "Add retry to the payment call" as open' }));
    expect(store.updateTask).toHaveBeenLastCalledWith(
      expect.objectContaining({ id: "t-retry", revision: 1 }),
      { completed: false },
    );
  });

  it("expands one row at a time with notes, files, facts and actions", async () => {
    const user = userEvent.setup();
    renderPanel(seededStore());

    await user.click(rowTitle("Audit checkout error states"));
    const detail = screen.getByRole("group", { name: "Audit checkout error states details" });
    expect(rowTitle("Audit checkout error states")).toHaveAttribute("aria-expanded", "true");
    expect(within(detail).getByText("Walk every error branch.")).toBeInTheDocument();
    const file = within(detail).getByRole("button", { name: "Open /workspace/src/checkout.ts in Files" });
    expect(file).toHaveTextContent("src/checkout.ts");
    expect(within(detail).getByText(/^Added .* in/)).toBeInTheDocument();
    expect(within(detail).getByRole("button", { name: "Checkout flow refactor" })).toBeInTheDocument();
    expect(within(detail).getByRole("button", { name: "Add to prompt" })).toBeEnabled();
    expect(within(detail).getByRole("button", { name: "Edit" })).toBeInTheDocument();
    expect(within(detail).getByRole("button", { name: "Move to…" })).toBeInTheDocument();
    expect(within(rowOf("Audit checkout error states")).getByText("has notes, 1 file, pinned")).toBeInTheDocument();

    await user.click(rowTitle("Add retry to the payment call"));
    expect(screen.queryByRole("group", { name: "Audit checkout error states details" })).not.toBeInTheDocument();
    expect(screen.getByRole("group", { name: "Add retry to the payment call details" })).toBeInTheDocument();
    await user.click(rowTitle("Add retry to the payment call"));
    expect(screen.queryByRole("group", { name: /details$/ })).not.toBeInTheDocument();
  });

  it("stages Add to prompt and keeps the docked surface open", async () => {
    const user = userEvent.setup();
    const stageTaskReference = vi.fn();
    renderPanel(seededStore(), { stageTaskReference });

    await user.click(rowTitle("Add retry to the payment call"));
    await user.click(screen.getByRole("button", { name: "Add to prompt" }));

    expect(stageTaskReference).toHaveBeenCalledWith({
      taskId: "t-retry",
      titleSnapshot: "Add retry to the payment call",
    });
    expect(panel()).toBeInTheDocument();
  });

  it("explains when no composer can receive the task", async () => {
    const user = userEvent.setup();
    renderPanel(seededStore());
    await user.click(rowTitle("Add retry to the payment call"));
    await user.click(screen.getByRole("button", { name: "Add to prompt" }));
    expect(screen.getByRole("alert")).toHaveTextContent("The message composer is unavailable.");
  });

  it("moves through the row menu", async () => {
    const user = userEvent.setup();
    const store = seededStore();
    renderPanel(store);

    await user.click(screen.getByRole("button", { name: 'Actions for "Add retry to the payment call"' }));
    const menu = screen.getByRole("menu");
    expect(within(menu).getAllByRole("menuitem").map((item) => item.textContent)).toEqual([
      "Add to prompt",
      "Edit…E",
      "PinP",
      "Send to BacklogB",
      "Move to",
      "Delete…",
    ]);
    // The key hints are visual; the names stay plain and the keys are exposed.
    expect(within(menu).getByRole("menuitem", { name: "Pin" })).toHaveAttribute("aria-keyshortcuts", "P");
    expect(within(menu).getByRole("menuitem", { name: "Send to Backlog" })).toHaveAttribute("aria-keyshortcuts", "B");
    const moveMenu = await openSubmenu(user, menu, "Move to");
    expect(within(moveMenu).getAllByRole("menuitem").map((item) => item.textContent)).toEqual([
      "This threadCurrent",
      "This project",
      "Global",
      "Choose…",
    ]);
    expect(within(moveMenu).getByRole("menuitem", { name: /This thread/ })).toHaveAttribute("data-disabled");
    // The first enabled row has focus; the current scope is skipped.
    expect(within(moveMenu).getByRole("menuitem", { name: "This project" })).toHaveFocus();
    await user.keyboard("{Enter}");

    expect(store.moveTask).toHaveBeenCalledWith(
      expect.objectContaining({ id: "t-retry" }),
      { kind: "project", projectId: "project-1" },
    );
    await waitFor(() => expect(announced("Moved “Add retry to the payment call” to acme-web.")).toBe(true));
  });

  it("pins from the row menu without expanding the row", async () => {
    const user = userEvent.setup();
    const store = seededStore();
    renderPanel(store);

    await user.click(screen.getByRole("button", { name: 'Actions for "Add retry to the payment call"' }));
    await user.click(screen.getByRole("menuitem", { name: "Pin" }));
    expect(store.updateTask).toHaveBeenCalledWith(
      expect.objectContaining({ id: "t-retry" }),
      { pinned: true },
    );
    // Menu clicks bubble through React from the portal; they must not toggle the row.
    expect(rowTitle("Add retry to the payment call")).toHaveAttribute("aria-expanded", "false");
    await user.click(rowTitle("Add retry to the payment call"));
    expect(rowTitle("Add retry to the payment call")).toHaveAttribute("aria-expanded", "true");
  });

  it("chooses any destination once, without listing the current thread twice", async () => {
    const user = userEvent.setup();
    const store = seededStore();
    renderPanel(store);

    await user.click(screen.getByRole("button", { name: 'Actions for "Add retry to the payment call"' }));
    const moveMenu = await openSubmenu(user, screen.getByRole("menu"), "Move to");
    within(moveMenu).getByRole("menuitem", { name: "Choose…" }).focus();
    await user.keyboard("{Enter}");
    const dialog = screen.getByRole("dialog", { name: "Move task" });
    const options = within(dialog).getAllByRole("option").map((option) => option.textContent);
    expect(options.filter((label) => label?.includes("Checkout flow refactor"))).toEqual([
      "This thread · Checkout flow refactor",
    ]);
    expect(options).not.toContain("Archived thread");
    await user.click(within(dialog).getByRole("option", { name: /Invoice rounding bug/ }));

    expect(store.moveTask).toHaveBeenCalledWith(
      expect.objectContaining({ id: "t-retry" }),
      { kind: "thread", threadId: "thread-other" },
    );
  });

  it("confirms a move that takes project files to another project", async () => {
    const user = userEvent.setup();
    const store = seededStore();
    vi.mocked(store.moveTask).mockRejectedValueOnce(new Error("The server connection was lost."));
    renderPanel(store);

    await user.click(screen.getByRole("button", { name: 'Actions for "Audit checkout error states"' }));
    const moveMenu = await openSubmenu(user, screen.getByRole("menu"), "Move to");
    within(moveMenu).getByRole("menuitem", { name: "Global" }).focus();
    await user.keyboard("{Enter}");
    expect(store.moveTask).not.toHaveBeenCalled();
    const confirm = screen.getByRole("dialog", { name: "Move task with project files?" });
    await user.click(within(confirm).getByRole("button", { name: "Move task" }));
    expect(await within(confirm).findByRole("alert")).toHaveTextContent("The server connection was lost.");
    await user.click(within(confirm).getByRole("button", { name: "Move task" }));
    await waitFor(() => expect(confirm).not.toBeInTheDocument());
    expect(store.moveTask).toHaveBeenCalledTimes(2);
  });

  it("deletes through the row menu after confirmation", async () => {
    const user = userEvent.setup();
    const store = seededStore();
    renderPanel(store);

    await user.click(screen.getByRole("button", { name: 'Actions for "Add retry to the payment call"' }));
    await user.click(screen.getByRole("menuitem", { name: "Delete…" }));
    const confirm = screen.getByRole("dialog", { name: "Delete task?" });
    expect(within(confirm).getByRole("button", { name: "Cancel" })).toHaveFocus();
    await user.click(within(confirm).getByRole("button", { name: "Delete task" }));
    expect(store.deleteTask).toHaveBeenCalledWith("t-retry");
  });

  it("writes the versioned task identity when a row is dragged", () => {
    const store = seededStore();
    renderPanel(store, { drag: true });
    const values = new Map<string, string>();
    const dataTransfer = {
      effectAllowed: "none",
      types: [] as string[],
      setData: vi.fn((type: string, value: string) => {
        values.set(type, value);
        dataTransfer.types.push(type);
      }),
      getData: vi.fn((type: string) => values.get(type) ?? ""),
    };
    const row = rowOf("Add retry to the payment call").querySelector(".tasks-row-main")!;
    expect(row).toHaveAttribute("draggable", "true");
    // No visible handle: the whole row is the drag source.
    expect(screen.queryByRole("button", { name: /^Drag/ })).not.toBeInTheDocument();

    fireEvent.dragStart(row, { dataTransfer });
    expect(JSON.parse(values.get(TASK_DRAG_MIME)!)).toEqual({ version: 1, taskId: "t-retry", revision: 0 });
    expect(dataTransfer.effectAllowed).toBe("copyMove");
  });

  it("moves a task dropped on a scope segment, outlining the targets", async () => {
    const store = seededStore();
    renderPanel(store, { drag: true });
    const values = new Map<string, string>();
    const types: string[] = [];
    const dataTransfer = {
      effectAllowed: "none",
      dropEffect: "none",
      types,
      setData: (type: string, value: string) => {
        values.set(type, value);
        if (!types.includes(type)) types.push(type);
      },
      getData: (type: string) => values.get(type) ?? "",
    };
    fireEvent.dragStart(rowOf("Add retry to the payment call").querySelector(".tasks-row-main")!, { dataTransfer });

    // Every place it can go is armed; its own scope and All are not.
    expect(segment("Project")).toHaveAttribute("data-task-drop-armed", "true");
    expect(segment("Global")).toHaveAttribute("data-task-drop-armed", "true");
    expect(segment("Thread")).not.toHaveAttribute("data-task-drop-armed");
    expect(segment("All")).not.toHaveAttribute("data-task-drop-armed");
    // The list is the current view's scope, where the task already is.
    expect(panel().querySelector(".tasks-scroll")).not.toHaveAttribute("data-task-drop-armed");
    fireEvent.dragOver(segment("Project"), { dataTransfer });
    expect(segment("Project")).toHaveAttribute("data-task-drop-target", "true");
    fireEvent.drop(segment("Project"), { dataTransfer });

    await vi.waitFor(() =>
      expect(store.moveTask).toHaveBeenCalledWith(
        expect.objectContaining({ id: "t-retry" }),
        { kind: "project", projectId: "project-1" },
        expect.any(String),
      ),
    );
    await waitFor(() => expect(announced("Moved “Add retry to the payment call” to acme-web.")).toBe(true));
  });

  it("moves a task dropped on the list to the scope in view", async () => {
    const user = userEvent.setup();
    const store = seededStore();
    renderPanel(store, { drag: true });
    await user.click(segment("Project"));
    await user.click(screen.getByRole("button", { name: "View options" }));
    await user.click(screen.getByRole("menuitemcheckbox", { name: "Include thread tasks" }));
    await user.keyboard("{Escape}");
    const values = new Map<string, string>();
    const types: string[] = [];
    const dataTransfer = {
      effectAllowed: "none",
      dropEffect: "none",
      types,
      setData: (type: string, value: string) => {
        values.set(type, value);
        if (!types.includes(type)) types.push(type);
      },
      getData: (type: string) => values.get(type) ?? "",
    };
    fireEvent.dragStart(rowOf("Add retry to the payment call").querySelector(".tasks-row-main")!, { dataTransfer });
    const list = panel().querySelector(".tasks-scroll")!;
    expect(list).toHaveAttribute("data-task-drop-armed", "true");
    fireEvent.dragOver(rowOf("Upgrade the test runner"), { dataTransfer });
    expect(list).toHaveAttribute("data-task-drop-target", "true");
    fireEvent.drop(rowOf("Upgrade the test runner"), { dataTransfer });

    await vi.waitFor(() =>
      expect(store.moveTask).toHaveBeenCalledWith(
        expect.objectContaining({ id: "t-retry" }),
        { kind: "project", projectId: "project-1" },
        expect.any(String),
      ),
    );
  });

  it("confirms dropping a task with files into another project", async () => {
    const store = seededStore();
    renderPanel(store, { drag: true });
    const values = new Map<string, string>();
    const types: string[] = [];
    const dataTransfer = {
      effectAllowed: "none",
      dropEffect: "none",
      types,
      setData: (type: string, value: string) => {
        values.set(type, value);
        if (!types.includes(type)) types.push(type);
      },
      getData: (type: string) => values.get(type) ?? "",
    };
    fireEvent.dragStart(rowOf("Audit checkout error states").querySelector(".tasks-row-main")!, { dataTransfer });
    fireEvent.dragOver(segment("Global"), { dataTransfer });
    fireEvent.drop(segment("Global"), { dataTransfer });

    const confirm = await screen.findByRole("dialog", { name: "Move task with project files?" });
    expect(store.moveTask).not.toHaveBeenCalled();
    fireEvent.click(within(confirm).getByRole("button", { name: "Move task" }));
    await vi.waitFor(() =>
      expect(store.moveTask).toHaveBeenCalledWith(
        expect.objectContaining({ id: "t-audit" }),
        { kind: "global" },
        expect.any(String),
      ),
    );
    await waitFor(() => expect(announced("Moved “Audit checkout error states” to Global.")).toBe(true));
  });
});

describe("TasksPanel edit dialog", () => {
  it("saves labelled fields including where the task belongs and its pin", async () => {
    const user = userEvent.setup();
    const store = seededStore();
    renderPanel(store);

    await user.click(rowTitle("Add retry to the payment call"));
    await user.click(screen.getByRole("button", { name: "Edit" }));
    const dialog = screen.getByRole("dialog", { name: "Edit task" });
    const title = within(dialog).getByRole("textbox", { name: "Title" });
    expect(title).toHaveFocus();
    await user.clear(title);
    await user.type(title, "Add retry with backoff");
    await user.type(within(dialog).getByRole("textbox", { name: "Notes" }), "Three attempts.");
    await user.click(within(dialog).getByRole("combobox", { name: "Belongs to" }));
    await user.click(screen.getByRole("option", { name: /This project · acme-web/ }));
    await user.click(within(dialog).getByRole("switch", { name: "Pinned" }));
    await user.click(within(dialog).getByRole("button", { name: "Save" }));

    expect(store.updateTask).toHaveBeenCalledWith(
      expect.objectContaining({ id: "t-retry", revision: 0 }),
      {
        title: "Add retry with backoff",
        details: "Three attempts.",
        scope: { kind: "project", projectId: "project-1" },
        pinned: true,
      },
    );
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Edit task" })).not.toBeInTheDocument());
  });

  it("guards unsaved changes on every way out", async () => {
    const user = userEvent.setup();
    const store = seededStore();
    renderPanel(store);

    await user.click(rowTitle("Add retry to the payment call"));
    await user.keyboard("e");
    const dialog = screen.getByRole("dialog", { name: "Edit task" });
    await user.type(within(dialog).getByRole("textbox", { name: "Notes" }), "Unsaved");
    await user.keyboard("{Escape}");

    const guard = screen.getByRole("dialog", { name: "Discard unsaved changes?" });
    expect(within(guard).getByRole("button", { name: "Keep editing" })).toHaveFocus();
    await user.click(within(guard).getByRole("button", { name: "Keep editing" }));
    expect(within(dialog).getByRole("textbox", { name: "Notes" })).toHaveValue("Unsaved");

    await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await user.click(screen.getByRole("button", { name: "Discard and close" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Edit task" })).not.toBeInTheDocument());
    expect(store.updateTask).not.toHaveBeenCalled();

    // Without changes Cancel simply closes.
    await user.click(screen.getByRole("button", { name: "Edit" }));
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("shows field errors on their fields and keeps a server error in the dialog", async () => {
    const user = userEvent.setup();
    const store = seededStore();
    vi.mocked(store.updateTask).mockRejectedValueOnce(new Error("Task changed in another client."));
    renderPanel(store);

    await user.click(rowTitle("Audit checkout error states"));
    await user.click(screen.getByRole("button", { name: "Edit" }));
    const dialog = screen.getByRole("dialog", { name: "Edit task" });
    const files = within(dialog).getByRole("list", { name: "Linked files" });
    expect(within(files).getByRole("listitem")).toHaveAttribute("title", "/workspace/src/checkout.ts");
    expect(within(files).getByText("checkout.ts")).toBeInTheDocument();

    await user.click(within(dialog).getByRole("button", { name: "Add file" }));
    const path = within(dialog).getByRole("textbox", { name: "Absolute file path" });
    await user.type(path, "docs/relative.md{Enter}");
    expect(path).toHaveAccessibleDescription("Enter an absolute file path beginning with /.");
    expect(path).toHaveAttribute("aria-invalid", "true");
    await user.clear(path);
    await user.type(path, "/workspace/docs/tasks.md{Enter}");
    expect(within(files).getAllByRole("listitem")).toHaveLength(2);

    const title = within(dialog).getByRole("textbox", { name: "Title" });
    await user.clear(title);
    await user.click(within(dialog).getByRole("button", { name: "Save" }));
    expect(title).toHaveAccessibleDescription("A task needs a title.");
    expect(store.updateTask).not.toHaveBeenCalled();

    await user.type(title, "Audit errors");
    await user.click(within(dialog).getByRole("button", { name: "Save" }));
    expect(await within(dialog).findByRole("alert")).toHaveTextContent("Task changed in another client.");
    expect(store.updateTask).toHaveBeenCalledWith(
      expect.objectContaining({ id: "t-audit" }),
      { title: "Audit errors", files: ["/workspace/src/checkout.ts", "/workspace/docs/tasks.md"] },
    );
  });

  it("deletes from the dialog through a confirmation", async () => {
    const user = userEvent.setup();
    const store = seededStore();
    renderPanel(store);

    await user.click(rowTitle("Add retry to the payment call"));
    await user.click(screen.getByRole("button", { name: "Edit" }));
    await user.click(screen.getByRole("button", { name: "Delete…" }));
    const confirm = screen.getByRole("dialog", { name: "Delete task?" });
    await user.click(within(confirm).getByRole("button", { name: "Delete task" }));

    expect(store.deleteTask).toHaveBeenCalledWith("t-retry");
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  });

  it("keeps an unsaved edit while the surface is suspended", () => {
    const store = seededStore();
    const panelLayoutStore = makePanelLayoutStore();
    const route = { name: "thread", threadId: "thread-9" } as const;
    const content = (active: boolean) => (
      <TasksHarness store={store} panelLayoutStore={panelLayoutStore} route={route} active={active} />
    );
    const view = render(content(true));
    fireEvent.click(rowTitle("Add retry to the payment call"));
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Notes" }), { target: { value: "Unsaved while configuring" } });

    view.rerender(content(false));
    expect(screen.queryByRole("dialog", { name: "Edit task" })).not.toBeInTheDocument();
    view.rerender(content(true));
    expect(screen.getByRole("textbox", { name: "Notes" })).toHaveValue("Unsaved while configuring");
  });
});

describe("TasksPanel view options and search", () => {
  it("sorts and filters per view and remembers the choice", async () => {
    const user = userEvent.setup();
    const store = seededStore([
      threadTask({ id: "t-zeta", title: "Zeta cleanup", createdAt: "2026-08-01T09:00:00.000Z", updatedAt: "2026-08-06T09:00:00.000Z" }),
      threadTask({ id: "t-batch", title: "Batch the refunds", createdAt: "2026-08-01T08:00:00.000Z" }),
    ]);
    const view = renderPanel(store);
    // Newest first, after the pinned task: pins are not a sort.
    expect(titles()).toEqual([
      "Audit checkout error states",
      "Add retry to the payment call",
      "Zeta cleanup",
      "Batch the refunds",
    ]);

    await user.click(screen.getByRole("button", { name: "View options" }));
    expect(screen.getAllByRole("menuitemradio").map((item) => item.textContent)).toEqual([
      "Newest",
      "Recently updated",
      "Title",
    ]);
    expect(screen.getByRole("menuitemradio", { name: "Newest" })).toBeChecked();
    // Completed is always the collapsed section: there is no Show choice.
    expect(screen.queryByRole("group", { name: "Show" })).not.toBeInTheDocument();
    expect(screen.queryByRole("menuitemradio", { name: "Completed" })).not.toBeInTheDocument();
    await user.click(screen.getByRole("menuitemradio", { name: "Title" }));
    // The menu stays open for several choices.
    expect(screen.getByRole("menu", { name: "View options" })).toBeInTheDocument();
    // The pinned task stays first in every sort.
    expect(titles()).toEqual([
      "Audit checkout error states",
      "Add retry to the payment call",
      "Batch the refunds",
      "Zeta cleanup",
    ]);
    await user.click(screen.getByRole("menuitemradio", { name: "Recently updated" }));
    expect(titles().slice(0, 2)).toEqual(["Audit checkout error states", "Zeta cleanup"]);
    await user.click(screen.getByRole("menuitemcheckbox", { name: "With notes" }));
    expect(titles()).toEqual(["Audit checkout error states"]);
    await user.keyboard("{Escape}");
    expect(screen.getByRole("button", { name: "View options" })).toHaveAttribute("data-filtering", "true");

    // Options belong to the view.
    await user.click(segment("Global"));
    expect(titles()).toEqual(["Rotate staging credentials"]);
    view.unmount();
    renderPanel(store);
    await user.click(segment("Thread"));
    expect(titles()).toEqual(["Audit checkout error states"]);

    expect(screen.getByRole("button", { name: "View options" })).toHaveAttribute("data-filtering", "true");
  });

  it("shows narrowing options as removable chips and counts what is listed", async () => {
    const user = userEvent.setup();
    renderPanel(seededStore());
    const count = () => panel().querySelector(".tasks-title-count")!;
    const filters = () => screen.queryByRole("group", { name: "View filters" });
    // Nothing narrows the list: the header counts like the Thread segment.
    expect(filters()).not.toBeInTheDocument();
    expect(count()).toHaveTextContent("2");
    expect(count()).toHaveAttribute("aria-label", "2 open");
    expect(segment("Thread")).toHaveAccessibleDescription("2 open");

    await user.click(screen.getByRole("button", { name: "View options" }));
    await user.click(screen.getByRole("menuitemcheckbox", { name: "Pinned" }));
    await user.click(screen.getByRole("menuitemcheckbox", { name: "Backlog" }));
    await user.keyboard("{Escape}");
    expect(within(filters()!).getAllByRole("button").map((chip) => chip.textContent)).toEqual([
      "Pinned only",
      "Backlog only",
    ]);
    // No task here is both pinned and in the backlog.
    expect(count()).toHaveTextContent("0 of 2");
    expect(count()).toHaveAttribute("aria-label", "0 of 2 open shown");
    expect(screen.getByText("No tasks match the view options.")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Remove filter: Backlog only" }));
    expect(titles()).toEqual(["Audit checkout error states"]);
    expect(count()).toHaveTextContent("1 of 2");
    // Focus moves to the chip that remains, then back to the scope.
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Remove filter: Pinned only" })).toHaveFocus(),
    );
    await user.keyboard("{Enter}");
    expect(filters()).not.toBeInTheDocument();
    expect(count()).toHaveTextContent("2");
    expect(screen.getByRole("button", { name: "View options" })).not.toHaveAttribute("data-filtering");
    await waitFor(() => expect(segment("Thread")).toHaveFocus());
  });

  it("searches titles, and notes when asked, without blocking the add row", async () => {
    const user = userEvent.setup();
    renderPanel(seededStore());

    await user.click(screen.getByRole("button", { name: "Search tasks" }));
    const search = screen.getByRole("textbox", { name: "Search tasks" });
    expect(search).toHaveFocus();
    expect(search).toHaveAttribute("placeholder", "Search titles");
    await user.type(search, "retry");
    expect(titles()).toEqual(["Add retry to the payment call"]);
    expect(addInput()).toBeEnabled();
    await user.clear(search);
    await user.type(search, "error branch");
    expect(titles()).toEqual([]);
    expect(screen.getByText("No tasks match “error branch”.")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "View options" }));
    await user.click(screen.getByRole("menuitemcheckbox", { name: "Search notes" }));
    await user.keyboard("{Escape}");
    expect(search).toHaveAttribute("placeholder", "Search titles and notes");
    expect(titles()).toEqual(["Audit checkout error states"]);

    await user.click(search);
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("textbox", { name: "Search tasks" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Search tasks" })).toHaveFocus();
    expect(titles()).toHaveLength(2);
  });
});

/** The thread's backlog: one pinned, one not. */
const BACKLOG = [
  threadTask({ id: "t-later", title: "Profile cold start", backlog: true, createdAt: "2026-08-05T10:00:00.000Z" }),
  threadTask({ id: "t-later-pinned", title: "Rewrite the receipts", backlog: true, pinned: true, createdAt: "2026-07-30T10:00:00.000Z" }),
];
const headings = () =>
  [...panel().querySelectorAll(".list-heading")].map((node) => node.textContent);
const backlogHeading = () => screen.getByRole("button", { name: /^Backlog/ });

describe("TasksPanel Backlog and Pin", () => {
  it("keeps backlog tasks in a collapsed Backlog section before Completed, pinned first", async () => {
    const user = userEvent.setup();
    renderPanel(seededStore(BACKLOG));

    expect(titles()).toEqual(["Audit checkout error states", "Add retry to the payment call"]);
    expect(headings()).toEqual(["Backlog2", "Completed1"]);
    expect(backlogHeading()).toHaveAttribute("aria-expanded", "false");
    // The label leads, where the rows start; the chevron follows the count.
    expect(backlogHeading().firstElementChild).toHaveClass("list-heading-label");
    expect(backlogHeading().lastElementChild).toHaveClass("list-heading-chevron");
    // Counts cover every open task, the backlog's included.
    expect(segment("Thread")).toHaveAccessibleDescription("4 open");
    expect(panel().querySelector(".tasks-title-count")).toHaveAttribute("aria-label", "4 open");

    await user.click(backlogHeading());
    expect(titles()).toEqual([
      "Audit checkout error states",
      "Add retry to the payment call",
      "Rewrite the receipts",
      "Profile cold start",
    ]);
    expect(within(screen.getByRole("list", { name: "Backlog tasks" })).getAllByRole("listitem")).toHaveLength(2);

    // The headings take part in list navigation.
    rowTitle("Add retry to the payment call").focus();
    await user.keyboard("{ArrowDown}");
    expect(backlogHeading()).toHaveFocus();
    await user.keyboard("{ArrowDown}");
    expect(rowTitle("Rewrite the receipts")).toHaveFocus();
    await user.keyboard("{End}");
    expect(screen.getByRole("button", { name: /^Completed/ })).toHaveFocus();
    backlogHeading().focus();
    await user.keyboard("{ArrowLeft}");
    expect(backlogHeading()).toHaveAttribute("aria-expanded", "false");

    // Pinned tasks lead the Backlog in every sort.
    await user.click(backlogHeading());
    await user.click(screen.getByRole("button", { name: "View options" }));
    await user.click(screen.getByRole("menuitemradio", { name: "Title" }));
    await user.keyboard("{Escape}");
    expect(titles().slice(2)).toEqual(["Rewrite the receipts", "Profile cold start"]);
  });

  it("says when every open task is in the Backlog", () => {
    act(() => navigate(threadPath("thread-9")));
    renderPanel(makeStore(BACKLOG, { threads: THREADS, projects: PROJECTS, workspaces: WORKSPACES }));
    expect(screen.getByText("Nothing current.")).toBeInTheDocument();
    expect(screen.getByText("Every open task here waits in the Backlog.")).toBeInTheDocument();
    expect(headings()).toEqual(["Backlog2"]);
  });

  it("makes the backlog the list under Only › Backlog, and adds to it", async () => {
    const user = userEvent.setup();
    const store = seededStore(BACKLOG);
    renderPanel(store);

    await user.click(screen.getByRole("button", { name: "View options" }));
    await user.click(screen.getByRole("menuitemcheckbox", { name: "Backlog" }));
    await user.keyboard("{Escape}");
    expect(titles()).toEqual(["Rewrite the receipts", "Profile cold start"]);
    // No Backlog heading, and completed tasks are never in the backlog.
    expect(headings()).toEqual([]);
    expect(panel().querySelector(".tasks-title-count")).toHaveTextContent("2 of 4");

    // A new task joins the backlog, so it does not vanish.
    await user.click(addInput());
    await user.keyboard("Measure the bundle{Enter}");
    expect(store.createTask).toHaveBeenLastCalledWith(
      "Measure the bundle",
      { kind: "thread", threadId: "thread-9" },
      undefined,
      { pinned: false, backlog: true },
    );

    // In All the backlog is the flat list, each row saying where it belongs.
    await user.click(segment("All"));
    await user.click(screen.getByRole("button", { name: "View options" }));
    await user.click(screen.getByRole("menuitemcheckbox", { name: "Backlog" }));
    await user.keyboard("{Escape}");
    // The task just added leads while it is still being created.
    expect(titles()).toEqual(["Measure the bundle", "Rewrite the receipts", "Profile cold start"]);
    expect(rowTitle("Profile cold start")).toHaveAccessibleDescription("In Checkout flow refactor · acme-web");
    expect(headings()).toEqual([]);
  });

  it("narrows every section under Only › Pinned, and both filters to pinned backlog tasks", async () => {
    const user = userEvent.setup();
    const store = seededStore(BACKLOG);
    renderPanel(store);

    await user.click(screen.getByRole("button", { name: "View options" }));
    await user.click(screen.getByRole("menuitemcheckbox", { name: "Pinned" }));
    await user.keyboard("{Escape}");
    expect(titles()).toEqual(["Audit checkout error states"]);
    // Completed tasks are never pinned, so Completed goes.
    expect(headings()).toEqual(["Backlog1"]);
    expect(panel().querySelector(".tasks-title-count")).toHaveTextContent("2 of 4");

    await user.click(screen.getByRole("button", { name: "View options" }));
    await user.click(screen.getByRole("menuitemcheckbox", { name: "Backlog" }));
    await user.keyboard("{Escape}");
    expect(titles()).toEqual(["Rewrite the receipts"]);
    expect(headings()).toEqual([]);

    // Added and pasted tasks match both filters.
    await user.click(addInput());
    await user.keyboard("Ship the receipts{Enter}");
    expect(store.createTask).toHaveBeenLastCalledWith(
      "Ship the receipts",
      { kind: "thread", threadId: "thread-9" },
      undefined,
      { pinned: true, backlog: true },
    );
    await user.paste("First\nSecond");
    const dialog = screen.getByRole("dialog", { name: "Create 2 tasks?" });
    await user.click(within(dialog).getByRole("button", { name: "Create 2 tasks" }));
    await waitFor(() => expect(store.createTask).toHaveBeenLastCalledWith(
      "First",
      { kind: "thread", threadId: "thread-9" },
      undefined,
      { pinned: true, backlog: true },
    ));
  });

  it("toggles Only › Pinned from the header, the same setting as the menu", async () => {
    const user = userEvent.setup();
    renderPanel(seededStore(BACKLOG));
    const header = screen.getByRole("banner", { name: "Tasks panel header" });
    const toggle = within(header).getByRole("button", { name: "Show only pinned tasks" });
    expect(toggle).toHaveAttribute("aria-pressed", "false");
    expect(toggle).toHaveAttribute("title", "Show only pinned tasks");

    await user.click(toggle);
    expect(toggle).toHaveAttribute("aria-pressed", "true");
    expect(titles()).toEqual(["Audit checkout error states"]);
    expect(getTasksViewOptions("thread").onlyPinned).toBe(true);
    expect(screen.getByRole("button", { name: "Remove filter: Pinned only" })).toBeInTheDocument();
    await user.click(within(header).getByRole("button", { name: "View options" }));
    const pinned = screen.getByRole("menuitemcheckbox", { name: "Pinned" });
    expect(pinned).toBeChecked();
    await user.click(pinned);
    await user.keyboard("{Escape}");
    expect(toggle).toHaveAttribute("aria-pressed", "false");
    expect(titles()).toEqual(["Audit checkout error states", "Add retry to the payment call"]);
    // The header count says when the list is narrowed.
    await user.click(toggle);
    expect(panel().querySelector(".tasks-title-count")).toHaveTextContent("2 of 4");
  });

  it("sends a task to the Backlog and takes it out from the menu and with B", async () => {
    const user = userEvent.setup();
    const store = seededStore(BACKLOG);
    renderPanel(store);

    await user.click(screen.getByRole("button", { name: 'Actions for "Add retry to the payment call"' }));
    await user.click(screen.getByRole("menuitem", { name: "Send to Backlog" }));
    expect(store.updateTask).toHaveBeenLastCalledWith(
      expect.objectContaining({ id: "t-retry" }),
      { backlog: true },
    );
    await waitFor(() => expect(announced("Sent “Add retry to the payment call” to the Backlog.")).toBe(true));

    await user.click(backlogHeading());
    await user.click(screen.getByRole("button", { name: 'Actions for "Profile cold start"' }));
    expect(
      within(screen.getByRole("menu")).getAllByRole("menuitem").map((item) => item.textContent),
    ).toContain("Take out of BacklogB");
    await user.click(screen.getByRole("menuitem", { name: "Take out of Backlog" }));
    expect(store.updateTask).toHaveBeenLastCalledWith(
      expect.objectContaining({ id: "t-later" }),
      { backlog: false },
    );

    rowTitle("Rewrite the receipts").focus();
    await user.keyboard("b");
    expect(store.updateTask).toHaveBeenLastCalledWith(
      expect.objectContaining({ id: "t-later-pinned" }),
      { backlog: false },
    );
    await user.keyboard("p");
    expect(store.updateTask).toHaveBeenLastCalledWith(
      expect.objectContaining({ id: "t-later-pinned" }),
      { pinned: false },
    );
  });

  it("offers neither Pin nor Backlog for a completed task, and ignores P and B", async () => {
    const user = userEvent.setup();
    const store = seededStore();
    renderPanel(store);

    await user.click(screen.getByRole("button", { name: /^Completed/ }));
    await user.click(screen.getByRole("button", { name: 'Actions for "Remove the legacy flag"' }));
    expect(
      within(screen.getByRole("menu")).getAllByRole("menuitem").map((item) => item.textContent),
    ).toEqual(["Add to prompt", "Edit…E", "Move to", "Delete…"]);
    await user.keyboard("{Escape}");

    rowTitle("Remove the legacy flag").focus();
    await user.keyboard("p");
    await user.keyboard("b");
    expect(store.updateTask).not.toHaveBeenCalled();
  });

  it("completes a pinned backlog task out of both, and reopens it into the list", async () => {
    const user = userEvent.setup();
    const store = seededStore(BACKLOG);
    renderPanel(store);
    await user.click(backlogHeading());

    await user.click(screen.getByRole("checkbox", { name: 'Mark "Rewrite the receipts" as done' }));
    expect(store.updateTask).toHaveBeenLastCalledWith(
      expect.objectContaining({ id: "t-later-pinned" }),
      { completed: true },
    );
    // The server clears the pin and the backlog in the same change.
    act(() =>
      store.publish(
        store.getTasks().map((task) =>
          task.id === "t-later-pinned"
            ? { ...task, completedAt: "2026-08-06T10:00:00.000Z", pinned: false, backlog: false, revision: 1 }
            : task,
        ),
      ),
    );
    expect(headings()).toEqual(["Backlog1", "Completed2"]);
    await user.click(screen.getByRole("button", { name: /^Completed/ }));
    expect(within(rowOf("Rewrite the receipts")).queryByText(/pinned/)).not.toBeInTheDocument();

    await user.click(screen.getByRole("checkbox", { name: 'Mark "Rewrite the receipts" as open' }));
    act(() =>
      store.publish(
        store.getTasks().map((task) =>
          task.id === "t-later-pinned" ? { ...task, completedAt: null, revision: 2 } : task,
        ),
      ),
    );
    // Back in the list, neither pinned nor in the backlog.
    expect(titles().slice(0, 3)).toEqual([
      "Audit checkout error states",
      "Add retry to the payment call",
      "Rewrite the receipts",
    ]);
    expect(headings()).toEqual(["Backlog1", "Completed1"]);
  });

  it("edits Pinned and Backlog independently, and neither for a completed task", async () => {
    const user = userEvent.setup();
    const store = seededStore();
    renderPanel(store);

    await user.click(rowTitle("Add retry to the payment call"));
    await user.click(screen.getByRole("button", { name: "Edit" }));
    let dialog = screen.getByRole("dialog", { name: "Edit task" });
    const backlog = within(dialog).getByRole("switch", { name: "Backlog" });
    expect(backlog).not.toBeChecked();
    expect(backlog).toHaveAccessibleDescription(
      "Backlog tasks wait, still open, in a collapsed section.",
    );
    await user.click(backlog);
    await user.click(within(dialog).getByRole("button", { name: "Save" }));
    expect(store.updateTask).toHaveBeenLastCalledWith(
      expect.objectContaining({ id: "t-retry" }),
      { backlog: true },
    );
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Edit task" })).not.toBeInTheDocument());

    await user.click(screen.getByRole("button", { name: /^Completed/ }));
    rowTitle("Remove the legacy flag").focus();
    await user.keyboard("e");
    dialog = screen.getByRole("dialog", { name: "Edit task" });
    for (const name of ["Pinned", "Backlog"]) {
      const control = within(dialog).getByRole("switch", { name });
      expect(control).not.toBeChecked();
      expect(control).toBeDisabled();
    }
  });

  it("says where matches are when only a collapsed section has them", async () => {
    const user = userEvent.setup();
    renderPanel(seededStore(BACKLOG));
    await user.click(screen.getByRole("button", { name: "Search tasks" }));
    await user.type(screen.getByRole("textbox", { name: "Search tasks" }), "cold");
    expect(titles()).toEqual([]);
    expect(screen.getByText("Nothing current matches.")).toBeInTheDocument();
    expect(screen.getByText("The matching tasks wait in the Backlog.")).toBeInTheDocument();
    expect(screen.queryByText(/^No tasks match/)).not.toBeInTheDocument();
    expect(headings()).toEqual(["Backlog1"]);

    await user.clear(screen.getByRole("textbox", { name: "Search tasks" }));
    await user.type(screen.getByRole("textbox", { name: "Search tasks" }), "legacy flag");
    expect(screen.getByText("The matching tasks are completed.")).toBeInTheDocument();
    expect(headings()).toEqual(["Completed1"]);
  });

  it("reveals a task hidden by filters or search without changing or saving them", async () => {
    const user = userEvent.setup();
    const store = seededStore(BACKLOG);
    renderPanel(store);
    await user.click(screen.getByRole("button", { name: "View options" }));
    await user.click(screen.getByRole("menuitemcheckbox", { name: "With files" }));
    await user.keyboard("{Escape}");
    expect(titles()).toEqual(["Audit checkout error states"]);

    // A backlog task opens in its expanded section.
    act(() => revealTask("t-later"));
    await waitFor(() => expect(rowTitle("Profile cold start")).toHaveAttribute("aria-expanded", "true"));
    expect(backlogHeading()).toHaveAttribute("aria-expanded", "true");
    expect(rowTitle("Profile cold start")).toHaveFocus();
    expect(getTasksViewOptions("thread")).toMatchObject({ onlyWithFiles: true, onlyPinned: false });
    expect(screen.getByRole("button", { name: "Remove filter: With files" })).toBeInTheDocument();

    // Changing the filters ends the exception.
    await user.click(screen.getByRole("button", { name: "Show only pinned tasks" }));
    expect(screen.queryByRole("button", { name: "Profile cold start" })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Show only pinned tasks" }));

    // So does changing the search.
    await user.click(screen.getByRole("button", { name: "Search tasks" }));
    await user.type(screen.getByRole("textbox", { name: "Search tasks" }), "audit");
    act(() => revealTask("t-retry"));
    await waitFor(() => expect(rowTitle("Add retry to the payment call")).toHaveAttribute("aria-expanded", "true"));
    expect(screen.getByRole("textbox", { name: "Search tasks" })).toHaveValue("audit");
    await user.type(screen.getByRole("textbox", { name: "Search tasks" }), "s");
    expect(screen.queryByRole("button", { name: "Add retry to the payment call" })).not.toBeInTheDocument();
    // Going back to the revealed search does not bring it back.
    await user.keyboard("{Backspace}");
    expect(screen.getByRole("textbox", { name: "Search tasks" })).toHaveValue("audit");
    expect(screen.queryByRole("button", { name: "Add retry to the payment call" })).not.toBeInTheDocument();

    // And changing the view.
    await user.clear(screen.getByRole("textbox", { name: "Search tasks" }));
    act(() => revealTask("t-retry"));
    await waitFor(() => expect(rowTitle("Add retry to the payment call")).toBeInTheDocument());
    await user.click(segment("Global"));
    await user.click(segment("Thread"));
    expect(screen.queryByRole("button", { name: "Add retry to the payment call" })).not.toBeInTheDocument();
  });
});

describe("TasksPanel two-line rows", () => {
  beforeEach(() => {
    setTasksLastView("all");
  });

  it("keeps the indicators beside the title on desktop", () => {
    renderPanel(seededStore());
    const main = rowOf("Audit checkout error states").querySelector(".tasks-row-main")!;
    expect(rowTitle("Audit checkout error states")).toHaveAttribute("data-location");
    expect(main.querySelector(":scope > .tasks-row-meta")).toHaveTextContent("has notes, 1 file, pinned");
    expect(main.querySelector(".scope-location .tasks-row-meta")).toBeNull();
  });

  it("moves the indicators onto the second line on touch, still described", () => {
    stubDensity(true);
    renderPanel(seededStore());
    const main = rowOf("Audit checkout error states").querySelector(".tasks-row-main")!;
    expect(main.querySelector(":scope > .tasks-row-meta")).toBeNull();
    expect(main.querySelector(".scope-location .tasks-row-meta")).not.toBeNull();
    // The second line is hidden from assistive technology; the row still
    // says what the indicators show.
    expect(
      within(main as HTMLElement)
        .getAllByText("has notes, 1 file, pinned")
        .filter((node) => !node.closest('[aria-hidden="true"]')),
    ).toHaveLength(1);
    // A row without indicators says nothing extra.
    expect(rowOf("Add retry to the payment call").querySelectorAll(".sr-only")).toHaveLength(1);
  });
});

describe("TasksPanel keyboard", () => {
  it("navigates rows and runs row shortcuts, ignoring them while typing", async () => {
    const user = userEvent.setup();
    const store = seededStore();
    renderPanel(store);

    // One tab stop for the list.
    expect(rowTitle("Audit checkout error states")).toHaveAttribute("tabindex", "0");
    expect(rowTitle("Add retry to the payment call")).toHaveAttribute("tabindex", "-1");
    rowTitle("Audit checkout error states").focus();
    await user.keyboard("{ArrowDown}");
    expect(rowTitle("Add retry to the payment call")).toHaveFocus();
    expect(rowTitle("Add retry to the payment call")).toHaveAttribute("tabindex", "0");
    await user.keyboard("{ArrowDown}");
    expect(screen.getByRole("button", { name: /^Completed/ })).toHaveFocus();
    await user.keyboard("{ArrowUp}");

    await user.keyboard("p");
    expect(store.updateTask).toHaveBeenLastCalledWith(
      expect.objectContaining({ id: "t-retry" }),
      { pinned: true },
    );
    await user.keyboard("{Enter}");
    expect(rowTitle("Add retry to the payment call")).toHaveAttribute("aria-expanded", "true");
    await user.keyboard("{Escape}");
    expect(rowTitle("Add retry to the payment call")).toHaveAttribute("aria-expanded", "false");
    expect(panel()).toBeInTheDocument();

    await user.keyboard("m");
    expect(await screen.findByRole("menu")).toHaveTextContent("This project");
    await user.keyboard("{Escape}");

    await user.keyboard("{Delete}");
    expect(screen.getByRole("dialog", { name: "Delete task?" })).toBeInTheDocument();
    await user.keyboard("{Escape}");

    await user.keyboard("{Control>}{Enter}{/Control}");
    expect(screen.getByRole("alert")).toHaveTextContent("The message composer is unavailable.");

    rowTitle("Add retry to the payment call").focus();
    await user.keyboard(" ");
    expect(store.updateTask).toHaveBeenLastCalledWith(
      expect.objectContaining({ id: "t-retry" }),
      { completed: true },
    );

    await user.keyboard("n");
    expect(addInput()).toHaveFocus();
    await user.keyboard("pen/e");
    expect(addInput()).toHaveValue("pen/e");
    expect(screen.queryByRole("textbox", { name: "Search tasks" })).not.toBeInTheDocument();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();

    rowTitle("Audit checkout error states").focus();
    await user.keyboard("/");
    expect(screen.getByRole("textbox", { name: "Search tasks" })).toHaveFocus();
  });

  it("keeps focus in the list when a completed row leaves it", async () => {
    const user = userEvent.setup();
    const store = seededStore();
    renderPanel(store);

    rowTitle("Audit checkout error states").focus();
    await user.keyboard(" ");
    act(() =>
      store.publish(
        store.getTasks().map((task) =>
          task.id === "t-audit" ? { ...task, completedAt: "2026-08-05T10:00:00.000Z" } : task,
        ),
      ),
    );
    expect(rowTitle("Add retry to the payment call")).toHaveFocus();
  });

  it("collapses the expanded row with Escape and leaves a docked panel open", () => {
    renderPanel(seededStore());
    expect(panel()).toHaveAttribute("data-presentation", "panel");
    fireEvent.click(rowTitle("Add retry to the payment call"));
    fireEvent.keyDown(rowTitle("Add retry to the payment call"), { key: "Escape" });
    expect(rowTitle("Add retry to the payment call")).toHaveAttribute("aria-expanded", "false");
    fireEvent.keyDown(rowTitle("Add retry to the payment call"), { key: "Escape" });
    expect(panel()).toBeInTheDocument();
  });
});

describe("TasksPanel reveal", () => {
  it("switches to a view holding the task, expands it and focuses it", async () => {
    const store = seededStore();
    renderPanel(store);

    act(() => revealTask("o-other"));
    await waitFor(() => expect(segment("All")).toHaveAttribute("aria-checked", "true"));
    expect(rowTitle("Round invoices half-even")).toHaveAttribute("aria-expanded", "true");
    expect(rowTitle("Round invoices half-even")).toHaveFocus();

    act(() => revealTask("t-done"));
    await waitFor(() => expect(segment("Thread")).toHaveAttribute("aria-checked", "true"));
    expect(screen.getByRole("button", { name: /^Completed/ })).toHaveAttribute("aria-expanded", "true");
    expect(rowTitle("Remove the legacy flag")).toHaveAttribute("aria-expanded", "true");
  });

  it("delivers a reveal requested before Tasks mounted, keeping the filters that hide it", async () => {
    const user = userEvent.setup();
    const store = seededStore();
    const view = renderPanel(store);
    await user.click(screen.getByRole("button", { name: "View options" }));
    await user.click(screen.getByRole("menuitemcheckbox", { name: "Pinned" }));
    view.unmount();

    revealTask("t-retry");
    renderPanel(store);
    await waitFor(() => expect(rowTitle("Add retry to the payment call")).toHaveAttribute("aria-expanded", "true"));
    // Shown as an exception: the filter stays on, and stays saved.
    expect(screen.getByRole("button", { name: "Remove filter: Pinned only" })).toBeInTheDocument();
    expect(getTasksViewOptions("thread").onlyPinned).toBe(true);
    expect(titles()).toEqual(["Audit checkout error states", "Add retry to the payment call"]);
  });
});

describe("TasksPanel files", () => {
  it("opens a linked file in the Files panel", async () => {
    const panelLayoutStore = makePanelLayoutStore();
    renderPanel(seededStore(), { panelLayoutStore });

    fireEvent.click(rowTitle("Audit checkout error states"));
    fireEvent.click(screen.getByRole("button", { name: "Open /workspace/src/checkout.ts in Files" }));
    await vi.waitFor(() =>
      expect(panelLayoutStore.open).toHaveBeenCalledWith("files", {
        intent: expect.objectContaining({
          kind: "open-workspace-file",
          workspaceId: "workspace-1",
          rootId: "primary",
          path: "src/checkout.ts",
          rootVisibility: "listed",
          target: { kind: "file" },
        }),
      }),
    );
  });

  it("reports a file outside the allowed worktrees and a non-normalized path", async () => {
    act(() => navigate(threadPath("thread-9")));
    const store = makeStore(
      [
        threadTask({ id: "a", title: "Outside", files: ["/other/private.txt"] }),
        threadTask({ id: "b", title: "Dotted", files: ["/other/../private.txt"] }),
      ],
      { threads: THREADS, projects: PROJECTS, workspaces: WORKSPACES, resolveFileLink: () => ({ status: "not_found" }) },
    );
    renderPanel(store);

    fireEvent.click(rowTitle("Outside"));
    fireEvent.click(screen.getByRole("button", { name: "Open /other/private.txt in Files" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("isn't available in Files");
    fireEvent.click(screen.getByRole("button", { name: "Dismiss error" }));

    vi.mocked(store.api.resolveWorkspaceFileLink).mockClear();
    fireEvent.click(rowTitle("Dotted"));
    fireEvent.click(screen.getByRole("button", { name: "Open /other/../private.txt in Files" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("isn't available in Files");
    expect(store.api.resolveWorkspaceFileLink).not.toHaveBeenCalled();
  });
});

describe("TasksPanel on a phone", () => {
  beforeEach(() => stubDensity(true));

  it("puts the add bar under the list and drills into a task's detail", async () => {
    const user = userEvent.setup();
    renderPanel(seededStore());
    const phonePanel = panel();
    // A panel like the others, not a dialog over the workbench.
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();

    const content = phonePanel.querySelector(".tasks-content")!;
    expect(content).toHaveAttribute("data-presentation", "sheet");
    expect(content.lastElementChild?.previousElementSibling).toHaveClass("tasks-add");
    expect(within(phonePanel).getByRole("button", { name: "Add task" })).toBeDisabled();
    expect(within(phonePanel).queryByRole("button", { name: "View options" })).not.toBeInTheDocument();
    // Only › Pinned has its own header button beside Search.
    const pinnedOnly = within(phonePanel).getByRole("button", { name: "Show only pinned tasks" });
    expect(pinnedOnly.previousElementSibling).toBe(within(phonePanel).getByRole("button", { name: "Search tasks" }));
    await user.click(pinnedOnly);
    expect(pinnedOnly).toHaveAttribute("aria-pressed", "true");
    expect(titles()).toEqual(["Audit checkout error states"]);
    await user.click(pinnedOnly);
    expect(titles()).toEqual(["Audit checkout error states", "Add retry to the payment call"]);
    // ⋯ is always shown on touch.
    expect(within(phonePanel).getByRole("button", { name: 'Actions for "Add retry to the payment call"' })).toBeInTheDocument();
    // The panel's ⋯ carries the View options.
    await user.click(within(phonePanel).getByRole("button", { name: "Tasks panel actions" }));
    const actions = screen.getByRole("dialog", { name: "Tasks panel" });
    await user.click(within(actions).getByRole("menuitemcheckbox", { name: "Pinned" }));
    expect(titles()).toEqual(["Audit checkout error states"]);
    await user.click(within(actions).getByRole("menuitemcheckbox", { name: "Pinned" }));
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Tasks panel" })).not.toBeInTheDocument());

    await user.click(rowTitle("Audit checkout error states"));
    expect(content).toHaveAttribute("data-task-detail-open", "true");
    expect(within(phonePanel).getByRole("heading", { name: "Audit checkout error states" })).toBeInTheDocument();
    expect(within(phonePanel).getByRole("button", { name: "Back to tasks" })).toHaveFocus();
    expect(within(phonePanel).queryByRole("textbox", { name: "Add a task" })).not.toBeInTheDocument();
    // One header: the detail's leads back to the list, and keeps ✕.
    expect(phonePanel.querySelectorAll("header")).toHaveLength(1);
    expect(within(phonePanel).getByRole("button", { name: "Close Tasks panel" })).toBeInTheDocument();
    await user.click(within(phonePanel).getByRole("button", { name: "Back to tasks" }));
    expect(content).not.toHaveAttribute("data-task-detail-open");
    await waitFor(() => expect(rowTitle("Audit checkout error states")).toHaveFocus());
  });

  it("closes an open detail on Android Back, and leaves Back alone otherwise", async () => {
    const user = userEvent.setup();
    renderPanel(seededStore());
    const content = panel().querySelector(".tasks-content")!;
    const back = () => {
      const event = new Event(CLOSE_TASK_DETAIL_EVENT, { cancelable: true });
      act(() => {
        window.dispatchEvent(event);
      });
      return event.defaultPrevented;
    };
    expect(back()).toBe(false);

    await user.click(rowTitle("Audit checkout error states"));
    expect(content).toHaveAttribute("data-task-detail-open", "true");
    expect(back()).toBe(true);
    expect(content).not.toHaveAttribute("data-task-detail-open");
    expect(panel()).toBeInTheDocument();
    await waitFor(() => expect(rowTitle("Audit checkout error states")).toHaveFocus());
    expect(back()).toBe(false);
  });

  it("shows Chat after Add to prompt, keeping Tasks loaded, and announces it", async () => {
    const user = userEvent.setup();
    const stageTaskReference = vi.fn();
    renderPanel(seededStore(), { stageTaskReference });

    await user.click(rowTitle("Add retry to the payment call"));
    await user.click(within(panel()).getByRole("button", { name: "Add to prompt" }));

    expect(stageTaskReference).toHaveBeenCalledWith({ taskId: "t-retry", titleSnapshot: "Add retry to the payment call" });
    // Chat comes in front, so the chip is seen arriving; Tasks stays loaded,
    // on its detail. The host announces, since Tasks is now off stage.
    expect(screen.queryByRole("region", { name: "Tasks" })).not.toBeInTheDocument();
    expect(document.querySelector('.tasks-content[data-task-detail-open="true"]')).toBeInTheDocument();
    await waitFor(() => expect(announced("Added “Add retry to the payment call” to the prompt.")).toBe(true));
  });

  it("shows Chat for a task's thread link", async () => {
    const user = userEvent.setup();
    renderPanel(seededStore());
    await user.click(rowTitle("Audit checkout error states"));
    await user.click(within(panel()).getByRole("button", { name: "Checkout flow refactor" }));
    expect(window.location.pathname).toBe(threadPath("thread-9"));
    expect(screen.queryByRole("region", { name: "Tasks" })).not.toBeInTheDocument();
    expect(document.querySelector(".tasks-content")).toBeInTheDocument();
  });

  it("closes the detail, then search, with Escape, and leaves the panel open", async () => {
    const user = userEvent.setup();
    renderPanel(seededStore());
    const phonePanel = panel();
    const content = phonePanel.querySelector(".tasks-content")!;
    await user.click(rowTitle("Add retry to the payment call"));
    expect(content).toHaveAttribute("data-task-detail-open", "true");
    await user.keyboard("{Escape}");
    expect(content).not.toHaveAttribute("data-task-detail-open");

    await user.click(within(phonePanel).getByRole("button", { name: "Search tasks" }));
    expect(within(phonePanel).getByRole("textbox", { name: "Search tasks" })).toHaveFocus();
    await user.keyboard("{Escape}");
    expect(within(phonePanel).queryByRole("textbox", { name: "Search tasks" })).not.toBeInTheDocument();

    await user.keyboard("{Escape}");
    expect(panel()).toBe(phonePanel);
  });

  it("closes the panel with its ✕", async () => {
    const user = userEvent.setup();
    renderPanel(seededStore());
    await user.click(within(panel()).getByRole("button", { name: "Close Tasks panel" }));
    expect(screen.queryByRole("region", { name: "Tasks" })).not.toBeInTheDocument();
    expect(document.querySelector(".tasks-content")).not.toBeInTheDocument();
  });

  it("hands a file to Files, which takes focus and so comes in front", async () => {
    const panelLayoutStore = makePanelLayoutStore();
    renderPanel(seededStore(), { panelLayoutStore });
    fireEvent.click(rowTitle("Audit checkout error states"));
    fireEvent.click(screen.getByRole("button", { name: "Open /workspace/src/checkout.ts in Files" }));
    await vi.waitFor(() =>
      expect(panelLayoutStore.open).toHaveBeenCalledWith("files", {
        intent: expect.objectContaining({ path: "src/checkout.ts" }),
      }),
    );
    // Tasks stays loaded behind Files.
    expect(document.querySelector(".tasks-content")).toBeInTheDocument();
  });
});

describe("TasksPanelContent docked", () => {
  it("draws the panel family's header with one actions menu and the layout's controls", async () => {
    const user = userEvent.setup();
    const store = seededStore();
    const panelControls = {
      onClose: vi.fn(),
      region: {
        region: "right" as const,
        maximized: false,
        extended: true,
        onMaximize: vi.fn(),
        onRestore: vi.fn(),
        onMove: vi.fn(),
        onExtend: vi.fn(),
      },
    };
    const onShowChat = vi.fn();
    render(
      <TasksPanelContent
        presentation="panel"
        store={store}
        panelLayoutStore={makePanelLayoutStore()}
        route={{ name: "thread", threadId: "thread-9" }}
        active
        onShowChat={onShowChat}
        panelControls={panelControls}
      />,
    );

    const header = screen.getByRole("banner", { name: "Tasks panel header" });
    expect(header).toHaveClass("workspace-panel-chrome");
    expect(within(header).getByText("Tasks")).toBeInTheDocument();
    expect(within(header).getByLabelText("2 open")).toBeInTheDocument();
    expect(within(header).getByRole("button", { name: "Search tasks" })).toBeInTheDocument();
    expect(within(header).getByRole("button", { name: "Show only pinned tasks" })).toBeInTheDocument();
    expect(within(header).getByRole("button", { name: "View options" })).toBeInTheDocument();
    // One overflow menu: the panel's, carrying the Tasks items too.
    expect(within(header).queryByRole("button", { name: "Tasks panel options" })).not.toBeInTheDocument();
    await user.click(within(header).getByRole("button", { name: "Tasks panel actions" }));
    const menu = screen.getByRole("menu");
    expect(within(menu).getByRole("menuitemradio", { name: "Right" })).toBeChecked();
    expect(within(menu).getByRole("menuitem", { name: "Add a task with notes" })).toBeInTheDocument();
    expect(within(menu).getByRole("menuitem", { name: "Keyboard shortcuts" })).toBeInTheDocument();
    await user.keyboard("{Escape}");

    // The layout's own close, not the content's.
    expect(within(header).getAllByRole("button", { name: "Close Tasks panel" })).toHaveLength(1);
    await user.click(within(header).getByRole("button", { name: "Close Tasks panel" }));
    expect(panelControls.onClose).toHaveBeenCalled();
    expect(onShowChat).not.toHaveBeenCalled();
    expect(addInput()).toHaveAttribute("data-panel-autofocus");
  });
});

describe("TasksPanel host", () => {
  it("retains an unsaved edit while Settings suspends the phone panel", async () => {
    stubDensity(true);
    const store = makeStore([makeTask({ id: "g", title: "Global errand" })]);
    const panelLayoutStore = makePanelLayoutStore();
    const route = { name: "thread", threadId: "thread-9" } as const;
    const content = (active: boolean) => (
      <TasksHarness store={store} panelLayoutStore={panelLayoutStore} route={route} active={active} />
    );
    const view = render(content(true));
    fireEvent.click(rowTitle("Global errand"));
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Notes" }), {
      target: { value: "Unsaved while configuring" },
    });

    for (let cycle = 0; cycle < 2; cycle += 1) {
      view.rerender(content(false));
      expect(screen.queryByRole("dialog", { name: "Edit task" })).not.toBeInTheDocument();
      expect(screen.queryByRole("region", { name: "Tasks" })).not.toBeInTheDocument();
      view.rerender(content(true));
      const editor = screen.getByRole("dialog", { name: "Edit task" });
      expect(within(editor).getByRole("textbox", { name: "Notes" })).toHaveValue("Unsaved while configuring");
      // Let the replaced surface's deferred focus restoration run too.
      await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
      expect(editor).toContainElement(document.activeElement as HTMLElement);
    }
  });
});
