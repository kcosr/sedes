import { createHash } from "node:crypto";
import type { RequestScope } from "../../identity/identity-provider.js";
import { OpenCodeNativeProtocolError, type OpenCodeNativeInboxItem, type OpenCodeNativeMessage } from "./opencode-native-api.js";
import type { OpenCodeOperationReceipt, OpenCodeThreadRepository } from "./opencode-thread-repository.js";

export type OpenCodeInputKind = "submit" | "steer";
export interface OpenCodeInputEvidence {
  readonly receipt: Readonly<OpenCodeOperationReceipt>;
  readonly trackerId: string;
  readonly requestedDelivery: "queue" | "steer";
  readonly admittedDelivery: "queue" | "steer" | null;
  readonly preparedPayloadFingerprint: string | null;
  readonly enqueueSequence: number | null;
  readonly consumedFingerprint: string | null;
  readonly withdrawnFingerprint: string | null;
  readonly withdrawalKind: "cancelled" | "reverted" | null;
  readonly payloadConflict: boolean;
  /** Lost continuity is terminal for automatic polling, never proof of nonacceptance. */
  readonly terminalLostAt: number | null;
}
type StoredEvidence = Omit<OpenCodeInputEvidence, "receipt" | "payloadConflict"> & { payloadConflict: number };
const columns = `tracker_id AS trackerId, requested_delivery AS requestedDelivery, admitted_delivery AS admittedDelivery,
  prepared_payload_fingerprint AS preparedPayloadFingerprint, enqueue_sequence AS enqueueSequence,
  consumed_fingerprint AS consumedFingerprint, withdrawn_fingerprint AS withdrawnFingerprint, withdrawal_kind AS withdrawalKind,
  payload_conflict AS payloadConflict, terminal_lost_at AS terminalLostAt`;
const unresolvedInput = `FROM opencode_input_evidence AS evidence JOIN opencode_operation_receipts AS receipt
  USING (tenant_id,owner_principal_id,application_operation_id,operation_kind)
  WHERE evidence.tenant_id=? AND evidence.owner_principal_id=? AND receipt.application_thread_id=?
    AND receipt.disposition IN ('dispatched','accepted','unknown')
    AND evidence.consumed_fingerprint IS NULL AND evidence.withdrawn_fingerprint IS NULL
    AND evidence.payload_conflict=0 AND evidence.terminal_lost_at IS NULL`;

/** Provider-private operation proof only; no transcript or pending input content is mirrored. */
export class OpenCodeInputEvidenceRepository {
  constructor(readonly operations: OpenCodeThreadRepository) {}

  begin(scope: RequestScope, threadId: string, operationId: string, kind: OpenCodeInputKind,
    trackerId: string, delivery: "queue" | "steer", now = Date.now()): OpenCodeInputEvidence {
    const receipt = this.operations.requireOperation(scope, threadId, operationId, kind);
    if (!receipt.nativeInputId || !trackerId || trackerId.length > 1_024) throw new OpenCodeNativeProtocolError();
    this.operations.database.prepare(`INSERT INTO opencode_input_evidence
      (tenant_id,owner_principal_id,application_operation_id,operation_kind,tracker_id,requested_delivery,updated_at)
      VALUES (?,?,?,?,?,?,?) ON CONFLICT DO NOTHING`).run(scope.tenantId, scope.principalId, operationId, kind, trackerId, delivery, now);
    const current = this.get(scope, threadId, operationId, kind);
    if (current.requestedDelivery !== delivery) throw new OpenCodeNativeProtocolError();
    // Preparing is not dispatch. A replaced observer may reserve this same
    // never-dispatched operation; only the actual dispatch freezes continuity.
    this.operations.database.prepare(`UPDATE opencode_input_evidence SET tracker_id=?,updated_at=?
      WHERE tenant_id=? AND owner_principal_id=? AND application_operation_id=? AND operation_kind=?
        AND prepared_payload_fingerprint IS NULL AND consumed_fingerprint IS NULL AND withdrawn_fingerprint IS NULL
        AND EXISTS (SELECT 1 FROM opencode_operation_receipts AS receipt
          WHERE receipt.tenant_id=opencode_input_evidence.tenant_id AND receipt.owner_principal_id=opencode_input_evidence.owner_principal_id
            AND receipt.application_operation_id=opencode_input_evidence.application_operation_id AND receipt.operation_kind=opencode_input_evidence.operation_kind
            AND receipt.disposition='prepared')`).run(trackerId, now, scope.tenantId, scope.principalId, operationId, kind);
    return this.get(scope, threadId, operationId, kind);
  }

  get(scope: RequestScope, threadId: string, operationId: string, kind: OpenCodeInputKind): OpenCodeInputEvidence {
    const receipt = this.operations.requireOperation(scope, threadId, operationId, kind);
    const row = this.operations.database.prepare(`SELECT ${columns} FROM opencode_input_evidence
      WHERE tenant_id=? AND owner_principal_id=? AND application_operation_id=? AND operation_kind=?`)
      .get(scope.tenantId, scope.principalId, operationId, kind) as StoredEvidence | undefined;
    if (!row || !receipt.nativeInputId) throw new OpenCodeNativeProtocolError();
    return { ...row, payloadConflict: row.payloadConflict === 1, receipt };
  }

  list(scope: RequestScope, threadId: string): readonly OpenCodeInputEvidence[] {
    // The binding read validates repository scope even for an empty query.
    this.operations.getBinding(scope, threadId);
    const rows = this.operations.database.prepare(`SELECT evidence.application_operation_id AS id, evidence.operation_kind AS kind
      FROM opencode_input_evidence AS evidence JOIN opencode_operation_receipts AS receipt
        USING (tenant_id,owner_principal_id,application_operation_id,operation_kind)
      WHERE evidence.tenant_id=? AND evidence.owner_principal_id=? AND receipt.application_thread_id=?
      ORDER BY receipt.created_at LIMIT 100001`).all(scope.tenantId, scope.principalId, threadId) as { id: string; kind: OpenCodeInputKind }[];
    if (rows.length > 100_000) throw new OpenCodeNativeProtocolError();
    return rows.map(row => this.get(scope, threadId, row.id, row.kind));
  }

  hasUnresolved(scope: RequestScope, threadId: string): boolean {
    this.operations.getBinding(scope, threadId);
    return this.operations.database.prepare(`SELECT 1 ${unresolvedInput} LIMIT 1`)
      .get(scope.tenantId, scope.principalId, threadId) !== undefined;
  }

  unresolved(scope: RequestScope, threadId: string): readonly { operationId: string; kind: OpenCodeInputKind }[] {
    this.operations.getBinding(scope, threadId);
    const rows = this.operations.database.prepare(`SELECT evidence.application_operation_id AS operationId,
      evidence.operation_kind AS kind ${unresolvedInput} ORDER BY receipt.created_at LIMIT 100001`)
      .all(scope.tenantId, scope.principalId, threadId) as { operationId: string; kind: OpenCodeInputKind }[];
    if (rows.length > 100_000) throw new OpenCodeNativeProtocolError();
    return rows;
  }

  recordTerminalLoss(scope: RequestScope, threadId: string, operationId: string, kind: OpenCodeInputKind): void {
    this.#dispatched(scope, threadId, operationId, kind);
    this.operations.database.prepare(`UPDATE opencode_input_evidence SET terminal_lost_at=coalesce(terminal_lost_at,?)
      WHERE tenant_id=? AND owner_principal_id=? AND application_operation_id=? AND operation_kind=?
        AND consumed_fingerprint IS NULL AND withdrawn_fingerprint IS NULL AND payload_conflict=0`)
      .run(Date.now(), scope.tenantId, scope.principalId, operationId, kind);
  }

  admit(scope: RequestScope, threadId: string, operationId: string, kind: OpenCodeInputKind,
    input: { readonly payloadFingerprint: string; readonly delivery: "queue" | "steer"; readonly enqueueSequence?: number }): OpenCodeInputEvidence {
    const current = this.#dispatched(scope, threadId, operationId, kind);
    digest(input.payloadFingerprint);
    if (input.enqueueSequence !== undefined && (!Number.isSafeInteger(input.enqueueSequence) || input.enqueueSequence < 0)) throw new OpenCodeNativeProtocolError();
    const conflict = current.preparedPayloadFingerprint !== null && current.preparedPayloadFingerprint !== input.payloadFingerprint ||
      current.enqueueSequence !== null && input.enqueueSequence !== undefined && current.enqueueSequence !== input.enqueueSequence;
    this.operations.database.prepare(`UPDATE opencode_input_evidence SET
      prepared_payload_fingerprint=coalesce(prepared_payload_fingerprint,?), admitted_delivery=?,
      enqueue_sequence=coalesce(enqueue_sequence,?), payload_conflict=max(payload_conflict,?),updated_at=?
      WHERE tenant_id=? AND owner_principal_id=? AND application_operation_id=? AND operation_kind=?`)
      .run(input.payloadFingerprint, input.delivery, input.enqueueSequence ?? null, conflict ? 1 : 0, Date.now(),
        scope.tenantId, scope.principalId, operationId, kind);
    this.#acceptAdmission(scope, threadId, current.receipt);
    return this.get(scope, threadId, operationId, kind);
  }

  consume(scope: RequestScope, threadId: string, operationId: string, kind: OpenCodeInputKind,
    proof: string, payloadFingerprint?: string): OpenCodeInputEvidence {
    const current = this.#dispatched(scope, threadId, operationId, kind); digest(proof);
    if (payloadFingerprint !== undefined) digest(payloadFingerprint);
    const conflict = payloadFingerprint !== undefined && current.preparedPayloadFingerprint !== null && current.preparedPayloadFingerprint !== payloadFingerprint;
    this.operations.database.prepare(`UPDATE opencode_input_evidence SET consumed_fingerprint=coalesce(consumed_fingerprint,?),
      prepared_payload_fingerprint=coalesce(prepared_payload_fingerprint,?), payload_conflict=max(payload_conflict,?),updated_at=?
      WHERE tenant_id=? AND owner_principal_id=? AND application_operation_id=? AND operation_kind=?`)
      .run(proof, payloadFingerprint ?? null, conflict ? 1 : 0, Date.now(), scope.tenantId, scope.principalId, operationId, kind);
    this.#acceptAdmission(scope, threadId, current.receipt);
    return this.get(scope, threadId, operationId, kind);
  }

  withdraw(scope: RequestScope, threadId: string, operationId: string, kind: OpenCodeInputKind,
    withdrawal: "cancelled" | "reverted", proof: string): OpenCodeInputEvidence {
    const current = this.#dispatched(scope, threadId, operationId, kind); digest(proof);
    this.operations.database.prepare(`UPDATE opencode_input_evidence SET withdrawn_fingerprint=coalesce(withdrawn_fingerprint,?),
      withdrawal_kind=coalesce(withdrawal_kind,?),updated_at=? WHERE tenant_id=? AND owner_principal_id=? AND application_operation_id=? AND operation_kind=?`)
      .run(proof, withdrawal, Date.now(), scope.tenantId, scope.principalId, operationId, kind);
    // Exact withdrawal proves admission, even if its enqueue event was missed;
    // it never establishes consumption or acceptance of a submitted turn.
    this.#acceptAdmission(scope, threadId, current.receipt);
    // Consumption proof is irreversible, including after native revert erases history.
    return this.get(scope, threadId, operationId, kind);
  }

  #dispatched(scope: RequestScope, threadId: string, operationId: string, kind: OpenCodeInputKind): OpenCodeInputEvidence {
    const current = this.get(scope, threadId, operationId, kind);
    if (current.receipt.disposition === "prepared" || current.receipt.disposition === "not_applied") throw new OpenCodeNativeProtocolError();
    return current;
  }
  #acceptAdmission(scope: RequestScope, threadId: string, receipt: Readonly<OpenCodeOperationReceipt>): void {
    if (receipt.disposition === "accepted") return;
    if (receipt.disposition !== "dispatched" && receipt.disposition !== "unknown") throw new OpenCodeNativeProtocolError();
    this.operations.recordOutcome(scope, threadId, receipt.applicationOperationId, receipt.operationKind, {
      expected: receipt.disposition, disposition: "accepted", now: Date.now(),
      nativeEvidenceFingerprint: openCodeOperationFingerprint({ kind: "native_input_admitted", sessionID: receipt.nativeSessionId, inputID: receipt.nativeInputId }),
    });
  }
}

export function openCodePreparedPayloadFingerprint(value: Extract<OpenCodeNativeInboxItem, { type: "user" }>["payload"] |
  Extract<OpenCodeNativeMessage, { type: "user" }>): string {
  return openCodeOperationFingerprint({ text: value.text, files: value.files ?? null,
    agents: value.agents ?? null, skills: value.skills ?? null, metadata: value.metadata ?? null });
}
export function openCodeOperationFingerprint(value: unknown): string {
  const canonical = (item: unknown): unknown => Array.isArray(item) ? item.map(canonical)
    : item !== null && typeof item === "object" ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
      .filter(([, value]) => value !== undefined).map(([key, value]) => [key, canonical(value)])) : item;
  return createHash("sha256").update("sedes-opencode-operation-v1\n").update(JSON.stringify(canonical(value))).digest("hex");
}
function digest(value: string): void { if (!/^[0-9a-f]{64}$/u.test(value)) throw new OpenCodeNativeProtocolError(); }
