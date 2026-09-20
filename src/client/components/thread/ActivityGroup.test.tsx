// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ConversationItem } from "../../../shared/index.js";
import { getActivityDetail, setActivityDetail } from "../../app/settings.js";
import { ActivityGroup } from "./ActivityGroup.js";
import { clearPendingActivityDetailExpansion } from "./activity-detail-intent.js";
import {
  activitySummaryLabel,
  groupConversationItems,
  summarizeActivityItems,
  type ActivityItem,
  type ActivitySummaryItem,
} from "./activity-groups.js";

beforeEach(() => {
  localStorage.clear();
  clearPendingActivityDetailExpansion();
  vi.stubGlobal(
    "matchMedia",
    vi.fn(() => ({
      matches: false,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })),
  );
});

afterEach(() => {
  cleanup();
  localStorage.clear();
  clearPendingActivityDetailExpansion();
  vi.unstubAllGlobals();
});

const reasoning = (
  id: string,
  overrides: Partial<Extract<ConversationItem, { kind: "reasoning" }>> = {},
): Extract<ConversationItem, { kind: "reasoning" }> => ({
  id,
  turnId: "turn-1",
  kind: "reasoning",
  revision: 1,
  status: "completed",
  markdown: { text: `Reasoning detail ${id}` },
  ...overrides,
});

const command = (
  id: string,
  overrides: Partial<Extract<ConversationItem, { kind: "command" }>> = {},
): Extract<ConversationItem, { kind: "command" }> => ({
  id,
  turnId: "turn-1",
  kind: "command",
  revision: 1,
  status: "completed",
  phase: "completed",
  command: { text: `command-${id}` },
  output: { text: `Command detail ${id}` },
  ...overrides,
});

const assistant = (id: string): ConversationItem => ({
  id,
  turnId: "turn-1",
  kind: "assistant_message",
  revision: 1,
  status: "completed",
  markdown: { text: `Assistant ${id}` },
});

const summary = (
  id: string,
  activityKind: ActivitySummaryItem["activityKind"],
  overrides: Partial<ActivitySummaryItem> = {},
): ActivitySummaryItem => ({
  id,
  turnId: "turn-1",
  kind: "activity_summary",
  activityKind,
  revision: 1,
  status: "completed",
  ...overrides,
});

describe("activity grouping", () => {
  it("forms maximal runs, including singleton runs, around ordinary items", () => {
    const groups = groupConversationItems([
      reasoning("reason-1"),
      command("command-1"),
      assistant("answer-1"),
      summary("summary-1", "web_search"),
    ]);

    expect(
      groups.map((group) =>
        group.kind === "activity"
          ? group.items.map(({ id }) => id)
          : group.item.id,
      ),
    ).toEqual([["reason-1", "command-1"], "answer-1", ["summary-1"]]);
  });

  it("counts reasoning separately, spans timestamp bounds, and marks active runs", () => {
    const settled = summarizeActivityItems([
      reasoning("reason-1", {
        startedAt: "2026-08-14T12:00:00.000Z",
        completedAt: "2026-08-14T12:00:10.000Z",
      }),
      command("command-1", {
        startedAt: "2026-08-14T12:00:12.000Z",
        completedAt: "2026-08-14T12:01:42.000Z",
      }),
      summary("summary-1", "file_read"),
    ]);
    expect(settled).toEqual({
      reasoningSteps: 1,
      toolCalls: 2,
      working: false,
      durationMilliseconds: 102_000,
    });
    expect(activitySummaryLabel(settled)).toBe(
      "Activity · 1 reasoning step · 2 tool calls · 1m 42s",
    );

    const active = summarizeActivityItems([
      summary("summary-2", "reasoning", { status: "streaming" }),
    ]);
    expect(activitySummaryLabel(active)).toBe(
      "Activity · 1 reasoning step · Working…",
    );
  });

  it("surfaces terminal failure and interruption without diagnostic text", () => {
    expect(
      activitySummaryLabel(
        summarizeActivityItems([
          command("failed-command", {
            status: "failed",
            phase: "failed",
            startedAt: "2026-08-14T12:00:00.000Z",
            completedAt: "2026-08-14T12:00:07.000Z",
          }),
        ]),
      ),
    ).toBe("Activity · 1 tool call · Failed · 7s");
    expect(
      activitySummaryLabel(
        summarizeActivityItems([
          summary("interrupted-summary", "tool", { status: "interrupted" }),
        ]),
      ),
    ).toBe("Activity · 1 tool call · Interrupted");
  });
});

describe("ActivityGroup", () => {
  it("renders detailed runs as one collapsed borderless control", () => {
    render(
      <ActivityGroup
        items={[reasoning("reason-1"), command("cmd-1")]}
        threadId="thread-1"
      />,
    );

    const toggle = screen.getByRole("button", {
      name: "Activity · 1 reasoning step · 1 tool call",
    });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByTestId("activity-group-details")).toBeNull();
    expect(screen.queryByText("Reasoning detail reason-1")).toBeNull();
    expect(screen.queryByText("Command detail cmd-1")).toBeNull();

    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByTestId("activity-group-details")).toBeVisible();
    expect(
      screen.getByRole("button", { name: "Disable details" }),
    ).toBeVisible();
    expect(
      document.querySelector('[data-item-kind="reasoning"]'),
    ).not.toBeNull();
    expect(document.querySelector('[data-item-kind="command"]')).not.toBeNull();
  });

  it("preserves an expanded detailed run while live members append", () => {
    const { rerender } = render(
      <ActivityGroup items={[reasoning("reason-1")]} threadId="thread-1" />,
    );
    fireEvent.click(
      screen.getByRole("button", {
        name: "Activity · 1 reasoning step",
      }),
    );

    rerender(
      <ActivityGroup
        items={[reasoning("reason-1"), command("cmd-1")]}
        threadId="thread-1"
      />,
    );

    expect(
      screen.getByRole("button", {
        name: "Activity · 1 reasoning step · 1 tool call",
      }),
    ).toHaveAttribute("aria-expanded", "true");
    expect(document.querySelector('[data-item-kind="command"]')).not.toBeNull();
  });

  it("discloses only the mode action for summaries", () => {
    const descriptor = {
      ...summary("summary-1", "tool", {
        startedAt: "2026-08-14T12:00:00.000Z",
        completedAt: "2026-08-14T12:00:42.000Z",
      }),
      // Invalid input is intentionally used to prove the presentation never
      // reaches into an error-like field even if untrusted runtime data did.
      error: { message: { text: "SECRET_ERROR_TEXT" } },
    } as ActivitySummaryItem;
    render(<ActivityGroup items={[descriptor]} threadId="thread-1" />);

    const toggle = screen.getByRole("button", {
      name: "Activity · 1 tool call · 42s",
    });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByTestId("activity-group-details")).toBeNull();
    expect(screen.queryByText(/SECRET_ERROR_TEXT/)).toBeNull();

    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    expect(
      screen.getByRole("button", { name: "Enable details" }),
    ).toBeVisible();
    expect(screen.queryByTestId("activity-group-details")).toBeNull();
    expect(screen.queryByText(/SECRET_ERROR_TEXT/)).toBeNull();
  });

  it("enables details, reopens the requested group, and disables them inline", () => {
    setActivityDetail("summary");
    const view = render(
      <ActivityGroup
        items={[summary("activity-1", "reasoning")]}
        threadId="thread-1"
      />,
    );
    fireEvent.click(
      screen.getByRole("button", {
        name: "Activity · 1 reasoning step",
      }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Enable details" }));
    expect(getActivityDetail()).toBe("full");

    view.unmount();
    render(
      <ActivityGroup items={[reasoning("activity-1")]} threadId="thread-1" />,
    );
    expect(
      screen.getByRole("button", {
        name: "Activity · 1 reasoning step",
      }),
    ).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByTestId("activity-group-details")).toBeVisible();

    fireEvent.click(screen.getByRole("button", { name: "Disable details" }));
    expect(getActivityDetail()).toBe("summary");
    expect(screen.queryByTestId("activity-group-details")).toBeNull();
  });

  it("marks failed detailed and interrupted summary runs visibly", () => {
    const { rerender } = render(
      <ActivityGroup
        items={[
          command("failed-command", { status: "failed", phase: "failed" }),
        ]}
        threadId="thread-1"
      />,
    );
    expect(screen.getByTestId("activity-group")).toHaveAttribute(
      "data-activity-status",
      "failed",
    );
    expect(
      screen.getByRole("button", {
        name: "Activity · 1 tool call · Failed",
      }),
    ).toBeVisible();

    rerender(
      <ActivityGroup
        items={[
          summary("interrupted-summary", "tool", { status: "interrupted" }),
        ]}
        threadId="thread-1"
      />,
    );
    expect(screen.getByTestId("activity-group")).toHaveAttribute(
      "data-activity-status",
      "interrupted",
    );
    expect(
      screen.getByRole("button", {
        name: "Activity · 1 tool call · Interrupted",
      }),
    ).toBeVisible();
  });

  it("fails closed for a transient mixed detailed and summary run", () => {
    const items: ActivityItem[] = [
      reasoning("reason-1"),
      summary("summary-1", "command"),
    ];
    render(<ActivityGroup items={items} threadId="thread-1" />);

    expect(screen.queryByRole("button")).toBeNull();
    expect(screen.queryByText("Reasoning detail reason-1")).toBeNull();
  });
});
