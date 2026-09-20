import { describe, expect, it } from "vitest";
import type { NormalizedApplicationThreadSummary } from "../../shared/index.js";
import { createThreadSearchMatcher } from "./sidebar-search.js";

const thread: NormalizedApplicationThreadSummary = {
  id: "thread-1",
  workspaceId: "workspace-1",
  targetId: "target-1",
  title: { text: "Investigate queues" },
  backend: { label: { text: "Pi" }, brand: "pi" },
  backingState: "bound",
  inventoryState: "active",
  inventoryRevision: 1,
  preferredWorktreeRevision: 0,
  preferredWorktree: null,
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
  lastActivityAt: "2026-08-01T12:00:00.000Z",
  stateChangedAt: "2026-08-01T12:00:00.000Z",
  automation: null,
  attention: {
    wake: false,
    automationContext: null,
    unseenCompletion: false,
    queueFailure: false,
  },
};

const snapshot = {
  workspaces: [
    {
      id: "workspace-1",
      environmentId: "environment-1",
      label: { text: "Sedes" },
      displayPath: { text: "/work/sidebar" },
      available: true as const,
    },
  ],
  environments: [
    {
      id: "environment-1",
      kind: "local" as const,
      label: { text: "Build machine" },
      available: true,
      directoryBrowsing: "unavailable" as const,
    },
  ],
  executionTargets: [
    {
      id: "target-1",
      environmentId: "environment-1",
      label: { text: "Local socket" },
      backend: { label: { text: "Codex UDS" }, brand: "codex" as const },
      workspaceExecution: { kind: "direct_only" as const },
      available: true as const,
    },
  ],
};

describe("createThreadSearchMatcher", () => {
  it.each([
    "queues",
    "sedes",
    "/WORK/SIDEBAR",
    "build machine",
    "local socket",
    "CODEX UDS",
    "pi",
  ])("matches indexed thread metadata for %s", (query) => {
    expect(createThreadSearchMatcher(query, snapshot)(thread)).toBe(true);
  });

  it("does not match unrelated text", () => {
    expect(createThreadSearchMatcher("needle", snapshot)(thread)).toBe(false);
  });
});
