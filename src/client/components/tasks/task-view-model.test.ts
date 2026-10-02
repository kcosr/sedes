import { describe, expect, it } from "vitest";
import type { AssociatedTask } from "../../../shared/index.js";
import {
  clampView,
  compareCompleted,
  compareOpen,
  destinationScope,
  groupTasks,
  inViewScope,
  matchesOnly,
  matchesQuery,
  openCount,
  parsePastedTitles,
  parseScopeKey,
  revealView,
  scopeKey,
  taskFileName,
  taskFileParent,
  viewFilters,
  viewUnavailableReason,
  type TasksContext,
} from "./task-view-model.js";
import { TASKS_VIEW_OPTIONS_DEFAULTS } from "../../app/tasks-panel-store.js";

function task(overrides: Partial<AssociatedTask> = {}): AssociatedTask {
  return {
    id: "task",
    scope: { kind: "global" },
    associatedWorkspaceId: null,
    title: "Task",
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

const context: TasksContext = {
  thread: { id: "thread-1", title: "Current", workspaceId: "workspace-1" },
  project: { id: "workspace-1", label: "acme-web" },
};

const projectTask = task({
  id: "project",
  scope: { kind: "workspace", workspaceId: "workspace-1" },
  associatedWorkspaceId: "workspace-1",
});
const threadTask = task({
  id: "thread",
  scope: { kind: "thread", threadId: "thread-1" },
  associatedWorkspaceId: "workspace-1",
});
const siblingTask = task({
  id: "sibling",
  scope: { kind: "thread", threadId: "thread-2" },
  associatedWorkspaceId: "workspace-1",
});
const otherTask = task({
  id: "other",
  scope: { kind: "thread", threadId: "thread-3" },
  associatedWorkspaceId: "workspace-2",
});

describe("views", () => {
  it("disables views without a chat to follow and narrows to one that applies", () => {
    expect(viewUnavailableReason("thread", {})).toBe("This thread isn't available.");
    expect(
      viewUnavailableReason("thread", { threadArchived: true, project: context.project! }),
    ).toBe("This thread is archived. Restore it to see its tasks.");
    expect(viewUnavailableReason("project", {})).toBe(
      "This thread's project isn't available.",
    );
    expect(
      viewUnavailableReason("project", { threadArchived: true, project: context.project! }),
    ).toBeUndefined();
    expect(viewUnavailableReason("all", {})).toBeUndefined();
    expect(clampView("thread", {})).toBe("global");
    expect(clampView("thread", { project: context.project! })).toBe("project");
    expect(clampView("all", {})).toBe("all");
    expect(clampView("thread", context)).toBe("thread");
  });

  it("adds to the scope in view, and to Global from All", () => {
    expect(destinationScope("thread", context)).toEqual({ kind: "thread", threadId: "thread-1" });
    expect(destinationScope("project", context)).toEqual({ kind: "workspace", workspaceId: "workspace-1" });
    expect(destinationScope("global", context)).toEqual({ kind: "global" });
    expect(destinationScope("all", context)).toEqual({ kind: "global" });
    expect(destinationScope("thread", {})).toBeUndefined();
  });

  it("filters each view by scope, with thread tasks in Project only on request", () => {
    const tasks = [task(), projectTask, threadTask, siblingTask, otherTask];
    const ids = (view: Parameters<typeof inViewScope>[1], include = false) =>
      tasks.filter((candidate) => inViewScope(candidate, view, context, include)).map(({ id }) => id);
    expect(ids("thread")).toEqual(["thread"]);
    expect(ids("project")).toEqual(["project"]);
    expect(ids("project", true)).toEqual(["project", "thread", "sibling"]);
    expect(ids("global")).toEqual(["task"]);
    expect(ids("all")).toHaveLength(5);
    expect(openCount([...tasks, task({ id: "done", completedAt: "2026-08-02T00:00:00.000Z" })], "all", context, false)).toBe(5);
    expect(openCount(tasks, "thread", {}, false)).toBe(0);
  });

  it("round-trips scope keys", () => {
    for (const scope of [projectTask.scope, threadTask.scope, { kind: "global" } as const]) {
      expect(parseScopeKey(scopeKey(scope))).toEqual(scope);
    }
    expect(parseScopeKey("thread:")).toBeUndefined();
    expect(parseScopeKey("nonsense")).toBeUndefined();
  });

  it("reveals a task in its own scope when the chat follows it, else in All", () => {
    expect(revealView(threadTask, context)).toBe("thread");
    expect(revealView(projectTask, context)).toBe("project");
    expect(revealView(task(), context)).toBe("global");
    expect(revealView(siblingTask, context)).toBe("all");
    expect(revealView(projectTask, {})).toBe("all");
  });
});

describe("search, filters and order", () => {
  it("matches titles, and notes only when asked", () => {
    const noted = task({ title: "Retry", details: "Use idempotency keys" });
    expect(matchesQuery(noted, "retry", false)).toBe(true);
    expect(matchesQuery(noted, "idempotency", false)).toBe(false);
    expect(matchesQuery(noted, "idempotency", true)).toBe(true);
    expect(matchesQuery(noted, "", false)).toBe(true);
  });

  it("combines the Only filters and flags narrowing options", () => {
    const options = { ...TASKS_VIEW_OPTIONS_DEFAULTS.thread, onlyPinned: true, onlyWithFiles: true };
    expect(matchesOnly(task({ pinned: true, files: ["/a"] }), options)).toBe(true);
    expect(matchesOnly(task({ pinned: true }), options)).toBe(false);
    expect(matchesOnly(task({ details: "   " }), { ...TASKS_VIEW_OPTIONS_DEFAULTS.thread, onlyWithNotes: true })).toBe(false);
    expect(viewFilters(TASKS_VIEW_OPTIONS_DEFAULTS.thread)).toEqual([]);
    // Sorting and search scope do not narrow the list.
    expect(viewFilters({ ...TASKS_VIEW_OPTIONS_DEFAULTS.thread, sort: "title", searchNotes: true })).toEqual([]);
    expect(
      viewFilters({ ...TASKS_VIEW_OPTIONS_DEFAULTS.thread, show: "completed", onlyPinned: true, onlyWithNotes: true }),
    ).toEqual([
      { key: "completed", label: "Completed", clear: { show: "open" } },
      { key: "pinned", label: "Pinned only", clear: { onlyPinned: false } },
      { key: "notes", label: "With notes", clear: { onlyWithNotes: false } },
    ]);
  });

  it("orders pinned first then newest, and never reorders on edit", () => {
    const old = task({ id: "old", createdAt: "2026-08-01T00:00:00.000Z", updatedAt: "2026-08-09T00:00:00.000Z" });
    const recent = task({ id: "recent", createdAt: "2026-08-05T00:00:00.000Z" });
    const pinned = task({ id: "pinned", pinned: true, createdAt: "2026-07-01T00:00:00.000Z", title: "Alpha" });
    const ids = (sort: Parameters<typeof compareOpen>[0]) =>
      [old, recent, pinned].sort(compareOpen(sort)).map(({ id }) => id);
    expect(ids("pinned-newest")).toEqual(["pinned", "recent", "old"]);
    // Equal update times fall back to the id.
    expect(ids("updated")).toEqual(["old", "pinned", "recent"]);
    expect(ids("title")).toEqual(["pinned", "old", "recent"]);
  });

  it("orders completed tasks by completion, without lifting pinned ones", () => {
    const first = task({ id: "first", pinned: true, completedAt: "2026-08-01T00:00:00.000Z" });
    const last = task({ id: "last", completedAt: "2026-08-03T00:00:00.000Z" });
    expect([first, last].sort(compareCompleted("pinned-newest")).map(({ id }) => id)).toEqual(["last", "first"]);
  });
});

describe("grouping", () => {
  it("puts Global first, then the current project, then others by name, with threads nested", () => {
    const groups = groupTasks(
      [otherTask, siblingTask, threadTask, projectTask, task({ id: "global" }), task({ id: "zed", scope: { kind: "workspace", workspaceId: "workspace-0" }, associatedWorkspaceId: "workspace-0" })],
      {
        workspaces: new Map([
          ["workspace-0", "zeta"],
          ["workspace-1", "acme-web"],
          ["workspace-2", "billing"],
        ]),
        threads: new Map([
          ["thread-1", "Current"],
          ["thread-2", "Another"],
        ]),
      },
      context,
    );
    expect(
      groups.map((group) => [
        group.label,
        group.count,
        group.tasks.map(({ id }) => id),
        group.children.map((child) => [child.label, child.tasks.map(({ id }) => id)]),
      ]),
    ).toEqual([
      ["Global", 1, ["global"], []],
      ["acme-web", 3, ["project"], [["Current", ["thread"]], ["Another", ["sibling"]]]],
      ["billing", 1, [], [["Thread", ["other"]]]],
      ["zeta", 1, ["zed"], []],
    ]);
    expect(groups.map(({ key }) => key)).toEqual(["global", "workspace:workspace-1", "workspace:workspace-2", "workspace:workspace-0"]);
    expect(groups[1]!.children[0]!.key).toBe("thread:thread-1");
  });

  it("names unknown projects and keeps project-less thread tasks together", () => {
    const groups = groupTasks(
      [task({ id: "orphan", scope: { kind: "thread", threadId: "gone" } })],
      { workspaces: new Map(), threads: new Map() },
      {},
    );
    expect(groups.map(({ label, kind }) => [label, kind])).toEqual([["No project", "project"]]);
  });
});

describe("pasted titles and files", () => {
  it("makes one title per line without list markers", () => {
    expect(
      parsePastedTitles("- [ ] Write it\r\n\r\n2. Ship it\n* [x] Tell support\n  • Celebrate  \n[ ] Bare box"),
    ).toEqual(["Write it", "Ship it", "Tell support", "Celebrate", "Bare box"]);
    expect(parsePastedTitles(`${"x".repeat(300)}\nshort`)[0]).toHaveLength(240);
    expect(parsePastedTitles("one line")).toEqual(["one line"]);
  });

  it("shows a file's name and its parent folder", () => {
    expect(taskFileName("/workspace/src/checkout.ts")).toBe("checkout.ts");
    expect(taskFileParent("/workspace/src/checkout.ts")).toBe("src/");
    expect(taskFileParent("/README.md")).toBe("");
    expect(taskFileName("/workspace/docs/")).toBe("docs");
  });
});
