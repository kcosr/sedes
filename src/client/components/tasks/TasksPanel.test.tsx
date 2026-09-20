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
import { useLayoutEffect } from "react";
import {
  TASK_DETAILS_MAX_CHARACTERS,
  type AssociatedTask,
  type NormalizedApplicationSnapshot,
  type Task,
  type WorkspaceFileLinkReference,
} from "../../../shared/index.js";
import type { ApplicationClientStore } from "../../stores/ApplicationClientStore.js";
import { navigate, threadPath } from "../../app/router.js";
import {
  ComposerDraftProvider,
  useComposerDraftCoordinator,
} from "../../context-excerpts/coordinator.js";
import {
  setTasksPanelIncludeNestedScopes,
  setTasksPanelOpen,
  setTasksPanelPinned,
} from "../../app/tasks-panel-store.js";
import { TasksPanel } from "./TasksPanel.js";
import type { PanelLayoutStore } from "../../workspace-panels/panel-state.js";
import { setPanelPresentation } from "../../app/settings.js";
import { TASK_DRAG_MIME, TaskDragProvider } from "../../tasks/task-drag.js";

const scrollIntoViewDescriptor = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "scrollIntoView");

beforeEach(() => {
  HTMLElement.prototype.scrollIntoView = vi.fn();
  // Desktop shell: the panel renders as the floating card, not the sheet.
  vi.stubGlobal(
    "matchMedia",
    vi.fn(() => ({
      matches: false,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })),
  );
  setTasksPanelIncludeNestedScopes(false);
  setTasksPanelPinned(true);
  setTasksPanelOpen(true);
});

afterEach(() => {
  cleanup();
  if (scrollIntoViewDescriptor) {
    Object.defineProperty(HTMLElement.prototype, "scrollIntoView", scrollIntoViewDescriptor);
  } else {
    Reflect.deleteProperty(HTMLElement.prototype, "scrollIntoView");
  }
  setTasksPanelOpen(false);
  vi.unstubAllGlobals();
  window.localStorage.clear();
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

function makeStore(
  tasks: readonly AssociatedTask[],
  context: {
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
  } = {},
): ApplicationClientStore {
  const state = {
    snapshot: {
      threads: context.threads ?? [],
      workspaces: context.workspaces ?? [],
      environments: context.environments ?? [],
      tasks,
    },
  };
  return {
    subscribe: () => () => undefined,
    getSnapshot: () => state,
    getTasks: () => state.snapshot.tasks,
    createTask: vi.fn(async (title: string, scope: Task["scope"]) =>
      makeTask({ id: "created-task", title, scope }),
    ),
    updateTask: vi.fn(async () => undefined),
    moveTask: vi.fn(async () => undefined),
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
  } as unknown as ApplicationClientStore;
}

function makePublishingStore(
  initialTasks: readonly AssociatedTask[],
  context: Parameters<typeof makeStore>[1] = {},
): {
  readonly store: ApplicationClientStore;
  readonly publishTasks: (tasks: readonly AssociatedTask[]) => void;
} {
  let state = {
    snapshot: {
      threads: context.threads ?? [],
      workspaces: context.workspaces ?? [],
      tasks: initialTasks,
    },
  };
  const listeners = new Set<() => void>();
  const store = makeStore(initialTasks, context);
  Object.assign(store, {
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    getSnapshot: () => state,
  });
  return {
    store,
    publishTasks: (tasks) => {
      state = { snapshot: { ...state.snapshot, tasks } };
      for (const listener of listeners) listener();
    },
  };
}

function makePanelLayoutStore(): PanelLayoutStore {
  return {
    openPanel: vi.fn(() => true),
  } as unknown as PanelLayoutStore;
}

function renderPanel(
  store: ApplicationClientStore,
  panelLayoutStore = makePanelLayoutStore(),
  stageTaskReference?: (reference: unknown) => void,
) {
  return render(
    <ComposerDraftProvider threadId="thread-9" workspaceId="workspace-1">
      {stageTaskReference && (
        <DraftConsumer stageTaskReference={stageTaskReference} />
      )}
      <TasksPanel store={store} panelLayoutStore={panelLayoutStore} />
    </ComposerDraftProvider>,
  );
}

function renderPanelWithTaskDrag(store: ApplicationClientStore) {
  const snapshot = store.getSnapshot().snapshot!;
  return render(
    <TaskDragProvider
      store={store}
      snapshot={snapshot as NormalizedApplicationSnapshot}
    >
      <ComposerDraftProvider threadId="thread-9" workspaceId="workspace-1">
        <TasksPanel store={store} panelLayoutStore={makePanelLayoutStore()} />
      </ComposerDraftProvider>
    </TaskDragProvider>,
  );
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

describe("TasksPanel", () => {
  it.each([false, true])("retains an unsaved task editor while Settings suspends the %s mobile surface", (mobile) => {
    vi.stubGlobal("matchMedia", vi.fn(() => ({ matches: mobile, addEventListener: vi.fn(), removeEventListener: vi.fn() })));
    const store = makeStore([makeTask({ scope: { kind: "thread", threadId: "thread-1" } })], {
      threads: [{ id: "thread-1", workspaceId: "workspace-1", title: { text: "Retained thread" }, inventoryState: "active" }],
      workspaces: [{ id: "workspace-1", label: { text: "Project" }, displayPath: { text: "/workspace" } }],
    });
    const panelLayoutStore = makePanelLayoutStore();
    const route = { name: "thread", threadId: "thread-1", automationOpen: false } as const;
    const content = (active: boolean) => <TasksPanel store={store} panelLayoutStore={panelLayoutStore} route={route} active={active} />;
    const view = render(content(true));
    fireEvent.click(screen.getByRole("button", { name: 'View "Write docs"' }));
    fireEvent.click(screen.getByRole("button", { name: /Edit/ }));
    const notes = screen.getByLabelText("Task notes");
    fireEvent.change(notes, { target: { value: "Unsaved while configuring" } });
    act(() => navigate("/settings/general"));
    view.rerender(content(false));
    expect(screen.queryByRole("dialog", { name: "Tasks" })).not.toBeInTheDocument();
    expect(notes).not.toBeVisible();
    fireEvent.keyDown(document, { key: "Escape" });
    view.rerender(content(true));
    expect(screen.getByLabelText("Task notes")).toBe(notes);
    expect(notes).toHaveValue("Unsaved while configuring");
  });

  it("treats pointer events inside the retained body as inside an unpinned Tasks surface", async () => {
    setTasksPanelPinned(false);
    const store = makeStore([makeTask()]);
    renderPanel(store);
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: 'View "Write docs"' }));
    expect(screen.getByRole("region", { name: "Tasks" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /Edit/ }));
    expect(screen.getByLabelText("Task notes")).toBeInTheDocument();
  });

  it("orders tasks newest first without promoting recently edited older tasks", () => {
    const store = makeStore([
      makeTask({
        id: "old",
        title: "Older",
        createdAt: "2026-08-01T09:00:00.000Z",
        updatedAt: "2026-08-03T09:00:00.000Z",
      }),
      makeTask({
        id: "new",
        title: "Newer",
        createdAt: "2026-08-02T09:00:00.000Z",
      }),
    ]);
    renderPanel(store);
    expect(
      screen
        .getAllByRole("button", { name: /^View / })
        .map((button) => button.textContent),
    ).toEqual(["Newer", "Older"]);
  });
  it("orders open tasks ahead of completed ones", () => {
    const store = makeStore([
      makeTask({
        id: "task-done",
        title: "Ship it",
        createdAt: "2026-08-01T09:00:00.000Z",
        completedAt: "2026-08-02T10:00:00.000Z",
      }),
      makeTask({
        id: "task-open",
        title: "Write docs",
        createdAt: "2026-08-01T10:00:00.000Z",
      }),
    ]);
    renderPanel(store);

    const titles = screen.getAllByRole("button", { name: /^View / });
    expect(titles.map((button) => button.textContent)).toEqual([
      "Write docs",
      "Ship it",
    ]);
  });

  it("orders pinned tasks first, then open tasks within each pin group", () => {
    const store = makeStore([
      makeTask({
        id: "older",
        title: "Older",
        createdAt: "2026-08-01T09:00:00.000Z",
      }),
      makeTask({ id: "pinned", title: "Pinned", pinned: true }),
      makeTask({
        id: "done-pinned",
        title: "Done pinned",
        pinned: true,
        completedAt: "2026-08-02T10:00:00.000Z",
      }),
    ]);
    renderPanel(store);

    expect(
      screen
        .getAllByRole("button", { name: /^View / })
        .map((button) => button.textContent),
    ).toEqual(["Pinned", "Done pinned", "Older"]);
  });

  it("persistently includes every principal task from the global view without changing creation scope", async () => {
    const context = {
      threads: [
        {
          id: "thread-1",
          workspaceId: "workspace-1",
          title: { text: "Task thread" },
        },
      ],
      workspaces: [
        {
          id: "workspace-1",
          label: { text: "Sedes" },
          displayPath: { text: "/workspace" },
          available: true,
        },
      ],
    };
    const store = makeStore(
      [
        makeTask({ id: "global", title: "Global task" }),
        makeTask({
          id: "project",
          title: "Project task",
          scope: { kind: "workspace", workspaceId: "workspace-1" },
          associatedWorkspaceId: "workspace-1",
        }),
        makeTask({
          id: "thread",
          title: "Thread task",
          scope: { kind: "thread", threadId: "thread-1" },
          associatedWorkspaceId: "workspace-1",
        }),
      ],
      context,
    );
    renderPanel(store);
    fireEvent.click(screen.getByRole("radio", { name: "Global" }));

    expect(screen.getAllByRole("button", { name: /^View / })).toHaveLength(1);
    const includeNested = screen.getByRole("checkbox", {
      name: "Include nested scopes",
    });
    fireEvent.click(includeNested);

    expect(screen.getAllByRole("button", { name: /^View / })).toHaveLength(3);
    expect(screen.queryByTitle("Global")).not.toBeInTheDocument();
    expect(screen.getByTitle("Sedes")).toBeInTheDocument();
    expect(screen.getByTitle("Sedes / Task thread")).toBeInTheDocument();
    expect(
      JSON.parse(window.localStorage.getItem("sedes.tasks.panel") ?? "null")
        .includeNestedScopes,
    ).toBe(true);

    fireEvent.change(screen.getByRole("searchbox"), {
      target: { value: "Create global" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Add task" }));
    await vi.waitFor(() =>
      expect(store.createTask).toHaveBeenCalledWith("Create global", {
        kind: "global",
      }),
    );
  });

  it("includes only authoritative child threads from a project view and keeps thread view exact", async () => {
    act(() => navigate(threadPath("thread-1")));
    const store = makeStore(
      [
        makeTask({
          id: "project",
          title: "Project task",
          scope: { kind: "workspace", workspaceId: "workspace-1" },
          associatedWorkspaceId: "workspace-1",
        }),
        makeTask({
          id: "child",
          title: "Child task",
          scope: { kind: "thread", threadId: "thread-1" },
          associatedWorkspaceId: "workspace-1",
        }),
        makeTask({
          id: "sibling",
          title: "Sibling task",
          scope: { kind: "thread", threadId: "thread-2" },
          associatedWorkspaceId: "workspace-1",
        }),
        makeTask({
          id: "other-project",
          title: "Other project task",
          scope: { kind: "thread", threadId: "thread-other" },
          associatedWorkspaceId: "workspace-2",
        }),
        makeTask({
          id: "missing-thread",
          title: "Capped thread task",
          scope: { kind: "thread", threadId: "missing" },
          associatedWorkspaceId: "workspace-1",
        }),
      ],
      {
        threads: [
          {
            id: "thread-1",
            workspaceId: "workspace-1",
            title: { text: "Current" },
          },
          {
            id: "thread-2",
            workspaceId: "workspace-1",
            title: { text: "Sibling" },
          },
          {
            id: "thread-other",
            workspaceId: "workspace-2",
            title: { text: "Elsewhere" },
          },
        ],
        workspaces: [
          {
            id: "workspace-1",
            label: { text: "Sedes" },
            displayPath: { text: "/workspace" },
            available: true,
          },
          {
            id: "workspace-2",
            label: { text: "Other" },
            displayPath: { text: "/other" },
            available: true,
          },
        ],
      },
    );
    renderPanel(store);
    fireEvent.click(screen.getByRole("radio", { name: "Project" }));

    expect(
      screen.getByRole("button", { name: 'View "Project task"' }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: 'View "Child task"' }),
    ).not.toBeInTheDocument();
    fireEvent.click(
      screen.getByRole("checkbox", { name: "Include nested scopes" }),
    );

    expect(
      screen.getByRole("button", { name: 'View "Child task"' }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: 'View "Sibling task"' }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: 'View "Other project task"' }),
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: 'View "Capped thread task"' }),
    ).toBeInTheDocument();
    expect(screen.getByTitle("Current")).toBeInTheDocument();
    expect(screen.getByTitle("Sibling")).toBeInTheDocument();
    expect(screen.getByTitle("Thread")).toBeInTheDocument();
    expect(screen.queryByTitle("Sedes")).not.toBeInTheDocument();

    fireEvent.click(
      screen.getByRole("button", { name: 'View "Sibling task"' }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    fireEvent.click(
      within(screen.getByRole("radiogroup", { name: "Task scope" })).getByRole(
        "radio",
        { name: "Thread" },
      ),
    );
    fireEvent.change(screen.getByLabelText("Task title"), {
      target: { value: "Edited sibling task" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save task" }));
    await vi.waitFor(() =>
      expect(store.updateTask).toHaveBeenCalledWith(
        expect.objectContaining({ id: "sibling" }),
        expect.objectContaining({
          title: "Edited sibling task",
          scope: { kind: "thread", threadId: "thread-2" },
        }),
      ),
    );

    fireEvent.click(
      within(
        screen.getByRole("radiogroup", { name: "Task scope view" }),
      ).getByRole("radio", { name: "Thread" }),
    );
    expect(
      screen.queryByRole("checkbox", { name: "Include nested scopes" }),
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: 'View "Child task"' }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: 'View "Sibling task"' }),
    ).not.toBeInTheDocument();
    expect(document.querySelector(".tasks-row-location")).toBeNull();
  });

  it("pins directly from a task row", async () => {
    const store = makeStore([makeTask()]);
    renderPanel(store);

    fireEvent.click(screen.getByRole("button", { name: 'Pin "Write docs"' }));

    await vi.waitFor(() =>
      expect(store.updateTask).toHaveBeenCalledWith(
        expect.objectContaining({ id: "task-1" }),
        { pinned: true },
      ),
    );
  });

  it("keeps pinning on the task row and presents text-only detail editing", () => {
    const store = makeStore([makeTask({ pinned: true })]);
    renderPanel(store);

    fireEvent.click(screen.getByRole("button", { name: 'View "Write docs"' }));

    expect(screen.getByRole("button", { name: "Edit" })).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Edit" }).querySelector("svg"),
    ).toBeNull();
    expect(
      screen.queryByRole("button", { name: "Unpin task" }),
    ).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    expect(screen.getByText("Edit task")).toBeInTheDocument();
    expect(
      screen.queryByRole("checkbox", { name: "Pin task" }),
    ).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Delete task" })).toHaveAttribute(
      "data-variant",
      "destructive",
    );
  });

  it("shows the selected task in the detail preview and gates prompt insertion", () => {
    const store = makeStore([
      makeTask({ details: "Cover the tasks API end to end." }),
    ]);
    renderPanel(store);

    fireEvent.click(screen.getByRole("button", { name: 'View "Write docs"' }));
    expect(
      screen.getByText("Cover the tasks API end to end."),
    ).toBeInTheDocument();
    // No thread open: insertion has no composer to target.
    expect(
      screen.getByRole("button", { name: /Add to prompt/ }),
    ).toBeDisabled();
  });

  it("stages the task reference without closing an unpinned panel", () => {
    act(() => navigate(threadPath("thread-9")));
    const store = makeStore(
      [
        makeTask({
          scope: { kind: "thread", threadId: "thread-9" },
          details: "Cover the tasks API end to end.",
        }),
      ],
      {
        threads: [
          {
            id: "thread-9",
            workspaceId: "workspace-1",
            title: { text: "Current thread" },
          },
        ],
        workspaces: [{ id: "workspace-1", label: { text: "Sedes" }, displayPath: { text: "/sedes" } }],
      },
    );
    const stage = vi.fn();
    renderPanel(store, makePanelLayoutStore(), stage);

    fireEvent.click(screen.getByRole("button", { name: "Unpin Tasks panel" }));
    fireEvent.click(screen.getByRole("button", { name: 'View "Write docs"' }));
    fireEvent.click(screen.getByRole("button", { name: /Add to prompt/ }));

    expect(stage).toHaveBeenCalledWith({
      taskId: "task-1",
      titleSnapshot: "Write docs",
    });
    expect(screen.getByRole("region", { name: "Tasks" })).toBeInTheDocument();
  });

  it("dismisses only an unpinned desktop panel on an outside pointer", async () => {
    const user = userEvent.setup();
    const outside = document.createElement("button");
    document.body.append(outside);
    renderPanel(makeStore([]));
    await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));

    expect(
      screen.getByRole("button", { name: "Unpin Tasks panel" }),
    ).toHaveAttribute("aria-pressed", "true");
    await user.click(outside);
    expect(screen.getByRole("region", { name: "Tasks" })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Unpin Tasks panel" }));
    expect(
      screen.getByRole("button", { name: "Pin Tasks panel" }),
    ).toHaveAttribute("aria-pressed", "false");
    expect(
      JSON.parse(window.localStorage.getItem("sedes.tasks.panel") ?? "null")
        .pinned,
    ).toBe(false);
    await user.click(outside);
    await waitFor(() =>
      expect(
        screen.queryByRole("region", { name: "Tasks" }),
      ).not.toBeInTheDocument(),
    );
    outside.remove();
  });

  it("keeps the panel open and explains when no composer receives the task", () => {
    act(() => navigate(threadPath("thread-9")));
    const store = makeStore(
      [makeTask({ scope: { kind: "thread", threadId: "thread-9" } })],
      {
        threads: [
          {
            id: "thread-9",
            workspaceId: "workspace-1",
            title: { text: "Current thread" },
          },
        ],
        workspaces: [{ id: "workspace-1", label: { text: "Sedes" }, displayPath: { text: "/sedes" } }],
      },
    );
    renderPanel(store);

    fireEvent.click(screen.getByRole("button", { name: 'View "Write docs"' }));
    fireEvent.click(screen.getByRole("button", { name: /Add to prompt/ }));

    expect(screen.getByRole("alert")).toHaveTextContent(
      "The message composer is unavailable.",
    );
    expect(screen.getByRole("region", { name: "Tasks" })).toBeInTheDocument();
  });

  it("stages the same reference shape when the task has no details", () => {
    act(() => navigate(threadPath("thread-9")));
    const store = makeStore(
      [makeTask({ scope: { kind: "thread", threadId: "thread-9" } })],
      {
        threads: [
          {
            id: "thread-9",
            workspaceId: "workspace-1",
            title: { text: "Current thread" },
          },
        ],
        workspaces: [{ id: "workspace-1", label: { text: "Sedes" }, displayPath: { text: "/sedes" } }],
      },
    );
    const stage = vi.fn();
    renderPanel(store, makePanelLayoutStore(), stage);

    fireEvent.click(screen.getByRole("button", { name: 'View "Write docs"' }));
    fireEvent.click(screen.getByRole("button", { name: /Add to prompt/ }));

    expect(stage).toHaveBeenCalledWith({
      taskId: "task-1",
      titleSnapshot: "Write docs",
    });
  });

  it("exits edit mode and previews the newly selected task", () => {
    const store = makeStore([
      makeTask({ id: "task-a", title: "Task A", details: "Notes for A" }),
      makeTask({
        id: "task-b",
        title: "Task B",
        details: "Notes for B",
        createdAt: "2026-08-01T11:00:00.000Z",
      }),
    ]);
    renderPanel(store);

    fireEvent.click(screen.getByRole("button", { name: 'View "Task A"' }));
    fireEvent.click(screen.getByRole("button", { name: /Edit/ }));
    expect(screen.getByLabelText("Task notes")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: 'View "Task B"' }));
    expect(screen.queryByLabelText("Task notes")).not.toBeInTheDocument();
    expect(screen.getByText("Notes for B")).toBeInTheDocument();
  });

  it("uses the shared large-document limit in the task editor", () => {
    const store = makeStore([makeTask()]);
    renderPanel(store);

    fireEvent.click(screen.getByRole("button", { name: 'View "Write docs"' }));
    fireEvent.click(screen.getByRole("button", { name: /Edit/ }));

    expect(screen.getByLabelText("Task notes")).toHaveAttribute(
      "maxlength",
      String(TASK_DETAILS_MAX_CHARACTERS),
    );
  });

  it("keeps delete, save, and cancel above the notes field", () => {
    const store = makeStore([makeTask()]);
    renderPanel(store);

    fireEvent.click(screen.getByRole("button", { name: 'View "Write docs"' }));
    fireEvent.click(screen.getByRole("button", { name: /Edit/ }));

    const notes = screen.getByLabelText("Task notes");
    for (const name of ["Delete task", "Save task", "Cancel editing"]) {
      const action = screen.getByRole("button", { name });
      expect(
        action.compareDocumentPosition(notes) &
          Node.DOCUMENT_POSITION_FOLLOWING,
      ).not.toBe(0);
    }

    fireEvent.click(screen.getByRole("button", { name: "Delete task" }));
    expect(screen.getByText("Delete this task?")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Keep editing" }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Save task" }),
    ).not.toBeInTheDocument();
  });

  it("saves an edit with Command+Enter while preserving plain Enter", async () => {
    const store = makeStore([makeTask({ revision: 3 })]);
    renderPanel(store);

    fireEvent.click(screen.getByRole("button", { name: 'View "Write docs"' }));
    fireEvent.click(screen.getByRole("button", { name: /Edit/ }));
    const notes = screen.getByLabelText("Task notes");
    fireEvent.change(notes, { target: { value: "First line\nSecond line" } });
    fireEvent.keyDown(notes, { key: "Enter" });
    expect(store.updateTask).not.toHaveBeenCalled();

    fireEvent.keyDown(notes, { key: "Enter", metaKey: true });

    await vi.waitFor(() =>
      expect(store.updateTask).toHaveBeenCalledWith(
        expect.objectContaining({ revision: 3 }),
        expect.objectContaining({ details: "First line\nSecond line" }),
      ),
    );
  });

  it("browses and creates in an explicitly selected project across chat navigation", async () => {
    act(() => navigate(threadPath("thread-9")));
    const store = makeStore([
      makeTask({ title: "Website task", scope: { kind: "workspace", workspaceId: "workspace-2" } }),
    ], {
      threads: [
        { id: "thread-9", workspaceId: "workspace-1", title: { text: "Current thread" } },
        { id: "thread-10", workspaceId: "workspace-2", title: { text: "Release thread" } },
      ],
      workspaces: [
        { id: "workspace-1", label: { text: "Sedes" }, displayPath: { text: "/sedes" } },
        { id: "workspace-2", label: { text: "Website" }, displayPath: { text: "/website" } },
      ],
    });
    renderPanel(store);
    fireEvent.click(screen.getByRole("radio", { name: "Project" }));
    expect(screen.queryByText("Website task")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("combobox", { name: "Task project" }));
    fireEvent.change(screen.getByRole("combobox", { name: "Search projects" }), { target: { value: "Website" } });
    fireEvent.click(screen.getByRole("option", { name: "Website /website" }));
    expect(screen.getByText("Website task")).toBeInTheDocument();
    act(() => navigate(threadPath("thread-10")));
    act(() => navigate(threadPath("thread-9")));
    expect(screen.getByRole("combobox", { name: "Task project" })).toHaveTextContent("Website");
    fireEvent.change(screen.getByLabelText("Search or add task"), { target: { value: "New website task" } });
    fireEvent.click(screen.getByRole("button", { name: "Add task" }));
    await waitFor(() => expect(store.createTask).toHaveBeenCalledWith("New website task", { kind: "workspace", workspaceId: "workspace-2" }));
  });

  it("can edit an existing archived-thread task without offering that thread as a destination", async () => {
    const task = makeTask({ scope: { kind: "thread", threadId: "archived-thread" } });
    const store = makeStore([task], {
      threads: [{ id: "archived-thread", workspaceId: "workspace-1", inventoryState: "archived", title: { text: "Finished planning" } }],
      workspaces: [{ id: "workspace-1", label: { text: "Sedes" }, displayPath: { text: "/sedes" } }],
    });
    setTasksPanelIncludeNestedScopes(true);
    renderPanel(store);
    fireEvent.click(screen.getByRole("radio", { name: "Global" }));
    fireEvent.click(screen.getByRole("button", { name: 'View "Write docs"' }));
    fireEvent.click(screen.getByRole("button", { name: /Edit/ }));
    const destination = screen.getByRole("combobox", { name: "Assign task to thread" });
    expect(destination).toHaveTextContent("Finished planning");
    fireEvent.click(destination);
    expect(screen.queryByRole("option", { name: /Finished planning/ })).not.toBeInTheDocument();
    fireEvent.keyDown(screen.getByRole("combobox", { name: "Search threads" }), { key: "Escape" });
    const scope = screen.getByRole("radiogroup", { name: "Task scope" });
    const threadScope = within(scope).getByRole("radio", { name: "Thread" });
    expect(threadScope).toBeEnabled();
    fireEvent.click(within(scope).getByRole("radio", { name: "Project" }));
    expect(screen.getByRole("combobox", { name: "Assign task to project" })).toBeVisible();
    fireEvent.click(threadScope);
    expect(threadScope).toBeChecked();
    expect(screen.getByRole("combobox", { name: "Assign task to thread" })).toHaveTextContent("Finished planning");
    fireEvent.change(screen.getByRole("textbox", { name: "Task title" }), { target: { value: "Updated archived task" } });
    fireEvent.click(screen.getByRole("button", { name: "Save task" }));
    await waitFor(() => expect(store.updateTask).toHaveBeenCalledWith(
      expect.objectContaining({ id: task.id, revision: task.revision }),
      expect.objectContaining({ title: "Updated archived task", scope: task.scope }),
    ));
  });

  it("distinguishes the current thread from an explicit choice of that same thread", () => {
    act(() => navigate(threadPath("thread-9")));
    const store = makeStore([], {
      threads: [{ id: "thread-9", workspaceId: "workspace-1", title: { text: "Planning" } }],
      workspaces: [{ id: "workspace-1", label: { text: "Sedes" }, displayPath: { text: "/sedes" } }],
    });
    renderPanel(store);
    fireEvent.click(screen.getByRole("radio", { name: "Thread" }));
    const trigger = screen.getByRole("combobox", { name: "Task thread" });
    expect(trigger).toHaveTextContent("Current thread · Planning");
    expect(trigger).toHaveAttribute("title", "Current thread · Planning");
    fireEvent.click(trigger);
    fireEvent.click(screen.getByRole("option", { name: "Planning · Sedes" }));
    expect(trigger).toHaveTextContent("Planning");
    expect(trigger).not.toHaveTextContent("Current thread");
    expect(trigger).toHaveAttribute("title", "Planning");
  });

  it("keeps remote environment collision labels while hiding the local environment label", () => {
    const store = makeStore([], {
      environments: [
        { id: "environment-local", kind: "local", label: { text: "Workstation" }, available: true },
        { id: "environment-remote", kind: "ssh", label: { text: "Workstation" }, available: true },
      ],
      workspaces: [
        { id: "workspace-local", environmentId: "environment-local", label: { text: "Local project" }, displayPath: { text: "/local" }, available: true },
        { id: "workspace-remote", environmentId: "environment-remote", label: { text: "Remote project" }, displayPath: { text: "/remote" }, available: true },
      ],
    });
    renderPanel(store);
    fireEvent.click(screen.getByRole("radio", { name: "Project" }));
    fireEvent.click(screen.getByRole("combobox", { name: "Task project" }));
    expect(screen.getByRole("option", { name: "Local project /local" })).toBeVisible();
    expect(screen.getByRole("option", { name: "Remote project · Workstation · remote /remote" })).toBeVisible();
  });

  it("excludes archived threads from browsing and assignment choices", () => {
    const store = makeStore([makeTask()], {
      threads: [
        { id: "active-thread", workspaceId: "workspace-1", inventoryState: "active", title: { text: "Active planning" } },
        { id: "archived-thread", workspaceId: "workspace-1", inventoryState: "archived", title: { text: "Archived planning" } },
      ],
      workspaces: [{ id: "workspace-1", label: { text: "Sedes" }, displayPath: { text: "/sedes" } }],
    });
    renderPanel(store);
    fireEvent.click(screen.getByRole("radio", { name: "Thread" }));
    fireEvent.click(screen.getByRole("combobox", { name: "Task thread" }));
    expect(screen.getByRole("option", { name: "Active planning · Sedes" })).toBeInTheDocument();
    expect(screen.queryByRole("option", { name: /Archived planning/ })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("option", { name: "Active planning · Sedes" }));
    fireEvent.click(screen.getByRole("radio", { name: "Global" }));
    fireEvent.click(screen.getByRole("button", { name: 'View "Write docs"' }));
    fireEvent.click(screen.getByRole("button", { name: /Edit/ }));
    fireEvent.click(within(screen.getByRole("radiogroup", { name: "Task scope" })).getByRole("radio", { name: "Thread" }));
    fireEvent.click(screen.getByRole("combobox", { name: "Assign task to thread" }));
    expect(screen.getByRole("option", { name: "Active planning · Sedes" })).toBeInTheDocument();
    expect(screen.queryByRole("option", { name: /Archived planning/ })).not.toBeInTheDocument();
  });

  it("requires a destination without a current chat and browses threads by title", async () => {
    const store = makeStore([
      makeTask({ title: "Release checklist", scope: { kind: "thread", threadId: "thread-10" } }),
    ], {
      threads: [{ id: "thread-10", workspaceId: "workspace-2", title: { text: "Release thread" } }],
      workspaces: [{ id: "workspace-2", label: { text: "Website" }, displayPath: { text: "/website" } }],
    });
    renderPanel(store);
    fireEvent.click(screen.getByRole("radio", { name: "Thread" }));
    fireEvent.change(screen.getByLabelText("Search or add task"), { target: { value: "Release checklist" } });
    expect(screen.getByRole("button", { name: "Add task" })).toBeDisabled();
    fireEvent.keyDown(screen.getByLabelText("Search or add task"), { key: "Enter" });
    expect(store.createTask).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("combobox", { name: "Task thread" }));
    fireEvent.change(screen.getByRole("combobox", { name: "Search threads" }), { target: { value: "Release" } });
    fireEvent.click(screen.getByRole("option", { name: "Release thread · Website" }));
    expect(screen.getByRole("combobox", { name: "Task thread" })).toHaveTextContent("Release thread");
    expect(screen.getByRole("button", { name: 'View "Release checklist"' })).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Search or add task"), { target: { value: "New release task" } });
    fireEvent.click(screen.getByRole("button", { name: "Add task" }));
    await waitFor(() => expect(store.createTask).toHaveBeenCalledWith("New release task", { kind: "thread", threadId: "thread-10" }));
  });

  it.each(["project", "thread"] as const)("assigns a task to a searched %s using its identity", async (kind) => {
    act(() => navigate(threadPath("thread-9")));
    const task = makeTask({ revision: 7 });
    const store = makeStore([task], {
      threads: [
        { id: "thread-9", workspaceId: "workspace-1", title: { text: "Planning" } },
        { id: "thread-10", workspaceId: "workspace-2", title: { text: "Planning" } },
      ],
      workspaces: [
        { id: "workspace-1", label: { text: "Sedes" }, displayPath: { text: "/sedes" } },
        { id: "workspace-2", label: { text: "Website" }, displayPath: { text: "/website" } },
      ],
    });
    renderPanel(store);
    fireEvent.click(screen.getByRole("radio", { name: "Global" }));
    fireEvent.click(screen.getByRole("button", { name: 'View "Write docs"' }));
    fireEvent.click(screen.getByRole("button", { name: /Edit/ }));
    const scopes = screen.getByRole("radiogroup", { name: "Task scope" });
    fireEvent.click(within(scopes).getByRole("radio", { name: kind === "project" ? "Project" : "Thread" }));
    fireEvent.click(screen.getByRole("combobox", { name: `Assign task to ${kind}` }));
    fireEvent.change(screen.getByRole("combobox", { name: kind === "project" ? "Search projects" : "Search threads" }), { target: { value: "Website" } });
    fireEvent.click(screen.getByRole("option", { name: kind === "project" ? "Website /website" : "Planning · Website" }));
    fireEvent.click(screen.getByRole("button", { name: "Save task" }));
    await waitFor(() => expect(store.updateTask).toHaveBeenCalledWith(
      expect.objectContaining({ id: task.id, revision: 7 }),
      expect.objectContaining({ scope: kind === "project" ? { kind: "workspace", workspaceId: "workspace-2" } : { kind: "thread", threadId: "thread-10" } }),
    ));
  });

  it("does not offer a thread picker from task details", () => {
    const task = makeTask();
    const store = makeStore([task], {
      threads: [
        {
          id: "thread-9",
          workspaceId: "workspace-1",
          title: { text: "Current thread" },
        },
        {
          id: "thread-10",
          workspaceId: "workspace-2",
          title: { text: "Release thread" },
        },
      ],
      workspaces: [
        { id: "workspace-1", label: { text: "Sedes" }, displayPath: { text: "/sedes" } },
        { id: "workspace-2", label: { text: "Website" }, displayPath: { text: "/website" } },
      ],
    });
    renderPanelWithTaskDrag(store);
    fireEvent.click(screen.getByRole("radio", { name: "Global" }));

    fireEvent.click(screen.getByRole("button", { name: 'View "Write docs"' }));
    expect(
      screen.queryByRole("button", { name: /Move to thread/ }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("searchbox", { name: "Search threads" }),
    ).not.toBeInTheDocument();
  });

  it("writes the versioned task identity to a drag operation", () => {
    const task = makeTask({ revision: 8 });
    const store = makeStore([task], { threads: [], workspaces: [] });
    renderPanelWithTaskDrag(store);
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    const values = new Map<string, string>();
    const dataTransfer = {
      effectAllowed: "none",
      types: [],
      setData: vi.fn((type: string, value: string) => {
        values.set(type, value);
        (dataTransfer.types as string[]).push(type);
      }),
      getData: vi.fn((type: string) => values.get(type) ?? ""),
    } as unknown as DataTransfer;

    fireEvent.dragStart(
      screen.getByRole("button", {
        name: "Drag “Write docs” to a thread or prompt",
      }),
      { dataTransfer },
    );

    expect(JSON.parse(values.get(TASK_DRAG_MIME)!)).toEqual({
      version: 1,
      taskId: "task-1",
      revision: 8,
    });
    expect(dataTransfer.effectAllowed).toBe("copyMove");
  });

  it("moves dragged tasks onto the Project and Thread scope headers", async () => {
    act(() => navigate(threadPath("thread-9")));
    const task = makeTask({ revision: 4 });
    const store = makeStore([task], {
      threads: [
        {
          id: "thread-9",
          workspaceId: "workspace-1",
          title: { text: "Current thread" },
        },
      ],
      workspaces: [{ id: "workspace-1", label: { text: "Sedes" }, displayPath: { text: "/sedes" } }],
    });
    renderPanelWithTaskDrag(store);
    fireEvent.click(screen.getByRole("radio", { name: "Global" }));

    const startDrag = () => {
      const values = new Map<string, string>();
      const types: string[] = [];
      const dataTransfer = {
        effectAllowed: "none",
        dropEffect: "none",
        types,
        setData: vi.fn((type: string, value: string) => {
          values.set(type, value);
          if (!types.includes(type)) types.push(type);
        }),
        getData: vi.fn((type: string) => values.get(type) ?? ""),
      } as unknown as DataTransfer;
      fireEvent.dragStart(
        screen.getByRole("button", {
          name: "Drag “Write docs” to a thread or prompt",
        }),
        { dataTransfer },
      );
      return dataTransfer;
    };

    const project = screen.getByRole("radio", { name: "Project" });
    let dataTransfer = startDrag();
    fireEvent.dragOver(project, { dataTransfer });
    expect(project).toHaveAttribute("data-task-scope-drop-target", "true");
    fireEvent.dragEnd(
      screen.getByRole("button", {
        name: "Drag “Write docs” to a thread or prompt",
      }),
      { dataTransfer },
    );
    await waitFor(() =>
      expect(project).not.toHaveAttribute("data-task-scope-drop-target"),
    );

    dataTransfer = startDrag();
    fireEvent.drop(project, { dataTransfer });
    await vi.waitFor(() =>
      expect(store.moveTask).toHaveBeenCalledWith(
        task,
        { kind: "workspace", workspaceId: "workspace-1" },
        expect.any(String),
      ),
    );

    const thread = screen.getByRole("radio", { name: "Thread" });
    dataTransfer = startDrag();
    fireEvent.dragOver(thread, { dataTransfer });
    expect(thread).toHaveAttribute("data-task-scope-drop-target", "true");
    fireEvent.drop(thread, { dataTransfer });
    await vi.waitFor(() =>
      expect(store.moveTask).toHaveBeenCalledWith(
        task,
        { kind: "thread", threadId: "thread-9" },
        expect.any(String),
      ),
    );
  });

  it("disables the Thread scope when its project cannot be resolved", () => {
    act(() => navigate(threadPath("missing-thread")));
    const store = makeStore([makeTask()], { threads: [], workspaces: [] });
    renderPanelWithTaskDrag(store);

    expect(screen.getByRole("radio", { name: "Thread" })).toBeDisabled();
  });

  it("moves a nested task to the scope represented by the Tasks card", async () => {
    setTasksPanelIncludeNestedScopes(true);
    const task = makeTask({
      scope: { kind: "workspace", workspaceId: "workspace-1" },
      associatedWorkspaceId: "workspace-1",
    });
    const store = makeStore([task]);
    renderPanelWithTaskDrag(store);
    const values = new Map<string, string>();
    const types: string[] = [];
    const dataTransfer = {
      effectAllowed: "none",
      dropEffect: "none",
      types,
      setData: vi.fn((type: string, value: string) => {
        values.set(type, value);
        if (!types.includes(type)) types.push(type);
      }),
      getData: vi.fn((type: string) => values.get(type) ?? ""),
    } as unknown as DataTransfer;

    fireEvent.dragStart(
      screen.getByRole("button", {
        name: "Drag “Write docs” to a thread or prompt",
      }),
      { dataTransfer },
    );
    const card = document.querySelector<HTMLElement>(".tasks-panel-body")!;
    fireEvent.dragOver(card, { dataTransfer });
    expect(card).toHaveAttribute("data-task-scope-drop-target", "true");
    fireEvent.drop(card, { dataTransfer });

    await vi.waitFor(() =>
      expect(store.moveTask).toHaveBeenCalledWith(
        task,
        { kind: "global" },
        expect.any(String),
      ),
    );
  });

  it("shows a cross-project scope-drop failure inside its confirmation", async () => {
    setTasksPanelIncludeNestedScopes(true);
    act(() => navigate(threadPath("thread-9")));
    const task = makeTask({
      scope: { kind: "workspace", workspaceId: "workspace-2" },
      associatedWorkspaceId: "workspace-2",
      files: ["/workspace-2/notes.md"],
    });
    const store = makeStore([task], {
      threads: [
        {
          id: "thread-9",
          workspaceId: "workspace-1",
          title: { text: "Current thread" },
        },
      ],
      workspaces: [
        { id: "workspace-1", label: { text: "Sedes" }, displayPath: { text: "/sedes" } },
        { id: "workspace-2", label: { text: "Website" }, displayPath: { text: "/website" } },
      ],
    });
    vi.mocked(store.moveTask).mockRejectedValueOnce(
      new Error("The server connection was lost."),
    );
    renderPanelWithTaskDrag(store);
    fireEvent.click(screen.getByRole("radio", { name: "Global" }));
    const values = new Map<string, string>();
    const types: string[] = [];
    const dataTransfer = {
      effectAllowed: "none",
      dropEffect: "none",
      types,
      setData: vi.fn((type: string, value: string) => {
        values.set(type, value);
        if (!types.includes(type)) types.push(type);
      }),
      getData: vi.fn((type: string) => values.get(type) ?? ""),
    } as unknown as DataTransfer;

    fireEvent.dragStart(
      screen.getByRole("button", {
        name: "Drag “Write docs” to a thread or prompt",
      }),
      { dataTransfer },
    );
    fireEvent.drop(screen.getByRole("radio", { name: "Project" }), {
      dataTransfer,
    });
    fireEvent.click(await screen.findByRole("button", { name: "Move task" }));

    expect(
      await within(screen.getByRole("dialog")).findByRole("alert"),
    ).toHaveTextContent("The server connection was lost.");
    expect(
      screen.getByRole("heading", { name: "Move task with project files?" }),
    ).toBeInTheDocument();
  });

  it("stages files and saves editable fields without changing row pinning", async () => {
    const task = makeTask({
      revision: 7,
      pinned: true,
      files: ["/workspace/README.md"],
    });
    const store = makeStore([task]);
    renderPanel(store);

    fireEvent.click(screen.getByRole("button", { name: 'View "Write docs"' }));
    fireEvent.click(screen.getByRole("button", { name: /Edit/ }));
    fireEvent.change(screen.getByLabelText("Task title"), {
      target: { value: "Write all docs" },
    });
    fireEvent.change(screen.getByLabelText("Task notes"), {
      target: { value: "Cover every workflow." },
    });
    fireEvent.change(screen.getByLabelText("Absolute file path"), {
      target: { value: "docs/relative.md" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Add file" }));
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Enter an absolute file path beginning with /.",
    );
    fireEvent.change(screen.getByLabelText("Absolute file path"), {
      target: { value: "/workspace/docs/tasks.md" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Add file" }));
    fireEvent.click(screen.getByRole("button", { name: "Save task" }));

    await vi.waitFor(() =>
      expect(store.updateTask).toHaveBeenCalledWith(
        expect.objectContaining({ id: "task-1", revision: 7 }),
        {
          title: "Write all docs",
          details: "Cover every workflow.",
          scope: { kind: "global" },
          files: ["/workspace/README.md", "/workspace/docs/tasks.md"],
        },
      ),
    );
    expect(store.moveTask).not.toHaveBeenCalled();
  });

  it("keeps the editor open and surfaces a stale revision conflict", async () => {
    const store = makeStore([makeTask({ revision: 4 })]);
    vi.mocked(store.updateTask).mockRejectedValueOnce(
      new Error("Task changed in another client. Reopen it and try again."),
    );
    renderPanel(store);

    fireEvent.click(screen.getByRole("button", { name: 'View "Write docs"' }));
    fireEvent.click(screen.getByRole("button", { name: /Edit/ }));
    fireEvent.click(screen.getByRole("button", { name: "Save task" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Task changed in another client. Reopen it and try again.",
    );
    expect(screen.getByLabelText("Task notes")).toBeInTheDocument();
    expect(store.updateTask).toHaveBeenCalledWith(
      expect.objectContaining({ revision: 4 }),
      expect.anything(),
    );
  });

  it("resolves and opens a linked current-workspace file in the existing Files panel", async () => {
    setPanelPresentation("single");
    act(() => navigate(threadPath("thread-9")));
    const store = makeStore(
      [
        makeTask({
          scope: { kind: "thread", threadId: "thread-9" },
          files: ["/workspace/docs/tasks.md"],
        }),
      ],
      {
        threads: [
          {
            id: "thread-9",
            workspaceId: "workspace-1",
            title: { text: "Tasks" },
          },
        ],
        workspaces: [
          {
            id: "workspace-1",
            label: { text: "Sedes" },
            displayPath: { text: "/workspace" },
            available: true,
          },
        ],
      },
    );
    const panelLayoutStore = makePanelLayoutStore();
    renderPanel(store, panelLayoutStore);

    fireEvent.click(screen.getByRole("button", { name: 'View "Write docs"' }));
    expect(screen.getByText("tasks.md")).toBeInTheDocument();
    expect(screen.getByText("/workspace/docs/tasks.md")).toBeInTheDocument();
    fireEvent.click(
      screen.getByRole("button", {
        name: "Open /workspace/docs/tasks.md in Files",
      }),
    );

    await vi.waitFor(() =>
      expect(panelLayoutStore.openPanel).toHaveBeenCalledWith(
        "workspace-files",
        {
          presentation: "single",
          intent: expect.objectContaining({
            kind: "open-workspace-file",
            workspaceId: "workspace-1",
            rootId: "primary",
            path: "docs/tasks.md",
            rootVisibility: "listed",
            target: { kind: "file" },
            sequence: expect.any(Number),
          }),
        },
      ),
    );
  });

  it("closes the mobile Tasks sheet after handing a file to Files", async () => {
    vi.stubGlobal(
      "matchMedia",
      vi.fn(() => ({
        matches: true,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      })),
    );
    act(() => navigate(threadPath("thread-9")));
    const store = makeStore(
      [
        makeTask({
          scope: { kind: "thread", threadId: "thread-9" },
          files: ["/workspace/docs/tasks.md"],
        }),
      ],
      {
        threads: [
          {
            id: "thread-9",
            workspaceId: "workspace-1",
            title: { text: "Tasks" },
          },
        ],
        workspaces: [
          {
            id: "workspace-1",
            label: { text: "Sedes" },
            displayPath: { text: "/workspace" },
            available: true,
          },
        ],
      },
    );
    renderPanel(store);

    fireEvent.click(screen.getByRole("button", { name: 'View "Write docs"' }));
    fireEvent.click(
      screen.getByRole("button", {
        name: "Open /workspace/docs/tasks.md in Files",
      }),
    );

    await vi.waitFor(() =>
      expect(
        screen.queryByRole("dialog", { name: "Tasks" }),
      ).not.toBeInTheDocument(),
    );
  });

  it("opens an allowed sibling-worktree task file through a link-only root", async () => {
    act(() => navigate(threadPath("thread-9")));
    const store = makeStore(
      [
        makeTask({
          scope: { kind: "thread", threadId: "thread-9" },
          files: ["/other/private.txt"],
        }),
      ],
      {
        threads: [
          {
            id: "thread-9",
            workspaceId: "workspace-1",
            title: { text: "Tasks" },
          },
        ],
        workspaces: [
          {
            id: "workspace-1",
            label: { text: "Sedes" },
            displayPath: { text: "/workspace" },
            available: true,
          },
        ],
        resolveFileLink: () => ({
          status: "resolved",
          rootId: "link-sibling",
          path: "private.txt",
          rootVisibility: "link_only",
        }),
      },
    );
    const panelLayoutStore = makePanelLayoutStore();
    renderPanel(store, panelLayoutStore);

    fireEvent.click(screen.getByRole("button", { name: 'View "Write docs"' }));
    fireEvent.click(
      screen.getByRole("button", {
        name: "Open /other/private.txt in Files",
      }),
      { shiftKey: true },
    );
    await vi.waitFor(() =>
      expect(panelLayoutStore.openPanel).toHaveBeenCalledWith(
        "workspace-files",
        {
          presentation: "single",
          intent: expect.objectContaining({
            workspaceId: "workspace-1",
            rootId: "link-sibling",
            path: "private.txt",
            rootVisibility: "link_only",
          }),
        },
      ),
    );
    expect(store.api.resolveWorkspaceFileLink).toHaveBeenCalledWith(
      "workspace-1",
      { kind: "absolute", path: "/other/private.txt" },
    );
  });

  it("reports an absolute task file that is outside allowed worktrees", async () => {
    act(() => navigate(threadPath("thread-9")));
    const store = makeStore(
      [
        makeTask({
          scope: { kind: "thread", threadId: "thread-9" },
          files: ["/other/private.txt"],
        }),
      ],
      {
        threads: [
          {
            id: "thread-9",
            workspaceId: "workspace-1",
            title: { text: "Tasks" },
          },
        ],
        workspaces: [
          {
            id: "workspace-1",
            label: { text: "Sedes" },
            displayPath: { text: "/workspace" },
            available: true,
          },
        ],
        resolveFileLink: () => ({ status: "not_found" }),
      },
    );
    renderPanel(store);

    fireEvent.click(screen.getByRole("button", { name: 'View "Write docs"' }));
    fireEvent.click(
      screen.getByRole("button", {
        name: "Open /other/private.txt in Files",
      }),
    );
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "isn't available in Files",
    );
  });

  it("rejects a non-normalized stored task path without calling Files", async () => {
    act(() => navigate(threadPath("thread-9")));
    const store = makeStore(
      [
        makeTask({
          scope: { kind: "thread", threadId: "thread-9" },
          files: ["/other/../private.txt"],
        }),
      ],
      {
        threads: [
          {
            id: "thread-9",
            workspaceId: "workspace-1",
            title: { text: "Tasks" },
          },
        ],
        workspaces: [
          {
            id: "workspace-1",
            label: { text: "Sedes" },
            displayPath: { text: "/workspace" },
            available: true,
          },
        ],
      },
    );
    renderPanel(store);

    fireEvent.click(screen.getByRole("button", { name: 'View "Write docs"' }));
    fireEvent.click(
      screen.getByRole("button", {
        name: "Open /other/../private.txt in Files",
      }),
    );

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "isn't available in Files",
    );
    expect(store.api.resolveWorkspaceFileLink).not.toHaveBeenCalled();
  });

  it("drops the detail preview when the selected task leaves the view", () => {
    const store = makeStore([makeTask({ details: "Global task notes." })]);
    renderPanel(store);

    fireEvent.click(screen.getByRole("button", { name: 'View "Write docs"' }));
    expect(screen.getByText("Global task notes.")).toBeInTheDocument();

    // The thread/project views are unavailable on the home route, so switch
    // is exercised by toggling the same task off instead.
    fireEvent.click(screen.getByRole("button", { name: 'View "Write docs"' }));
    expect(screen.queryByText("Global task notes.")).not.toBeInTheDocument();
  });

  it("uses the add-task input to filter titles by default", () => {
    const store = makeStore([
      makeTask({ id: "task-docs", title: "Write docs", details: "API guide" }),
      makeTask({
        id: "task-release",
        title: "Ship release",
        details: "Verify Android package",
        createdAt: "2026-08-01T11:00:00.000Z",
      }),
    ]);
    renderPanel(store);

    const input = screen.getByRole("searchbox", {
      name: "Search or add task",
    });
    expect(input).toHaveAttribute("placeholder", "Search or add task");
    fireEvent.change(input, { target: { value: "release" } });
    expect(
      screen.queryByRole("button", { name: 'View "Write docs"' }),
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: 'View "Ship release"' }),
    ).toBeInTheDocument();

    fireEvent.change(input, { target: { value: "" } });
    expect(input).toHaveValue("");
    expect(screen.getAllByRole("button", { name: /^View / })).toHaveLength(2);
  });

  it("can persistently include task content from the options menu", () => {
    const store = makeStore([
      makeTask({ id: "task-docs", title: "Write docs", details: "API guide" }),
      makeTask({
        id: "task-release",
        title: "Ship release",
        details: "Verify Android package",
        createdAt: "2026-08-01T11:00:00.000Z",
      }),
    ]);
    renderPanel(store);

    const input = screen.getByRole("searchbox", {
      name: "Search or add task",
    });
    fireEvent.change(input, { target: { value: "ANDROID" } });
    expect(
      screen.queryByRole("button", { name: /^View / }),
    ).not.toBeInTheDocument();

    fireEvent.click(
      screen.getByRole("button", { name: "Tasks panel options" }),
    );
    const searchContent = screen.getByRole("checkbox", {
      name: "Search task content",
    });
    expect(searchContent).not.toBeChecked();
    fireEvent.click(searchContent);

    expect(
      screen.getByRole("button", { name: 'View "Ship release"' }),
    ).toBeInTheDocument();
    expect(
      JSON.parse(window.localStorage.getItem("sedes.tasks.panel") ?? "null")
        .searchContent,
    ).toBe(true);
  });

  it("selects the exact Enter-created duplicate after publication lag and shows read-only detail", async () => {
    const existing = makeTask({
      id: "existing-task",
      title: "Ship release",
      details: "Existing task details.",
    });
    const created = makeTask({
      id: "returned-created-task",
      title: "Ship release",
      details: "Newly created task details.",
      createdAt: "2026-08-01T11:00:00.000Z",
    });
    const publishing = makePublishingStore([existing]);
    vi.mocked(publishing.store.createTask).mockResolvedValueOnce(created);
    const store = publishing.store;
    renderPanel(store);

    fireEvent.click(
      screen.getByRole("button", { name: 'View "Ship release"' }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    fireEvent.click(screen.getByRole("button", { name: "Delete task" }));
    expect(screen.getByText("Delete this task?")).toBeInTheDocument();
    const input = screen.getByRole("searchbox", {
      name: "Search or add task",
    });
    fireEvent.change(input, { target: { value: "Ship release" } });
    fireEvent.keyDown(input, { key: "Enter" });

    await vi.waitFor(() => {
      expect(store.createTask).toHaveBeenCalledWith("Ship release", {
        kind: "global",
      });
      expect(input).toHaveValue("");
    });
    expect(screen.queryByText("Delete this task?")).not.toBeInTheDocument();
    expect(
      screen.queryByText("Newly created task details."),
    ).not.toBeInTheDocument();

    act(() => publishing.publishTasks([existing, created]));

    expect(screen.getByText("Newly created task details.")).toBeInTheDocument();
    expect(
      screen.queryByText("Existing task details."),
    ).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Task notes")).not.toBeInTheDocument();
    const duplicateRows = screen
      .getAllByRole("button", { name: 'View "Ship release"' })
      .map((button) => button.closest("li"));
    expect(duplicateRows).toHaveLength(2);
    expect(duplicateRows[0]).toHaveAttribute("data-selected", "true");
  });

  it.each([
    { view: "global", expectedScope: { kind: "global" } },
    {
      view: "project",
      expectedScope: { kind: "workspace", workspaceId: "workspace-1" },
    },
    {
      view: "thread",
      expectedScope: { kind: "thread", threadId: "thread-9" },
    },
  ] as const)(
    "creates in the $view scope from the Add button",
    async ({ view, expectedScope }) => {
      if (view !== "global") act(() => navigate(threadPath("thread-9")));
      const publishing = makePublishingStore([], {
        threads: [
          {
            id: "thread-9",
            workspaceId: "workspace-1",
            title: { text: "Task thread" },
          },
        ],
        workspaces: [
          {
            id: "workspace-1",
            label: { text: "Sedes" },
            displayPath: { text: "/workspace" },
            available: true,
          },
        ],
      });
      const created = makeTask({
        id: `created-${view}`,
        scope: expectedScope,
        title: `Create ${view}`,
        details: `Created ${view} detail.`,
      });
      vi.mocked(publishing.store.createTask).mockResolvedValueOnce(created);
      const store = publishing.store;
      renderPanel(store);
      fireEvent.click(screen.getByRole("radio", {
        name: view === "global" ? "Global" : view === "project" ? "Project" : "Thread",
      }));
      const input = screen.getByRole("searchbox", {
        name: "Search or add task",
      });
      fireEvent.change(input, { target: { value: `Create ${view}` } });
      fireEvent.click(screen.getByRole("button", { name: "Add task" }));

      await vi.waitFor(() => {
        expect(store.createTask).toHaveBeenCalledWith(
          `Create ${view}`,
          expectedScope,
        );
        expect(input).toHaveValue("");
      });
      act(() => publishing.publishTasks([created]));
      expect(screen.getByText(created.details)).toBeInTheDocument();
    },
  );

  it("preserves the intended created selection across scope filtering", async () => {
    act(() => navigate(threadPath("thread-9")));
    const context = {
      threads: [
        {
          id: "thread-9",
          workspaceId: "workspace-1",
          title: { text: "Task thread" },
        },
      ],
      workspaces: [
        {
          id: "workspace-1",
          label: { text: "Sedes" },
          displayPath: { text: "/workspace" },
          available: true,
        },
      ],
    };
    const created = makeTask({
      id: "created-thread-task",
      scope: { kind: "thread", threadId: "thread-9" },
      title: "Thread follow-up",
      details: "Created thread task detail.",
    });
    const publishing = makePublishingStore([], context);
    vi.mocked(publishing.store.createTask).mockResolvedValueOnce(created);
    renderPanel(publishing.store);
    fireEvent.click(screen.getByRole("radio", { name: "Thread" }));
    fireEvent.change(screen.getByRole("searchbox"), {
      target: { value: created.title },
    });
    fireEvent.click(screen.getByRole("button", { name: "Add task" }));
    await vi.waitFor(() =>
      expect(publishing.store.createTask).toHaveBeenCalled(),
    );

    fireEvent.click(screen.getByRole("radio", { name: "Project" }));
    act(() => publishing.publishTasks([created]));
    expect(screen.queryByText(created.details)).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("radio", { name: "Thread" }));
    expect(screen.getByText(created.details)).toBeInTheDocument();
  });

  it("preserves the input and current selection when creation fails", async () => {
    const current = makeTask({ details: "Keep this selection." });
    const store = makeStore([current]);
    vi.mocked(store.createTask).mockRejectedValueOnce(
      new Error("Could not create task."),
    );
    renderPanel(store);
    fireEvent.click(screen.getByRole("button", { name: 'View "Write docs"' }));
    const input = screen.getByRole("searchbox", {
      name: "Search or add task",
    });
    fireEvent.change(input, { target: { value: "Rejected task" } });
    fireEvent.click(screen.getByRole("button", { name: "Add task" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Could not create task.",
    );
    expect(input).toHaveValue("Rejected task");
    fireEvent.change(input, { target: { value: "" } });
    expect(screen.getByText("Keep this selection.")).toBeInTheDocument();
  });

  it("keeps mobile Back behavior for an auto-selected created task", async () => {
    vi.stubGlobal(
      "matchMedia",
      vi.fn(() => ({
        matches: true,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      })),
    );
    const created = makeTask({
      id: "created-mobile-task",
      title: "Mobile follow-up",
      details: "Created on mobile.",
    });
    const publishing = makePublishingStore([]);
    vi.mocked(publishing.store.createTask).mockResolvedValueOnce(created);
    renderPanel(publishing.store);
    fireEvent.change(screen.getByRole("searchbox"), {
      target: { value: created.title },
    });
    fireEvent.click(screen.getByRole("button", { name: "Add task" }));
    await vi.waitFor(() =>
      expect(publishing.store.createTask).toHaveBeenCalled(),
    );
    act(() => publishing.publishTasks([created]));
    expect(screen.getByText(created.details)).toBeInTheDocument();

    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByText(created.details)).not.toBeInTheDocument();
    expect(screen.getByRole("dialog", { name: "Tasks" })).toBeInTheDocument();
  });

  it("anchors the mobile sheet to the bottom and lifts it above the keyboard", () => {
    vi.stubGlobal(
      "matchMedia",
      vi.fn(() => ({
        matches: true,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      })),
    );
    vi.stubGlobal("innerHeight", 800);
    vi.stubGlobal("visualViewport", {
      height: 500,
      offsetTop: 20,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    });

    renderPanel(makeStore([]));

    const sheet = screen.getByRole("dialog", { name: "Tasks" });
    expect(sheet.style.getPropertyValue("--tasks-keyboard-inset")).toBe(
      "280px",
    );
  });

  it("closes an editor when search hides its task", () => {
    const store = makeStore([
      makeTask({ details: "Cover the tasks API end to end." }),
    ]);
    renderPanel(store);

    fireEvent.click(screen.getByRole("button", { name: 'View "Write docs"' }));
    fireEvent.click(screen.getByRole("button", { name: /Edit/ }));
    expect(screen.getByLabelText("Task title")).toBeInTheDocument();

    const input = screen.getByRole("searchbox", {
      name: "Search or add task",
    });
    fireEvent.change(input, { target: { value: "no match" } });
    expect(screen.queryByLabelText("Task title")).not.toBeInTheDocument();

    fireEvent.change(input, { target: { value: "" } });
    expect(screen.queryByLabelText("Task title")).not.toBeInTheDocument();
  });

  it("keeps the search query while task detail is open and resets it after panel close", () => {
    const store = makeStore([
      makeTask({ details: "Cover the tasks API end to end." }),
    ]);
    renderPanel(store);

    const input = screen.getByRole("searchbox", {
      name: "Search or add task",
    });
    fireEvent.change(input, { target: { value: "tasks api" } });
    fireEvent.click(screen.getByRole("button", { name: 'View "Write docs"' }));
    expect(input).toHaveValue("tasks api");
    expect(
      screen.getByText("Cover the tasks API end to end."),
    ).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Close Tasks panel" }));
    act(() => setTasksPanelOpen(true));
    expect(
      screen.getByRole("searchbox", { name: "Search or add task" }),
    ).toHaveValue("");
  });

  it("closes an open detail when beginning a new task", () => {
    const store = makeStore([
      makeTask({ details: "Cover the tasks API end to end." }),
    ]);
    renderPanel(store);

    fireEvent.click(screen.getByRole("button", { name: 'View "Write docs"' }));
    expect(
      screen.getByText("Cover the tasks API end to end."),
    ).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "New task" }));
    expect(
      screen.queryByText("Cover the tasks API end to end."),
    ).not.toBeInTheDocument();
  });

  it("uses mobile Back to close task detail before closing the sheet", () => {
    vi.stubGlobal(
      "matchMedia",
      vi.fn(() => ({
        matches: true,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      })),
    );
    const store = makeStore([
      makeTask({ details: "Cover the tasks API end to end." }),
    ]);
    renderPanel(store);

    fireEvent.click(screen.getByRole("button", { name: 'View "Write docs"' }));
    fireEvent.keyDown(document, { key: "Escape" });

    expect(
      screen.queryByText("Cover the tasks API end to end."),
    ).not.toBeInTheDocument();
    expect(screen.getByRole("dialog", { name: "Tasks" })).toBeInTheDocument();

    fireEvent.keyDown(document, { key: "Escape" });
    expect(
      screen.queryByRole("dialog", { name: "Tasks" }),
    ).not.toBeInTheDocument();
  });

  it("closes an open desktop Tasks panel with Escape", () => {
    renderPanel(makeStore([]));
    const outside = document.createElement("button");
    document.body.append(outside);
    outside.focus();

    fireEvent.keyDown(document, { key: "Escape" });

    expect(
      screen.queryByRole("region", { name: "Tasks" }),
    ).not.toBeInTheDocument();
    outside.remove();
  });
});
