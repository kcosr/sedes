import { DomainError } from "../../domain/errors.js";
import type { RequestScope } from "../../identity/identity-provider.js";
import type { AutomationExecutionPolicy } from "../../runtime/automation-execution-policy.js";
import type { CompiledBackendModelPolicy } from "../model-policy.js";
import { antigravityModelIsAllowed } from "./model-selection.js";
import type { AntigravityThreadRepository } from "./thread-repository.js";

export class AntigravityAutomationPolicy implements AutomationExecutionPolicy {
  constructor(
    readonly settings: AntigravityThreadRepository,
    readonly modelPolicy: CompiledBackendModelPolicy,
    readonly scope: RequestScope,
    readonly backendInstanceId: string,
  ) {}

  assertCanAutomate(scope: RequestScope, applicationThreadId: string): void {
    if (scope.tenantId !== this.scope.tenantId || scope.principalId !== this.scope.principalId) throw unavailable();
    const current = this.settings.get(scope, applicationThreadId);
    if (current.backendInstanceId !== this.backendInstanceId || !antigravityModelIsAllowed(this.modelPolicy, current)) throw unavailable();
  }
}

function unavailable(): DomainError {
  return new DomainError("invalid_transition", "Choose an allowed Antigravity model and reasoning effort before running automation.");
}
