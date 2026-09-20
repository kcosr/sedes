// @vitest-environment jsdom

import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  BoundedValue,
  NormalizedThreadSnapshot,
} from "../../shared/index.js";
import type { ThreadClientStore } from "../stores/ThreadClientStore.js";
import { ProviderFeatureComposerActions } from "./registry.js";

beforeEach(() => {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe(): void {}
      disconnect(): void {}
      unobserve(): void {}
    },
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const ref = { featureId: "codex.goal", schemaVersion: 1 } as const;

function capability(actionIds: readonly string[], revision = 3) {
  return {
    ref,
    revision,
    label: { text: "Goal" },
    availability: "available" as const,
    operations: actionIds.map((actionId) => ({
      actionId,
      label: { text: actionId },
      effects: {
        application: "write" as const,
        modelUsage: "none" as const,
        external: "durable_side_effect" as const,
      },
      confirmation: "none" as const,
      execution: "durable" as const,
    })),
    presentationSlots: ["composer_action" as const],
  };
}

function snapshot(input: {
  readonly state: BoundedValue;
  readonly actions: readonly string[];
  readonly revision?: number;
}): NormalizedThreadSnapshot {
  return {
    runState: "idle",
    capabilities: {
      providerFeatures: [capability(input.actions, input.revision)],
    },
    providerFeatures: [
      {
        ref,
        revision: input.revision ?? 3,
        state: input.state,
      },
    ],
  } as unknown as NormalizedThreadSnapshot;
}

function objectValue(
  value: Readonly<Record<string, BoundedValue>>,
): BoundedValue {
  return {
    kind: "object",
    entries: Object.entries(value).map(([key, entry]) => ({
      key: { text: key },
      value: entry,
    })),
  };
}

function setState(
  objective: string,
  status:
    | "active"
    | "paused"
    | "blocked"
    | "usage_limited"
    | "budget_limited"
    | "complete",
): BoundedValue {
  return objectValue({
    state: { text: "set" },
    objective: { text: objective },
    status: { text: status },
  });
}

function unsetState(): BoundedValue {
  return objectValue({ state: { text: "unset" } });
}

const statusLabels: Readonly<Record<string, string>> = {
  active: "Active",
  paused: "Paused",
  blocked: "Blocked",
  usage_limited: "Usage limited",
  budget_limited: "Budget limited",
  complete: "Complete",
};

function renderGoal(
  value: NormalizedThreadSnapshot,
  perform = vi.fn().mockResolvedValue(undefined),
  disabled = false,
  mobile = false,
) {
  const store = { perform } as unknown as ThreadClientStore;
  return render(
    <ProviderFeatureComposerActions
      store={store}
      snapshot={value}
      disabled={disabled}
      mobile={mobile}
    />,
  );
}

describe("codex.goal@1 client feature", () => {
  it("renders an accessible unset chip and starts a goal", async () => {
    const perform = vi.fn().mockResolvedValue({
      status: "accepted",
      operationId: "op-1",
    });
    renderGoal(
      snapshot({ state: unsetState(), actions: ["create"] }),
      perform,
    );

    const chip = screen.getByRole("button", { name: "Goal, unset" });
    expect(chip).toBeEnabled();
    fireEvent.click(chip);

    const objective = screen.getByLabelText("Objective");
    expect(objective).toHaveFocus();
    fireEvent.change(objective, {
      target: { value: "  Finish the migration  " },
    });
    fireEvent.click(screen.getByRole("button", { name: "Start goal" }));

    await waitFor(() =>
      expect(perform).toHaveBeenCalledWith({
        action: "perform_provider_feature",
        feature: ref,
        actionId: "create",
        arguments: objectValue({
          objective: { text: "Finish the migration" },
        }),
        expectedFeatureRevision: 3,
      }),
    );
  });

  it("submits the create form with Cmd/Ctrl+Enter", async () => {
    const perform = vi.fn().mockResolvedValue({
      status: "accepted",
      operationId: "op-1",
    });
    renderGoal(
      snapshot({ state: unsetState(), actions: ["create"] }),
      perform,
    );
    fireEvent.click(screen.getByRole("button", { name: "Goal, unset" }));
    const objective = screen.getByLabelText("Objective");
    fireEvent.change(objective, { target: { value: "Finish the migration" } });
    fireEvent.keyDown(objective, { key: "Enter", ctrlKey: true });

    await waitFor(() =>
      expect(perform).toHaveBeenCalledWith({
        action: "perform_provider_feature",
        feature: ref,
        actionId: "create",
        arguments: objectValue({
          objective: { text: "Finish the migration" },
        }),
        expectedFeatureRevision: 3,
      }),
    );

    cleanup();
    const metaPerform = vi.fn().mockResolvedValue({
      status: "accepted",
      operationId: "op-2",
    });
    renderGoal(
      snapshot({ state: unsetState(), actions: ["create"] }),
      metaPerform,
    );
    fireEvent.click(screen.getByRole("button", { name: "Goal, unset" }));
    const metaObjective = screen.getByLabelText("Objective");
    fireEvent.change(metaObjective, { target: { value: "Ship it" } });
    fireEvent.keyDown(metaObjective, { key: "Enter", metaKey: true });

    await waitFor(() =>
      expect(metaPerform).toHaveBeenCalledWith(
        expect.objectContaining({ actionId: "create" }),
      ),
    );
  });

  it("keeps Cmd/Ctrl+Enter behind the same validation and disabled gates", async () => {
    const perform = vi.fn().mockResolvedValue({
      status: "accepted",
      operationId: "op-1",
    });
    renderGoal(
      snapshot({ state: unsetState(), actions: ["create"] }),
      perform,
    );
    fireEvent.click(screen.getByRole("button", { name: "Goal, unset" }));
    const objective = screen.getByLabelText("Objective");

    // Empty objective: validation error, no dispatch.
    fireEvent.change(objective, { target: { value: "   " } });
    fireEvent.keyDown(objective, { key: "Enter", ctrlKey: true });
    await waitFor(() =>
      expect(
        screen.getByText("Goal objective must not be empty."),
      ).toBeInTheDocument(),
    );
    expect(perform).not.toHaveBeenCalled();

    // Plain Enter without the modifier inserts a newline — no submit.
    fireEvent.change(objective, { target: { value: "Real objective" } });
    fireEvent.keyDown(objective, { key: "Enter" });
    expect(perform).not.toHaveBeenCalled();

    cleanup();
    // Disabled thread: modifier submit stays inert like the Create button.
    const disabledPerform = vi.fn().mockResolvedValue({
      status: "accepted",
      operationId: "op-2",
    });
    renderGoal(
      snapshot({ state: unsetState(), actions: ["create"] }),
      disabledPerform,
      true,
    );
    fireEvent.click(screen.getByRole("button", { name: "Goal, unset" }));
    const disabledObjective = screen.getByLabelText("Objective");
    fireEvent.keyDown(disabledObjective, { key: "Enter", ctrlKey: true });
    expect(disabledPerform).not.toHaveBeenCalled();
  });

  it("shows pause and clear for active goals with full objective text", () => {
    renderGoal(
      snapshot({
        state: setState("Ship durable Goal recovery", "active"),
        actions: ["pause", "clear"],
      }),
    );

    expect(
      screen.getByRole("button", {
        name: "Goal, Active: Ship durable Goal recovery",
      }),
    ).toBeInTheDocument();
    fireEvent.click(
      screen.getByRole("button", {
        name: "Goal, Active: Ship durable Goal recovery",
      }),
    );
    expect(
      screen.getAllByText("Ship durable Goal recovery").length,
    ).toBeGreaterThan(0);
    expect(screen.getByRole("button", { name: "Pause" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Clear" })).toBeEnabled();
    expect(screen.queryByRole("button", { name: "Resume" })).toBeNull();
  });

  it.each(["paused", "blocked"] as const)("shows resume and clear for %s goals", async (status) => {
    const perform = vi.fn().mockResolvedValue({
      status: "accepted",
      operationId: "op-1",
    });
    renderGoal(
      snapshot({
        state: setState("Resume objective", status),
        actions: ["resume", "clear"],
      }),
      perform,
    );
    fireEvent.click(
      screen.getByRole("button", { name: `Goal, ${statusLabels[status]}: Resume objective` }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Resume" }));
    await waitFor(() =>
      expect(perform).toHaveBeenCalledWith(
        expect.objectContaining({
          actionId: "resume",
          arguments: { kind: "object", entries: [] },
        }),
      ),
    );
  });

  it("offers clear only for terminal provider statuses", () => {
    renderGoal(
      snapshot({
        state: setState("Done", "complete"),
        actions: ["clear"],
      }),
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Goal, Complete: Done" }),
    );
    expect(screen.getByRole("button", { name: "Clear" })).toBeEnabled();
    expect(screen.queryByRole("button", { name: "Pause" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Resume" })).toBeNull();
  });

  it("does not expose budget, edit, progress, or confirmation controls", () => {
    renderGoal(
      snapshot({
        state: setState("No extras", "active"),
        actions: ["pause", "clear"],
      }),
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Goal, Active: No extras" }),
    );
    expect(screen.queryByText(/budget/i)).toBeNull();
    expect(screen.queryByText(/progress/i)).toBeNull();
    expect(screen.queryByText(/edit objective/i)).toBeNull();
    expect(screen.queryByRole("button", { name: /confirm/i })).toBeNull();
    expect(screen.queryByText(/are you sure/i)).toBeNull();
  });

  it("keeps the popover open and shows uncertain state on recovery_required", async () => {
    const perform = vi.fn().mockResolvedValue({
      status: "recovery_required",
      retryable: true,
    });
    renderGoal(
      snapshot({
        state: setState("Ship durable Goal recovery", "active"),
        actions: ["pause", "clear"],
      }),
      perform,
    );

    fireEvent.click(
      screen.getByRole("button", {
        name: "Goal, Active: Ship durable Goal recovery",
      }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Pause" }));

    await waitFor(() =>
      expect(
        screen.getByText(
          /The Goal change could not be confirmed/i,
        ),
      ).toBeInTheDocument(),
    );
    // Popover stays open — full objective still available.
    expect(
      screen.getAllByText("Ship durable Goal recovery").length,
    ).toBeGreaterThan(0);
    expect(screen.getByRole("button", { name: "Pause" })).toBeInTheDocument();
  });

  it("uses a modal bottom card on mobile and preserves a dirty objective across dismissal", async () => {
    renderGoal(
      snapshot({ state: unsetState(), actions: ["create"] }),
      undefined,
      false,
      true,
    );
    const trigger = screen.getByRole("button", { name: "Goal, unset" });
    fireEvent.click(trigger);

    const dialog = screen.getByRole("dialog", { name: "Goal" });
    expect(dialog).toHaveClass("codex-goal-mobile-card");
    const objective = screen.getByLabelText("Objective");
    expect(objective).toHaveFocus();
    fireEvent.change(objective, { target: { value: "Keep this draft" } });
    fireEvent.keyDown(dialog, { key: "Escape" });

    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(trigger).toHaveFocus();
    fireEvent.click(trigger);
    expect(screen.getByLabelText("Objective")).toHaveValue("Keep this draft");
  });

  it("does not raise the keyboard when inspecting a set mobile Goal", () => {
    renderGoal(
      snapshot({
        state: setState("Inspect without editing", "active"),
        actions: ["pause", "clear"],
      }),
      undefined,
      false,
      true,
    );
    fireEvent.click(
      screen.getByRole("button", {
        name: "Goal, Active: Inspect without editing",
      }),
    );

    expect(screen.getByRole("dialog", { name: "Goal" })).toBeInTheDocument();
    expect(screen.queryByRole("textbox")).toBeNull();
    expect(document.activeElement?.tagName).not.toBe("TEXTAREA");
  });

  it("lifts the mobile card above the visual viewport keyboard inset", async () => {
    const viewport = new EventTarget() as EventTarget & {
      height: number;
      offsetTop: number;
    };
    viewport.height = 500;
    viewport.offsetTop = 20;
    Object.defineProperty(window, "innerHeight", {
      configurable: true,
      value: 800,
    });
    Object.defineProperty(window, "visualViewport", {
      configurable: true,
      value: viewport,
    });

    renderGoal(
      snapshot({ state: unsetState(), actions: ["create"] }),
      undefined,
      false,
      true,
    );
    fireEvent.click(screen.getByRole("button", { name: "Goal, unset" }));

    await waitFor(() =>
      expect(screen.getByRole("dialog", { name: "Goal" })).toHaveStyle({
        "--codex-goal-keyboard-inset": "280px",
      }),
    );

    viewport.height = 640;
    viewport.offsetTop = 10;
    act(() => viewport.dispatchEvent(new Event("resize")));
    await waitFor(() =>
      expect(screen.getByRole("dialog", { name: "Goal" })).toHaveStyle({
        "--codex-goal-keyboard-inset": "150px",
      }),
    );
  });

  it("cannot dismiss a mobile Goal while its provider action is pending", async () => {
    let resolvePerform!: (value: {
      status: "recovery_required";
      retryable: boolean;
    }) => void;
    const perform = vi.fn(
      () =>
        new Promise<{ status: "recovery_required"; retryable: boolean }>(
          (resolve) => {
            resolvePerform = resolve;
          },
        ),
    );
    renderGoal(
      snapshot({
        state: setState("Keep recovery visible", "active"),
        actions: ["pause"],
      }),
      perform,
      false,
      true,
    );
    fireEvent.click(
      screen.getByRole("button", {
        name: "Goal, Active: Keep recovery visible",
      }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Pause" }));
    const dialog = screen.getByRole("dialog", { name: "Goal" });
    expect(screen.queryByRole("button", { name: "Close" })).toBeNull();
    fireEvent.keyDown(dialog, { key: "Escape" });
    expect(dialog).toBeInTheDocument();

    await act(async () => {
      resolvePerform({ status: "recovery_required", retryable: true });
    });
    expect(dialog).toBeInTheDocument();
    expect(
      screen.getByText(/The Goal change could not be confirmed/i),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Close" })).toBeInTheDocument();
  });

  it("omits unknown composer features", () => {
    const unknown = {
      runState: "idle",
      capabilities: {
        providerFeatures: [
          {
            ref: { featureId: "codex.unknown", schemaVersion: 1 },
            revision: 1,
            label: { text: "Unknown feature" },
            availability: "available",
            operations: [],
            presentationSlots: ["composer_action"],
          },
        ],
      },
      providerFeatures: [],
    } as unknown as NormalizedThreadSnapshot;
    render(
      <ProviderFeatureComposerActions
        store={{ perform: vi.fn() } as unknown as ThreadClientStore}
        snapshot={unknown}
        disabled={false}
        mobile={false}
      />,
    );
    expect(screen.queryByText(/Unknown feature/)).not.toBeInTheDocument();
  });

  it("renders a compact text-free indicator colored per status", () => {
    const statuses = [
      "active",
      "paused",
      "blocked",
      "usage_limited",
      "budget_limited",
      "complete",
    ] as const;
    for (const status of statuses) {
      cleanup();
      renderGoal(
        snapshot({
          state: setState("Objective text that must stay hidden", status),
          actions: ["clear"],
        }),
      );
      const indicator = screen.getByRole("button", {
        name: `Goal, ${statusLabels[status]}: Objective text that must stay hidden`,
      });
      expect(indicator.className).toBe(
        `codex-goal-indicator set status-${status}`,
      );
      // Collapsed control carries no visible text — the objective and
      // status only appear inside the popover and the accessible name.
      expect(indicator.textContent).toBe("");
      expect(indicator).toHaveAttribute("title", `Goal: ${statusLabels[status]}`);
    }
    cleanup();
    renderGoal(snapshot({ state: unsetState(), actions: ["create"] }));
    const unsetIndicator = screen.getByRole("button", { name: "Goal, unset" });
    expect(unsetIndicator.className).toBe("codex-goal-indicator unset");
    expect(unsetIndicator.textContent).toBe("");
    expect(unsetIndicator).toHaveAttribute("title", "Set goal");
  });
});
