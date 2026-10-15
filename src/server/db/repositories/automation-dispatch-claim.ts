import type Database from "better-sqlite3";
import type { RequestScope } from "../../identity/identity-provider.js";
import { AutomationDeferredError } from "../../domain/automation-deferred.js";

/** Rechecked in the same transaction that reserves a new provider effect. */
export function assertAutomationDispatchClaim(
  database: Database.Database,
  scope: RequestScope,
  input: {
    readonly automationId: string;
    readonly automationRunId: string;
    readonly mutationId: string;
    readonly claimToken: string | undefined;
    readonly targetThreadId?: string;
  },
): void {
  if (!database.inTransaction) throw new Error("automation_admission_requires_transaction");
  const admitted = input.claimToken && database.prepare(`
    SELECT 1 FROM automation_runs AS run
    JOIN application_threads AS source ON source.tenant_id = run.tenant_id
      AND source.owner_principal_id = run.owner_principal_id AND source.id = run.anchor_thread_id
    JOIN thread_principal_state AS inventory ON inventory.tenant_id = source.tenant_id
      AND inventory.principal_id = source.owner_principal_id AND inventory.thread_id = source.id
    JOIN workspaces AS workspace ON workspace.tenant_id = source.tenant_id
      AND workspace.owner_principal_id = source.owner_principal_id AND workspace.id = source.workspace_id
    WHERE run.tenant_id = ? AND run.owner_principal_id = ? AND run.automation_id = ? AND run.id = ?
      AND run.dispatch_mutation_id = ? AND run.claim_token = ? AND run.state = 'dispatching'
      AND run.force_reset_at IS NULL AND inventory.inventory_state <> 'archived'
      AND source.availability = 'available' AND workspace.removed_at IS NULL
      AND (? IS NULL OR (run.run_mode = 'same_thread' AND run.anchor_thread_id = ?)
        OR (run.run_mode = 'clone' AND run.child_thread_id = ?))
  `).get(scope.tenantId, scope.principalId, input.automationId, input.automationRunId, input.mutationId, input.claimToken, input.targetThreadId ?? null, input.targetThreadId ?? null, input.targetThreadId ?? null);
  if (!admitted) throw new AutomationDeferredError("source_busy", "The automation dispatch no longer owns an admissible claim.");
}
