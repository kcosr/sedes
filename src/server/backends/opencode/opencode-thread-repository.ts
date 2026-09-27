import type Database from "better-sqlite3";
import { z } from "zod";
import { DomainError } from "../../domain/errors.js";
import type { RequestScope } from "../../identity/identity-provider.js";
import { parseOpenCodeBindingDetail, serializeOpenCodeBindingDetail, type OpenCodeBindingDetail } from "./opencode-binding-detail.js";

const identifier = z.string().min(1).max(1_024).regex(/^[^\u0000-\u001f\u007f-\u009f]+$/u);
const fingerprint = z.string().regex(/^[0-9a-f]{64}$/u);
const sourceSchema = z.discriminatedUnion("kind", [z.strictObject({ kind: z.literal("user") }),
  z.strictObject({ kind: z.literal("automation"), automationId: identifier, automationRunId: identifier })]);
const operationSchema = z.strictObject({
  applicationThreadId: identifier,
  connectionProfileId: identifier,
  executionEnvironmentId: identifier,
  nativeSessionId: identifier,
  applicationOperationId: identifier,
  operationKind: z.enum(["create", "submit", "steer", "fork", "interrupt", "action", "interaction"]),
  nativeInputId: identifier.nullable(),
  requestFingerprint: fingerprint,
  requestSource: sourceSchema.nullable(),
  deadlineAt: z.number().int().nonnegative().safe().nullable(),
}).refine(value => value.operationKind !== "interrupt" || value.deadlineAt !== null);
export type OpenCodeOperationEvidence = z.infer<typeof operationSchema>;
export type OpenCodeOperationKind = OpenCodeOperationEvidence["operationKind"];
export type OpenCodeOperationDisposition = "prepared" | "dispatched" | "accepted" | "not_applied" | "unknown";
export interface OpenCodeOperationReceipt extends OpenCodeOperationEvidence {
  readonly disposition: OpenCodeOperationDisposition;
  readonly nativeEvidenceFingerprint: string | null;
  readonly createdAt: number;
  readonly updatedAt: number;
}
interface Target {
  backendInstanceId: string;
  connectionProfileId: string;
  executionEnvironmentId: string;
  canonicalWorkspacePath: string;
  backendKind: string;
  connectionKind: string;
}
interface ActiveAttempt {
  mutationId: string;
  phase: string;
  reservedId: string;
  sessionId: string | null;
  detail: string | null;
  sourceKind: string;
  automationId: string | null;
  automationRunId: string | null;
}

/** One scoped native namespace; no provider requests or inferred admission. */
export class OpenCodeThreadRepository {
  readonly database: Database.Database;
  readonly #scope: RequestScope;
  readonly #backendInstanceId: string;
  readonly #nativeNamespaceKey: string;

  constructor(input: { database: Database.Database; scope: RequestScope; backendInstanceId: string; nativeNamespaceKey: string }) {
    this.database = input.database;
    this.#scope = Object.freeze({ tenantId: identifier.parse(input.scope.tenantId), principalId: identifier.parse(input.scope.principalId) });
    this.#backendInstanceId = identifier.parse(input.backendInstanceId);
    this.#nativeNamespaceKey = identifier.parse(input.nativeNamespaceKey);
  }

  saveBinding(scope: RequestScope, applicationThreadId: string, detail: OpenCodeBindingDetail): void {
    this.#assertScope(scope);
    const canonical = serializeOpenCodeBindingDetail(detail);
    const checked = parseOpenCodeBindingDetail(canonical);
    const target = this.#target(scope, applicationThreadId);
    this.#assertDetail(scope, target, checked);
    const binding = this.database.prepare(`SELECT backend_conversation_id AS sessionId
      FROM conversation_bindings WHERE tenant_id = ? AND owner_principal_id = ? AND application_thread_id = ?
      AND backend_instance_id = ? AND connection_profile_id = ? AND execution_environment_id = ?`)
      .get(scope.tenantId, scope.principalId, applicationThreadId, this.#backendInstanceId,
        target.connectionProfileId, target.executionEnvironmentId) as { sessionId: string } | undefined;
    if (binding?.sessionId !== checked.sessionId) throw mismatch();
    const existing = this.getBinding(scope, applicationThreadId);
    if (existing !== undefined) {
      if (existing !== canonical) throw mismatch();
      return;
    }
    this.database.prepare(`INSERT INTO opencode_binding_details (
      tenant_id, owner_principal_id, application_thread_id, backend_instance_id,
      connection_profile_id, execution_environment_id, native_namespace_key, native_session_id, opaque_binding_detail
    ) VALUES (?,?,?,?,?,?,?,?,?)`).run(scope.tenantId, scope.principalId, applicationThreadId,
      this.#backendInstanceId, target.connectionProfileId, target.executionEnvironmentId,
      this.#nativeNamespaceKey, checked.sessionId, canonical);
  }

  getBinding(scope: RequestScope, applicationThreadId: string): string | undefined {
    this.#assertScope(scope);
    const row = this.database.prepare(`SELECT opaque_binding_detail AS detail, native_session_id AS sessionId,
      backend_instance_id AS backendInstanceId, native_namespace_key AS nativeNamespaceKey
      FROM opencode_binding_details WHERE tenant_id = ? AND owner_principal_id = ? AND application_thread_id = ?`)
      .get(scope.tenantId, scope.principalId, applicationThreadId) as {
        detail: string; sessionId: string; backendInstanceId: string; nativeNamespaceKey: string;
      } | undefined;
    if (!row) return undefined;
    if (row.backendInstanceId !== this.#backendInstanceId || row.nativeNamespaceKey !== this.#nativeNamespaceKey) throw mismatch();
    const target = this.#target(scope, applicationThreadId);
    const detail = parseOpenCodeBindingDetail(row.detail);
    this.#assertDetail(scope, target, detail);
    const bound = this.database.prepare(`SELECT backend_conversation_id AS sessionId FROM conversation_bindings
      WHERE tenant_id = ? AND owner_principal_id = ? AND application_thread_id = ?
      AND backend_instance_id = ? AND connection_profile_id = ? AND execution_environment_id = ?`)
      .get(scope.tenantId, scope.principalId, applicationThreadId, this.#backendInstanceId,
        target.connectionProfileId, target.executionEnvironmentId) as { sessionId: string } | undefined;
    if (detail.sessionId !== row.sessionId || bound?.sessionId !== detail.sessionId) throw mismatch();
    return serializeOpenCodeBindingDetail(detail);
  }

  reserveOperation(scope: RequestScope, evidence: OpenCodeOperationEvidence, now: number): OpenCodeOperationReceipt {
    this.#assertScope(scope);
    const input = operationSchema.parse(evidence);
    this.#assertOperationTarget(scope, input);
    const current = this.readOperation(scope, input.applicationThreadId, input.applicationOperationId, input.operationKind);
    if (current) {
      if (JSON.stringify(operationSchema.parse(currentEvidence(current))) !== JSON.stringify(input)) throw mismatch();
      return current;
    }
    this.database.prepare(`INSERT INTO opencode_operation_receipts (
      tenant_id, owner_principal_id, application_thread_id, backend_instance_id, connection_profile_id,
      execution_environment_id, native_namespace_key, native_session_id, application_operation_id,
      operation_kind, native_input_id, request_fingerprint, request_source_json, deadline_at, disposition, created_at, updated_at
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,'prepared',?,?)`).run(scope.tenantId, scope.principalId,
      input.applicationThreadId, this.#backendInstanceId, input.connectionProfileId, input.executionEnvironmentId,
      this.#nativeNamespaceKey, input.nativeSessionId, input.applicationOperationId, input.operationKind,
      input.nativeInputId, input.requestFingerprint, input.requestSource === null ? null : JSON.stringify(input.requestSource), input.deadlineAt, now, now);
    return this.readOperation(scope, input.applicationThreadId, input.applicationOperationId, input.operationKind)!;
  }

  readOperation(scope: RequestScope, applicationThreadId: string, applicationOperationId: string, operationKind: OpenCodeOperationKind): Readonly<OpenCodeOperationReceipt> | undefined {
    this.#assertScope(scope);
    const row = this.database.prepare(`SELECT application_thread_id AS applicationThreadId,
      backend_instance_id AS backendInstanceId, native_namespace_key AS nativeNamespaceKey,
      connection_profile_id AS connectionProfileId, execution_environment_id AS executionEnvironmentId,
      native_session_id AS nativeSessionId, application_operation_id AS applicationOperationId,
      operation_kind AS operationKind, native_input_id AS nativeInputId, request_fingerprint AS requestFingerprint,
      request_source_json AS requestSourceJson,
      deadline_at AS deadlineAt, disposition, native_evidence_fingerprint AS nativeEvidenceFingerprint,
      created_at AS createdAt, updated_at AS updatedAt FROM opencode_operation_receipts
      WHERE tenant_id = ? AND owner_principal_id = ? AND application_operation_id = ? AND operation_kind = ?`)
      .get(scope.tenantId, scope.principalId, applicationOperationId, operationKind) as
      (Omit<OpenCodeOperationReceipt, "requestSource"> & { requestSourceJson: string | null; backendInstanceId: string; nativeNamespaceKey: string }) | undefined;
    if (!row) return undefined;
    if (row.applicationThreadId !== applicationThreadId || row.backendInstanceId !== this.#backendInstanceId || row.nativeNamespaceKey !== this.#nativeNamespaceKey) throw mismatch();
    const { backendInstanceId: _backend, nativeNamespaceKey: _namespace, requestSourceJson, ...stored } = row;
    const receipt = { ...stored, requestSource: requestSourceJson === null ? null : sourceSchema.parse(JSON.parse(requestSourceJson)) };
    operationSchema.parse(currentEvidence(receipt));
    this.#assertOperationTarget(scope, receipt);
    return Object.freeze(receipt);
  }

  /** Returns true only to the caller that first reserves dispatch authority. */
  markDispatched(scope: RequestScope, applicationThreadId: string, applicationOperationId: string, operationKind: OpenCodeOperationKind, now: number): boolean {
    this.requireOperation(scope, applicationThreadId, applicationOperationId, operationKind);
    return this.database.prepare(`UPDATE opencode_operation_receipts SET disposition = 'dispatched', updated_at = ?
      WHERE tenant_id = ? AND owner_principal_id = ? AND application_operation_id = ? AND operation_kind = ? AND disposition = 'prepared'
      AND (deadline_at IS NULL OR deadline_at > ?)`).run(now, scope.tenantId, scope.principalId, applicationOperationId, operationKind, now).changes === 1;
  }

  recordOutcome(scope: RequestScope, applicationThreadId: string, applicationOperationId: string, operationKind: OpenCodeOperationKind, input: {
    expected: "prepared" | "dispatched" | "unknown";
    disposition: "accepted" | "not_applied" | "unknown";
    nativeEvidenceFingerprint: string | null;
    now: number;
  }): boolean {
    const current = this.requireOperation(scope, applicationThreadId, applicationOperationId, operationKind);
    if (input.nativeEvidenceFingerprint !== null) fingerprint.parse(input.nativeEvidenceFingerprint);
    if (current.disposition === "accepted" || current.disposition === "not_applied") {
      if (current.disposition !== input.disposition || current.nativeEvidenceFingerprint !== input.nativeEvidenceFingerprint) throw mismatch();
      return true;
    }
    if (input.disposition === "accepted" && (input.nativeEvidenceFingerprint === null || input.expected === "prepared" ||
        (current.operationKind === "interrupt" && current.deadlineAt! <= input.now))) throw mismatch();
    return this.database.prepare(`UPDATE opencode_operation_receipts
      SET disposition = ?, native_evidence_fingerprint = ?, updated_at = ?
      WHERE tenant_id = ? AND owner_principal_id = ? AND application_operation_id = ? AND operation_kind = ? AND disposition = ?`)
      .run(input.disposition, input.nativeEvidenceFingerprint, input.now, scope.tenantId, scope.principalId,
        applicationOperationId, operationKind, input.expected).changes === 1;
  }

  requireOperation(scope: RequestScope, applicationThreadId: string, applicationOperationId: string, operationKind: OpenCodeOperationKind): Readonly<OpenCodeOperationReceipt> {
    const current = this.readOperation(scope, applicationThreadId, applicationOperationId, operationKind);
    if (!current) throw new DomainError("not_found", "The OpenCode operation was not found.");
    return current;
  }

  /** Application creation authority exists before a native session or binding. */
  assertCreateAuthority(scope: RequestScope, applicationThreadId: string, operationId: string,
    sessionId: string, source: OpenCodeOperationEvidence["requestSource"]): void {
    this.#assertScope(scope); this.#target(scope, applicationThreadId);
    const attempt = this.#activeAttempt(scope, applicationThreadId);
    if (attempt.mutationId !== operationId || attempt.reservedId !== sessionId ||
        attempt.phase === "prepared" || JSON.stringify(attemptSource(attempt)) !== JSON.stringify(source)) throw mismatch();
  }

  /** No discovered ID, abandoned attempt, or merely prepared create authorizes attach. */
  requireProvisionalBinding(scope: RequestScope, applicationThreadId: string, sessionId: string): {
    readonly detail: OpenCodeBindingDetail;
    readonly applicationOperationId: string;
    readonly source: NonNullable<OpenCodeOperationEvidence["requestSource"]>;
  } {
    this.#assertScope(scope);
    const target = this.#target(scope, applicationThreadId);
    const attempt = this.#activeAttempt(scope, applicationThreadId);
    if (!["conversation_identified", "first_submission_started", "accepted_unpersisted", "recovery_required"].includes(attempt.phase) ||
        !attempt.sessionId || !attempt.detail || attempt.reservedId !== sessionId || attempt.sessionId !== sessionId) throw mismatch();
    const detail = parseOpenCodeBindingDetail(attempt.detail);
    this.#assertDetail(scope, target, detail);
    if (detail.sessionId !== sessionId) throw mismatch();
    const receipt = this.readOperation(scope, applicationThreadId, attempt.mutationId, "create");
    const source = attemptSource(attempt);
    if (!receipt || receipt.disposition !== "accepted" || receipt.nativeSessionId !== sessionId ||
        JSON.stringify(receipt.requestSource) !== JSON.stringify(source)) throw mismatch();
    const settings = this.database.prepare(`SELECT 1 FROM opencode_operation_settings_snapshots
      WHERE tenant_id=? AND owner_principal_id=? AND application_thread_id=?
        AND application_operation_id=? AND operation_kind='create'`)
      .get(scope.tenantId, scope.principalId, applicationThreadId, attempt.mutationId);
    if (!settings) throw mismatch();
    return { detail, applicationOperationId: attempt.mutationId, source };
  }

  #activeAttempt(scope: RequestScope, applicationThreadId: string): ActiveAttempt {
    const rows = this.database.prepare(`SELECT attempt.mutation_id AS mutationId,
      attempt.phase, attempt.backend_creation_correlation AS reservedId,
      attempt.provisional_backend_conversation_id AS sessionId, attempt.provisional_opaque_binding_detail AS detail,
      attempt.source_kind AS sourceKind, attempt.source_automation_id AS automationId,
      attempt.source_automation_run_id AS automationRunId, attempt.creation_kind AS creationKind
      FROM conversation_creation_attempts AS attempt JOIN application_threads AS thread
        ON thread.tenant_id=attempt.tenant_id AND thread.owner_principal_id=attempt.owner_principal_id
        AND thread.id=attempt.application_thread_id AND thread.backend_instance_id=attempt.backend_instance_id
        AND thread.connection_profile_id=attempt.connection_profile_id AND thread.environment_id=attempt.execution_environment_id
      WHERE attempt.tenant_id=? AND attempt.owner_principal_id=? AND attempt.application_thread_id=?
        AND thread.backing_state IN ('creating','creation_unknown') AND attempt.force_reset_at IS NULL
        AND attempt.phase NOT IN ('bound','aborted_unpersisted') LIMIT 2`)
      .all(scope.tenantId, scope.principalId, applicationThreadId) as (ActiveAttempt & { creationKind: string })[];
    if (rows.length !== 1 || rows[0]!.creationKind !== "first_input") throw mismatch();
    return rows[0]!;
  }

  #assertOperationTarget(scope: RequestScope, evidence: OpenCodeOperationEvidence): void {
    const target = this.#target(scope, evidence.applicationThreadId);
    if (target.connectionProfileId !== evidence.connectionProfileId || target.executionEnvironmentId !== evidence.executionEnvironmentId) throw mismatch();
    // First submission uses the accepted create's exact active provisional
    // authority. Unrelated input and steering never inherit that authority.
    if (evidence.operationKind === "create" || evidence.operationKind === "fork") return;
    const encoded = this.getBinding(scope, evidence.applicationThreadId);
    if (encoded) {
      if (parseOpenCodeBindingDetail(encoded).sessionId !== evidence.nativeSessionId) throw mismatch();
      return;
    }
    if (evidence.operationKind === "steer") throw mismatch();
    const provisional = this.requireProvisionalBinding(scope, evidence.applicationThreadId, evidence.nativeSessionId);
    if (evidence.operationKind === "submit" && (evidence.applicationOperationId !== provisional.applicationOperationId ||
        JSON.stringify(evidence.requestSource) !== JSON.stringify(provisional.source))) throw mismatch();
  }

  #assertDetail(scope: RequestScope, target: Target, detail: OpenCodeBindingDetail): void {
    if (detail.tenantId !== scope.tenantId || detail.principalId !== scope.principalId ||
        detail.backendInstanceId !== this.#backendInstanceId || detail.connectionProfileId !== target.connectionProfileId ||
        detail.executionEnvironmentId !== target.executionEnvironmentId || detail.canonicalWorkspacePath !== target.canonicalWorkspacePath ||
        detail.nativeNamespaceKey !== this.#nativeNamespaceKey) throw mismatch();
  }

  #target(scope: RequestScope, applicationThreadId: string): Target {
    const target = this.database.prepare(`SELECT thread.backend_instance_id AS backendInstanceId,
      thread.connection_profile_id AS connectionProfileId, thread.environment_id AS executionEnvironmentId,
      workspace.canonical_path AS canonicalWorkspacePath, backend.kind AS backendKind, profile.kind AS connectionKind
      FROM application_threads AS thread JOIN workspaces AS workspace ON workspace.tenant_id = thread.tenant_id
        AND workspace.owner_principal_id = thread.owner_principal_id AND workspace.id = thread.workspace_id
      JOIN agent_backend_instances AS backend ON backend.tenant_id = thread.tenant_id AND backend.id = thread.backend_instance_id
      JOIN agent_connection_profiles AS profile ON profile.tenant_id = thread.tenant_id
        AND profile.owner_principal_id = thread.owner_principal_id AND profile.id = thread.connection_profile_id
      WHERE thread.tenant_id = ? AND thread.owner_principal_id = ? AND thread.id = ?`)
      .get(scope.tenantId, scope.principalId, applicationThreadId) as Target | undefined;
    if (!target || target.backendInstanceId !== this.#backendInstanceId || target.backendKind !== "opencode" || target.connectionKind !== "opencode_http") throw mismatch();
    return target;
  }

  #assertScope(scope: RequestScope): void {
    if (scope.tenantId !== this.#scope.tenantId || scope.principalId !== this.#scope.principalId) throw mismatch();
  }
}

function currentEvidence(receipt: OpenCodeOperationReceipt): OpenCodeOperationEvidence {
  const { disposition: _disposition, nativeEvidenceFingerprint: _evidence, createdAt: _created, updatedAt: _updated, ...evidence } = receipt;
  return evidence;
}
function mismatch(): DomainError {
  return new DomainError("conflict", "The OpenCode operation or native binding does not match its recorded authority.");
}
function attemptSource(attempt: ActiveAttempt): NonNullable<OpenCodeOperationEvidence["requestSource"]> {
  if (!["composer", "automation", "agent_control", "principal_client"].includes(attempt.sourceKind)) throw mismatch();
  return sourceSchema.parse(attempt.sourceKind === "automation"
    ? { kind: "automation", automationId: attempt.automationId, automationRunId: attempt.automationRunId }
    : { kind: "user" });
}
