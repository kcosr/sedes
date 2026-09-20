// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  ApplicationClientState,
  ApplicationClientStore,
} from "../stores/ApplicationClientStore.js";
import { ArchivedView } from "./ArchivedView.js";
import { installThreadPanelOpenRequestListener } from "../workspace-panels/thread-panel-navigation.js";

afterEach(() => {
  cleanup();
  localStorage.clear();
  vi.unstubAllGlobals();
});
beforeEach(() => {
  vi.stubGlobal(
    "matchMedia",
    vi.fn(() => ({
      matches: false,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })),
  );
});

describe("ArchivedView location", () => {
  it("marks historical identities and Shift-opens the archived thread in single-panel mode", () => {
    const thread = {
      id: "thread-1",
      workspaceId: "workspace-1",
      targetId: "target-1",
      title: { text: "Archived work" },
      backend: { label: { text: "Codex" }, brand: "codex" as const },
      backingState: "bound" as const,
      inventoryState: "archived" as const,
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
      runState: "idle" as const,
      terminalSummary: { runningCount: 0, retainedCount: 0 },
      queuedInputCount: 0,
      pendingQuestionCount: 0,
      stashedPromptCount: 0,
      available: false,
      lastActivityAt: "2026-08-09T12:00:00.000Z",
      stateChangedAt: "2026-08-09T12:00:00.000Z",
      automation: null,
      attention: {
        wake: false,
        automationContext: null,
        unseenCompletion: false,
        queueFailure: false,
      },
    };
    const state: ApplicationClientState = {
      status: "ready",
      connection: "connected",
      authoritative: true,
      providerPulseEnabled: false,
      search: "",
      descendantPages: {},
      pendingThreadConfigurationCopySourceIds: [],
      visibleThreads: [thread],
      snapshot: {
        advisories: [],
        environments: [
          {
            id: "environment-1",
            kind: "local" as const,
            label: { text: "Retired host" },
            available: false,
            directoryBrowsing: "unavailable" as const,
          },
          {
            id: "environment-2",
            kind: "ssh" as const,
            label: { text: "Remote" },
            available: true,
            directoryBrowsing: "available" as const,
          },
        ],
        workspaces: [
          {
            id: "workspace-1",
            environmentId: "environment-1",
            label: { text: "sedes" },
            displayPath: { text: "/srv/sedes" },
            available: false,
          },
        ],
        executionTargets: [
          {
            id: "target-1",
            environmentId: "environment-1",
            label: { text: "Codex SSH" },
            backend: { label: { text: "Codex" }, brand: "codex" },
            workspaceExecution: { kind: "direct_only" },
            available: false,
            unavailableReason: { text: "Target retired" },
          },
        ],
        threads: [thread],
        forkOrigins: [],
        lineagePlacements: [],
        groups: [],
        lineageFamilies: [],
        defaultNewThreadTargetId: null,
        counts: { active: 0, snoozed: 0, settled: 0, archived: 1 },
        tasks: [],
      },
    };
    const store = {
      subscribe: () => () => undefined,
      getSnapshot: () => state,
      setSearch: vi.fn(),
      mutateInventory: vi.fn(async () => undefined),
    } as unknown as ApplicationClientStore;

    const onOpen = vi.fn();
    const removeOpenListener = installThreadPanelOpenRequestListener(
      window,
      onOpen,
    );
    render(<ArchivedView store={store} />);
    const row = screen.getByTestId("archive-row");
    expect(row).toHaveTextContent("sedes · Project unavailable");
    expect(row).not.toHaveTextContent("Local");
    expect(row).toHaveTextContent("Environment unavailable");
    expect(row).toHaveTextContent("Codex SSH · Codex · Unavailable");
    fireEvent.click(screen.getByRole("button", { name: /Archived work/ }), {
      shiftKey: true,
    });
    expect(onOpen).toHaveBeenCalledWith({
      threadId: "thread-1",
      presentation: "single",
    });
    expect(window.location.pathname).toBe("/threads/thread-1");
    removeOpenListener();
  });
});
