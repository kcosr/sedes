/**
 * The four views of a scoped list (Tasks, Workpads): the current thread, its
 * project, Global, and everything. Each panel keeps its own last view and
 * per-view options; the views and their names are shared.
 */
export type ScopeView = "thread" | "project" | "global" | "all";

export const SCOPE_VIEWS: readonly ScopeView[] = [
  "thread",
  "project",
  "global",
  "all",
];

export const SCOPE_VIEW_LABEL: Readonly<Record<ScopeView, string>> = {
  thread: "Thread",
  project: "Project",
  global: "Global",
  all: "All",
};

/**
 * The order within a list: newest created, most recently updated, or by
 * title.
 */
export type ScopeListSort = "newest" | "updated" | "title";

export const SCOPE_LIST_SORTS: readonly ScopeListSort[] = [
  "newest",
  "updated",
  "title",
];
