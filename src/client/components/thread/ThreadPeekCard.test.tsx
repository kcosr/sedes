// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
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
        projectLabel="agent-workspaces"
        locationPath="/srv/agent-workspaces"
        locationAvailable={false}
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
        projectLabel="sedes"
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
    const view = render(<ThreadPeekCard thread={active} projectLabel="Sedes" position={{ top: 10, left: 20 }} />);
    const stateRow = () => view.container.querySelector('[data-row="state"]')!;
    expect(stateRow()).toHaveTextContent("Waiting for subagent");
    expect(stateRow().querySelector('[data-glyph="background-agents"] .comet-spinner')).not.toBeNull();

    view.rerender(<ThreadPeekCard thread={{ ...active, attention: { ...base.attention, unseenCompletion: true } }} projectLabel="Sedes" position={{ top: 10, left: 20 }} />);
    expect(stateRow()).toHaveTextContent("Finished while you were away · 1 subagent still running");
    expect(stateRow().querySelector('[data-glyph="unseen"] .flat-row-unseen-dot')).not.toBeNull();
    expect(view.container.querySelector('[data-row="unseen"]')).toBeNull();

    view.rerender(<ThreadPeekCard thread={{ ...base, backgroundWork: { agents: 0, commands: 2, other: 0 } }} projectLabel="Sedes" position={{ top: 10, left: 20 }} />);
    expect(stateRow()).toHaveTextContent("Background work · 2 commands");
    expect(stateRow().querySelector('[data-glyph="background-commands"] .flat-row-background-dot')).not.toBeNull();

    view.rerender(<ThreadPeekCard thread={active} backgroundWorkCurrent={false} projectLabel="Sedes" position={{ top: 10, left: 20 }} />);
    expect(stateRow()).toHaveTextContent("Idle");
    expect(stateRow().querySelector(".comet-spinner")).toBeNull();
  });
});


describe("ThreadPeekCard detail beneath attention and background glyphs", () => {
  it.each([
    {
      name: "snoozed completion",
      overrides: { inventoryState: "snoozed" as const, snoozedUntil: "2026-09-27T12:45:00.000Z" },
      unseen: true,
      glyph: "unseen",
      label: "Finished while you were away · Snoozed · wakes in 45m",
    },
    {
      name: "completion with queued input",
      overrides: { queuedInputCount: 2 },
      unseen: true,
      glyph: "unseen",
      label: "Finished while you were away · 2 queued",
    },
    {
      name: "subagent with queued input",
      overrides: { backgroundWork: { agents: 1, commands: 0, other: 0 }, queuedInputCount: 2 },
      unseen: false,
      glyph: "background-agents",
      label: "Waiting for subagent · 2 queued",
    },
    {
      name: "command with queued input",
      overrides: { backgroundWork: { agents: 0, commands: 1, other: 0 }, queuedInputCount: 1 },
      unseen: false,
      glyph: "background-commands",
      label: "Background command running · 1 queued",
    },
    {
      name: "settled completion",
      overrides: { inventoryState: "settled" as const, stateChangedAt: "2026-09-27T11:55:00.000Z" },
      unseen: true,
      glyph: "unseen",
      label: "Finished while you were away · Settled 5m ago",
    },
    {
      name: "disconnected completion",
      overrides: { runState: "disconnected" as const, backgroundWork: { agents: 1, commands: 0, other: 0 } },
      unseen: true,
      glyph: "unseen",
      label: "Finished while you were away · Disconnected",
    },
    {
      name: "draft completion",
      overrides: { backingState: "unbound" as const },
      unseen: true,
      glyph: "unseen",
      label: "Finished while you were away · Draft",
    },
    {
      name: "plain idle completion",
      overrides: {},
      unseen: true,
      glyph: "unseen",
      label: "Finished while you were away",
    },
  ])("retains $name facts without adding a competing glyph", ({ overrides, unseen, glyph, label }) => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-27T12:00:00.000Z"));
    try {
      const base = thread();
      const view = render(
        <ThreadPeekCard
          thread={{ ...base, ...overrides, attention: { ...base.attention, unseenCompletion: unseen } }}
          projectLabel="Sedes"
          position={{ top: 10, left: 20 }}
        />,
      );
      const stateRow = view.container.querySelector('[data-row="state"]')!;
      expect(stateRow).toHaveTextContent(label);
      expect(stateRow.querySelector(".thread-peek-row-text")).toHaveAttribute("title", label);
      expect(stateRow.querySelectorAll("[data-glyph]")).toHaveLength(1);
      expect(stateRow.querySelector("[data-glyph]")).toHaveAttribute("data-glyph", glyph);
    } finally {
      vi.useRealTimers();
    }
  });
});
