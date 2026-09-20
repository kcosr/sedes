import { DomainError } from "./errors.js";

/**
 * Shared create/update guard for clone-mode automation definitions.
 *
 * The capability is resolved by the caller because the normalized thread
 * service owns the branching boundary. Keeping the decision here prevents
 * HTTP and canonical agent-tool adapters from drifting on the resulting
 * domain behavior.
 */
export function assertAutomationCloneEligible(input: {
  readonly runMode: "same_thread" | "clone";
  readonly canCloneOnRun: boolean;
}): void {
  if (input.runMode === "clone" && !input.canCloneOnRun) {
    throw new DomainError(
      "invalid_transition",
      "Clone-mode automation is not available for this thread.",
    );
  }
}
