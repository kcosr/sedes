import { describe, expect, it } from "vitest";
import type {
  NormalizedApplicationThreadSummary,
  NormalizedThreadGroup,
} from "../../shared/index.js";
import type { SidebarFlatGroup } from "../app/sidebar-view-model.js";
import { projectSidebarStacks } from "./sidebar-group-projections.js";

const GROUP_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const GROUP_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const WORKSPACE_LABELS = new Map([
  ["workspace-1", "Sedes"],
  ["workspace-2", "Console"],
]);

function group(id: string, name: string): NormalizedThreadGroup {
  return { id, name, revision: 1, memberCount: 20, activeMemberCount: 10 };
}

function thread(
  id: string,
  input: Partial<NormalizedApplicationThreadSummary> = {},
): NormalizedApplicationThreadSummary {
  return {
    id,
    workspaceId: "workspace-1",
    targetId: "target-1",
    title: { text: `Thread ${id}` },
    backend: { label: { text: "Pi" }, brand: "pi" },
    backingState: "bound",
    inventoryState: "active",
    inventoryRevision: 1,
    pinned: false,
    pinRevision: 0,
    groupId: null,
    groupAssignmentRevision: 0,
    bookmarkRevision: 0,
    turnBookmarkCount: 0,
    threadRevision: 1,
    runState: "idle",
    terminalSummary: { runningCount: 0, retainedCount: 0 },
    queuedInputCount: 0,
    stashedPromptCount: 0,
    pendingQuestionCount: 0,
    available: true,
    lastActivityAt: "2026-08-20T12:00:00.000Z",
    stateChangedAt: "2026-08-20T12:00:00.000Z",
    automation: null,
    attention: {
      wake: false,
      automationContext: null,
      unseenCompletion: false,
      queueFailure: false,
    },
    ...input,
    preferredWorktreeRevision: input.preferredWorktreeRevision ?? 0,
    preferredWorktree: input.preferredWorktree ?? null,
  };
}

function bucket(
  key: string,
  threads: readonly NormalizedApplicationThreadSummary[],
): SidebarFlatGroup {
  return { key, label: key, kind: "time", futureTimes: false, threads };
}

describe("projectSidebarStacks", () => {
  it("leaves the already-organized stream unchanged when stacking is off", () => {
    const groups = projectSidebarStacks({
      groups: [bucket("Today", [thread("second"), thread("first")])],
      stackBy: "none",
      threadGroups: [],
      workspaceLabels: WORKSPACE_LABELS,
    });

    expect(groups[0]?.entries.map(({ key }) => key)).toEqual([
      "thread:second",
      "thread:first",
    ]);
  });

  it("anchors a thread-group stack at its first occurrence across buckets", () => {
    const first = thread("today", { groupId: GROUP_A });
    const between = thread("between");
    const later = thread("yesterday", { groupId: GROUP_A });
    const groups = projectSidebarStacks({
      groups: [bucket("Today", [first, between]), bucket("Yesterday", [later])],
      stackBy: "group",
      threadGroups: [group(GROUP_A, "Alpha")],
      workspaceLabels: WORKSPACE_LABELS,
    });

    expect(groups.map(({ key }) => key)).toEqual(["Today"]);
    expect(groups[0]?.entries.map(({ key }) => key)).toEqual([
      `group:${GROUP_A}`,
      "thread:between",
    ]);
    const entry = groups[0]?.entries[0];
    if (entry?.kind !== "stack") throw new Error("expected stack");
    expect(entry.representative.id).toBe("today");
    expect(entry.members.map(({ id }) => id)).toEqual(["today", "yesterday"]);
    expect(entry).toMatchObject({ stackBy: "group", label: "Alpha" });
  });

  it("does not promote a newer or selected member over the first row", () => {
    const first = thread("first", {
      groupId: GROUP_A,
      lastActivityAt: "2026-08-19T12:00:00.000Z",
    });
    const newer = thread("newer", {
      groupId: GROUP_A,
      lastActivityAt: "2026-08-23T12:00:00.000Z",
    });
    const groups = projectSidebarStacks({
      groups: [bucket("ordered", [first, newer])],
      stackBy: "group",
      threadGroups: [group(GROUP_A, "Alpha")],
      workspaceLabels: WORKSPACE_LABELS,
    });
    const entry = groups[0]?.entries[0];
    if (entry?.kind !== "stack") throw new Error("expected stack");
    expect(entry.representative.id).toBe("first");
    expect(entry.members.map(({ id }) => id)).toEqual(["first", "newer"]);
  });

  it("keeps singleton and missing-catalog memberships as ordinary rows", () => {
    const groups = projectSidebarStacks({
      groups: [
        bucket("ordered", [
          thread("known-singleton", { groupId: GROUP_A }),
          thread("orphan-a", { groupId: GROUP_B }),
          thread("orphan-b", { groupId: GROUP_B }),
        ]),
      ],
      stackBy: "group",
      threadGroups: [group(GROUP_A, "Alpha")],
      workspaceLabels: WORKSPACE_LABELS,
    });
    expect(groups[0]?.entries.map(({ key }) => key)).toEqual([
      "thread:known-singleton",
      "thread:orphan-a",
      "thread:orphan-b",
    ]);
  });

  it("stacks projects at the first project member without reordering buckets", () => {
    const sedesFirst = thread("sedes-first");
    const console = thread("console", { workspaceId: "workspace-2" });
    const sedesLater = thread("sedes-later");
    const groups = projectSidebarStacks({
      groups: [
        bucket("Active", [sedesFirst, console]),
        bucket("Settled", [sedesLater]),
      ],
      stackBy: "project",
      threadGroups: [],
      workspaceLabels: WORKSPACE_LABELS,
    });

    expect(groups.map(({ key }) => key)).toEqual(["Active"]);
    expect(groups[0]?.entries.map(({ key }) => key)).toEqual([
      "project:workspace-1",
      "thread:console",
    ]);
    const entry = groups[0]?.entries[0];
    if (entry?.kind !== "stack") throw new Error("expected stack");
    expect(entry).toMatchObject({
      stackBy: "project",
      stackId: "workspace-1",
      label: "Sedes",
      representative: { id: "sedes-first" },
    });
  });

  it("omits buckets emptied by members anchored in an earlier bucket", () => {
    const groups = projectSidebarStacks({
      groups: [
        bucket("Today", [thread("a", { groupId: GROUP_A })]),
        bucket("Yesterday", [thread("b", { groupId: GROUP_A })]),
      ],
      stackBy: "group",
      threadGroups: [group(GROUP_A, "Alpha")],
      workspaceLabels: WORKSPACE_LABELS,
    });
    expect(groups).toHaveLength(1);
    expect(groups[0]).toMatchObject({ key: "Today", threadCount: 1 });
  });
});
