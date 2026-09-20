// @vitest-environment jsdom

import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ThreadArchiveImpact } from "../../../shared/index.js";
import { SettleImpactDialog } from "./SettleImpactDialog.js";

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
      root: { items: [], total: openTasks, omitted: openTasks },
      descendants: { items: [], total: 0, omitted: 0 },
    },
    archiveOnly: { available: true },
    archiveAll: { available: true },
  };
}

describe("SettleImpactDialog", () => {
  it("warns about stash-only impact without offering a recovery choice", async () => {
    const onSettle = vi.fn().mockResolvedValue(undefined);
    const onOpenChange = vi.fn();
    render(
      <SettleImpactDialog
        open
        onOpenChange={onOpenChange}
        impact={impact({ stashes: 2 })}
        loadImpact={vi.fn()}
        onSettle={onSettle}
      />,
    );

    expect(screen.getByText("2 stashed prompts")).toBeVisible();
    expect(screen.getByText(/remain attached to the settled thread/)).toBeVisible();
    expect(
      screen.queryByRole("radiogroup", { name: "Open task handling" }),
    ).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Settle" }));

    expect(onSettle).toHaveBeenCalledWith({ expectedStashedPromptCount: 2 });
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
  });

  it("cancels a stash warning without settling", async () => {
    const onSettle = vi.fn();
    const onOpenChange = vi.fn();
    render(
      <SettleImpactDialog
        open
        onOpenChange={onOpenChange}
        impact={impact({ stashes: 1 })}
        loadImpact={vi.fn()}
        onSettle={onSettle}
      />,
    );

    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));

    expect(onSettle).not.toHaveBeenCalled();
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("combines the confirmed stash count with the selected task disposition", async () => {
    const onSettle = vi.fn().mockResolvedValue(undefined);
    render(
      <SettleImpactDialog
        open
        onOpenChange={vi.fn()}
        impact={impact({ stashes: 1, openTasks: 2 })}
        loadImpact={vi.fn()}
        onSettle={onSettle}
      />,
    );

    await userEvent.click(screen.getByRole("radio", { name: "Keep" }));
    await userEvent.click(screen.getByRole("button", { name: "Settle" }));

    expect(onSettle).toHaveBeenCalledWith({
      expectedStashedPromptCount: 1,
      openTaskDisposition: "keep",
    });
  });

  it("refreshes stale stash impact and requires a second confirmation", async () => {
    const onSettle = vi
      .fn()
      .mockRejectedValueOnce(new Error("Stashed prompts changed."))
      .mockResolvedValueOnce(undefined);
    const loadImpact = vi.fn().mockResolvedValue(impact({ stashes: 3 }));
    render(
      <SettleImpactDialog
        open
        onOpenChange={vi.fn()}
        impact={impact({ stashes: 1 })}
        loadImpact={loadImpact}
        onSettle={onSettle}
      />,
    );

    await userEvent.click(screen.getByRole("button", { name: "Settle" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Stashed prompts changed.",
    );
    expect(await screen.findByText("3 stashed prompts")).toBeVisible();
    expect(onSettle).toHaveBeenCalledTimes(1);

    await userEvent.click(screen.getByRole("button", { name: "Settle" }));
    expect(onSettle).toHaveBeenLastCalledWith({
      expectedStashedPromptCount: 3,
    });
  });
});
