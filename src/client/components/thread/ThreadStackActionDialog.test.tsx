// @vitest-environment jsdom

import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { BulkInventoryImpact } from "../../../shared/index.js";
import { ThreadStackActionDialog } from "./ThreadStackActionDialog.js";

afterEach(cleanup);

function makeImpact(): BulkInventoryImpact {
  return {
    action: "settle",
    targets: [{ threadId: "thread-1", expectedRevision: 1 }],
    targetCount: 1,
    affectedCount: 1,
    unchangedCount: 0,
    pendingQuestionCount: 0,
    stashedPromptCount: 0,
    available: true,
    blockers: { items: [], total: 0, omitted: 0 },
    openTasks: {
      snapshot: "a".repeat(64),
      items: [
        { id: "task-1", title: "Check the release", threadId: "thread-1" },
      ],
      total: 2,
      omitted: 1,
    },
  };
}

function props() {
  return {
    open: true,
    onOpenChange: vi.fn(),
    label: "Release",
    action: "settle" as const,
    impact: makeImpact(),
    loading: false,
    pending: false,
    requestLocked: false,
    error: "",
    onReload: vi.fn(),
    onConfirm: vi.fn(),
    threadTitleFor: (id: string) =>
      id === "thread-1" ? "Release thread" : undefined,
  };
}

describe("ThreadStackActionDialog", () => {
  it.each([
    { action: "settle", word: "park", label: "Park" },
    { action: "archive", word: "archive", label: "Archive" },
  ] as const)(
    "lists affected tasks and offers completion for $label",
    async ({ action, word, label }) => {
      const initial = props();
      render(
        <ThreadStackActionDialog
          {...initial}
          action={action}
          impact={{ ...initial.impact, action }}
        />,
      );
      expect(
        screen.getByRole("dialog", { name: `${label} threads in Release` }),
      ).toHaveAccessibleDescription(`${label} 1 thread.`);
      const tasks = screen.getByRole("region", {
        name: `2 open tasks affected by this ${word}`,
      });
      expect(within(tasks).getByText("Check the release")).toBeVisible();
      expect(within(tasks).getByText("Release thread")).toHaveAttribute(
        "title",
        "Owned by thread thread-1",
      );
      expect(within(tasks).getByText("1 more task not shown")).toBeVisible();
      expect(screen.getByRole("radio", { name: "To project" })).toBeChecked();
      await userEvent.click(
        screen.getByRole("radio", { name: "Complete all" }),
      );
      expect(screen.getByRole("note")).toHaveTextContent(
        `All open tasks on the threads you ${word}, including those not shown, will be marked completed`,
      );
      await userEvent.click(screen.getByRole("button", { name: label }));
      expect(initial.onConfirm).toHaveBeenCalledWith({
        openTaskDisposition: "complete",
      });
    },
  );

  it("keeps completion locked for an exact retry and shows refreshed tasks after reload", async () => {
    const initial = props();
    const { rerender } = render(<ThreadStackActionDialog {...initial} />);
    await userEvent.click(screen.getByRole("radio", { name: "Complete all" }));
    await userEvent.click(screen.getByRole("button", { name: "Park" }));
    rerender(
      <ThreadStackActionDialog
        {...initial}
        requestLocked
        error="Open tasks changed."
      />,
    );
    expect(screen.getByRole("radio", { name: "Complete all" })).toBeDisabled();
    expect(screen.getByRole("radio", { name: "Complete all" })).toBeChecked();
    await userEvent.click(
      screen.getByRole("button", { name: "Refresh impact" }),
    );
    expect(initial.onReload).toHaveBeenCalledOnce();
    const refreshed = makeImpact();
    refreshed.openTasks.items = [
      { id: "task-2", title: "Review deployment", threadId: "thread-2" },
    ];
    refreshed.openTasks.snapshot = "b".repeat(64);
    rerender(<ThreadStackActionDialog {...initial} impact={refreshed} />);
    expect(screen.queryByText("Check the release")).not.toBeInTheDocument();
    expect(screen.getByText("Review deployment")).toBeVisible();
    expect(screen.getByText("Thread thread-2")).toBeVisible();
    expect(screen.getByRole("radio", { name: "Complete all" })).toBeEnabled();
    expect(initial.onConfirm).toHaveBeenCalledTimes(1);
  });

  it.each([
    { action: "settle", progress: "Parking…" },
    { action: "unsettle", progress: "Unparking…" },
    { action: "archive", progress: "Archiving…" },
  ] as const)("names the pending action: $progress", ({ action, progress }) => {
    const initial = props();
    render(
      <ThreadStackActionDialog
        {...initial}
        action={action}
        impact={{ ...initial.impact, action }}
        pending
      />,
    );
    expect(screen.getByRole("button", { name: progress })).toBeDisabled();
  });

  it("does not offer task changes for Unpark", () => {
    const initial = props();
    render(
      <ThreadStackActionDialog
        {...initial}
        action="unsettle"
        impact={{ ...initial.impact, action: "unsettle" }}
      />,
    );
    expect(
      screen.getByRole("dialog", { name: "Unpark threads in Release" }),
    ).toBeVisible();
    expect(screen.getByRole("button", { name: "Unpark" })).toBeEnabled();
    expect(
      screen.queryByRole("radiogroup", { name: "Open task handling" }),
    ).not.toBeInTheDocument();
    expect(screen.queryByText("Check the release")).not.toBeInTheDocument();
  });
});
