import { describe, expect, it } from "vitest";
import type { WorkpadCounts, WorkpadSummary } from "../../shared/protocol/workpads.js";
import { WORKPADS_VIEW_OPTIONS_DEFAULTS } from "../app/workpads-panel-store.js";
import {
  archivedListRequest,
  groupKeys,
  groupWorkpads,
  showsLocation,
  viewCount,
  workpadListRequest,
  type WorkpadGroup,
} from "./workpads-view-model.js";

const defaults = WORKPADS_VIEW_OPTIONS_DEFAULTS.thread;
const target = { threadId: "thread-1", projectId: "project-1" };
const author = { kind: "user" as const, threadId: null, clientId: null, name: "You", nameSnapshot: "You" };
const time = "2026-10-09T00:00:00.000Z";
const workpad = (id: string, scope: WorkpadSummary["scope"]): WorkpadSummary =>
  ({ id, title: id, scope, revision: 0, archivedAt: null, createdAt: time, updatedAt: time, author });

describe("workpad view requests", () => {
  it("maps each view to its list: Thread, Project and Global exact, All every workpad", () => {
    expect(workpadListRequest("thread", target, defaults)).toEqual({ scope: { kind: "thread", threadId: "thread-1" }, scopeMode: "exact", sort: "updated" });
    expect(workpadListRequest("project", target, defaults)).toEqual({ scope: { kind: "project", projectId: "project-1" }, scopeMode: "exact", sort: "updated" });
    expect(workpadListRequest("project", target, { ...defaults, includeThreadWorkpads: true })).toEqual(
      { scope: { kind: "project", projectId: "project-1" }, scopeMode: "subtree", sort: "updated" });
    expect(workpadListRequest("global", target, { ...defaults, sort: "title" })).toEqual({ scope: { kind: "global" }, scopeMode: "exact", sort: "title" });
    // All groups by project with the current one leading, unless turned off.
    expect(workpadListRequest("all", target, defaults)).toEqual(
      { scope: { kind: "global" }, scopeMode: "subtree", sort: "updated", group: "project", leadProjectId: "project-1" });
    expect(workpadListRequest("all", {}, defaults)).toEqual({ scope: { kind: "global" }, scopeMode: "subtree", sort: "updated", group: "project" });
    expect(workpadListRequest("all", target, { ...defaults, groupByProject: false, sort: "newest" })).toEqual(
      { scope: { kind: "global" }, scopeMode: "subtree", sort: "newest", group: "none" });
    // A view with nothing to follow lists nothing.
    expect(workpadListRequest("thread", { projectId: "project-1" }, defaults)).toBeUndefined();
    expect(workpadListRequest("project", { threadId: "thread-1" }, defaults)).toBeUndefined();
  });

  it("lists a view's archived workpads by the same scope and sort, never grouped", () => {
    expect(archivedListRequest("all", target, { ...defaults, sort: "title" })).toEqual(
      { scope: { kind: "global" }, scopeMode: "subtree", sort: "title", archived: true });
    expect(archivedListRequest("project", target, { ...defaults, includeThreadWorkpads: true })).toEqual(
      { scope: { kind: "project", projectId: "project-1" }, scopeMode: "subtree", sort: "updated", archived: true });
    expect(archivedListRequest("thread", {}, defaults)).toBeUndefined();
  });

  it("reads each view's count, Project's with its threads' while it includes them", () => {
    const counts: WorkpadCounts["active"] = { thread: 1, project: 2, projectWithThreads: 5, global: 3, all: 9 };
    expect(viewCount(counts, "thread", false)).toBe(1);
    expect(viewCount(counts, "project", false)).toBe(2);
    expect(viewCount(counts, "project", true)).toBe(5);
    expect(viewCount(counts, "global", true)).toBe(3);
    expect(viewCount(counts, "all", false)).toBe(9);
    expect(viewCount({ ...counts, thread: null }, "thread", false)).toBeUndefined();
    expect(viewCount(undefined, "all", false)).toBeUndefined();
  });

  it("names rows' places only in lists that mix scopes without headings", () => {
    expect(showsLocation("thread", defaults, "active")).toBe(false);
    expect(showsLocation("global", defaults, "archived")).toBe(false);
    expect(showsLocation("project", defaults, "active")).toBe(false);
    expect(showsLocation("project", { ...defaults, includeThreadWorkpads: true }, "active")).toBe(true);
    expect(showsLocation("all", defaults, "active")).toBe(false);
    expect(showsLocation("all", defaults, "archived")).toBe(true);
    expect(showsLocation("all", { ...defaults, groupByProject: false }, "active")).toBe(true);
  });
});

describe("All's groups", () => {
  const labels = {
    project: (id: string) => ({ web: "acme-web", docs: "docs" })[id],
    thread: (id: string) => ({ "thread-a": "Zeta thread", "thread-b": "Alpha thread" })[id],
    threadProject: (id: string) => ({ "thread-a": "web", "thread-b": "web", "thread-c": "docs" })[id],
  };

  it("keeps the server's order, nesting each thread under its project", () => {
    // The server leads with the current project and orders the rest; the
    // client never re-sorts, so a group continues across pages.
    const groups = groupWorkpads([
      workpad("g1", { kind: "global" }),
      workpad("w1", { kind: "project", projectId: "web" }),
      workpad("a1", { kind: "thread", threadId: "thread-a" }),
      workpad("b1", { kind: "thread", threadId: "thread-b" }),
      workpad("b2", { kind: "thread", threadId: "thread-b" }),
      workpad("d1", { kind: "project", projectId: "docs" }),
      workpad("c1", { kind: "thread", threadId: "thread-c" }),
    ], labels);
    const outline = (list: readonly WorkpadGroup[]): unknown[] => list.map(group => [group.label, group.count, group.items.map(({ id }) => id), outline(group.children)]);
    expect(outline(groups)).toEqual([
      ["Global", 1, ["g1"], []],
      ["acme-web", 4, ["w1"], [["Zeta thread", 1, ["a1"], []], ["Alpha thread", 2, ["b1", "b2"], []]]],
      ["docs", 2, ["d1"], [["Thread", 1, ["c1"], []]]],
    ]);
    expect(groups.map(({ key, kind }) => [key, kind])).toEqual([["global", "global"], ["project:web", "project"], ["project:docs", "project"]]);
    expect(groupKeys(groups)).toEqual(["global", "project:web", "thread:thread-a", "thread:thread-b", "project:docs", "thread:thread-c"]);
  });

  it("names what the snapshot does not know generically", () => {
    const groups = groupWorkpads([
      workpad("x1", { kind: "project", projectId: "gone" }),
      workpad("y1", { kind: "thread", threadId: "unknown" }),
    ], labels);
    expect(groups.map(({ label, children }) => [label, children.map(child => child.label)])).toEqual([["Project", []], ["No project", ["Thread"]]]);
  });
});
