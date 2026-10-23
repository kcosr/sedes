import type { CodexNativeThreadGoal } from "./codex-goal-protocol.js";

const MAX_COMPLETED_GOAL_TURNS = 512;

export interface CodexGoalRecoveryEvidence {
  readonly generation: number;
  readonly turnId: string;
  readonly epoch: number;
  readonly goal: CodexNativeThreadGoal;
}

interface LiveGoalTurn {
  readonly turnId: string;
  readonly epoch: number;
  goal?: CodexNativeThreadGoal;
  started: boolean;
  recoveryAllowed: boolean;
  outcome?: "completed" | "interrupted" | "failed";
}

function sameGoal(left: CodexNativeThreadGoal | null | undefined, right: CodexNativeThreadGoal | null | undefined): boolean {
  return !!left && !!right && left.threadId === right.threadId &&
    left.objective === right.objective && left.createdAt === right.createdAt &&
    left.tokenBudget === right.tokenBudget;
}

/**
 * One live turn's Goal evidence, private to one attached Codex handle.
 * Snapshots establish a baseline but never manufacture completed-turn evidence.
 * Codex does not expose a Goal id or blocked reason: this is a conservative
 * continuity check, not proof that an error caused the blocked transition.
 */
export class CodexGoalRecoveryTracker {
  #generation = 0;
  #epoch = 0;
  #goal: CodexNativeThreadGoal | null = null;
  #turn: LiveGoalTurn | undefined;
  readonly #completedGoalTurns = new Set<string>();

  establish(generation: number, goal: CodexNativeThreadGoal | null): void {
    this.invalidate();
    this.#generation = generation;
    this.#goal = goal && { ...goal };
  }

  invalidate(): void {
    this.#epoch += 1;
    this.#turn = undefined;
    this.#goal = null;
    this.#completedGoalTurns.clear();
  }

  /** Cancel recovery without losing this live turn's Goal participation. */
  cancelRecovery(): void {
    this.#disableRecovery();
    this.#goal = null;
  }

  started(input: { readonly generation: number; readonly turnId: string }): void {
    if (!this.#owns(input.generation)) return;
    // Goal accounting/stop notifications can precede turn/started on the
    // native rail. Preserve evidence already captured for this exact turn.
    if (this.#turn?.turnId === input.turnId) {
      this.#turn.started = true;
      return;
    }
    this.#turn = {
      turnId: input.turnId,
      epoch: ++this.#epoch,
      started: true,
      recoveryAllowed: true,
      ...(this.#goal?.status === "active" ? { goal: { ...this.#goal } } : {}),
    };
  }

  observeGoal(input: {
    readonly generation: number;
    readonly turnId: string | null;
    readonly goal: CodexNativeThreadGoal | null;
  }): void {
    if (!this.#owns(input.generation)) return;
    const previous = this.#goal;
    const goal = input.goal && { ...input.goal };
    this.#goal = goal;
    const same = sameGoal(previous, goal);
    const turn = this.#turn;

    // Unattributed mutations include user pause/clear/resume/replacement.
    // A same-active-goal accounting update has no control effect.
    if (input.turnId === null) {
      if (!same || goal?.status !== "active" || previous?.status !== "active") this.#disableRecovery();
      return;
    }
    if (!goal || (goal.status !== "active" && goal.status !== "blocked")) {
      this.#disableRecovery();
      return;
    }
    if (turn?.turnId === input.turnId) {
      if (turn.goal && !sameGoal(turn.goal, goal)) {
        this.#disableRecovery();
        return;
      }
      if (goal.status === "active") turn.goal = { ...goal };
      return;
    }

    // Never transfer old-turn evidence to a different currently running turn.
    if (turn?.started && !turn.outcome) {
      this.#disableRecovery();
      return;
    }
    const active = goal.status === "active" ? goal :
      same && previous?.status === "active" ? previous : undefined;
    if (!active) {
      this.#disableRecovery();
      return;
    }
    this.#turn = {
      turnId: input.turnId,
      epoch: ++this.#epoch,
      goal: { ...active },
      started: false,
      recoveryAllowed: true,
    };
  }

  completed(input: {
    readonly generation: number;
    readonly turnId: string;
    readonly outcome: "completed" | "interrupted" | "failed";
  }): void {
    if (!this.#owns(input.generation) || this.#turn?.turnId !== input.turnId) return;
    this.#turn.outcome = input.outcome;
    if (this.#turn.goal) {
      // Native autonomous work can start its next turn before the application
      // actor consumes this completion. Retain only bounded participation,
      // never recovery evidence, for those delayed completion observers.
      this.#completedGoalTurns.add(input.turnId);
      if (this.#completedGoalTurns.size > MAX_COMPLETED_GOAL_TURNS) {
        this.#completedGoalTurns.delete(this.#completedGoalTurns.values().next().value!);
      }
    }
  }

  isGoalTurn(generation: number, turnId: string): boolean {
    return this.#owns(generation) &&
      ((this.#turn?.turnId === turnId && !!this.#turn.goal) || this.#completedGoalTurns.has(turnId));
  }

  recovery(generation: number, turnId: string): CodexGoalRecoveryEvidence | undefined {
    const turn = this.#turn;
    if (!this.#owns(generation) || turn?.turnId !== turnId || !turn.goal || !turn.recoveryAllowed || turn.outcome !== "failed") return;
    return { generation, turnId, epoch: turn.epoch, goal: { ...turn.goal } };
  }

  canResume(evidence: CodexGoalRecoveryEvidence, freshGoal: CodexNativeThreadGoal | null): boolean {
    const turn = this.#turn;
    return this.#owns(evidence.generation) && turn?.turnId === evidence.turnId &&
      turn.epoch === evidence.epoch && turn.recoveryAllowed && turn.outcome === "failed" &&
      sameGoal(turn.goal, evidence.goal) && sameGoal(this.#goal, evidence.goal) &&
      sameGoal(freshGoal, evidence.goal) && freshGoal?.status === "blocked";
  }

  #owns(generation: number): boolean {
    return generation > 0 && generation === this.#generation;
  }

  #disableRecovery(): void {
    this.#epoch += 1;
    // Completion observers still need to know this was Goal work: a successful
    // terminal turn rearms the allowance, while failure must not fall back to
    // sending ordinary text after an explicit Goal pause or clear.
    if (this.#turn) this.#turn.recoveryAllowed = false;
  }
}
