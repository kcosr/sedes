import type { TurnForkCapability } from "../../shared/index.js";
import {
  LATEST_PROVIDER_SNAPSHOT_FORK_ATTEMPT_KEY,
  type ThreadClientState,
  type TurnForkAttempt,
} from "../stores/ThreadClientStore.js";

export type LatestForkSelection =
  | { readonly boundary: "latest_provider_snapshot" }
  | {
      readonly boundary: "selected_completed_turn";
      readonly capability: TurnForkCapability;
    };

export interface LatestTurnForkDecision {
  readonly selection?: LatestForkSelection;
  readonly attempt?: TurnForkAttempt;
  readonly available: boolean;
  readonly label: string;
  readonly unavailableReason?: string;
  readonly restart: boolean;
}

export type LatestTurnForkState = Pick<
  ThreadClientState,
  | "status"
  | "error"
  | "connection"
  | "authoritative"
  | "snapshot"
  | "forkAttempts"
>;

/**
 * Resolve the generic Fork command. A provider snapshot is preferred because
 * it can include the provider's persisted portion of an active turn. Backends
 * without that boundary retain the exact newest-completed-turn behavior.
 */
export function latestTurnForkDecision(
  state: LatestTurnForkState | undefined,
): LatestTurnForkDecision {
  if (!state || state.status === "loading") {
    return unavailable("Loading fork availability…");
  }
  if (state.status === "error") {
    return unavailable(state.error ?? "This thread could not be loaded.");
  }
  if (!state.snapshot) {
    return unavailable("Loading fork availability…");
  }
  if (state.connection !== "connected" || !state.authoritative) {
    return unavailable(
      "Wait for the thread to reconnect and receive authoritative history.",
    );
  }

  const snapshotCapability = state.snapshot.forkSource.latestProviderSnapshot;
  if (snapshotCapability.available) {
    return decisionForSelection(
      { boundary: "latest_provider_snapshot" },
      state.forkAttempts[LATEST_PROVIDER_SNAPSHOT_FORK_ATTEMPT_KEY],
    );
  }

  const sourceTurnId = state.snapshot.orderedTurnIds.findLast((turnId) => {
    const turn = state.snapshot!.turnsById[turnId];
    return turn?.status === "completed" && turn.endedBy === "agent_settled";
  });
  if (!sourceTurnId) {
    const selectedCapability =
      state.snapshot.forkSource.selectedCompletedTurn;
    return unavailable(
      selectedCapability.available
        ? "This thread has no completed turn to fork."
        : (selectedCapability.unavailableReason?.text ??
          snapshotCapability.unavailableReason?.text ??
          "This thread has no completed turn to fork."),
    );
  }
  const capability = state.snapshot.forksByTurnId[sourceTurnId];
  if (!capability) {
    return unavailable("Fork availability for the latest turn is not known.");
  }
  if (!capability.available) {
    return unavailable(
      capability.unavailableReason?.text ??
        "The latest turn cannot be forked right now.",
    );
  }

  return decisionForSelection(
    { boundary: "selected_completed_turn", capability },
    state.forkAttempts[sourceTurnId],
  );
}

function decisionForSelection(
  selection: LatestForkSelection,
  attempt: TurnForkAttempt | undefined,
): LatestTurnForkDecision {
  if (attempt?.phase === "pending") {
    return unavailable("The fork is being created.", selection, attempt);
  }
  if (attempt?.phase === "request_failed" && !attempt.retryable) {
    return unavailable(attempt.diagnostic, selection, attempt);
  }
  if (attempt?.phase === "recovery_required" && !attempt.retryable) {
    return unavailable(attempt.diagnostic, selection, attempt);
  }

  return {
    selection,
    ...(attempt ? { attempt } : {}),
    available: true,
    label:
      attempt?.phase === "request_failed" ||
      attempt?.phase === "recovery_required"
        ? "Retry fork"
        : "Fork",
    restart: attempt?.phase === "aborted",
  };
}

function unavailable(
  unavailableReason: string,
  selection?: LatestForkSelection,
  attempt?: TurnForkAttempt,
): LatestTurnForkDecision {
  return {
    ...(selection ? { selection } : {}),
    ...(attempt ? { attempt } : {}),
    available: false,
    label: "Fork",
    unavailableReason,
    restart: false,
  };
}
