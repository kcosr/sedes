import { describe, expect, it } from "vitest";
import type { WorkpadCounts } from "../../shared/protocol/workpads.js";
import { WORKPADS_VIEW_OPTIONS_DEFAULTS } from "../app/workpads-panel-store.js";
import { archivedListRequest, showsLocation, viewCount, workpadListRequest } from "./workpads-view-model.js";

const defaults = WORKPADS_VIEW_OPTIONS_DEFAULTS.thread;
const target = { threadId: "thread-1", projectId: "project-1" };

describe("workpad view requests", () => {
  it("maps each view to its list: Thread, Project and Global exact, All every workpad", () => {
    expect(workpadListRequest("thread", target, defaults)).toEqual({ scope: { kind: "thread", threadId: "thread-1" }, scopeMode: "exact", sort: "updated" });
    expect(workpadListRequest("project", target, defaults)).toEqual({ scope: { kind: "project", projectId: "project-1" }, scopeMode: "exact", sort: "updated" });
    expect(workpadListRequest("project", target, { ...defaults, includeThreadWorkpads: true })).toEqual(
      { scope: { kind: "project", projectId: "project-1" }, scopeMode: "subtree", sort: "updated" });
    expect(workpadListRequest("global", target, { ...defaults, sort: "title" })).toEqual({ scope: { kind: "global" }, scopeMode: "exact", sort: "title" });
    // All is every workpad in one flat list, whatever the chat follows.
    expect(workpadListRequest("all", target, defaults)).toEqual({ scope: { kind: "global" }, scopeMode: "subtree", sort: "updated" });
    expect(workpadListRequest("all", {}, { ...defaults, sort: "newest" })).toEqual({ scope: { kind: "global" }, scopeMode: "subtree", sort: "newest" });
    // A view with nothing to follow lists nothing.
    expect(workpadListRequest("thread", { projectId: "project-1" }, defaults)).toBeUndefined();
    expect(workpadListRequest("project", { threadId: "thread-1" }, defaults)).toBeUndefined();
  });

  it("lists a view's archived workpads by the same scope and sort", () => {
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

  it("names rows' places only in lists that mix scopes", () => {
    expect(showsLocation("thread", defaults)).toBe(false);
    expect(showsLocation("global", defaults)).toBe(false);
    expect(showsLocation("project", defaults)).toBe(false);
    expect(showsLocation("project", { ...defaults, includeThreadWorkpads: true })).toBe(true);
    expect(showsLocation("all", defaults)).toBe(true);
  });
});
