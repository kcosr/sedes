import type Database from "better-sqlite3";
import { DomainError } from "../domain/errors.js";
import type { RequestScope } from "../identity/identity-provider.js";

/** Rechecked both when enabling automation and immediately before dispatch. */
export interface AutomationExecutionPolicy {
  assertCanAutomate(
    scope: RequestScope,
    applicationThreadId: string,
  ): void;
}

/**
 * Routes automation admission to the backend instance that owns the thread.
 * Backend modules retain authority over their native durable setting shapes;
 * an enabled backend without an admission contribution fails closed.
 */
export class BackendAutomationExecutionPolicyRouter
  implements AutomationExecutionPolicy
{
  constructor(
    readonly database: Database.Database,
    readonly policies: ReadonlyMap<string, AutomationExecutionPolicy>,
  ) {}

  assertCanAutomate(
    scope: RequestScope,
    applicationThreadId: string,
  ): void {
    const thread = this.database
      .prepare(
        `
          SELECT thread.backend_instance_id AS backendInstanceId,
            workspace.removed_at AS removedAt
          FROM application_threads AS thread
          JOIN workspaces AS workspace
            ON workspace.tenant_id = thread.tenant_id
            AND workspace.owner_principal_id = thread.owner_principal_id
            AND workspace.id = thread.workspace_id
          WHERE thread.tenant_id = ? AND thread.owner_principal_id = ? AND thread.id = ?
        `,
      )
      .get(scope.tenantId, scope.principalId, applicationThreadId) as
      | { readonly backendInstanceId: string; readonly removedAt: number | null }
      | undefined;
    if (!thread) {
      throw new DomainError("not_found", "The automation thread was not found.");
    }
    if (thread.removedAt !== null) {
      throw new DomainError("invalid_transition", "Restore the removed project before running automation.");
    }
    const policy = this.policies.get(thread.backendInstanceId);
    if (!policy) {
      throw new DomainError(
        "invalid_transition",
        "This thread's backend is unavailable for automation.",
      );
    }
    policy.assertCanAutomate(scope, applicationThreadId);
  }
}
