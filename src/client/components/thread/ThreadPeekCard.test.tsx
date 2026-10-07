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
    nonArchivedWorkpadCount: 0,
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

describe("ThreadPeekCard automation line", () => {
  type Automation = NonNullable<NormalizedApplicationThreadSummary["automation"]>;
  type LastRun = NonNullable<Automation["lastRun"]>;
  const NOW = new Date("2026-10-06T03:40:00.000Z");

  function automated(
    automation: Partial<Automation>,
    overrides: Partial<NormalizedApplicationThreadSummary> = {},
  ): NormalizedApplicationThreadSummary {
    return {
      ...thread(),
      automation: {
        status: "enabled",
        runMode: "same_thread",
        scheduleKind: "cron",
        schedule: { kind: "cron", expression: "0 2 * * *", timeZone: "UTC" },
        misfirePolicy: "coalesce",
        promptPreview: "Check dependencies",
        revision: 1,
        runsRevision: 0,
        hasPrecheck: false,
        ...automation,
      },
      ...overrides,
    };
  }

  function run(state: LastRun["state"], overrides: Partial<LastRun> = {}): LastRun {
    return {
      id: "run-1",
      state,
      occurrence: "scheduled",
      scheduledFor: "2026-10-05T06:30:00.000Z",
      ...overrides,
    };
  }

  function renderPeek(subject: NormalizedApplicationThreadSummary) {
    vi.useFakeTimers({ now: NOW });
    try {
      return render(
        <ThreadPeekCard thread={subject} projectLabel="acme-web" position={{ top: 10, left: 20 }} />,
      ).container;
    } finally {
      vi.useRealTimers();
    }
  }

  const automationRow = (container: HTMLElement) =>
    container.querySelector<HTMLElement>('[data-row="automation"]')!;

  it.each([
    {
      name: "active",
      automation: { nextRunAt: "2026-10-07T02:00:00.000Z", lastRun: run("completed") },
      text: /^Automation · next Tmrw \d/u,
      glyph: "repeat",
      tone: "success",
    },
    {
      name: "failed",
      automation: { lastRun: run("failed", { finishedAt: "2026-10-05T06:40:00.000Z" }) },
      text: /^Automation · Failed 21h ago$/u,
      glyph: "triangle",
      tone: "danger",
    },
    {
      name: "uncertain",
      automation: { status: "paused" as const, lastRun: run("uncertain") },
      text: /^Automation · Outcome unknown$/u,
      glyph: "triangle",
      tone: "warning",
    },
    {
      name: "sending",
      automation: { lastRun: run("dispatching") },
      text: /^Automation · Sending$/u,
      glyph: "spinner",
      tone: "info",
    },
    {
      name: "paused",
      automation: { status: "paused" as const, lastRun: run("completed") },
      text: /^Automation · Paused$/u,
      glyph: "pause",
      tone: "neutral",
    },
    {
      name: "not started",
      automation: { status: "paused" as const },
      text: /^Automation · Not started$/u,
      glyph: "pause",
      tone: "neutral",
    },
  ])("says $name in one line with its health glyph and tone", ({ automation, text, glyph, tone }) => {
    const container = renderPeek(automated(automation));
    const row = automationRow(container);
    expect(row).toHaveTextContent(text);
    expect(row).toHaveAttribute("data-tone", tone);
    expect(row.querySelector(`[data-automation-glyph="${glyph}"]`)).not.toBeNull();
    expect(container.querySelectorAll('[data-row^="automation"]')).toHaveLength(1);
    // The automation line replaces the plain "Idle" row and its second Repeat.
    expect(container.querySelector('[data-row="state"]')).toBeNull();
    expect(container.querySelectorAll(".lucide-repeat").length).toBeLessThanOrEqual(1);
  });

  it("keeps the state row when it says more than Idle, without the automation glyph", () => {
    const container = renderPeek(
      automated({ status: "paused", lastRun: run("completed") }, { inventoryState: "settled", stateChangedAt: "2026-10-06T00:40:00.000Z" }),
    );
    const stateRow = container.querySelector('[data-row="state"]')!;
    expect(stateRow).toHaveTextContent("Settled 3h ago");
    expect(stateRow.querySelector("[data-glyph]")).toHaveAttribute("data-glyph", "settled");
    expect(stateRow.querySelector(".automation-glyph")).toBeNull();

    const queued = renderPeek(automated({}, { queuedInputCount: 2 }));
    expect(queued.querySelectorAll('[data-row="state"]')[0]).toHaveTextContent("Idle · 2 queued");
  });

  it("shows a running thread's state beside its automation", () => {
    const container = renderPeek(automated({ lastRun: run("queued") }, { runState: "running" }));
    expect(container.querySelector('[data-row="state"]')).toHaveTextContent("Running");
    expect(automationRow(container)).toHaveTextContent("Automation · Waiting for turn");
  });

  it("names a suspended automation", () => {
    const archived = renderPeek(automated({ lastRun: run("completed") }, { inventoryState: "archived" }));
    expect(automationRow(archived)).toHaveTextContent("Automation · Thread archived");
    expect(automationRow(archived).querySelector('[data-automation-glyph="archive"]')).not.toBeNull();
    const snoozed = renderPeek(
      automated({}, { inventoryState: "snoozed", snoozedUntil: "2026-10-06T09:00:00.000Z" }),
    );
    expect(automationRow(snoozed)).toHaveTextContent("Automation · Snoozed");
  });

  it("keeps the failed-run line for a thread whose automation context failed without an automation", () => {
    const base = thread();
    const container = renderPeek({
      ...base,
      attention: { ...base.attention, automationContext: "failed" },
    });
    const row = container.querySelector('[data-row="automation-failed"]')!;
    expect(row).toHaveTextContent("Last run failed");
    expect(row).toHaveAttribute("data-tone", "danger");
    expect(automationRow(container)).toBeNull();
  });

  it("keeps a retained scheduled failure after a later run succeeds", () => {
    const base = automated({
      nextRunAt: "2026-10-07T02:00:00.000Z",
      lastRun: run("completed", { occurrence: "manual" }),
    });
    const container = renderPeek({
      ...base,
      attention: { ...base.attention, automationContext: "failed" },
    });
    expect(automationRow(container)).toHaveTextContent(/^Automation · next Tmrw/u);
    const row = container.querySelector('[data-row="automation-failed"]')!;
    expect(row).toHaveTextContent("A scheduled run failed");
    expect(row).toHaveAttribute("data-tone", "danger");
  });

  it("does not repeat a failure the automation line already shows", () => {
    const base = automated({ lastRun: run("failed") });
    const container = renderPeek({
      ...base,
      attention: { ...base.attention, automationContext: "failed" },
    });
    expect(automationRow(container)).toHaveTextContent("Automation · Failed");
    expect(container.querySelector('[data-row="automation-failed"]')).toBeNull();
  });
});
