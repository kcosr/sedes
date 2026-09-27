import type { AutomationExecutionPolicy } from "../../runtime/automation-execution-policy.js";
import { DomainError } from "../../domain/errors.js";

export class OpenCodeAutomationExecutionPolicy implements AutomationExecutionPolicy {
  assertCanAutomate(..._input: Parameters<AutomationExecutionPolicy["assertCanAutomate"]>): never {
    throw new DomainError("invalid_transition", "OpenCode automation is unavailable.");
  }
}
