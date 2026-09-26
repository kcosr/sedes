// @vitest-environment jsdom

import {
  cleanup,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { useState } from "react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ThreadForceResetImpact } from "../../../shared/index.js";
import { ForceResetDialog } from "./ForceResetDialog.js";

afterEach(cleanup);

const impact: ThreadForceResetImpact = {
  blockerFingerprint: "b".repeat(64),
  resettable: true,
  blockers: [
    { kind: "pending_interaction", count: 1 },
    { kind: "completion_callback", count: 2 },
    { kind: "conversation_operation", count: 2 },
    { kind: "conversation_runtime", count: 1 },
    { kind: "fork_origin", count: 1 },
  ],
  affectedThreads: [
    {
      threadId: "11111111-1111-4111-8111-111111111111",
      title: "Stuck fork",
    },
    {
      threadId: "22222222-2222-4222-8222-222222222222",
      title: "Its unfinished child",
      runtime: {
        runState: "running",
        backgroundActivity: { state: "known", agents: 1, commands: 1, other: 0 },
      },
    },
  ],
  warnings: [
    {
      code: "running_work_will_stop",
      message: "Force reset replaces the loaded runtimes listed below, which stops their running turns and background work.",
    },
    {
      code: "provider_side_effects_may_remain",
      message: "A provider operation may already have taken effect.",
    },
    {
      code: "native_fork_orphan_may_remain",
      message: "A native fork orphan may remain.",
    },
  ],
};

describe("ForceResetDialog", () => {
  it("shows exact blocker counts, affected threads, and provider warnings", async () => {
    render(
      <ForceResetDialog
        open
        onOpenChange={vi.fn()}
        loadImpact={vi.fn().mockResolvedValue(impact)}
        onForceReset={vi.fn()}
      />,
    );

    const dialog = await screen.findByRole("dialog", {
      name: "Force reset Sedes state?",
    });
    expect(
      within(dialog).getByText("1 pending approval or question"),
    ).toBeVisible();
    expect(
      within(dialog).getByText("2 registered agent callbacks"),
    ).toBeVisible();
    expect(within(dialog).getByText("2 conversation operations")).toBeVisible();
    expect(within(dialog).getByText("1 conversation runtime")).toBeVisible();
    expect(within(dialog).getByText("1 fork operation")).toBeVisible();
    expect(within(dialog).getByText("Affected threads (2)")).toBeVisible();
    const threads = within(dialog).getAllByRole("listitem").filter(
      (item) => item.closest("ul")?.classList.contains("force-reset-threads"),
    );
    expect(threads.map((item) => item.textContent)).toEqual([
      "Stuck fork",
      "Its unfinished childRuntime running, 2 background tasks; resetting stops this work.",
    ]);
    expect(dialog).toHaveTextContent("stops their running turns and background work");
    expect(dialog).toHaveTextContent(
      "without waiting for provider reconciliation",
    );
    expect(dialog).toHaveTextContent("provider work may already have happened");
    expect(dialog).toHaveTextContent("A native fork orphan may remain.");
    expect(within(dialog).getByTestId("force-reset-background")).toHaveTextContent(
      "Running in the affected conversations: 1 background agent, 1 background command. Replacing their runtimes may stop this work.",
    );
  });

  it("reports unknown background inventories and omits the note when there is none", async () => {
    const { unmount } = render(
      <ForceResetDialog
        open
        onOpenChange={vi.fn()}
        loadImpact={vi.fn().mockResolvedValue({
          ...impact,
          affectedThreads: [
            impact.affectedThreads[0],
            {
              ...impact.affectedThreads[1],
              runtime: { runState: "idle", backgroundActivity: { state: "unknown", agents: 0, commands: 0, other: 0 } },
            },
          ],
        })}
        onForceReset={vi.fn()}
      />,
    );
    expect(await screen.findByTestId("force-reset-background")).toHaveTextContent(
      "Background work is unknown in one conversation.",
    );
    unmount();
    render(
      <ForceResetDialog
        open
        onOpenChange={vi.fn()}
        loadImpact={vi.fn().mockResolvedValue({
          ...impact,
          affectedThreads: [
            impact.affectedThreads[0],
            { ...impact.affectedThreads[1], runtime: { runState: "idle" } },
          ],
        })}
        onForceReset={vi.fn()}
      />,
    );
    await screen.findByText("Affected threads (2)");
    expect(screen.queryByTestId("force-reset-background")).toBeNull();
  });

  it("keeps load failures in the dialog and retries", async () => {
    const loadImpact = vi
      .fn()
      .mockRejectedValueOnce(new Error("Impact unavailable"))
      .mockResolvedValueOnce(impact);
    render(
      <ForceResetDialog
        open
        onOpenChange={vi.fn()}
        loadImpact={loadImpact}
        onForceReset={vi.fn()}
      />,
    );

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Impact unavailable");
    await userEvent.click(within(alert).getByRole("button", { name: "Retry" }));
    expect(await screen.findByText("2 conversation operations")).toBeVisible();
    expect(loadImpact).toHaveBeenCalledTimes(2);
  });

  it("submits once while pending", async () => {
    let resolveReset: (() => void) | undefined;
    const onForceReset = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveReset = resolve;
        }),
    );
    const loadImpact = vi.fn().mockResolvedValue(impact);
    render(
      <ForceResetDialog
        open
        onOpenChange={vi.fn()}
        loadImpact={loadImpact}
        onForceReset={onForceReset}
      />,
    );

    const reset = await screen.findByRole("button", { name: "Force reset" });
    await userEvent.click(reset);
    expect(onForceReset).toHaveBeenCalledTimes(1);
    expect(
      screen.getByRole("button", { name: "Force resetting…" }),
    ).toBeDisabled();
    resolveReset?.();
  });

  it("reuses a preview mutation id for reset retries and replaces it after refresh", async () => {
    const onForceReset = vi
      .fn()
      .mockRejectedValue(new Error("Outcome unknown"));
    const loadImpact = vi.fn().mockResolvedValue(impact);
    render(
      <ForceResetDialog
        open
        onOpenChange={vi.fn()}
        loadImpact={loadImpact}
        onForceReset={onForceReset}
      />,
    );

    await screen.findByText("2 conversation operations");
    await userEvent.click(screen.getByRole("button", { name: "Force reset" }));
    const alert = await screen.findByRole("alert");
    await userEvent.click(
      within(alert).getByRole("button", { name: "Retry reset" }),
    );
    await waitFor(() => expect(onForceReset).toHaveBeenCalledTimes(2));
    const firstMutationId = onForceReset.mock.calls[0]![1];
    expect(onForceReset.mock.calls[1]![1]).toBe(firstMutationId);

    await userEvent.click(
      within(await screen.findByRole("alert")).getByRole("button", {
        name: "Refresh preview",
      }),
    );
    await waitFor(() => expect(loadImpact).toHaveBeenCalledTimes(2));
    await screen.findByText("2 conversation operations");
    await userEvent.click(screen.getByRole("button", { name: "Force reset" }));
    await waitFor(() => expect(onForceReset).toHaveBeenCalledTimes(3));
    expect(onForceReset.mock.calls[2]![1]).not.toBe(firstMutationId);
  });

  it("restores focus to the opening row when closed", async () => {
    const trigger = document.createElement("button");
    trigger.textContent = "Thread row";
    document.body.append(trigger);
    const returnFocusRef = { current: trigger };
    function ControlledDialog(): React.JSX.Element {
      const [open, setOpen] = useState(true);
      return (
        <ForceResetDialog
          open={open}
          onOpenChange={setOpen}
          loadImpact={vi.fn().mockResolvedValue(impact)}
          onForceReset={vi.fn()}
          returnFocusRef={returnFocusRef}
        />
      );
    }
    render(<ControlledDialog />);
    await screen.findByText("2 conversation operations");
    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(trigger).toHaveFocus());
    trigger.remove();
  });
});
