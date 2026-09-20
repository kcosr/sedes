import { createHash } from "node:crypto";
import type Database from "better-sqlite3";
import { z } from "zod";
import type { ProviderTransportScope } from "../../../provider-protocol/transport/assured-framed-transport.js";

const id = z.string().min(1).max(256);
const sequence = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const methodSchema = z.enum(["thread/start", "thread/fork", "turn/start", "turn/steer"]);
const correlationSchema = z.strictObject({
  kind: z.enum(["create", "fork", "start", "steer"]),
  applicationOperationId: id,
  applicationThreadId: id,
});
const methodForKind = { create: "thread/start", fork: "thread/fork", start: "turn/start", steer: "turn/steer" } as const;
export type CodexRuntimeReceiptCorrelation = z.infer<typeof correlationSchema>;
export type CodexRuntimeReceiptAuthority = Readonly<{ scope: ProviderTransportScope; runtimeId: string }>;
export type CodexRuntimeReceiptRetirementProof = Readonly<{
  disposition: "confirmed_retired";
  runtimeId: string;
  retirementOperationId: string;
  retiredAt: number;
}>;

// Only native identity and delivery evidence survive. Native transcript bodies,
// prompt inputs, remote error messages/data and tool output are never copied.
const outcomeSchema = z.discriminatedUnion("status", [
  z.strictObject({ status: z.literal("completed"), generation: sequence, inboundSequence: sequence,
    nativeThreadId: id.optional(), nativeTurnId: id.optional() }),
  z.strictObject({ status: z.literal("failed"), generation: sequence,
    failure: z.discriminatedUnion("kind", [
      z.strictObject({ kind: z.literal("delivery"), code: id, delivery: z.enum(["not_sent", "sent_outcome_unknown"]) }),
      z.strictObject({ kind: z.literal("remote"), code: z.number().int(),
        rejectionReason: z.enum(["no_active_turn", "expected_turn_mismatch"]).optional() }),
    ]) }),
]);
export type CodexCriticalReceiptOutcome = z.infer<typeof outcomeSchema>;
export type CodexRuntimeReceipt = Readonly<{
  operationId: string;
  method: z.infer<typeof methodSchema>;
  requestFingerprint: string;
  correlation: CodexRuntimeReceiptCorrelation;
  state: "reserved" | "recorded" | "reconciled";
  outcome: CodexCriticalReceiptOutcome | null;
}>;
export type CodexRuntimeReceiptReservation = Readonly<{
  operationId: string; method: string; requestFingerprint: string;
  correlation: CodexRuntimeReceiptCorrelation;
}>;
export type CodexRuntimeReceiptObservation = Readonly<{
  status: "pending" | "completed" | "failed";
  operationId: string; method: string;
  receipt?: Readonly<{ result: unknown; generation: number; inboundSequence: number }>;
  failure?: Readonly<{ kind: "delivery" | "remote"; code: string | number; generation: number;
    delivery?: "not_sent" | "sent_outcome_unknown";
    rejectionReason?: "no_active_turn" | "expected_turn_mismatch" }>;
}>;

export interface CodexRuntimeReceiptSink {
  reserve(authority: CodexRuntimeReceiptAuthority, input: CodexRuntimeReceiptReservation): CodexRuntimeReceipt;
  recordOutcome(authority: CodexRuntimeReceiptAuthority, outcome: CodexRuntimeReceiptObservation): "recorded" | "untracked";
  releaseRejected(authority: CodexRuntimeReceiptAuthority, operationId: string): boolean;
  compactRetiredRuntime(authority: CodexRuntimeReceiptAuthority, proof: CodexRuntimeReceiptRetirementProof): number;
  pending(authority: CodexRuntimeReceiptAuthority): readonly CodexRuntimeReceipt[];
  reconcileRecordedApplicationState(authority: CodexRuntimeReceiptAuthority): number;
}

const authoritySchema = z.strictObject({
  tenantId: id, principalId: id, executionEnvironmentId: id, backendInstanceId: id,
});
function key(authority: CodexRuntimeReceiptAuthority): string[] {
  const scope = authoritySchema.parse(authority.scope);
  return [scope.tenantId, scope.principalId, scope.executionEnvironmentId,
    scope.backendInstanceId, id.parse(authority.runtimeId)];
}
const where = `tenant_id = ? AND principal_id = ? AND execution_environment_id = ?
  AND backend_instance_id = ? AND runtime_id = ?`;
const columns = `operation_id AS operationId, method, request_fingerprint AS requestFingerprint,
  application_operation_id AS applicationOperationId, application_thread_id AS applicationThreadId,
  kind, state, outcome_json AS outcomeJson, outcome_fingerprint AS outcomeFingerprint`;
type Row = {
  operationId: string; method: CodexRuntimeReceipt["method"]; requestFingerprint: string;
  applicationOperationId: string; applicationThreadId: string; kind: CodexRuntimeReceiptCorrelation["kind"];
  state: CodexRuntimeReceipt["state"]; outcomeJson: string | null; outcomeFingerprint: string | null;
};
function receipt(row: Row): CodexRuntimeReceipt {
  return { operationId: row.operationId, method: row.method, requestFingerprint: row.requestFingerprint,
    correlation: { kind: row.kind, applicationOperationId: row.applicationOperationId,
      applicationThreadId: row.applicationThreadId }, state: row.state,
    outcome: row.outcomeJson === null ? null : outcomeSchema.parse(JSON.parse(row.outcomeJson)) };
}
function digest(value: string): string { return createHash("sha256").update(value).digest("hex"); }
function project(observation: CodexRuntimeReceiptObservation): CodexCriticalReceiptOutcome {
  if (observation.status === "failed") {
    const failure = observation.failure;
    if (!failure) throw new Error("codex_runtime_receipt_failure_missing");
    return outcomeSchema.parse({ status: "failed", generation: failure.generation,
      failure: failure.kind === "delivery"
        ? { kind: "delivery", code: failure.code, delivery: failure.delivery }
        : { kind: "remote", code: failure.code, ...(failure.rejectionReason ? { rejectionReason: failure.rejectionReason } : {}) } });
  }
  if (observation.status !== "completed" || !observation.receipt) {
    throw new Error("codex_runtime_receipt_outcome_unsettled");
  }
  const { result, generation, inboundSequence } = observation.receipt;
  switch (methodSchema.parse(observation.method)) {
    case "thread/start":
    case "thread/fork": {
      const parsed = z.object({ thread: z.object({ id }) }).parse(result);
      return outcomeSchema.parse({ status: "completed", generation, inboundSequence, nativeThreadId: parsed.thread.id });
    }
    case "turn/start": {
      const parsed = z.object({ turn: z.object({ id }) }).parse(result);
      return outcomeSchema.parse({ status: "completed", generation, inboundSequence, nativeTurnId: parsed.turn.id });
    }
    case "turn/steer": {
      const parsed = z.object({ turnId: id }).parse(result);
      return outcomeSchema.parse({ status: "completed", generation, inboundSequence, nativeTurnId: parsed.turnId });
    }
  }
}

/** Durable application-side handoff. Settled proof moves to its authoritative
 * application operation; saturation never expires possibly applied work.
 * A runtime ID MUST name one enduring backend incarnation, not a reconnect.
 * Reconciliation's synchronous callback writes authoritative app state using the
 * same database transaction. A thrown callback rolls back both writes. */
export class CodexRuntimeReceiptStore implements CodexRuntimeReceiptSink {
  constructor(readonly database: Database.Database,
    readonly limits: Readonly<{ maximumRecords: number; maximumRecordsPerRuntime: number; maximumRetiredRuntimes?: number }> = {
      maximumRecords: 65_536, maximumRecordsPerRuntime: 4_096,
    }) {
    for (const limit of Object.values(limits)) {
      if (!Number.isSafeInteger(limit) || limit < 1) throw new Error("codex_runtime_receipt_limit_invalid");
    }
  }

  reserve(authority: CodexRuntimeReceiptAuthority, input: CodexRuntimeReceiptReservation): CodexRuntimeReceipt {
    const scope = key(authority);
    const operationId = id.parse(input.operationId);
    const method = methodSchema.parse(input.method);
    const correlation = correlationSchema.parse(input.correlation);
    const fingerprint = z.string().regex(/^[a-f0-9]{64}$/).parse(input.requestFingerprint);
    if (methodForKind[correlation.kind] !== method) throw new Error("codex_runtime_receipt_kind_mismatch");
    return this.database.transaction(() => {
      if (this.#retired(scope)) throw new Error("codex_runtime_receipt_incarnation_retired");
      const byId = this.#row(scope, operationId) ?? this.#applicationProofByOperation(authority, operationId);
      const existing = this.database.prepare(`SELECT ${columns} FROM codex_runtime_receipts WHERE ${where}
        AND application_operation_id = ? AND application_thread_id = ? AND kind = ?`)
        .get(...scope, correlation.applicationOperationId, correlation.applicationThreadId, correlation.kind) as Row | undefined;
      const row = byId ?? existing ?? this.#applicationProof(authority, correlation);
      if (row) {
        if (row.method !== method || row.requestFingerprint !== fingerprint || row.kind !== correlation.kind ||
          row.applicationOperationId !== correlation.applicationOperationId || row.applicationThreadId !== correlation.applicationThreadId ||
          (byId && existing && byId.operationId !== existing.operationId)) {
          throw new Error("codex_runtime_receipt_identity_conflict");
        }
        return receipt(row);
      }
      this.#compactApplicationReceipts(authority);
      const total = this.database.prepare(`SELECT (SELECT count(*) FROM codex_runtime_receipts)
        + (SELECT count(*) FROM codex_retired_runtime_receipt_fences) AS count`).get() as { count: number };
      const runtime = this.database.prepare(`SELECT count(*) AS count FROM codex_runtime_receipts WHERE ${where}`).get(...scope) as { count: number };
      if (total.count >= this.limits.maximumRecords || runtime.count >= this.limits.maximumRecordsPerRuntime) {
        throw new Error("codex_runtime_receipt_capacity_exhausted");
      }
      this.database.prepare(`INSERT INTO codex_runtime_receipts
        (tenant_id, principal_id, execution_environment_id, backend_instance_id, runtime_id,
         operation_id, application_operation_id, application_thread_id, kind, method, request_fingerprint, state)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'reserved')`)
        .run(...scope, operationId, correlation.applicationOperationId, correlation.applicationThreadId,
          correlation.kind, method, fingerprint);
      return receipt(this.#row(scope, operationId)!);
    }).immediate();
  }

  recordOutcome(authority: CodexRuntimeReceiptAuthority, observation: CodexRuntimeReceiptObservation): "recorded" | "untracked" {
    const scope = key(authority);
    const operationId = id.parse(observation.operationId);
    return this.database.transaction(() => {
      const row = this.#row(scope, operationId) ?? this.#applicationProofByOperation(authority, operationId);
      if (!row) {
        if (methodSchema.safeParse(observation.method).success) {
          throw new Error("codex_runtime_receipt_not_found");
        }
        return "untracked";
      }
      if (row.method !== observation.method) throw new Error("codex_runtime_receipt_method_mismatch");
      const json = JSON.stringify(project(observation));
      if (Buffer.byteLength(json) > 4096) throw new Error("codex_runtime_receipt_outcome_too_large");
      const fingerprint = digest(json);
      if (row.state !== "reserved") {
        if (row.outcomeFingerprint !== fingerprint) throw new Error("codex_runtime_receipt_outcome_conflict");
        return "recorded";
      }
      this.database.prepare(`UPDATE codex_runtime_receipts SET state = 'recorded', outcome_json = ?,
        outcome_fingerprint = ? WHERE ${where} AND operation_id = ?`).run(json, fingerprint, ...scope, operationId);
      return "recorded";
    }).immediate();
  }

  pending(authority: CodexRuntimeReceiptAuthority): readonly CodexRuntimeReceipt[] {
    return (this.database.prepare(`SELECT ${columns} FROM codex_runtime_receipts WHERE ${where}
      AND state != 'reconciled' ORDER BY operation_id`).all(...key(authority)) as Row[]).map(receipt);
  }

  /** Observe committed application acceptance; never synthesize it from provider
   * success. Native history can still be unavailable while a receipt is pending.
   * Codex completionCorrelation is the exact application operation identity. */
  reconcileRecordedApplicationState(authority: CodexRuntimeReceiptAuthority): number {
    key(authority);
    return this.database.transaction(() => {
      let reconciled = 0;
      for (const value of this.pending(authority)) {
        if (value.outcome?.status !== "completed") continue;
        const { scope } = authority;
        const binding = this.database.prepare(`SELECT binding.backend_conversation_id AS nativeThreadId
          FROM conversation_bindings AS binding JOIN application_threads AS thread
            ON thread.tenant_id = binding.tenant_id AND thread.owner_principal_id = binding.owner_principal_id
            AND thread.id = binding.application_thread_id AND thread.backing_state = 'bound'
            AND thread.backend_instance_id = binding.backend_instance_id
            AND thread.environment_id = binding.execution_environment_id
          WHERE binding.tenant_id = ? AND binding.owner_principal_id = ?
            AND binding.execution_environment_id = ? AND binding.backend_instance_id = ?
            AND binding.application_thread_id = ?`)
          .get(scope.tenantId, scope.principalId, scope.executionEnvironmentId, scope.backendInstanceId,
            value.correlation.applicationThreadId) as { nativeThreadId: string } | undefined;
        if (!binding) continue;
        let accepted = false;
        if (value.correlation.kind === "create" || value.correlation.kind === "fork") {
          accepted = binding.nativeThreadId === value.outcome.nativeThreadId;
        } else {
          accepted = !!this.database.prepare(`SELECT 1 FROM submission_completion_observations
            WHERE tenant_id = ? AND owner_principal_id = ? AND application_thread_id = ?
              AND operation_id = ? AND backend_correlation = ?`)
            .get(scope.tenantId, scope.principalId, value.correlation.applicationThreadId,
              value.correlation.applicationOperationId, value.correlation.applicationOperationId);
        }
        if (!accepted) continue;
        this.reconcile(authority, value.operationId, () => {});
        reconciled++;
      }
      this.#compactApplicationReceipts(authority);
      return reconciled;
    }).immediate();
  }

  /** Call only with positive authoritative runtime-retirement evidence. Carrier
   * loss, main shutdown, and absent inventory are never retirement proof. Fence
   * installation and compaction are atomic; future admission stays forbidden. */
  compactRetiredRuntime(authority: CodexRuntimeReceiptAuthority, proof: CodexRuntimeReceiptRetirementProof): number {
    const scope = key(authority);
    const parsed = z.strictObject({ disposition: z.literal("confirmed_retired"), runtimeId: id,
      retirementOperationId: id, retiredAt: sequence }).parse(proof);
    if (parsed.runtimeId !== authority.runtimeId) throw new Error("codex_runtime_receipt_retirement_identity_mismatch");
    return this.database.transaction(() => {
      if (this.#retired(scope)) return 0;
      if (this.pending(authority).length !== 0) throw new Error("codex_runtime_receipt_retirement_unreconciled");
      const fences = this.database.prepare("SELECT count(*) AS count FROM codex_retired_runtime_receipt_fences").get() as { count: number };
      if (fences.count >= (this.limits.maximumRetiredRuntimes ?? 4_096)) {
        throw new Error("codex_runtime_receipt_retirement_capacity_exhausted");
      }
      const removed = this.database.prepare(`DELETE FROM codex_runtime_receipts WHERE ${where}`).run(...scope).changes;
      const total = this.database.prepare("SELECT count(*) AS count FROM codex_runtime_receipts").get() as { count: number };
      if (total.count + fences.count >= this.limits.maximumRecords) throw new Error("codex_runtime_receipt_capacity_exhausted");
      this.database.prepare(`INSERT INTO codex_retired_runtime_receipt_fences
        (tenant_id, principal_id, execution_environment_id, backend_instance_id, runtime_id, retirement_operation_id, retired_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)`).run(...scope, parsed.retirementOperationId, parsed.retiredAt);
      return removed;
    }).immediate();
  }

  reconcile(authority: CodexRuntimeReceiptAuthority, operationId: string,
    commit: (value: CodexRuntimeReceipt & { outcome: CodexCriticalReceiptOutcome }) => void): "committed" | "already_reconciled" {
    const scope = key(authority);
    id.parse(operationId);
    return this.database.transaction(() => {
      const row = this.#row(scope, operationId) ?? this.#applicationProofByOperation(authority, operationId);
      if (!row) throw new Error("codex_runtime_receipt_not_found");
      if (row.state === "reconciled") return "already_reconciled";
      const value = receipt(row);
      if (!value.outcome) throw new Error("codex_runtime_receipt_outcome_unsettled");
      const result: unknown = commit({ ...value, outcome: value.outcome });
      if (result && typeof result === "object" && "then" in result) {
        throw new Error("codex_runtime_receipt_commit_must_be_synchronous");
      }
      this.database.prepare(`UPDATE codex_runtime_receipts SET state = 'reconciled', outcome_json = NULL
        WHERE ${where} AND operation_id = ?`).run(...scope, operationId);
      return "committed";
    }).immediate();
  }

  /** Release only after the caller handles a proved rejection: unsent delivery,
   * native overload (-32001), or an exact stale-steer rejection. A timeout or
   * other uncertain outcome must continue to block another send. */
  releaseRejected(authority: CodexRuntimeReceiptAuthority, operationId: string): boolean {
    const scope = key(authority);
    id.parse(operationId);
    return this.database.transaction(() => {
      const row = this.#row(scope, operationId);
      if (!row) return false;
      const value = receipt(row);
      if (value.state !== "recorded" || value.outcome?.status !== "failed" ||
        (value.outcome.failure.kind === "delivery"
          ? value.outcome.failure.delivery !== "not_sent"
          : value.outcome.failure.code !== -32001 &&
            (value.method !== "turn/steer" || value.outcome.failure.code !== -32600 || !value.outcome.failure.rejectionReason))) {
        throw new Error("codex_runtime_receipt_rejection_unconfirmed");
      }
      this.database.prepare(`DELETE FROM codex_runtime_receipts WHERE ${where} AND operation_id = ?`).run(...scope, operationId);
      return true;
    }).immediate();
  }

  #applicationProof(authority: CodexRuntimeReceiptAuthority, correlation: CodexRuntimeReceiptCorrelation): Row | undefined {
    const creation = correlation.kind === "create" || correlation.kind === "fork";
    const table = creation ? "conversation_creation_attempts" : "submission_completion_observations";
    const operation = creation ? "mutation_id" : "operation_id";
    const result = this.database.prepare(`SELECT json_extract(codex_runtime_receipts_json, ?) AS proof
      FROM ${table} WHERE tenant_id = ? AND owner_principal_id = ?
        AND application_thread_id = ? AND ${operation} = ?`)
      .get(`$.${correlation.kind}`, authority.scope.tenantId, authority.scope.principalId,
        correlation.applicationThreadId, correlation.applicationOperationId) as { proof: string | null } | undefined;
    return this.#decodeProof(authority, result?.proof);
  }

  #applicationProofByOperation(authority: CodexRuntimeReceiptAuthority, operationId: string): Row | undefined {
    for (const kind of ["create", "fork", "start", "steer"] as const) {
      const table = kind === "create" || kind === "fork" ? "conversation_creation_attempts" : "submission_completion_observations";
      const results = this.database.prepare(`SELECT json_extract(codex_runtime_receipts_json, '$.${kind}') AS proof
        FROM ${table} WHERE tenant_id = ? AND owner_principal_id = ?
          AND json_extract(codex_runtime_receipts_json, '$.${kind}.operationId') = ?`)
        .all(authority.scope.tenantId, authority.scope.principalId, operationId) as { proof: string }[];
      for (const result of results) {
        const row = this.#decodeProof(authority, result.proof);
        if (row) return row;
      }
    }
    return undefined;
  }

  #decodeProof(authority: CodexRuntimeReceiptAuthority, json: string | null | undefined): Row | undefined {
    if (!json) return undefined;
    const proof = JSON.parse(json) as Row & { executionEnvironmentId: string; backendInstanceId: string; runtimeId: string };
    if (proof.executionEnvironmentId !== authority.scope.executionEnvironmentId ||
      proof.backendInstanceId !== authority.scope.backendInstanceId || proof.runtimeId !== authority.runtimeId) return undefined;
    return proof;
  }

  /** Move only settled dedup evidence onto its existing final application
   * operation, in the same transaction as removing the transport ledger row.
   * Unresolved rows and rows without an authoritative application owner stay. */
  #compactApplicationReceipts(authority: CodexRuntimeReceiptAuthority): void {
    const rows = this.database.prepare(`SELECT ${columns}, tenant_id AS tenantId, principal_id AS principalId,
      execution_environment_id AS executionEnvironmentId, backend_instance_id AS backendInstanceId,
      runtime_id AS runtimeId FROM codex_runtime_receipts WHERE ${where} AND state = 'reconciled'`).all(...key(authority)) as
      (Row & { tenantId: string; principalId: string; executionEnvironmentId: string; backendInstanceId: string; runtimeId: string })[];
    for (const row of rows) {
      const creation = row.kind === "create" || row.kind === "fork";
      const table = creation ? "conversation_creation_attempts" : "submission_completion_observations";
      const operation = creation ? "mutation_id" : "operation_id";
      const accepted = creation ? "phase = 'bound' AND execution_environment_id = ? AND backend_instance_id = ?" : "backend_correlation = ?";
      const acceptance = creation ? [row.executionEnvironmentId, row.backendInstanceId] : [row.applicationOperationId];
      const predicate = `tenant_id = ? AND owner_principal_id = ? AND application_thread_id = ? AND ${operation} = ? AND ${accepted}`;
      const args = [row.tenantId, row.principalId, row.applicationThreadId, row.applicationOperationId, ...acceptance];
      const owner = this.database.prepare(`SELECT codex_runtime_receipts_json AS proofs FROM ${table} WHERE ${predicate}`)
        .get(...args) as { proofs: string } | undefined;
      if (!owner) continue;
      const proofs = JSON.parse(owner.proofs) as Record<string, unknown>;
      const { tenantId, principalId, ...proof } = row;
      if (proofs[row.kind] && JSON.stringify(proofs[row.kind]) !== JSON.stringify(proof)) continue;
      proofs[row.kind] = proof;
      this.database.prepare(`UPDATE ${table} SET codex_runtime_receipts_json = ? WHERE ${predicate}`)
        .run(JSON.stringify(proofs), ...args);
      this.database.prepare(`DELETE FROM codex_runtime_receipts WHERE ${where} AND operation_id = ?`)
        .run(tenantId, principalId, row.executionEnvironmentId, row.backendInstanceId, row.runtimeId, row.operationId);
    }
  }

  #row(scope: readonly string[], operationId: string): Row | undefined {
    return this.database.prepare(`SELECT ${columns} FROM codex_runtime_receipts WHERE ${where} AND operation_id = ?`)
      .get(...scope, operationId) as Row | undefined;
  }

  #retired(scope: readonly string[]): boolean {
    return !!this.database.prepare(`SELECT 1 FROM codex_retired_runtime_receipt_fences WHERE ${where}`).get(...scope);
  }
}
