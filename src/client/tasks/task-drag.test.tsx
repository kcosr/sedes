// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  AssociatedTask,
  NormalizedApplicationSnapshot,
} from "../../shared/index.js";
import type { ApplicationClientStore } from "../stores/ApplicationClientStore.js";
import {
  TaskDragProvider,
  handleTaskDragStart,
  useTaskDrag,
  useTaskScopeDropTargets,
  type TaskScopeDropTarget,
} from "./task-drag.js";

afterEach(cleanup);

const task: AssociatedTask = {
  id: "task-1",
  scope: { kind: "thread", threadId: "thread-1" },
  associatedProjectId: "project-1",
  title: "Audit error states",
  details: "",
  pinned: false,
  backlog: false,
  files: [],
  completedAt: null,
  revision: 3,
  createdAt: "2026-08-01T10:00:00.000Z",
  updatedAt: "2026-08-01T10:00:00.000Z",
};

const projectTarget: TaskScopeDropTarget = {
  scope: { kind: "project", projectId: "project-1" },
  label: "acme-web",
  projectId: "project-1",
};

function dataTransfer(): DataTransfer {
  const values = new Map<string, string>();
  const types: string[] = [];
  return {
    effectAllowed: "none",
    dropEffect: "none",
    types,
    setData: vi.fn((type: string, value: string) => {
      values.set(type, value);
      if (!types.includes(type)) types.push(type);
    }),
    getData: vi.fn((type: string) => values.get(type) ?? ""),
  } as unknown as DataTransfer;
}

function Targets(): React.JSX.Element {
  const taskDrag = useTaskDrag();
  const drop = useTaskScopeDropTargets<"body" | "project" | "thread">();
  return (
    <div data-testid="body" {...drop.props("body", projectTarget)}>
      <button
        type="button"
        draggable
        onDragStart={(event) => handleTaskDragStart(taskDrag, task, event)}
      >
        Drag
      </button>
      <span data-testid="project" {...drop.props("project", projectTarget)} />
      <span data-testid="thread" {...drop.props("thread", undefined)} />
      <output data-testid="over">{drop.over ?? "none"}</output>
    </div>
  );
}

function renderTargets() {
  const moveTask = vi.fn(async () => undefined);
  const store = {
    getTasks: () => [task],
    moveTask,
  } as unknown as ApplicationClientStore;
  const snapshot = { threads: [], workspaces: [], tasks: [task] };
  render(
    <TaskDragProvider
      store={store}
      snapshot={snapshot as unknown as NormalizedApplicationSnapshot}
    >
      <Targets />
    </TaskDragProvider>,
  );
  return { moveTask };
}

describe("useTaskScopeDropTargets", () => {
  it("arms accepting targets during a drag and marks the one under the task", () => {
    renderTargets();
    const transfer = dataTransfer();
    expect(screen.getByTestId("project")).not.toHaveAttribute("data-task-drop-armed");

    fireEvent.dragStart(screen.getByRole("button", { name: "Drag" }), {
      dataTransfer: transfer,
    });
    expect(screen.getByTestId("project")).toHaveAttribute("data-task-drop-armed", "true");
    expect(screen.getByTestId("body")).toHaveAttribute("data-task-drop-armed", "true");
    // A scope that does not apply accepts nothing.
    expect(screen.getByTestId("thread")).not.toHaveAttribute("data-task-drop-armed");

    fireEvent.dragOver(screen.getByTestId("project"), { dataTransfer: transfer });
    expect(screen.getByTestId("over")).toHaveTextContent("project");
    expect(screen.getByTestId("project")).toHaveAttribute("data-task-drop-target", "true");
    // The innermost target takes the drag; its container does not.
    expect(screen.getByTestId("body")).not.toHaveAttribute("data-task-drop-target");

    fireEvent.dragOver(screen.getByTestId("thread"), { dataTransfer: transfer });
    expect(screen.getByTestId("over")).toHaveTextContent("body");

    fireEvent.dragLeave(screen.getByTestId("body"), {
      dataTransfer: transfer,
      relatedTarget: null,
    });
    expect(screen.getByTestId("over")).toHaveTextContent("none");

    fireEvent.dragEnd(screen.getByRole("button", { name: "Drag" }), {
      dataTransfer: transfer,
    });
    expect(screen.getByTestId("project")).not.toHaveAttribute("data-task-drop-armed");
  });

  it("moves the dropped task to the target's scope and ends the drag", async () => {
    const { moveTask } = renderTargets();
    const transfer = dataTransfer();
    fireEvent.dragStart(screen.getByRole("button", { name: "Drag" }), {
      dataTransfer: transfer,
    });
    fireEvent.dragOver(screen.getByTestId("project"), { dataTransfer: transfer });
    fireEvent.drop(screen.getByTestId("project"), { dataTransfer: transfer });
    await waitFor(() =>
      expect(moveTask).toHaveBeenCalledWith(
        task,
        projectTarget.scope,
        expect.any(String),
      ),
    );
    expect(moveTask).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId("over")).toHaveTextContent("none");
    expect(screen.getByTestId("project")).not.toHaveAttribute("data-task-drop-armed");
  });

  it("ignores drags that do not carry a task", () => {
    const { moveTask } = renderTargets();
    const transfer = dataTransfer();
    fireEvent.dragOver(screen.getByTestId("project"), { dataTransfer: transfer });
    fireEvent.drop(screen.getByTestId("project"), { dataTransfer: transfer });
    expect(screen.getByTestId("over")).toHaveTextContent("none");
    expect(moveTask).not.toHaveBeenCalled();
  });
});

describe("TaskDragProvider sidebar drops", () => {
  const withFiles: AssociatedTask = {
    ...task,
    id: "task-files",
    files: ["/workspace/src/checkout.ts"],
  };
  // project-1 has locations on two hosts; project-2 is another project.
  const snapshot = {
    threads: [
      { id: "thread-1", workspaceId: "workspace-local", title: { text: "Checkout" } },
      { id: "thread-remote", workspaceId: "workspace-remote", title: { text: "Remote checkout" } },
      { id: "thread-billing", workspaceId: "workspace-billing", title: { text: "Invoices" } },
    ],
    workspaces: [
      { id: "workspace-local", projectId: "project-1" },
      { id: "workspace-remote", projectId: "project-1" },
      { id: "workspace-billing", projectId: "project-2" },
    ],
    tasks: [withFiles],
  };

  function Sidebar(): React.JSX.Element {
    const taskDrag = useTaskDrag();
    return (
      <div className="sidebar-inner">
        <button
          type="button"
          draggable
          onDragStart={(event) => handleTaskDragStart(taskDrag, withFiles, event)}
        >
          Drag
        </button>
        {snapshot.threads.map((thread) => (
          <div key={thread.id} data-thread-id={thread.id}>
            {thread.title.text}
          </div>
        ))}
      </div>
    );
  }

  function renderSidebar() {
    const moveTask = vi.fn(async () => undefined);
    const store = { getTasks: () => [withFiles], moveTask } as unknown as ApplicationClientStore;
    render(
      <TaskDragProvider
        store={store}
        snapshot={snapshot as unknown as NormalizedApplicationSnapshot}
      >
        <Sidebar />
      </TaskDragProvider>,
    );
    return { moveTask };
  }

  function dropOn(title: string) {
    const transfer = dataTransfer();
    fireEvent.dragStart(screen.getByRole("button", { name: "Drag" }), { dataTransfer: transfer });
    fireEvent.dragOver(screen.getByText(title), { dataTransfer: transfer });
    fireEvent.drop(screen.getByText(title), { dataTransfer: transfer });
  }

  it("moves a task with files to a thread on another location of its project without asking", async () => {
    const { moveTask } = renderSidebar();
    dropOn("Remote checkout");
    await waitFor(() =>
      expect(moveTask).toHaveBeenCalledWith(
        withFiles,
        { kind: "thread", threadId: "thread-remote" },
        expect.any(String),
      ),
    );
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("confirms moving a task with files into another project's thread", async () => {
    const { moveTask } = renderSidebar();
    dropOn("Invoices");
    const confirm = await screen.findByRole("dialog", { name: "Move task with project files?" });
    expect(confirm).toHaveTextContent("Moving it to Invoices keeps those absolute file paths unchanged.");
    expect(moveTask).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Move task" }));
    await waitFor(() =>
      expect(moveTask).toHaveBeenCalledWith(
        withFiles,
        { kind: "thread", threadId: "thread-billing" },
        expect.any(String),
      ),
    );
  });
});
