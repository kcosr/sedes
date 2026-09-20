import { DomainError } from "../../domain/errors.js";
import type { RequestScope } from "../../identity/identity-provider.js";
import type { AutomationExecutionPolicy } from "../../runtime/automation-execution-policy.js";
import type { CompiledBackendModelPolicy } from "../model-policy.js";
import type { PiConversationRepository } from "./pi-conversation-repository.js";

export class PiAutomationExecutionPolicy implements AutomationExecutionPolicy {
  constructor(
    readonly settings: PiConversationRepository,
    readonly modelPolicy: CompiledBackendModelPolicy,
  ) {}

  assertCanAutomate(scope: RequestScope, applicationThreadId: string): void {
    const current = this.settings.getSettings(scope, applicationThreadId);
    if (
      !current.modelProvider ||
      !current.modelId ||
      !current.thinkingLevel ||
      !this.modelPolicy.isSelectionAllowed({
        providerId: current.modelProvider,
        modelId: current.modelId,
        reasoningEffort: current.thinkingLevel,
      })
    ) {
      throw new DomainError(
        "invalid_transition",
        "Choose an allowed Pi model and thinking level before enabling or running automation.",
      );
    }
  }
}
