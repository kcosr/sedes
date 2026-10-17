// @vitest-environment jsdom

import {
  cleanup,
  render,
  screen,
  waitFor,
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
      "Review stashed prompts before parking this thread.",
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

  it("keeps open tasks attached when confirming a stash warning", async () => {
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

    expect(
      screen.queryByRole("radiogroup", { name: "Open task handling" }),
    ).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Park" }));

    expect(onPark).toHaveBeenCalledWith({
      expectedStashedPromptCount: 1,
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
});
