import { createHash } from "node:crypto";
import type Database from "better-sqlite3";
import type { RequestScope } from "../../identity/identity-provider.js";
import { DomainError } from "../../domain/errors.js";
import type { BackendKind } from "../../backends/contracts.js";
import type { BackendCreationProvenanceRepairRegistry } from "../../backends/creation-provenance-repair.js";

export interface ConversationCreationProvenance {
  readonly tenantId: string;
  readonly ownerPrincipalId: string;
  readonly applicationThreadId: string;
  readonly backendInstanceId: string;
  readonly connectionProfileId: string;
  readonly executionEnvironmentId: string;
  readonly backendConversationId: string;
  readonly attemptId: string;
  readonly creationKind: "first_input" | "fork";
}

export interface CreationProvenanceRepairEvidence extends ConversationCreationProvenance {
  readonly backendKind: BackendKind;
  readonly mutationId: string;
  readonly forceResetAt: number;
  readonly phase: string;
  readonly inventoryState: string;
  /** Exact private receipt/settings snapshot used by backend validation. */
  readonly backendEvidence: string;
  readonly workspaceId: string;
  readonly canonicalWorkspacePath: string;
  readonly connectionKind: string;
  readonly backingState: string;
  readonly fingerprint: string;
}

const columns = `proof.tenant_id AS tenantId, proof.owner_principal_id AS ownerPrincipalId,
  proof.application_thread_id AS applicationThreadId, proof.backend_instance_id AS backendInstanceId,
  proof.connection_profile_id AS connectionProfileId, proof.execution_environment_id AS executionEnvironmentId,
  proof.backend_conversation_id AS backendConversationId, proof.attempt_id AS attemptId,
  proof.creation_kind AS creationKind`;

/** Native creation identity outlives the operation that submits its first input. */
export class ConversationCreationProvenanceRepository {
  constructor(readonly database: Database.Database, readonly repairAdapters?: BackendCreationProvenanceRepairRegistry) {}

  get(scope: RequestScope, applicationThreadId: string): ConversationCreationProvenance | undefined {
    return this.database.prepare(`SELECT ${columns} FROM conversation_creation_provenance AS proof
      WHERE proof.tenant_id=? AND proof.owner_principal_id=? AND proof.application_thread_id=?`)
      .get(scope.tenantId, scope.principalId, applicationThreadId) as ConversationCreationProvenance | undefined;
  }

  /** Read-only preparation state, not native identity or mutation authority. */
  isCreationInProgress(scope: RequestScope, applicationThreadId: string, kind?: "first_input" | "fork"): boolean {
    const rows = this.database.prepare(`SELECT attempt.attempt_id FROM application_threads AS thread
      JOIN conversation_creation_attempts AS attempt ON attempt.tenant_id=thread.tenant_id
        AND attempt.owner_principal_id=thread.owner_principal_id AND attempt.application_thread_id=thread.id
        AND attempt.backend_instance_id=thread.backend_instance_id AND attempt.connection_profile_id=thread.connection_profile_id
        AND attempt.execution_environment_id=thread.environment_id
      WHERE thread.tenant_id=? AND thread.owner_principal_id=? AND thread.id=? AND thread.backing_state='creating'
        AND attempt.force_reset_at IS NULL
        AND (? IS NULL OR attempt.creation_kind=?)
        AND attempt.phase IN ('prepared','external_call_started','conversation_identified','first_submission_started','accepted_unpersisted') LIMIT 2`)
      .all(scope.tenantId, scope.principalId, applicationThreadId, kind ?? null, kind ?? null);
    return rows.length === 1;
  }

  matchesBinding(scope: RequestScope, applicationThreadId: string,
    expected: { readonly backendInstanceId?: string; readonly backendConversationId?: string } = {}): boolean {
    const proof = this.database.prepare(`SELECT ${columns} FROM conversation_creation_provenance AS proof
      JOIN conversation_bindings AS binding ON binding.tenant_id=proof.tenant_id
        AND binding.owner_principal_id=proof.owner_principal_id AND binding.application_thread_id=proof.application_thread_id
        AND binding.backend_instance_id=proof.backend_instance_id AND binding.connection_profile_id=proof.connection_profile_id
        AND binding.execution_environment_id=proof.execution_environment_id AND binding.backend_conversation_id=proof.backend_conversation_id
      JOIN application_threads AS thread ON thread.tenant_id=binding.tenant_id AND thread.owner_principal_id=binding.owner_principal_id
        AND thread.id=binding.application_thread_id AND thread.backend_instance_id=binding.backend_instance_id
        AND thread.connection_profile_id=binding.connection_profile_id AND thread.environment_id=binding.execution_environment_id
      WHERE proof.tenant_id=? AND proof.owner_principal_id=? AND proof.application_thread_id=?`)
      .get(scope.tenantId, scope.principalId, applicationThreadId) as ConversationCreationProvenance | undefined;
    return !!proof && (expected.backendInstanceId === undefined || proof.backendInstanceId === expected.backendInstanceId)
      && (expected.backendConversationId === undefined || proof.backendConversationId === expected.backendConversationId);
  }

  /** Called only inside the transaction that binds an already verified native create. */
  recordVerifiedBinding(scope: RequestScope, applicationThreadId: string, attemptId: string, now: number): void {
    if (!this.database.inTransaction) throw new Error("creation_provenance_requires_binding_transaction");
    const result = this.database.prepare(`INSERT INTO conversation_creation_provenance
      SELECT binding.tenant_id,binding.owner_principal_id,binding.application_thread_id,binding.backend_instance_id,
        binding.connection_profile_id,binding.execution_environment_id,binding.backend_conversation_id,
        attempt.attempt_id,attempt.creation_kind,?,'binding'
      FROM conversation_bindings AS binding JOIN conversation_creation_attempts AS attempt
        ON attempt.tenant_id=binding.tenant_id AND attempt.owner_principal_id=binding.owner_principal_id
        AND attempt.application_thread_id=binding.application_thread_id AND attempt.backend_instance_id=binding.backend_instance_id
        AND attempt.connection_profile_id=binding.connection_profile_id AND attempt.execution_environment_id=binding.execution_environment_id
        AND attempt.provisional_backend_conversation_id=binding.backend_conversation_id
      WHERE binding.tenant_id=? AND binding.owner_principal_id=? AND binding.application_thread_id=?
        AND attempt.attempt_id=? AND attempt.force_reset_at IS NULL
        AND attempt.phase IN ('conversation_identified','first_submission_started','accepted_unpersisted','recovery_required','bound')
        AND attempt.provisional_opaque_binding_detail IS NOT NULL AND attempt.external_call_started_at IS NOT NULL
      ON CONFLICT(tenant_id,owner_principal_id,application_thread_id) DO NOTHING`)
      .run(now, scope.tenantId, scope.principalId, applicationThreadId, attemptId);
    const proof = this.get(scope, applicationThreadId);
    if ((!result.changes && !proof) || proof?.attemptId !== attemptId || !this.matchesBinding(scope, applicationThreadId)) {
      throw new DomainError("conflict", "The verified creation identity does not match the current binding.");
    }
  }

  previewRepair(scope: RequestScope, applicationThreadId: string, expectedNativeSessionId: string): CreationProvenanceRepairEvidence {
    const rows = this.database.prepare(`SELECT binding.tenant_id AS tenantId,binding.owner_principal_id AS ownerPrincipalId,
      binding.application_thread_id AS applicationThreadId,binding.backend_instance_id AS backendInstanceId,
      binding.connection_profile_id AS connectionProfileId,binding.execution_environment_id AS executionEnvironmentId,
      binding.backend_conversation_id AS backendConversationId,attempt.attempt_id AS attemptId,attempt.creation_kind AS creationKind,
      backend.kind AS backendKind,attempt.mutation_id AS mutationId,
      attempt.force_reset_at AS forceResetAt,attempt.phase,inventory.inventory_state AS inventoryState,
      thread.workspace_id AS workspaceId,workspace.canonical_path AS canonicalWorkspacePath,
      profile.kind AS connectionKind,thread.backing_state AS backingState
      FROM conversation_bindings AS binding JOIN application_threads AS thread
        ON thread.tenant_id=binding.tenant_id AND thread.owner_principal_id=binding.owner_principal_id AND thread.id=binding.application_thread_id
        AND thread.backend_instance_id=binding.backend_instance_id AND thread.connection_profile_id=binding.connection_profile_id
        AND thread.environment_id=binding.execution_environment_id
      JOIN agent_backend_instances AS backend ON backend.tenant_id=binding.tenant_id AND backend.id=binding.backend_instance_id
      JOIN thread_principal_state AS inventory ON inventory.tenant_id=binding.tenant_id
        AND inventory.principal_id=binding.owner_principal_id AND inventory.thread_id=binding.application_thread_id
      JOIN workspaces AS workspace ON workspace.tenant_id=thread.tenant_id AND workspace.owner_principal_id=thread.owner_principal_id
        AND workspace.id=thread.workspace_id AND workspace.environment_id=thread.environment_id
      JOIN agent_connection_profiles AS profile ON profile.tenant_id=thread.tenant_id AND profile.owner_principal_id=thread.owner_principal_id
        AND profile.id=thread.connection_profile_id AND profile.backend_instance_id=thread.backend_instance_id
        AND profile.execution_environment_id=thread.environment_id
      JOIN conversation_creation_attempts AS attempt ON attempt.tenant_id=binding.tenant_id AND attempt.owner_principal_id=binding.owner_principal_id
        AND attempt.application_thread_id=binding.application_thread_id AND attempt.backend_instance_id=binding.backend_instance_id
        AND attempt.connection_profile_id=binding.connection_profile_id AND attempt.execution_environment_id=binding.execution_environment_id
        AND attempt.provisional_backend_conversation_id=binding.backend_conversation_id
      WHERE binding.tenant_id=? AND binding.owner_principal_id=? AND binding.application_thread_id=? AND binding.backend_conversation_id=?
        AND attempt.force_reset_at IS NOT NULL
        AND attempt.phase IN ('conversation_identified','first_submission_started','accepted_unpersisted','recovery_required')
        AND attempt.provisional_opaque_binding_detail IS NOT NULL AND attempt.external_call_started_at IS NOT NULL LIMIT 2`)
      .all(scope.tenantId, scope.principalId, applicationThreadId, expectedNativeSessionId) as Omit<CreationProvenanceRepairEvidence, "fingerprint" | "backendEvidence">[];
    if (rows.length !== 1) throw new DomainError("conflict", "Repair requires one exact verified creation and current native binding.");
    const row = rows[0]!;
    const adapter = this.repairAdapters?.creationProvenanceRepairForBackendKind(row.backendKind);
    if (!adapter) throw new DomainError("invalid_transition", "This backend has no supported abandoned-creation repair.");
    const backendEvidence = adapter.collectVerifiedEvidence({ database: this.database, scope, ...row });
    if (backendEvidence === undefined) throw new DomainError("conflict", "The retained backend creation evidence does not verify this exact binding.");
    const evidence = { ...row, backendEvidence };
    return { ...evidence, fingerprint: createHash("sha256").update(JSON.stringify(evidence)).digest("hex") };
  }

  applyRepair(scope: RequestScope, applicationThreadId: string, input: {
    readonly expectedNativeSessionId: string; readonly expectedFingerprint: string; readonly now: number; readonly repairId: string;
  }): CreationProvenanceRepairEvidence {
    return this.database.transaction(() => {
      const evidence = this.previewRepair(scope, applicationThreadId, input.expectedNativeSessionId);
      if (evidence.fingerprint !== input.expectedFingerprint) {
        throw new DomainError("conflict", "The native creation evidence is invalid or changed after preview.");
      }
      if (this.get(scope, applicationThreadId)) throw new DomainError("conflict", "This thread already has creation provenance.");
      this.database.prepare(`INSERT INTO conversation_creation_provenance VALUES (?,?,?,?,?,?,?,?,?,?,'repair')`)
        .run(scope.tenantId, scope.principalId, applicationThreadId, evidence.backendInstanceId,evidence.connectionProfileId,
          evidence.executionEnvironmentId,evidence.backendConversationId,evidence.attemptId,evidence.creationKind,input.now);
      this.database.prepare(`INSERT INTO conversation_creation_provenance_repairs VALUES (?,?,?,?,?,?)`)
        .run(scope.tenantId,scope.principalId,input.repairId,applicationThreadId,evidence.fingerprint,input.now);
      return evidence;
    }).immediate();
  }
}
