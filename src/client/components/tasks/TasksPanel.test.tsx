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
  revealTask,
} from "../../app/tasks-panel-store.js";
import { TasksPanel, TasksPanelContent } from "./TasksPanel.js";
import {
  TasksDockSlot,
  usePublishTasksDock,
  useTasksHost,
  type TasksHost,
} from "./tasks-host.js";
import type { PanelLayoutStore } from "../../workspace-panels/panel-state.js";
import { setPanelPresentation } from "../../app/settings.js";
import { TASK_DRAG_MIME, TaskDragProvider } from "../../tasks/task-drag.js";
import { CLOSE_TASK_DETAIL_EVENT } from "../../app/android-back.js";

const toast = vi.hoisted(() => ({ show: vi.fn() }));
vi.mock("../ui/toast.js", () => ({ useToast: () => toast }));

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
  // Desktop shell: the panel renders as the floating card, not the sheet.
  stubDensity(false);
  resetStorage();
  toast.show.mockReset();
});

afterEach(() => {
  cleanup();
  if (scrollIntoViewDescriptor) {
    Object.defineProperty(HTMLElement.prototype, "scrollIntoView", scrollIntoViewDescriptor);
  } else {
    Reflect.deleteProperty(HTMLElement.prototype, "scrollIntoView");
  }
  tasksHost = undefined;
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
    associatedWorkspaceId: null,
    title: "Write docs",
    details: "",
    pinned: false,
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
    createTask: vi.fn(async (title: string, scope: Task["scope"], details?: string) =>
      makeTask({ id: `created-${title}`, title, scope, details: details ?? "" }),
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

function makePanelLayoutStore(): PanelLayoutStore {
  return { openPanel: vi.fn(() => true) } as unknown as PanelLayoutStore;
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

let tasksHost: TasksHost | undefined;

/** Captures the host and anchors its popover, as the corner toggle does. */
function HostProbe(): React.JSX.Element {
  tasksHost = useTasksHost();
  return <span ref={(element) => tasksHost?.setPopoverAnchor(element)} />;
}

/** Stands in for a thread workspace with the Tasks panel docked in it. */
function DockedTasks({ active }: { readonly active: boolean }): React.JSX.Element {
  const [present, setPresent] = useState(true);
  usePublishTasksDock({
    present,
    visible: present && active,
    controls: {
      active,
      onCollapse: () => undefined,
      onClose: () => setPresent(false),
      onDock: () => undefined,
    },
    open: () => setPresent(true),
    toggle: () => setPresent((current) => !current),
    close: () => setPresent(false),
  });
  // Settings hides the retained workspace (and so the docked panel).
  return (
    <div hidden={!active}>
      <TasksDockSlot />
    </div>
  );
}

/**
 * The Tasks host as the application shell mounts it: docked in a thread
 * workspace, otherwise the popover, or the sheet on phones.
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
      <HostProbe />
      {route.name === "thread" ? <DockedTasks active={active} /> : null}
    </TasksPanel>
  );
}

/** Shows Tasks the way the page presents it (a docked panel is already shown). */
function openTasks(): void {
  if (tasksHost?.placement === undefined) act(() => tasksHost?.toggleOverlay());
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
  openTasks();
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
    label: { text: "acme-web" },
    displayPath: { text: "/workspace" },
    available: true,
  },
  {
    id: "workspace-2",
    environmentId: "local",
    label: { text: "billing-service" },
    displayPath: { text: "/billing" },
    available: true,
  },
];

const ENVIRONMENTS = [{ id: "local", kind: "local", label: { text: "Local" }, available: true }];

const threadTask = (overrides: Partial<AssociatedTask> = {}) =>
  makeTask({
    scope: { kind: "thread", threadId: "thread-9" },
    associatedWorkspaceId: "workspace-1",
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
      makeTask({ id: "p-upgrade", title: "Upgrade the test runner", scope: { kind: "workspace", workspaceId: "workspace-1" }, associatedWorkspaceId: "workspace-1" }),
      makeTask({ id: "s-sibling", title: "Sibling thread task", scope: { kind: "thread", threadId: "thread-2" }, associatedWorkspaceId: "workspace-1" }),
      makeTask({ id: "o-other", title: "Round invoices half-even", scope: { kind: "thread", threadId: "thread-other" }, associatedWorkspaceId: "workspace-2" }),
      makeTask({ id: "g-rotate", title: "Rotate staging credentials" }),
      ...extra,
    ],
    { threads: THREADS, workspaces: WORKSPACES, environments: ENVIRONMENTS },
  );
}

const panel = () => screen.getByRole("region", { name: "Tasks" });
const scope = () => screen.getByRole("radiogroup", { name: "Task scope view" });
const segment = (name: string) => within(scope()).getByRole("radio", { name });
const rowTitle = (title: string) => screen.getByRole("button", { name: title });
const rowOf = (title: string) => rowTitle(title).closest(".tasks-row") as HTMLElement;
const titles = () =>
  [...panel().querySelectorAll(".tasks-row-title")].map((node) => node.textContent);
const addInput = () => screen.getByRole("textbox", { name: "Add a task" });

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
      expect(store.createTask).toHaveBeenCalledWith("From All", { kind: "global" }, undefined),
    );

    view.unmount();
    renderPanel(store);
    expect(segment("All")).toHaveAttribute("aria-checked", "true");
  });

  it("disables views that do not apply and says why", () => {
    const store = makeStore([makeTask()], { threads: THREADS, workspaces: WORKSPACES });
    renderPanel(store);

    expect(segment("Thread")).toBeDisabled();
    expect(segment("Project")).toBeDisabled();
    expect(segment("Global")).toHaveAttribute("aria-checked", "true");
    expect(scope()).toHaveAccessibleDescription(
      "Thread: Open a thread to see its tasks. Project: Open a thread in a project to see its project tasks.",
    );
    expect(segment("Thread").parentElement).toHaveAttribute(
      "title",
      "Open a thread to see its tasks.",
    );
  });

  it("groups All by Global, then projects with their threads, collapsibly", () => {
    renderPanel(seededStore());
    fireEvent.click(segment("All"));

    const headings = [...panel().querySelectorAll(".tasks-group-heading")].map(
      (node) => node.textContent,
    );
    expect(headings).toEqual([
      "Global1",
      "acme-web4",
      "Checkout flow refactor2",
      "Sibling thread1",
      "billing-service1",
      "Invoice rounding bug1",
    ]);
    // Location shows in the headings, never inline on the rows.
    expect(panel().querySelector(".tasks-row-location")).toBeNull();

    const acme = screen.getByRole("button", { name: /^acme-web/ });
    expect(acme).toHaveAttribute("aria-expanded", "true");
    fireEvent.click(acme);
    expect(acme).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByRole("button", { name: "Upgrade the test runner" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^Sibling thread/ })).not.toBeInTheDocument();
    expect(rowTitle("Round invoices half-even")).toBeInTheDocument();
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
    expect(store.createTask).toHaveBeenCalledWith("Ship it", { kind: "thread", threadId: "thread-9" });
  });

  it("keeps a single-line paste in the field", async () => {
    const user = userEvent.setup();
    renderPanel(seededStore());
    await user.click(addInput());
    await user.paste("Just one line");
    expect(addInput()).toHaveValue("Just one line");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
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
  it("collapses completed tasks into a muted Completed section with undo", async () => {
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
    expect(toast.show).toHaveBeenCalledWith({
      message: "Task completed",
      anchor: expect.any(HTMLElement),
      action: { label: "Undo", onAction: expect.any(Function) },
    });
    // The toast sits on the Tasks surface it came from.
    expect(toast.show.mock.calls[0]![0].anchor.closest("[data-toast-region]")).toBe(panel());
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

    await act(async () => toast.show.mock.calls[0]![0].action.onAction());
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
    expect(toast.show).not.toHaveBeenCalled();
  });

  it("explains when no composer can receive the task", async () => {
    const user = userEvent.setup();
    renderPanel(seededStore());
    await user.click(rowTitle("Add retry to the payment call"));
    await user.click(screen.getByRole("button", { name: "Add to prompt" }));
    expect(screen.getByRole("alert")).toHaveTextContent("The message composer is unavailable.");
  });

  it("moves through the row menu with an undo toast", async () => {
    const user = userEvent.setup();
    const store = seededStore();
    renderPanel(store);

    await user.click(screen.getByRole("button", { name: 'Actions for "Add retry to the payment call"' }));
    const menu = screen.getByRole("menu");
    expect(within(menu).getAllByRole("menuitem").map((item) => item.textContent)).toEqual([
      "Add to prompt",
      "Edit…E",
      "PinP",
      "Move to",
      "Delete…",
    ]);
    // The key hints are visual; the names stay plain and the keys are exposed.
    expect(within(menu).getByRole("menuitem", { name: "Pin" })).toHaveAttribute("aria-keyshortcuts", "P");
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
      { kind: "workspace", workspaceId: "workspace-1" },
    );
    await waitFor(() =>
      expect(toast.show).toHaveBeenCalledWith({
        message: "Moved to acme-web",
        anchor: expect.any(HTMLElement),
        action: { label: "Undo", onAction: expect.any(Function) },
      }),
    );
    expect(toast.show.mock.calls[0]![0].anchor.closest("[data-toast-region]")).toBe(panel());
    await act(async () => toast.show.mock.calls[0]![0].action.onAction());
    expect(store.moveTask).toHaveBeenLastCalledWith(
      expect.objectContaining({ id: "t-retry" }),
      { kind: "thread", threadId: "thread-9" },
    );
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
        { kind: "workspace", workspaceId: "workspace-1" },
        expect.any(String),
      ),
    );
    await waitFor(() =>
      expect(toast.show).toHaveBeenCalledWith({
        message: "Moved to acme-web",
        anchor: expect.any(HTMLElement),
        action: { label: "Undo", onAction: expect.any(Function) },
      }),
    );
    expect(toast.show.mock.calls[0]![0].anchor.closest("[data-toast-region]")).toBe(panel());
    // Undo moves it back where it came from.
    await act(async () => toast.show.mock.calls[0]![0].action.onAction());
    expect(store.moveTask).toHaveBeenLastCalledWith(
      expect.objectContaining({ id: "t-retry" }),
      { kind: "thread", threadId: "thread-9" },
      expect.any(String),
    );
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
        { kind: "workspace", workspaceId: "workspace-1" },
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
    await waitFor(() =>
      expect(toast.show).toHaveBeenCalledWith(expect.objectContaining({ message: "Moved to Global" })),
    );
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
        scope: { kind: "workspace", workspaceId: "workspace-1" },
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
    const route = { name: "thread", threadId: "thread-9", automationOpen: false } as const;
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
    ]);
    const view = renderPanel(store);
    expect(titles()).toEqual(["Audit checkout error states", "Add retry to the payment call", "Zeta cleanup"]);

    await user.click(screen.getByRole("button", { name: "View options" }));
    await user.click(screen.getByRole("menuitemradio", { name: "Title" }));
    // The menu stays open for several choices.
    expect(screen.getByRole("menu", { name: "View options" })).toBeInTheDocument();
    expect(titles()).toEqual(["Add retry to the payment call", "Audit checkout error states", "Zeta cleanup"]);
    await user.click(screen.getByRole("menuitemradio", { name: "Recently updated" }));
    expect(titles()[0]).toBe("Zeta cleanup");
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

    await user.click(screen.getByRole("button", { name: "View options" }));
    await user.click(screen.getByRole("menuitemcheckbox", { name: "With notes" }));
    await user.click(screen.getByRole("menuitemradio", { name: "Completed" }));
    expect(titles()).toEqual(["Remove the legacy flag"]);
    expect(screen.queryByRole("button", { name: /^Completed/ })).not.toBeInTheDocument();
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

  it("closes the expanded row, then search, before Escape closes the popover", async () => {
    const user = userEvent.setup();
    renderPanel(makeStore([makeTask({ id: "g", title: "Global errand" })]));
    expect(panel()).toHaveAttribute("data-presentation", "popover");
    await user.click(rowTitle("Global errand"));
    await user.keyboard("{Escape}");
    expect(rowTitle("Global errand")).toHaveAttribute("aria-expanded", "false");
    expect(panel()).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Search tasks" }));
    expect(screen.getByRole("textbox", { name: "Search tasks" })).toHaveFocus();
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("textbox", { name: "Search tasks" })).not.toBeInTheDocument();
    expect(panel()).toBeInTheDocument();

    await user.keyboard("{Escape}");
    expect(screen.queryByRole("region", { name: "Tasks" })).not.toBeInTheDocument();
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

  it("delivers a reveal requested before Tasks mounted and clears hiding filters", async () => {
    const user = userEvent.setup();
    const store = seededStore();
    const view = renderPanel(store);
    await user.click(screen.getByRole("button", { name: "View options" }));
    await user.click(screen.getByRole("menuitemcheckbox", { name: "Pinned" }));
    view.unmount();

    revealTask("t-retry");
    renderPanel(store);
    await waitFor(() => expect(rowTitle("Add retry to the payment call")).toHaveAttribute("aria-expanded", "true"));
  });
});

describe("TasksPanel files", () => {
  it("opens a linked file in the Files panel", async () => {
    setPanelPresentation("single");
    const panelLayoutStore = makePanelLayoutStore();
    renderPanel(seededStore(), { panelLayoutStore });

    fireEvent.click(rowTitle("Audit checkout error states"));
    fireEvent.click(screen.getByRole("button", { name: "Open /workspace/src/checkout.ts in Files" }), { shiftKey: true });
    await vi.waitFor(() =>
      expect(panelLayoutStore.openPanel).toHaveBeenCalledWith("workspace-files", {
        presentation: "split",
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
      { threads: THREADS, workspaces: WORKSPACES, resolveFileLink: () => ({ status: "not_found" }) },
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

describe("TasksPanel phone sheet", () => {
  beforeEach(() => stubDensity(true));

  it("puts the add bar under the list and drills into a task's detail", async () => {
    const user = userEvent.setup();
    const stageTaskReference = vi.fn();
    renderPanel(seededStore(), { stageTaskReference });
    const sheet = screen.getByRole("dialog", { name: "Tasks" });
    // Opening focuses the view rather than the add bar (no soft keyboard).
    await waitFor(() => expect(within(sheet).getByRole("radio", { name: "Thread" })).toHaveFocus());

    const content = sheet.querySelector(".tasks-content")!;
    expect(content).toHaveAttribute("data-presentation", "sheet");
    expect(content.lastElementChild?.previousElementSibling).toHaveClass("tasks-add");
    expect(within(sheet).getByRole("button", { name: "Add task" })).toBeDisabled();
    expect(within(sheet).queryByRole("button", { name: "View options" })).not.toBeInTheDocument();
    // ⋯ is always shown on touch.
    expect(within(sheet).getByRole("button", { name: 'Actions for "Add retry to the payment call"' })).toBeInTheDocument();

    await user.click(rowTitle("Audit checkout error states"));
    expect(content).toHaveAttribute("data-task-detail-open", "true");
    expect(within(sheet).getByRole("heading", { name: "Audit checkout error states" })).toBeInTheDocument();
    expect(within(sheet).getByRole("button", { name: "Back to tasks" })).toHaveFocus();
    expect(within(sheet).queryByRole("textbox", { name: "Add a task" })).not.toBeInTheDocument();

    act(() => window.dispatchEvent(new Event(CLOSE_TASK_DETAIL_EVENT)));
    expect(content).not.toHaveAttribute("data-task-detail-open");
    expect(sheet).toBeInTheDocument();
    await waitFor(() => expect(rowTitle("Audit checkout error states")).toHaveFocus());

    await user.click(rowTitle("Add retry to the payment call"));
    await user.click(within(sheet).getByRole("button", { name: "Add to prompt" }));
    expect(stageTaskReference).toHaveBeenCalledWith({ taskId: "t-retry", titleSnapshot: "Add retry to the payment call" });
    expect(toast.show).toHaveBeenCalledWith({ message: "Added to prompt" });
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Tasks" })).not.toBeInTheDocument());
  });

  it("closes the detail with Escape before the sheet", () => {
    renderPanel(seededStore());
    fireEvent.click(rowTitle("Add retry to the payment call"));
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.getByRole("dialog", { name: "Tasks" })).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "Add a task" })).toBeInTheDocument();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("dialog", { name: "Tasks" })).not.toBeInTheDocument();
  });

  it("closes the sheet after handing a file to Files", async () => {
    renderPanel(seededStore());
    fireEvent.click(rowTitle("Audit checkout error states"));
    fireEvent.click(screen.getByRole("button", { name: "Open /workspace/src/checkout.ts in Files" }));
    await vi.waitFor(() => expect(screen.queryByRole("dialog", { name: "Tasks" })).not.toBeInTheDocument());
  });

  it("anchors the sheet to the bottom and lifts it above the keyboard", () => {
    vi.stubGlobal("innerHeight", 800);
    vi.stubGlobal("visualViewport", {
      height: 500,
      offsetTop: 20,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    });
    renderPanel(makeStore([]));
    const sheet = screen.getByRole("dialog", { name: "Tasks" });
    expect(sheet).toHaveAttribute("data-layout", "sheet");
    expect(sheet.style.getPropertyValue("--keyboard-inset")).toBe("280px");
  });
});

describe("TasksPanelContent docked", () => {
  it("draws the panel family's header with one actions menu and the layout's controls", async () => {
    const user = userEvent.setup();
    const store = seededStore();
    const panelControls = { onCollapse: vi.fn(), onClose: vi.fn(), onDock: vi.fn(), dockEdge: "right" as const };
    const onRequestClose = vi.fn();
    render(
      <TasksPanelContent
        presentation="panel"
        store={store}
        panelLayoutStore={makePanelLayoutStore()}
        route={{ name: "thread", threadId: "thread-9", automationOpen: false }}
        active
        onRequestClose={onRequestClose}
        panelControls={panelControls}
      />,
    );

    const header = screen.getByRole("banner", { name: "Tasks panel header" });
    expect(header).toHaveClass("workspace-panel-chrome");
    expect(within(header).getByText("Tasks")).toBeInTheDocument();
    expect(within(header).getByLabelText("2 open")).toBeInTheDocument();
    expect(within(header).getByRole("button", { name: "Search tasks" })).toBeInTheDocument();
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
    expect(onRequestClose).not.toHaveBeenCalled();
    expect(addInput()).toHaveAttribute("data-panel-autofocus");
  });
});

describe("TasksPanel host", () => {
  it.each([false, true])(
    "retains an unsaved edit while Settings suspends the popover or sheet (phone: %s)",
    (phone) => {
      stubDensity(phone);
      const store = makeStore([makeTask({ id: "g", title: "Global errand" })]);
      const panelLayoutStore = makePanelLayoutStore();
      const route = { name: "home" } as const;
      const content = (active: boolean) => (
        <TasksHarness store={store} panelLayoutStore={panelLayoutStore} route={route} active={active} />
      );
      const view = render(content(true));
      openTasks();
      fireEvent.click(rowTitle("Global errand"));
      fireEvent.click(screen.getByRole("button", { name: "Edit" }));
      fireEvent.change(screen.getByRole("textbox", { name: "Notes" }), {
        target: { value: "Unsaved while configuring" },
      });

      view.rerender(content(false));
      expect(screen.queryByRole("dialog", { name: "Edit task" })).not.toBeInTheDocument();
      expect(screen.queryByRole("region", { name: "Tasks" })).not.toBeInTheDocument();
      view.rerender(content(true));
      expect(screen.getByRole("textbox", { name: "Notes" })).toHaveValue("Unsaved while configuring");
    },
  );

  it("keeps the popover open for presses inside the retained content", async () => {
    const user = userEvent.setup();
    renderPanel(makeStore([makeTask({ id: "g", title: "Global errand" })]));
    await user.click(rowTitle("Global errand"));
    expect(panel()).toHaveAttribute("data-presentation", "popover");
    await user.click(screen.getByRole("button", { name: "Edit" }));
    expect(screen.getByRole("dialog", { name: "Edit task" })).toBeInTheDocument();
  });

  it("dismisses the popover on an outside pointer and offers no pin or resize", async () => {
    const user = userEvent.setup();
    const outside = document.createElement("button");
    document.body.append(outside);
    renderPanel(makeStore([]));
    await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));

    expect(panel()).toHaveAttribute("data-presentation", "popover");
    expect(screen.queryByRole("button", { name: /Pin Tasks panel/ })).toBeNull();
    expect(screen.queryByRole("separator", { name: "Resize Tasks panel" })).toBeNull();
    await user.click(outside);
    await waitFor(() =>
      expect(screen.queryByRole("region", { name: "Tasks" })).not.toBeInTheDocument(),
    );
    outside.remove();
  });

  it("closes the popover from its close button", async () => {
    const user = userEvent.setup();
    renderPanel(makeStore([]));
    await user.click(screen.getByRole("button", { name: "Close Tasks panel" }));
    expect(screen.queryByRole("region", { name: "Tasks" })).not.toBeInTheDocument();
  });
});
