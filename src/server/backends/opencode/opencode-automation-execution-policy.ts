import type { AutomationExecutionPolicy } from "../../runtime/automation-execution-policy.js";
import { DomainError } from "../../domain/errors.js";
import type { RequestScope } from "../../identity/identity-provider.js";
import type { CompiledBackendModelPolicy } from "../model-policy.js";
import { assertOpenCodeCatalogPolicy, qualifiedOpenCodeModelId } from "./opencode-model-selection.js";
import type { OpenCodeThreadSettingsRepository } from "./opencode-thread-settings-repository.js";

export class OpenCodeAutomationExecutionPolicy implements AutomationExecutionPolicy {
  constructor(readonly input: { readonly scope: RequestScope; readonly backendInstanceId: string;
    readonly settings: OpenCodeThreadSettingsRepository; readonly modelPolicy: CompiledBackendModelPolicy }) {
    input.settings.assertScope(input.scope);
    if (input.backendInstanceId !== input.settings.backendInstanceId) throw unavailable();
    assertOpenCodeCatalogPolicy(input.modelPolicy);
  }
  assertCanAutomate(scope: RequestScope, applicationThreadId: string): void {
    const current = this.input.settings.get(scope, applicationThreadId);
    if (!current.desired || (current.observationState === "confirmed" && current.observed?.classification !== "recognized")) throw unavailable();
    qualifiedOpenCodeModelId(current.desired);
    // The driver revalidates the enabled native catalog and exact current selection at every effect.
  }
}
function unavailable(): DomainError { return new DomainError("invalid_transition", "Choose available OpenCode settings before enabling or running automation."); }
