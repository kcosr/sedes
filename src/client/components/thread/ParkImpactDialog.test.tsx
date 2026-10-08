// @vitest-environment jsdom

import {
  cleanup,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ThreadArchiveImpact } from "../../../shared/index.js";
import { ParkImpactDialog } from "./ParkImpactDialog.js";

afterEach(cleanup);

function impact({
  stashes = 0,
  openTasks = 0,
}: {
  readonly stashes?: number;
  readonly openTasks?: number;
} = {}): ThreadArchiveImpact {
  return {
    descendantCount: 0,
    executionWorkspace: { kind: "direct" },
    pendingQuestions: { root: 0, descendants: 0 },
    stashedPrompts: { root: stashes, descendants: 0 },
    openTasks: {
      familySnapshot: "b".repeat(64),
      root: {
        snapshot: "a".repeat(64),
        items: [],
        total: openTasks,
        omitted: openTasks,
      },
      descendants: {
        snapshot: "a".repeat(64),
        items: [],
        total: 0,
        omitted: 0,
      },
    },
    archiveOnly: { available: true },
    archiveAll: { available: true },
  };
}

describe("ParkImpactDialog", () => {
  it("warns about stash-only impact without offering a recovery choice", async () => {
    const onPark = vi.fn().mockResolvedValue(undefined);
    const onOpenChange = vi.fn();
    render(
      <ParkImpactDialog
        open
        onOpenChange={onOpenChange}
        impact={impact({ stashes: 2 })}
        loadImpact={vi.fn()}
        onPark={onPark}
      />,
    );

    expect(
      screen.getByRole("dialog", { name: "Park this thread" }),
    ).toHaveAccessibleDescription(
      "Review unfinished work before parking this thread.",
    );
    expect(screen.getByText("2 stashed prompts")).toBeVisible();
    expect(
      screen.getByText(/remain attached to the parked thread/),
    ).toBeVisible();
    expect(
      screen.queryByRole("radiogroup", { name: "Open task handling" }),
    ).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Park" }));

    expect(onPark).toHaveBeenCalledWith({ expectedStashedPromptCount: 2 });
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
  });

  it("cancels a stash warning without parking", async () => {
    const onPark = vi.fn();
    const onOpenChange = vi.fn();
    render(
      <ParkImpactDialog
        open
        onOpenChange={onOpenChange}
        impact={impact({ stashes: 1 })}
        loadImpact={vi.fn()}
        onPark={onPark}
      />,
    );

    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));

    expect(onPark).not.toHaveBeenCalled();
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("combines the confirmed stash count with the selected task disposition", async () => {
    const onPark = vi.fn().mockResolvedValue(undefined);
    render(
      <ParkImpactDialog
        open
        onOpenChange={vi.fn()}
        impact={impact({ stashes: 1, openTasks: 2 })}
        loadImpact={vi.fn()}
        onPark={onPark}
      />,
    );

    await userEvent.click(screen.getByRole("radio", { name: "Keep" }));
    await userEvent.click(screen.getByRole("button", { name: "Park" }));

    expect(onPark).toHaveBeenCalledWith({
      expectedStashedPromptCount: 1,
      openTaskDisposition: "keep",
    });
  });

  it("refreshes stale stash impact and requires a second confirmation", async () => {
    const onPark = vi
      .fn()
      .mockRejectedValueOnce(new Error("Stashed prompts changed."))
      .mockResolvedValueOnce(undefined);
    const loadImpact = vi.fn().mockResolvedValue(impact({ stashes: 3 }));
    render(
      <ParkImpactDialog
        open
        onOpenChange={vi.fn()}
        impact={impact({ stashes: 1 })}
        loadImpact={loadImpact}
        onPark={onPark}
      />,
    );

    await userEvent.click(screen.getByRole("button", { name: "Park" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Stashed prompts changed.",
    );
    expect(await screen.findByText("3 stashed prompts")).toBeVisible();
    expect(onPark).toHaveBeenCalledTimes(1);

    await userEvent.click(screen.getByRole("button", { name: "Park" }));
    expect(onPark).toHaveBeenLastCalledWith({
      expectedStashedPromptCount: 3,
    });
  });
  it("lists only this thread's tasks and confirms completion against the refreshed snapshot", async () => {
    const initial = impact({ openTasks: 2 });
    initial.openTasks.root.items.push({
      id: "task-1",
      title: "First task",
      threadId: "thread-1",
    });
    initial.openTasks.root.omitted = 1;
    initial.openTasks.descendants = {
      snapshot: "c".repeat(64),
      items: [
        { id: "task-child", title: "Child task", threadId: "thread-child" },
      ],
      total: 1,
      omitted: 0,
    };
    const refreshed = impact({ openTasks: 2 });
    refreshed.openTasks.root = {
      snapshot: "d".repeat(64),
      items: [
        { id: "task-2", title: "Replacement task", threadId: "thread-1" },
      ],
      total: 2,
      omitted: 1,
    };
    const onPark = vi
      .fn()
      .mockRejectedValueOnce(
        new Error("Open tasks changed. Review the updated list."),
      )
      .mockResolvedValueOnce(undefined);
    const loadImpact = vi.fn().mockResolvedValue(refreshed);
    render(
      <ParkImpactDialog
        open
        onOpenChange={vi.fn()}
        impact={initial}
        loadImpact={loadImpact}
        onPark={onPark}
      />,
    );

    const tasks = screen.getByRole("region", {
      name: "2 open tasks affected by this park",
    });
    expect(within(tasks).getByText("First task")).toBeVisible();
    expect(within(tasks).getByText("1 more task not shown")).toBeVisible();
    expect(screen.queryByText("Child task")).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("radio", { name: "Complete all" }));
    expect(screen.getByRole("note")).toHaveTextContent(
      "including those not shown",
    );
    await userEvent.click(screen.getByRole("button", { name: "Park" }));
    expect(onPark).toHaveBeenLastCalledWith({
      expectedStashedPromptCount: 0,
      openTaskDisposition: "complete",
      expectedOpenTaskSnapshot: "a".repeat(64),
    });
    expect(await screen.findByText("Replacement task")).toBeVisible();
    expect(screen.queryByText("First task")).not.toBeInTheDocument();
    expect(onPark).toHaveBeenCalledTimes(1);
    await userEvent.click(screen.getByRole("button", { name: "Park" }));
    expect(onPark).toHaveBeenLastCalledWith({
      expectedStashedPromptCount: 0,
      openTaskDisposition: "complete",
      expectedOpenTaskSnapshot: "d".repeat(64),
    });
  });
});
