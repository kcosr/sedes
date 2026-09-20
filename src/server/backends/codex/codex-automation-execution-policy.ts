import type Database from "better-sqlite3";
import { DomainError } from "../../domain/errors.js";
import type { RequestScope } from "../../identity/identity-provider.js";
import type { AutomationExecutionPolicy } from "../../runtime/automation-execution-policy.js";
import type { CompiledBackendModelPolicy } from "../model-policy.js";
import { CodexThreadExecutionSettingsRepository } from "./codex-thread-execution-settings-repository.js";

export class CodexAutomationExecutionPolicy
  implements AutomationExecutionPolicy
{
  readonly #settings: CodexThreadExecutionSettingsRepository;

  constructor(
    readonly database: Database.Database,
    readonly modelPolicy: CompiledBackendModelPolicy,
  ) {
    this.#settings = new CodexThreadExecutionSettingsRepository(database);
  }

  assertCanAutomate(
    scope: RequestScope,
    applicationThreadId: string,
  ): void {
    const row = this.database.prepare(`
      SELECT 1 AS found
      FROM application_threads AS thread
      WHERE thread.tenant_id = ? AND thread.owner_principal_id = ?
        AND thread.id = ?
    `).get(scope.tenantId, scope.principalId, applicationThreadId) as
      | { readonly found: 1 }
      | undefined;
    if (!row) {
      throw new DomainError("not_found", "The automation thread was not found.");
    }
    const desired = this.#settings.find(scope, applicationThreadId)?.desired;
    if (
      !desired ||
      !this.modelPolicy.isSelectionAllowed({
        modelId: desired.model,
        reasoningEffort: desired.reasoningEffort,
      })
    ) {
      throw new DomainError(
        "invalid_transition",
        "Choose an allowed Codex model and reasoning effort before enabling or running automation.",
      );
    }
  }
}
