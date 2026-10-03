// @vitest-environment jsdom

import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  TASKS_PANEL_DEFAULTS,
  TASKS_PANEL_STORAGE_KEY,
  TASKS_VIEW_OPTIONS_DEFAULTS,
  consumeReveal,
  getPendingReveal,
  getTasksPanelPreferences,
  getTasksViewOptions,
  revealTask,
  setTasksLastView,
  setTasksViewOptions,
  subscribeReveal,
  useTaskReveal,
  useTasksViewOptions,
  type TasksRevealRequest,
  type TasksView,
} from "./tasks-panel-store.js";

const RETIRED_WIDTH_KEY = "sedes.tasks.panel.width";

function invalidate(): void {
  // Drop the module's cached snapshot the same way another tab would.
  window.dispatchEvent(
    new StorageEvent("storage", { key: TASKS_PANEL_STORAGE_KEY }),
  );
}

function seed(raw: string): void {
  window.localStorage.setItem(TASKS_PANEL_STORAGE_KEY, raw);
  invalidate();
}

function stored(): unknown {
  return JSON.parse(window.localStorage.getItem(TASKS_PANEL_STORAGE_KEY)!);
}

function drainReveal(): void {
  const pending = getPendingReveal();
  if (pending) consumeReveal(pending.sequence);
}

beforeEach(() => {
  window.localStorage.clear();
  invalidate();
  drainReveal();
});

afterEach(() => {
  cleanup();
  drainReveal();
});

describe("tasks panel preferences", () => {
  it("returns defaults when nothing is stored", () => {
    expect(getTasksPanelPreferences()).toEqual(TASKS_PANEL_DEFAULTS);
    expect(TASKS_PANEL_DEFAULTS.lastView).toBe("thread");
    expect(TASKS_VIEW_OPTIONS_DEFAULTS.all).toEqual({
      sort: "newest",
      onlyPinned: false,
      onlyBacklog: false,
      onlyWithNotes: false,
      onlyWithFiles: false,
      groupByProject: true,
      includeThreadTasks: false,
      searchNotes: false,
    });
  });

  it("remembers the last view and each view's options independently", () => {
    setTasksLastView("project");
    setTasksViewOptions("project", { includeThreadTasks: true, sort: "title" });
    setTasksViewOptions("all", { groupByProject: false });
    setTasksViewOptions("thread", { onlyPinned: true, onlyBacklog: true, searchNotes: true });

    expect(getTasksPanelPreferences().lastView).toBe("project");
    expect(getTasksViewOptions("project")).toEqual({
      ...TASKS_VIEW_OPTIONS_DEFAULTS.project,
      includeThreadTasks: true,
      sort: "title",
    });
    expect(getTasksViewOptions("all")).toEqual({
      ...TASKS_VIEW_OPTIONS_DEFAULTS.all,
      groupByProject: false,
    });
    expect(getTasksViewOptions("thread")).toEqual({
      ...TASKS_VIEW_OPTIONS_DEFAULTS.thread,
      onlyPinned: true,
      onlyBacklog: true,
      searchNotes: true,
    });
    expect(getTasksViewOptions("global")).toEqual(
      TASKS_VIEW_OPTIONS_DEFAULTS.global,
    );
    expect(stored()).toEqual(getTasksPanelPreferences());

    // A reload reads the same preferences back.
    invalidate();
    expect(getTasksViewOptions("project").sort).toBe("title");
  });

  it("publishes per-view options to subscribers", () => {
    const seen: string[] = [];
    function Probe({ view }: { readonly view: TasksView }) {
      seen.push(useTasksViewOptions(view).sort);
      return null;
    }
    render(<Probe view="global" />);
    act(() => setTasksViewOptions("global", { sort: "updated" }));
    expect(seen.at(-1)).toBe("updated");
  });

  it("never throws on malformed version 2 blobs and keeps valid fields", () => {
    for (const raw of [
      "not json",
      "null",
      "[]",
      '{"version":99,"lastView":"all"}',
      '{"version":2,"lastView":42,"views":[]}',
    ]) {
      seed(raw);
      expect(getTasksPanelPreferences()).toEqual(TASKS_PANEL_DEFAULTS);
    }
    seed(
      JSON.stringify({
        version: 2,
        lastView: "all",
        views: {
          all: { sort: "bogus", groupByProject: "yes", onlyBacklog: true },
          project: "nope",
        },
      }),
    );
    expect(getTasksPanelPreferences()).toEqual({
      version: 2,
      lastView: "all",
      views: {
        ...TASKS_VIEW_OPTIONS_DEFAULTS,
        all: { ...TASKS_VIEW_OPTIONS_DEFAULTS.all, onlyBacklog: true },
      },
    });
  });

  it("reads options saved before Backlog: the pin sort and Show are retired", () => {
    seed(
      JSON.stringify({
        version: 2,
        lastView: "thread",
        views: {
          thread: { sort: "pinned-newest", show: "completed", onlyPinned: true },
          project: { sort: "title", show: "open" },
        },
      }),
    );
    expect(getTasksViewOptions("thread")).toEqual({
      ...TASKS_VIEW_OPTIONS_DEFAULTS.thread,
      sort: "newest",
      onlyPinned: true,
    });
    expect(getTasksViewOptions("project")).toEqual({
      ...TASKS_VIEW_OPTIONS_DEFAULTS.project,
      sort: "title",
    });
    // The next write drops the retired fields.
    setTasksViewOptions("global", { searchNotes: true });
    expect(JSON.stringify(stored())).not.toMatch(/pinned-newest|"show"/u);
  });
});

describe("version 1 migration", () => {
  it("drops open and pinned, remembers the default view and rewrites storage", () => {
    window.localStorage.setItem(RETIRED_WIDTH_KEY, "488");
    seed(
      JSON.stringify({
        version: 1,
        open: true,
        pinned: true,
        defaultView: "project",
        searchContent: true,
        includeNestedScopes: true,
        addTo: "project",
      }),
    );
    const expected = {
      version: 2,
      lastView: "project",
      views: {
        thread: { ...TASKS_VIEW_OPTIONS_DEFAULTS.thread, searchNotes: true },
        project: {
          ...TASKS_VIEW_OPTIONS_DEFAULTS.project,
          searchNotes: true,
          includeThreadTasks: true,
        },
        global: { ...TASKS_VIEW_OPTIONS_DEFAULTS.global, searchNotes: true },
        all: { ...TASKS_VIEW_OPTIONS_DEFAULTS.all, searchNotes: true },
      },
    };
    expect(getTasksPanelPreferences()).toEqual(expected);
    // No version 1 shape or retired key outlives the first read.
    expect(stored()).toEqual(expected);
    expect(window.localStorage.getItem(RETIRED_WIDTH_KEY)).toBeNull();
    for (const retired of ["open", "pinned", "defaultView", "searchContent", "includeNestedScopes", "addTo"]) {
      expect(stored()).not.toHaveProperty(retired);
    }
  });

  it("turns Global with nested scopes into All", () => {
    seed('{"version":1,"defaultView":"global","includeNestedScopes":true}');
    expect(getTasksPanelPreferences().lastView).toBe("all");
    expect(getTasksViewOptions("project").includeThreadTasks).toBe(true);

    seed('{"version":1,"defaultView":"global","includeNestedScopes":false}');
    expect(getTasksPanelPreferences().lastView).toBe("global");
  });

  it("migrates malformed version 1 fields to defaults", () => {
    seed('{"version":1,"open":"yes","defaultView":42,"searchContent":"no"}');
    expect(getTasksPanelPreferences()).toEqual(TASKS_PANEL_DEFAULTS);
    expect(stored()).toEqual(TASKS_PANEL_DEFAULTS);
  });
});

describe("revealTask", () => {
  it("notifies live subscribers and stays pending until consumed", () => {
    const listener = vi.fn();
    const unsubscribe = subscribeReveal(listener);
    revealTask("task-1");
    revealTask("task-1");
    expect(listener.mock.calls.map(([request]) => request)).toEqual([
      { taskId: "task-1", sequence: expect.any(Number) },
      { taskId: "task-1", sequence: expect.any(Number) },
    ]);
    const [first, second] = listener.mock.calls.map(
      ([request]) => request as TasksRevealRequest,
    );
    expect(second!.sequence).toBeGreaterThan(first!.sequence);
    expect(getPendingReveal()).toEqual(second);

    // Consuming an older request leaves the newer one pending.
    consumeReveal(first!.sequence);
    expect(getPendingReveal()).toEqual(second);
    consumeReveal(second!.sequence);
    expect(getPendingReveal()).toBeUndefined();

    unsubscribe();
    revealTask("task-2");
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it("delivers a reveal made before the content mounted, then live ones", () => {
    revealTask("before-mount");
    const handled: string[] = [];
    function Content() {
      useTaskReveal(({ taskId }) => handled.push(taskId));
      return null;
    }
    const view = render(<Content />);
    expect(handled).toEqual(["before-mount"]);
    expect(getPendingReveal()).toBeUndefined();

    act(() => revealTask("while-mounted"));
    expect(handled).toEqual(["before-mount", "while-mounted"]);
    expect(getPendingReveal()).toBeUndefined();

    view.unmount();
    revealTask("after-unmount");
    expect(handled).toHaveLength(2);
    expect(getPendingReveal()).toMatchObject({ taskId: "after-unmount" });
  });
});
