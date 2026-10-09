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
  taskSections,
  viewFilters,
  viewUnavailableReason,
  type TasksContext,
} from "./task-view-model.js";
import { TASKS_VIEW_OPTIONS_DEFAULTS } from "../../app/tasks-panel-store.js";

function task(overrides: Partial<AssociatedTask> = {}): AssociatedTask {
  return {
    id: "task",
    scope: { kind: "global" },
    associatedProjectId: null,
    title: "Task",
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

const context: TasksContext = {
  thread: { id: "thread-1", title: "Current", workspaceId: "workspace-1" },
  project: { id: "project-1", label: "acme-web" },
};

const projectTask = task({
  id: "project",
  scope: { kind: "project", projectId: "project-1" },
  associatedProjectId: "project-1",
});
const threadTask = task({
  id: "thread",
  scope: { kind: "thread", threadId: "thread-1" },
  associatedProjectId: "project-1",
});
const siblingTask = task({
  id: "sibling",
  scope: { kind: "thread", threadId: "thread-2" },
  associatedProjectId: "project-1",
});
const otherTask = task({
  id: "other",
  scope: { kind: "thread", threadId: "thread-3" },
  associatedProjectId: "project-2",
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
    // Workpads names its own items.
    expect(viewUnavailableReason("thread", { threadArchived: true }, "workpads")).toBe(
      "This thread is archived. Restore it to see its workpads.",
    );
    expect(clampView("thread", {})).toBe("global");
    expect(clampView("thread", { project: context.project! })).toBe("project");
    expect(clampView("all", {})).toBe("all");
    expect(clampView("thread", context)).toBe("thread");
  });

  it("adds to the scope in view, and to Global from All", () => {
    expect(destinationScope("thread", context)).toEqual({ kind: "thread", threadId: "thread-1" });
    expect(destinationScope("project", context)).toEqual({ kind: "project", projectId: "project-1" });
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
    const backlogOnly = { ...TASKS_VIEW_OPTIONS_DEFAULTS.thread, onlyBacklog: true };
    expect(matchesOnly(task({ backlog: true }), backlogOnly)).toBe(true);
    expect(matchesOnly(task(), backlogOnly)).toBe(false);
    // Pinned and Backlog together: pinned backlog tasks only.
    const both = { ...backlogOnly, onlyPinned: true };
    expect(matchesOnly(task({ backlog: true, pinned: true }), both)).toBe(true);
    expect(matchesOnly(task({ backlog: true }), both)).toBe(false);
    expect(matchesOnly(task({ pinned: true }), both)).toBe(false);
    expect(viewFilters(TASKS_VIEW_OPTIONS_DEFAULTS.thread, "thread")).toEqual([]);
    // Sorting and search scope do not narrow the list.
    expect(viewFilters({ ...TASKS_VIEW_OPTIONS_DEFAULTS.thread, sort: "title", searchNotes: true }, "thread")).toEqual([]);
    expect(
      viewFilters({ ...TASKS_VIEW_OPTIONS_DEFAULTS.thread, onlyPinned: true, onlyBacklog: true, onlyWithNotes: true }, "thread"),
    ).toEqual([
      { key: "pinned", label: "Pinned only", clear: { onlyPinned: false }, narrows: true },
      { key: "backlog", label: "Backlog only", clear: { onlyBacklog: false }, narrows: true },
      { key: "notes", label: "With notes", clear: { onlyWithNotes: false }, narrows: true },
    ]);
  });

  it("chips Project's thread tasks, which add to the list rather than narrow it", () => {
    const withThreads = { ...TASKS_VIEW_OPTIONS_DEFAULTS.project, includeThreadTasks: true };
    expect(viewFilters(withThreads, "project")).toEqual([
      { key: "threads", label: "Thread tasks", clear: { includeThreadTasks: false }, narrows: false },
    ]);
    // The option belongs to Project; other views ignore a stored value.
    expect(viewFilters(withThreads, "all")).toEqual([]);
    expect(viewFilters({ ...withThreads, onlyPinned: true }, "project").map(({ key }) => key)).toEqual(["pinned", "threads"]);
  });

  it("puts pinned tasks first in every sort, and never reorders on edit", () => {
    const old = task({ id: "old", createdAt: "2026-08-01T00:00:00.000Z", updatedAt: "2026-08-09T00:00:00.000Z", title: "Beta" });
    const recent = task({ id: "recent", createdAt: "2026-08-05T00:00:00.000Z", title: "Gamma" });
    const pinned = task({ id: "pinned", pinned: true, createdAt: "2026-07-01T00:00:00.000Z", title: "Zulu" });
    const ids = (sort: Parameters<typeof compareOpen>[0]) =>
      [old, recent, pinned].sort(compareOpen(sort)).map(({ id }) => id);
    expect(ids("newest")).toEqual(["pinned", "recent", "old"]);
    expect(ids("updated")).toEqual(["pinned", "old", "recent"]);
    expect(ids("title")).toEqual(["pinned", "old", "recent"]);
    // Equal times fall back to the id.
    expect([recent, task({ id: "a", createdAt: recent.createdAt })].sort(compareOpen("newest")).map(({ id }) => id)).toEqual(["a", "recent"]);
  });

  it("orders completed tasks by completion by default, else by the sort", () => {
    const first = task({ id: "first", title: "Alpha", completedAt: "2026-08-01T00:00:00.000Z" });
    const last = task({ id: "last", title: "Beta", completedAt: "2026-08-03T00:00:00.000Z" });
    expect([first, last].sort(compareCompleted("newest")).map(({ id }) => id)).toEqual(["last", "first"]);
    expect([last, first].sort(compareCompleted("title")).map(({ id }) => id)).toEqual(["first", "last"]);
  });

  it("splits a view into the list, Backlog and Completed, pinned first in each", () => {
    const current = task({ id: "current", createdAt: "2026-08-05T00:00:00.000Z" });
    const pinned = task({ id: "pinned", pinned: true, createdAt: "2026-08-01T00:00:00.000Z" });
    const later = task({ id: "later", backlog: true, createdAt: "2026-08-04T00:00:00.000Z" });
    const pinnedLater = task({ id: "pinned-later", backlog: true, pinned: true, createdAt: "2026-08-02T00:00:00.000Z" });
    const done = task({ id: "done", completedAt: "2026-08-06T00:00:00.000Z" });
    const all = [later, done, current, pinnedLater, pinned];
    const ids = (options: Partial<typeof TASKS_VIEW_OPTIONS_DEFAULTS.thread>) => {
      const merged = { ...TASKS_VIEW_OPTIONS_DEFAULTS.thread, ...options };
      const sections = taskSections(all.filter((candidate) => matchesOnly(candidate, merged)), merged);
      return {
        main: sections.main.map(({ id }) => id),
        backlog: sections.backlog.map(({ id }) => id),
        completed: sections.completed.map(({ id }) => id),
      };
    };
    expect(ids({})).toEqual({
      main: ["pinned", "current"],
      backlog: ["pinned-later", "later"],
      completed: ["done"],
    });
    expect(ids({ sort: "title" }).backlog).toEqual(["pinned-later", "later"]);
    // Only › Pinned narrows each section; no completed task is pinned.
    expect(ids({ onlyPinned: true })).toEqual({ main: ["pinned"], backlog: ["pinned-later"], completed: [] });
    // Only › Backlog: the backlog is the list, with no Backlog section.
    expect(ids({ onlyBacklog: true })).toEqual({ main: ["pinned-later", "later"], backlog: [], completed: [] });
    expect(ids({ onlyBacklog: true, onlyPinned: true })).toEqual({ main: ["pinned-later"], backlog: [], completed: [] });
  });
});

describe("grouping", () => {
  it("puts Global first, then the current project, then others by name, with threads nested", () => {
    const groups = groupTasks(
      [otherTask, siblingTask, threadTask, projectTask, task({ id: "global" }), task({ id: "zed", scope: { kind: "project", projectId: "project-0" }, associatedProjectId: "project-0" })],
      {
        projects: new Map([
          ["project-0", "zeta"],
          ["project-1", "acme-web"],
          ["project-2", "billing"],
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
    expect(groups.map(({ key }) => key)).toEqual(["global", "project:project-1", "project:project-2", "project:project-0"]);
    expect(groups[1]!.children[0]!.key).toBe("thread:thread-1");
  });

  it("names unknown projects and keeps project-less thread tasks together", () => {
    const groups = groupTasks(
      [task({ id: "orphan", scope: { kind: "thread", threadId: "gone" } })],
      { projects: new Map(), threads: new Map() },
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
