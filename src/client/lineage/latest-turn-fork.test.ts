import { describe, expect, it } from "vitest";
import type { TurnForkCapability } from "../../shared/index.js";
import { LATEST_PROVIDER_SNAPSHOT_FORK_ATTEMPT_KEY } from "../stores/ThreadClientStore.js";
import type { LatestTurnForkState } from "./latest-turn-fork.js";
import { latestTurnForkDecision } from "./latest-turn-fork.js";

const eligible: TurnForkCapability = {
  sourceTurnId: "turn-2",
  expectedTurnRevision: 7,
  available: true,
};

function state(
  orderedTurnIds: readonly string[],
  forksByTurnId: Readonly<Record<string, TurnForkCapability>>,
  overrides: Partial<LatestTurnForkState> = {},
): LatestTurnForkState {
  return {
    status: "ready",
    connection: "connected",
    authoritative: true,
    forkAttempts: {},
    snapshot: {
      orderedTurnIds,
      turnsById: Object.fromEntries(
        orderedTurnIds.map((id) => [
          id,
          { id, status: "completed", endedBy: "agent_settled" },
        ]),
      ),
      forksByTurnId,
      forkSource: {
        selectedCompletedTurn: { available: true },
        latestProviderSnapshot: {
          available: false,
          unavailableReason: { text: "Provider snapshots are unavailable." },
        },
      },
    } as LatestTurnForkState["snapshot"],
    ...overrides,
  };
}

describe("latestTurnForkDecision", () => {
  it("prefers the latest provider snapshot over a completed-turn boundary", () => {
    const current = state(["turn-1", "turn-2"], { "turn-2": eligible });
    const decision = latestTurnForkDecision({
      ...current,
      snapshot: {
        ...current.snapshot!,
        forkSource: {
          ...current.snapshot!.forkSource,
          latestProviderSnapshot: { available: true },
        },
      },
    });

    expect(decision).toMatchObject({
      available: true,
      selection: { boundary: "latest_provider_snapshot" },
      label: "Fork",
      restart: false,
    });
  });

  it("falls back to the newest successfully completed turn", () => {
    const decision = latestTurnForkDecision(
      state(["turn-1", "turn-2"], {
        "turn-1": { ...eligible, sourceTurnId: "turn-1" },
        "turn-2": eligible,
      }),
    );

    expect(decision).toMatchObject({
      available: true,
      selection: {
        boundary: "selected_completed_turn",
        capability: eligible,
      },
    });
  });

  it("does not search backward when the newest completed turn is unavailable", () => {
    const decision = latestTurnForkDecision(
      state(["turn-1", "turn-2"], {
        "turn-1": { ...eligible, sourceTurnId: "turn-1" },
        "turn-2": {
          ...eligible,
          available: false,
          unavailableReason: { text: "The newest turn is no longer forkable." },
        },
      }),
    );

    expect(decision).toMatchObject({
      available: false,
      unavailableReason: "The newest turn is no longer forkable.",
    });
  });

  it.each([
    "starting",
    "running",
    "waiting_for_approval",
    "waiting_for_input",
    "stopping",
  ] as const)(
    "falls back to the latest completed turn while a non-snapshot backend is %s",
    (runState) => {
      const current = state(["turn-1", "turn-active"], {
        "turn-1": { ...eligible, sourceTurnId: "turn-1" },
      });
      const decision = latestTurnForkDecision({
        ...current,
        snapshot: {
          ...current.snapshot!,
          runState,
          turnsById: {
            "turn-1": {
              id: "turn-1",
              status: "completed",
              endedBy: "agent_settled",
            },
            "turn-active": { id: "turn-active", status: "in_progress" },
          },
        } as unknown as LatestTurnForkState["snapshot"],
      });

      expect(decision).toMatchObject({
        available: true,
        selection: {
          boundary: "selected_completed_turn",
          capability: { sourceTurnId: "turn-1" },
        },
      });
    },
  );

  it("reports a missing completed turn when selected-turn forking is otherwise available", () => {
    const decision = latestTurnForkDecision(state([], {}));
    expect(decision).toMatchObject({
      available: false,
      unavailableReason: "This thread has no completed turn to fork.",
    });
  });

  it("uses the snapshot attempt key for retry and recovery state", () => {
    const current = state(["turn-2"], { "turn-2": eligible });
    const decision = latestTurnForkDecision({
      ...current,
      snapshot: {
        ...current.snapshot!,
        forkSource: {
          ...current.snapshot!.forkSource,
          latestProviderSnapshot: { available: true },
        },
      },
      forkAttempts: {
        [LATEST_PROVIDER_SNAPSHOT_FORK_ATTEMPT_KEY]: {
          phase: "recovery_required",
          childThreadId: "child-1",
          retryable: true,
          diagnostic: "Confirm the recorded provider child.",
        },
      },
    });

    expect(decision).toMatchObject({
      available: true,
      label: "Retry fork",
      selection: { boundary: "latest_provider_snapshot" },
    });
  });

  it("does not expose a terminal snapshot recovery as a selected-turn fallback", () => {
    const current = state(["turn-2"], { "turn-2": eligible });
    const decision = latestTurnForkDecision({
      ...current,
      snapshot: {
        ...current.snapshot!,
        forkSource: {
          ...current.snapshot!.forkSource,
          latestProviderSnapshot: { available: true },
        },
      },
      forkAttempts: {
        [LATEST_PROVIDER_SNAPSHOT_FORK_ATTEMPT_KEY]: {
          phase: "recovery_required",
          childThreadId: "child-1",
          retryable: false,
          diagnostic: "Provider outcome is still unknown.",
        },
      },
    });

    expect(decision).toMatchObject({
      available: false,
      unavailableReason: "Provider outcome is still unknown.",
      selection: { boundary: "latest_provider_snapshot" },
    });
  });

  it("preserves retry and terminal outcomes for the selected-turn fallback", () => {
    const retryable = latestTurnForkDecision(
      state(["turn-2"], { "turn-2": eligible }, {
        forkAttempts: {
          "turn-2": {
            phase: "request_failed",
            retryable: true,
            diagnostic: "Connection lost.",
          },
        },
      }),
    );
    expect(retryable).toMatchObject({
      available: true,
      label: "Retry fork",
      selection: { boundary: "selected_completed_turn" },
    });

    const terminal = latestTurnForkDecision(
      state(["turn-2"], { "turn-2": eligible }, {
        forkAttempts: {
          "turn-2": {
            phase: "recovery_required",
            childThreadId: "child-2",
            retryable: false,
            diagnostic: "Provider outcome is still unknown.",
          },
        },
      }),
    );
    expect(terminal).toMatchObject({
      available: false,
      unavailableReason: "Provider outcome is still unknown.",
      selection: { boundary: "selected_completed_turn" },
    });
  });

  it("requires an authoritative connected snapshot", () => {
    const decision = latestTurnForkDecision(
      state(["turn-2"], { "turn-2": eligible }, { authoritative: false }),
    );
    expect(decision).toMatchObject({
      available: false,
      unavailableReason:
        "Wait for the thread to reconnect and receive authoritative history.",
    });
  });
});
