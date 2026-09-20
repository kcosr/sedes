import { DomainError } from "../../domain/errors.js";
import type { RequestScope } from "../../identity/identity-provider.js";
import type { AutomationExecutionPolicy } from "../../runtime/automation-execution-policy.js";
import type { CompiledBackendModelPolicy } from "../model-policy.js";
import type { ClaudeThreadRepository } from "./claude-thread-repository.js";

export class ClaudeAutomationExecutionPolicy implements AutomationExecutionPolicy {
  constructor(
    readonly settings: ClaudeThreadRepository,
    readonly modelPolicy: CompiledBackendModelPolicy,
  ) {}

  assertCanAutomate(scope: RequestScope, applicationThreadId: string): void {
    const current = this.settings.find(scope, applicationThreadId);
    if (!current) {
      throw new DomainError("not_found", "The Claude thread was not found.");
    }
    if (
      !current.model ||
      (current.effort === null
        ? !this.modelPolicy.isModelWithoutReasoningEffortAllowed({
            modelId: current.model,
          })
        : !this.modelPolicy.isSelectionAllowed({
            modelId: current.model,
            reasoningEffort: current.effort,
          }))
    ) {
      throw new DomainError(
        "invalid_transition",
        "Choose an allowed Claude model and effort before enabling or running automation.",
      );
    }
  }
}
