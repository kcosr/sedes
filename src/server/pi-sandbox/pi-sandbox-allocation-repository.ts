import type Database from "better-sqlite3";
import { DomainError } from "../domain/errors.js";
import type { RequestScope } from "../identity/identity-provider.js";
import type { PiSandboxWorkspaceAccess } from "./contracts.js";

export type PiSandboxAllocationState =
  | "reserved"
  | "materializing"
  | "ready"
  | "materialization_failed"
  | "deleting"
  | "delete_failed"
  | "deleted";

export type PiSandboxAllocationRecord = {
  readonly tenantId: string;
  readonly ownerPrincipalId: string;
  readonly applicationThreadId: string;
  readonly allocationId: string;
  readonly executionEnvironmentId: string;
  readonly sourceWorkspaceId: string;
  readonly sourceCanonicalPath: string;
  readonly allocationRootPath: string;
  readonly homePath: string;
  readonly workspacePath: string;
  readonly workspaceAccess: PiSandboxWorkspaceAccess;
  readonly networkProfile: "isolated" | "execution_host";
  readonly state: PiSandboxAllocationState;
  readonly retention: "active" | "retained" | "delete_requested";
  readonly operationId: string | null;
  readonly completedDeleteOperationId: string | null;
  readonly operationKind: "materialize" | "delete" | null;
  readonly diagnosticCode: string | null;
  readonly sourceHeadOid: string | null;
  readonly sandboxBranch: string | null;
  readonly revision: number;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly readyAt: number | null;
  readonly retainedAt: number | null;
  readonly deletedAt: number | null;
};

const columns = `
  tenant_id AS tenantId,
  owner_principal_id AS ownerPrincipalId,
  application_thread_id AS applicationThreadId,
  allocation_id AS allocationId,
  execution_environment_id AS executionEnvironmentId,
  source_workspace_id AS sourceWorkspaceId,
  source_canonical_path AS sourceCanonicalPath,
  allocation_root_path AS allocationRootPath,
  home_path AS homePath,
  workspace_path AS workspacePath,
  workspace_access AS workspaceAccess,
  network_profile AS networkProfile,
  state, retention,
  operation_id AS operationId,
  completed_delete_operation_id AS completedDeleteOperationId,
  operation_kind AS operationKind,
  diagnostic_code AS diagnosticCode,
  source_head_oid AS sourceHeadOid,
  sandbox_branch AS sandboxBranch,
  revision,
  created_at AS createdAt,
  updated_at AS updatedAt,
  ready_at AS readyAt,
  retained_at AS retainedAt,
  deleted_at AS deletedAt
`;

function conflict(message: string): never {
  throw new DomainError("conflict", message);
}

export function piSandboxEffectiveWorkspacePath(
  allocation: PiSandboxAllocationRecord,
): string {
  return allocation.workspaceAccess === "read_only"
    ? allocation.sourceCanonicalPath
    : allocation.workspacePath;
}

export class PiSandboxAllocationRepository {
  constructor(readonly database: Database.Database) {}

  getForThread(
    scope: RequestScope,
    applicationThreadId: string,
  ): PiSandboxAllocationRecord | undefined {
    return this.database
      .prepare(
        `SELECT ${columns}
         FROM pi_sandbox_allocations
         WHERE tenant_id = ? AND owner_principal_id = ?
           AND application_thread_id = ?`,
      )
      .get(scope.tenantId, scope.principalId, applicationThreadId) as
      | PiSandboxAllocationRecord
      | undefined;
  }

  reserve(
    scope: RequestScope,
    input: {
      readonly applicationThreadId: string;
      readonly allocationId: string;
      readonly executionEnvironmentId: string;
      readonly sourceWorkspaceId: string;
      readonly sourceCanonicalPath: string;
      readonly workspaceAccess: PiSandboxWorkspaceAccess;
      readonly allocationRootPath: string;
      readonly homePath: string;
      readonly workspacePath: string;
      readonly networkProfile: "isolated" | "execution_host";
      readonly now: number;
    },
  ): PiSandboxAllocationRecord {
    return this.database.transaction(() => {
      const existing = this.getForThread(scope, input.applicationThreadId);
      if (existing) {
        const same =
          existing.allocationId === input.allocationId &&
          existing.executionEnvironmentId === input.executionEnvironmentId &&
          existing.sourceWorkspaceId === input.sourceWorkspaceId &&
          existing.sourceCanonicalPath === input.sourceCanonicalPath &&
          existing.allocationRootPath === input.allocationRootPath &&
          existing.homePath === input.homePath &&
          existing.workspacePath === input.workspacePath &&
          existing.workspaceAccess === input.workspaceAccess &&
          existing.networkProfile === input.networkProfile;
        if (!same) conflict("The thread already owns another sandbox allocation.");
        return existing;
      }

      const authority = this.database
        .prepare(
          `SELECT 1
           FROM application_threads AS thread
           JOIN workspaces AS workspace
             ON workspace.tenant_id = thread.tenant_id
            AND workspace.owner_principal_id = thread.owner_principal_id
            AND workspace.environment_id = thread.environment_id
            AND workspace.id = thread.workspace_id
           WHERE thread.tenant_id = ? AND thread.owner_principal_id = ?
             AND thread.id = ? AND thread.environment_id = ?
             AND thread.workspace_id = ? AND workspace.canonical_path = ?`,
        )
        .get(
          scope.tenantId,
          scope.principalId,
          input.applicationThreadId,
          input.executionEnvironmentId,
          input.sourceWorkspaceId,
          input.sourceCanonicalPath,
        );
      if (!authority) {
        throw new DomainError(
          "not_found",
          "The thread source workspace was not found in the execution environment.",
        );
      }

      this.database
        .prepare(
          `INSERT INTO pi_sandbox_allocations(
             tenant_id, owner_principal_id, application_thread_id,
             allocation_id, execution_environment_id, source_workspace_id,
             source_canonical_path, allocation_root_path, home_path,
             workspace_path, workspace_access, network_profile, state, retention,
             created_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'reserved', 'active', ?, ?)`,
        )
        .run(
          scope.tenantId,
          scope.principalId,
          input.applicationThreadId,
          input.allocationId,
          input.executionEnvironmentId,
          input.sourceWorkspaceId,
          input.sourceCanonicalPath,
          input.allocationRootPath,
          input.homePath,
          input.workspacePath,
          input.workspaceAccess,
          input.networkProfile,
          input.now,
          input.now,
        );
      return this.requireForThread(scope, input.applicationThreadId);
    })();
  }

  requireForThread(
    scope: RequestScope,
    applicationThreadId: string,
  ): PiSandboxAllocationRecord {
    const record = this.getForThread(scope, applicationThreadId);
    if (!record) {
      throw new DomainError("not_found", "The thread sandbox was not found.");
    }
    return record;
  }

  beginMaterialization(
    scope: RequestScope,
    applicationThreadId: string,
    input: { readonly expectedRevision: number; readonly operationId: string; readonly now: number },
  ): PiSandboxAllocationRecord {
    const current = this.requireForThread(scope, applicationThreadId);
    if (current.state === "materializing" && current.operationId === input.operationId) {
      return current;
    }
    if (
      current.revision !== input.expectedRevision ||
      !["reserved", "materialization_failed"].includes(current.state) ||
      current.retention === "delete_requested"
    ) {
      conflict("The sandbox cannot begin materialization from its current state.");
    }
    this.#transition(scope, applicationThreadId, input.expectedRevision, {
      state: "materializing",
      retention: current.retention,
      operationId: input.operationId,
      operationKind: "materialize",
      diagnosticCode: null,
      now: input.now,
    });
    return this.requireForThread(scope, applicationThreadId);
  }

  completeMaterialization(
    scope: RequestScope,
    applicationThreadId: string,
    input: {
      readonly operationId: string;
      readonly sourceHeadOid: string | null;
      readonly sandboxBranch: string | null;
      readonly now: number;
    },
  ): PiSandboxAllocationRecord {
    const result = this.database
      .prepare(
        `UPDATE pi_sandbox_allocations
         SET state = 'ready', operation_id = NULL, operation_kind = NULL,
           diagnostic_code = NULL, source_head_oid = ?, sandbox_branch = ?,
           ready_at = ?, updated_at = ?, revision = revision + 1
         WHERE tenant_id = ? AND owner_principal_id = ?
           AND application_thread_id = ? AND state = 'materializing'
           AND operation_id = ? AND operation_kind = 'materialize'`,
      )
      .run(
        input.sourceHeadOid,
        input.sandboxBranch,
        input.now,
        input.now,
        scope.tenantId,
        scope.principalId,
        applicationThreadId,
        input.operationId,
      );
    if (result.changes !== 1) conflict("The sandbox materialization operation changed.");
    return this.requireForThread(scope, applicationThreadId);
  }

  failMaterialization(
    scope: RequestScope,
    applicationThreadId: string,
    input: { readonly operationId: string; readonly diagnosticCode: string; readonly now: number },
  ): PiSandboxAllocationRecord {
    return this.#completeFailedOperation(scope, applicationThreadId, {
      ...input,
      operationKind: "materialize",
      state: "materialization_failed",
    });
  }

  markRetained(
    scope: RequestScope,
    applicationThreadId: string,
    input: { readonly expectedRevision: number; readonly now: number },
  ): PiSandboxAllocationRecord {
    const current = this.requireForThread(scope, applicationThreadId);
    if (current.retention === "retained") return current;
    if (
      current.revision !== input.expectedRevision ||
      ["deleting", "deleted"].includes(current.state)
    ) {
      conflict("The sandbox cannot be retained from its current state.");
    }
    const result = this.database
      .prepare(
        `UPDATE pi_sandbox_allocations
         SET retention = 'retained', retained_at = ?, updated_at = ?,
           revision = revision + 1
         WHERE tenant_id = ? AND owner_principal_id = ?
           AND application_thread_id = ? AND revision = ?`,
      )
      .run(
        input.now,
        input.now,
        scope.tenantId,
        scope.principalId,
        applicationThreadId,
        input.expectedRevision,
      );
    if (result.changes !== 1) conflict("The sandbox changed while being retained.");
    return this.requireForThread(scope, applicationThreadId);
  }

  beginDeletion(
    scope: RequestScope,
    applicationThreadId: string,
    input: { readonly expectedRevision: number; readonly operationId: string; readonly now: number },
  ): PiSandboxAllocationRecord {
    const current = this.requireForThread(scope, applicationThreadId);
    if (current.state === "deleting" && current.operationId === input.operationId) {
      return current;
    }
    if (
      current.state === "deleted" &&
      current.completedDeleteOperationId === input.operationId
    ) {
      return current;
    }
    if (
      current.revision !== input.expectedRevision ||
      ["materializing", "deleting", "deleted"].includes(current.state)
    ) {
      conflict("The sandbox cannot begin deletion from its current state.");
    }
    this.#transition(scope, applicationThreadId, input.expectedRevision, {
      state: "deleting",
      retention: "delete_requested",
      operationId: input.operationId,
      operationKind: "delete",
      diagnosticCode: null,
      now: input.now,
    });
    return this.requireForThread(scope, applicationThreadId);
  }

  completeDeletion(
    scope: RequestScope,
    applicationThreadId: string,
    input: { readonly operationId: string; readonly now: number },
  ): PiSandboxAllocationRecord {
    const result = this.database
      .prepare(
        `UPDATE pi_sandbox_allocations
         SET state = 'deleted', operation_id = NULL, operation_kind = NULL,
           completed_delete_operation_id = ?, diagnostic_code = NULL,
           deleted_at = ?, updated_at = ?,
           revision = revision + 1
         WHERE tenant_id = ? AND owner_principal_id = ?
           AND application_thread_id = ? AND state = 'deleting'
           AND operation_id = ? AND operation_kind = 'delete'`,
      )
      .run(
        input.operationId,
        input.now,
        input.now,
        scope.tenantId,
        scope.principalId,
        applicationThreadId,
        input.operationId,
      );
    if (result.changes !== 1) conflict("The sandbox deletion operation changed.");
    return this.requireForThread(scope, applicationThreadId);
  }

  failDeletion(
    scope: RequestScope,
    applicationThreadId: string,
    input: { readonly operationId: string; readonly diagnosticCode: string; readonly now: number },
  ): PiSandboxAllocationRecord {
    return this.#completeFailedOperation(scope, applicationThreadId, {
      ...input,
      operationKind: "delete",
      state: "delete_failed",
    });
  }

  listRecoverable(scope: RequestScope): PiSandboxAllocationRecord[] {
    return this.database
      .prepare(
        `SELECT ${columns}
         FROM pi_sandbox_allocations
         WHERE tenant_id = ? AND owner_principal_id = ?
           AND state IN ('materializing', 'materialization_failed', 'deleting', 'delete_failed')
         ORDER BY updated_at, application_thread_id`,
      )
      .all(scope.tenantId, scope.principalId) as PiSandboxAllocationRecord[];
  }

  /**
   * Startup crash reconciliation. An external filesystem operation that was
   * in flight when the sole application process stopped has an unknown
   * outcome; it is never promoted to success from SQLite alone. Clearing its
   * operation identity permits an explicit, newly identified retry.
   */
  reconcileInterruptedOperations(
    scope: RequestScope,
    input: { readonly now: number },
  ): PiSandboxAllocationRecord[] {
    return this.database.transaction(() => {
      const interrupted = this.database
        .prepare(
          `SELECT application_thread_id AS applicationThreadId
           FROM pi_sandbox_allocations
           WHERE tenant_id = ? AND owner_principal_id = ?
             AND state IN ('materializing', 'deleting')
           ORDER BY application_thread_id`,
        )
        .all(scope.tenantId, scope.principalId) as Array<{
        readonly applicationThreadId: string;
      }>;
      if (interrupted.length === 0) return [];
      this.database
        .prepare(
          `UPDATE pi_sandbox_allocations
           SET state = CASE state
                 WHEN 'materializing' THEN 'materialization_failed'
                 ELSE 'delete_failed'
               END,
             operation_id = NULL,
             operation_kind = NULL,
             diagnostic_code = CASE state
               WHEN 'materializing' THEN 'materialization_interrupted'
               ELSE 'deletion_interrupted'
             END,
             updated_at = ?,
             revision = revision + 1
           WHERE tenant_id = ? AND owner_principal_id = ?
             AND state IN ('materializing', 'deleting')`,
        )
        .run(input.now, scope.tenantId, scope.principalId);
      return interrupted.map(({ applicationThreadId }) =>
        this.requireForThread(scope, applicationThreadId),
      );
    })();
  }

  #transition(
    scope: RequestScope,
    applicationThreadId: string,
    expectedRevision: number,
    input: {
      readonly state: PiSandboxAllocationState;
      readonly retention: PiSandboxAllocationRecord["retention"];
      readonly operationId: string;
      readonly operationKind: "materialize" | "delete";
      readonly diagnosticCode: string | null;
      readonly now: number;
    },
  ): void {
    const result = this.database
      .prepare(
        `UPDATE pi_sandbox_allocations
         SET state = ?, retention = ?,
           retained_at = CASE WHEN ? = 'retained' THEN retained_at ELSE NULL END,
           operation_id = ?, operation_kind = ?, diagnostic_code = ?,
           updated_at = ?, revision = revision + 1
         WHERE tenant_id = ? AND owner_principal_id = ?
           AND application_thread_id = ? AND revision = ?`,
      )
      .run(
        input.state,
        input.retention,
        input.retention,
        input.operationId,
        input.operationKind,
        input.diagnosticCode,
        input.now,
        scope.tenantId,
        scope.principalId,
        applicationThreadId,
        expectedRevision,
      );
    if (result.changes !== 1) conflict("The sandbox allocation changed concurrently.");
  }

  #completeFailedOperation(
    scope: RequestScope,
    applicationThreadId: string,
    input: {
      readonly operationId: string;
      readonly operationKind: "materialize" | "delete";
      readonly state: "materialization_failed" | "delete_failed";
      readonly diagnosticCode: string;
      readonly now: number;
    },
  ): PiSandboxAllocationRecord {
    const result = this.database
      .prepare(
        `UPDATE pi_sandbox_allocations
         SET state = ?, operation_id = NULL, operation_kind = NULL,
           diagnostic_code = ?, updated_at = ?, revision = revision + 1
         WHERE tenant_id = ? AND owner_principal_id = ?
           AND application_thread_id = ? AND operation_id = ?
           AND operation_kind = ?`,
      )
      .run(
        input.state,
        input.diagnosticCode,
        input.now,
        scope.tenantId,
        scope.principalId,
        applicationThreadId,
        input.operationId,
        input.operationKind,
      );
    if (result.changes !== 1) conflict("The sandbox operation changed before failure was recorded.");
    return this.requireForThread(scope, applicationThreadId);
  }
}
