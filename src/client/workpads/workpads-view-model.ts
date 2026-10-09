import type { ListWorkpadsRequest, WorkpadCounts } from "../../shared/protocol/workpads.js";
import type { WorkpadsView, WorkpadsViewOptions } from "../app/workpads-panel-store.js";

/**
 * Pure presentation logic for the Workpads panel: what each view asks the
 * server for, which counts its segments show, and which lists name each
 * row's place. Workpads are server-paged, so unlike Tasks the filtering,
 * ordering and counting happen on the server.
 */

/** The thread and project the panel's views show. */
export interface WorkpadsTarget {
  /** Absent when the Thread view does not apply. */
  readonly threadId?: string;
  /** Absent when the Project view does not apply. */
  readonly projectId?: string;
}

/** A view's list request, without the search, page size or cursor. */
export type WorkpadListQuery = Omit<ListWorkpadsRequest, "query" | "limit" | "cursor">;

/**
 * The active list of a view: Thread and Global their exact scope, Project
 * its own (and its threads' with Include thread workpads), and All every
 * workpad in one flat list. Undefined when the view has nothing to follow.
 */
export function workpadListRequest(
  view: WorkpadsView,
  target: WorkpadsTarget,
  options: WorkpadsViewOptions,
): WorkpadListQuery | undefined {
  const { sort } = options;
  switch (view) {
    case "thread":
      return target.threadId
        ? { scope: { kind: "thread", threadId: target.threadId }, scopeMode: "exact", sort }
        : undefined;
    case "project":
      return target.projectId
        ? {
            scope: { kind: "project", projectId: target.projectId },
            scopeMode: options.includeThreadWorkpads ? "subtree" : "exact",
            sort,
          }
        : undefined;
    case "global":
      return { scope: { kind: "global" }, scopeMode: "exact", sort };
    case "all":
      return { scope: { kind: "global" }, scopeMode: "subtree", sort };
  }
}

/** The view's Archived section: the same scope and sort. */
export function archivedListRequest(
  view: WorkpadsView,
  target: WorkpadsTarget,
  options: WorkpadsViewOptions,
): WorkpadListQuery | undefined {
  const active = workpadListRequest(view, target, options);
  return active && { scope: active.scope, scopeMode: active.scopeMode, sort: active.sort, archived: true };
}

/**
 * A view's count among the server's counts: Project counts its threads'
 * workpads while it includes them. Undefined while counts are not known.
 */
export function viewCount(
  counts: WorkpadCounts["active"] | undefined,
  view: WorkpadsView,
  includeThreadWorkpads: boolean,
): number | undefined {
  if (!counts) return undefined;
  const value =
    view === "thread" ? counts.thread
      : view === "project" ? (includeThreadWorkpads ? counts.projectWithThreads : counts.project)
        : view === "global" ? counts.global
          : counts.all;
  return value ?? undefined;
}

/**
 * Whether rows say where each workpad belongs: in lists that mix scopes,
 * All and Project with its threads' workpads, as in Tasks. A view's
 * Archived section reads as its list does.
 */
export function showsLocation(view: WorkpadsView, options: WorkpadsViewOptions): boolean {
  return view === "all" || (view === "project" && options.includeThreadWorkpads);
}
