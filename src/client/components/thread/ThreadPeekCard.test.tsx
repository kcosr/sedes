// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { NormalizedApplicationThreadSummary } from "../../../shared/index.js";
import { ThreadPeekCard } from "./ThreadPeekCard.js";

afterEach(cleanup);

function thread(): NormalizedApplicationThreadSummary {
  return {
    id: "thread-1",
    workspaceId: "workspace-1",
    targetId: "target-1",
    title: { text: "Investigate sidebar scope" },
    backend: { label: { text: "Codex" }, brand: "codex" },
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
}

describe("ThreadPeekCard location", () => {
  it("stays self-contained with project, environment, and exact target", () => {
    render(
      <ThreadPeekCard
        thread={thread()}
        workspaceLabel="agent-workspaces"
        workspacePath="/srv/agent-workspaces"
        workspaceAvailable={false}
        environmentLabel="aw-rocky8-sip"
        showEnvironment
        environmentAvailable={false}
        targetLabel="Codex SSH · Codex"
        targetAvailable={false}
        position={{ top: 10, left: 20 }}
      />,
    );

    expect(screen.getByTestId("thread-peek")).toHaveTextContent(
      "agent-workspaces · Unavailable",
    );
    expect(screen.getByTestId("thread-peek")).toHaveTextContent(
      "aw-rocky8-sip · Unavailable",
    );
    expect(screen.getByTestId("thread-peek")).toHaveTextContent(
      "Codex SSH · Codex · Unavailable",
    );
  });

  it("omits the singleton environment row", () => {
    render(
      <ThreadPeekCard
        thread={thread()}
        workspaceLabel="sedes"
        environmentLabel="Local"
        showEnvironment={false}
        targetLabel="Codex UDS"
        position={{ top: 10, left: 20 }}
      />,
    );
    expect(document.querySelector('[data-row="environment"]')).toBeNull();
    expect(document.querySelector('[data-row="target"]')).not.toBeNull();
  });
});

describe("ThreadPeekCard background state", () => {
  it("shares the row's completion, agent, command and idle priority", () => {
    const base = thread();
    const active = { ...base, backgroundWork: { agents: 1, commands: 0, other: 0 } };
    const view = render(<ThreadPeekCard thread={active} workspaceLabel="Sedes" position={{ top: 10, left: 20 }} />);
    const stateRow = () => view.container.querySelector('[data-row="state"]')!;
    expect(stateRow()).toHaveTextContent("Waiting for subagent");
    expect(stateRow().querySelector('[data-glyph="background-agents"] .comet-spinner')).not.toBeNull();

    view.rerender(<ThreadPeekCard thread={{ ...active, attention: { ...base.attention, unseenCompletion: true } }} workspaceLabel="Sedes" position={{ top: 10, left: 20 }} />);
    expect(stateRow()).toHaveTextContent("Finished while you were away · 1 subagent still running");
    expect(stateRow().querySelector('[data-glyph="unseen"] .flat-row-unseen-dot')).not.toBeNull();
    expect(view.container.querySelector('[data-row="unseen"]')).toBeNull();

    view.rerender(<ThreadPeekCard thread={{ ...base, backgroundWork: { agents: 0, commands: 2, other: 0 } }} workspaceLabel="Sedes" position={{ top: 10, left: 20 }} />);
    expect(stateRow()).toHaveTextContent("Background work · 2 commands");
    expect(stateRow().querySelector('[data-glyph="background-commands"] .flat-row-background-dot')).not.toBeNull();

    view.rerender(<ThreadPeekCard thread={active} backgroundWorkCurrent={false} workspaceLabel="Sedes" position={{ top: 10, left: 20 }} />);
    expect(stateRow()).toHaveTextContent("Idle");
    expect(stateRow().querySelector(".comet-spinner")).toBeNull();
  });
});
