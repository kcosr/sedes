import { createHash } from "node:crypto";
import type Database from "better-sqlite3";
import {
  clientOriginSchema,
  directInputReceiptSchema,
  type ClientOrigin,
  type DirectInputReceipt,
  type DirectInputReceiptLookup,
  type DirectInputRequest,
} from "../../../shared/protocol/thread-input.js";
import type { RequestScope } from "../../identity/identity-provider.js";
import { DomainError } from "../../domain/errors.js";

export type DirectInputRecord = {
  readonly mutationId: string;
  readonly threadId: string;
  readonly requestFingerprint: string;
  readonly admittedMode: "submit" | "queue" | "steer";
  readonly queuedInputId: string | null;
  readonly creationAttemptId: string | null;
  readonly createdAt: number;
};

function fingerprint(threadId: string, request: DirectInputRequest): string {
  return createHash("sha256").update(JSON.stringify([
    threadId,
    request.text,
    request.origin.clientId,
    request.runningPolicy.mode,
    request.runningPolicy.mode === "steer" ? request.runningPolicy.target.kind : null,
    request.runningPolicy.mode === "steer" && request.runningPolicy.target.kind === "turn"
      ? request.runningPolicy.target.turnId : null,
  ])).digest("hex");
}

/** Principal-wide idempotency is independent of thread/queue retention. */
export class DirectInputRepository {
  constructor(readonly database: Database.Database) {}

  find(scope: RequestScope, mutationId: string): DirectInputRecord | undefined {
    return this.database.prepare(`SELECT mutation_id AS mutationId,
      application_thread_id AS threadId, request_fingerprint AS requestFingerprint,
      admitted_mode AS admittedMode, queued_input_id AS queuedInputId,
      creation_attempt_id AS creationAttemptId, created_at AS createdAt
      FROM direct_input_receipts WHERE tenant_id = ? AND owner_principal_id = ? AND mutation_id = ?
    `).get(scope.tenantId, scope.principalId, mutationId) as DirectInputRecord | undefined;
  }

  replay(scope: RequestScope, threadId: string, request: DirectInputRequest): DirectInputRecord | undefined {
    const record = this.find(scope, request.mutationId);
    if (record && record.requestFingerprint !== fingerprint(threadId, request)) {
      throw new DomainError("conflict", "The input mutation ID was reused with different input.");
    }
    return record;
  }

  /** Call inside the same transaction that prepares first send or inserts the queue row. */
  record(scope: RequestScope, threadId: string, request: DirectInputRequest, input: {
    readonly admittedMode: DirectInputRecord["admittedMode"];
    readonly queuedInputId?: string;
    readonly creationAttemptId?: string;
    readonly now: number;
  }): DirectInputRecord {
    if (!this.database.inTransaction) throw new Error("direct_input_receipt_requires_admission_transaction");
    const replay = this.replay(scope, threadId, request);
    if (replay) return replay;
    this.database.prepare(`INSERT INTO direct_input_receipts (
      tenant_id, owner_principal_id, mutation_id, application_thread_id,
      request_fingerprint, admitted_mode, queued_input_id, creation_attempt_id, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      scope.tenantId, scope.principalId, request.mutationId, threadId,
      fingerprint(threadId, request), input.admittedMode,
      input.queuedInputId ?? null, input.creationAttemptId ?? null, input.now,
    );
    return this.find(scope, request.mutationId)!;
  }

  lookup(scope: RequestScope, mutationId: string): DirectInputReceiptLookup {
    const record = this.find(scope, mutationId);
    return record ? { status: "found", receipt: this.present(scope, record) } : { status: "notObserved" };
  }

  present(scope: RequestScope, record: DirectInputRecord): DirectInputReceipt {
    let status: DirectInputReceipt["status"] = "failed";
    let currentMode = record.admittedMode;
    let diagnostic: string | undefined = "The admitted input is no longer retained.";
    if (record.queuedInputId !== null) {
      const queued = this.database.prepare(`SELECT state, resolved_delivery_mode AS mode, diagnostic
        FROM queued_inputs WHERE tenant_id = ? AND owner_principal_id = ?
          AND application_thread_id = ? AND id = ? AND mutation_id = ?
      `).get(scope.tenantId, scope.principalId, record.threadId, record.queuedInputId, record.mutationId) as
        { state: string; mode: DirectInputReceipt["currentMode"]; diagnostic: string | null } | undefined;
      if (queued) {
        currentMode = queued.mode;
        status = queued.state === "pending" || queued.state === "retry_wait" ? "queued"
          : queued.state === "dispatching" ? "submitting"
          : queued.state === "uncertain" ? "recovery_required"
          : queued.state === "accepted" ? "accepted"
          : queued.state === "cancelled" ? "cancelled" : "failed";
        diagnostic = queued.diagnostic ?? undefined;
      }
    } else {
      const attempt = this.database.prepare(`SELECT phase, diagnostic FROM conversation_creation_attempts
        WHERE tenant_id = ? AND owner_principal_id = ? AND application_thread_id = ?
          AND attempt_id = ? AND mutation_id = ?
      `).get(scope.tenantId, scope.principalId, record.threadId, record.creationAttemptId, record.mutationId) as
        { phase: string; diagnostic: string | null } | undefined;
      if (attempt) {
        status = attempt.phase === "bound" || attempt.phase === "accepted_unpersisted" ? "accepted"
          : attempt.phase === "aborted_unpersisted" ? "failed"
          : attempt.phase === "recovery_required" ? "recovery_required" : "submitting";
        diagnostic = attempt.diagnostic ?? undefined;
      }
    }
    return directInputReceiptSchema.parse({
      mutationId: record.mutationId, threadId: record.threadId, operationId: record.mutationId,
      admittedMode: record.admittedMode, currentMode, status,
      ...(record.queuedInputId === null ? {} : { queuedInputId: record.queuedInputId }),
      ...(diagnostic ? { diagnostic } : {}),
    });
  }

  recordOrigin(scope: RequestScope, threadId: string, operationId: string, origin?: ClientOrigin): void {
    const clientId = origin ? clientOriginSchema.parse(origin).clientId : null;
    const existing = this.database.prepare(`SELECT client_id AS clientId FROM input_client_origins
      WHERE tenant_id = ? AND owner_principal_id = ? AND application_thread_id = ? AND operation_id = ?
    `).get(scope.tenantId, scope.principalId, threadId, operationId) as { clientId: string | null } | undefined;
    if (existing) {
      if (existing.clientId !== clientId) throw new DomainError("conflict", "The input origin differs from its admission.");
      return;
    }
    this.database.prepare(`INSERT INTO input_client_origins
      (tenant_id, owner_principal_id, application_thread_id, operation_id, client_id) VALUES (?, ?, ?, ?, ?)
    `).run(scope.tenantId, scope.principalId, threadId, operationId, clientId);
  }

  /** A turn is attributed by its first normalized user item, never a later completion callback. */
  turnOrigin(scope: RequestScope, threadId: string, turnId: string, firstInput?: {
    readonly operationId?: string;
  }): ClientOrigin | undefined {
    const read = () => this.database.prepare(`SELECT client_id AS clientId FROM thread_turn_origins
      WHERE tenant_id = ? AND owner_principal_id = ? AND application_thread_id = ? AND application_turn_id = ?
    `).get(scope.tenantId, scope.principalId, threadId, turnId) as { clientId: string | null } | undefined;
    let row = read();
    if (!row && firstInput) {
      const input = firstInput.operationId === undefined ? undefined : this.database.prepare(`
        SELECT client_id AS clientId FROM input_client_origins WHERE tenant_id = ? AND owner_principal_id = ?
          AND application_thread_id = ? AND operation_id = ?
      `).get(scope.tenantId, scope.principalId, threadId, firstInput.operationId) as { clientId: string | null } | undefined;
      // A Sedes operation can materialize while its acceptance callback is pending;
      // origins were already committed with admission, so missing provenance is not guessed.
      if (firstInput.operationId !== undefined && !input) return undefined;
      this.database.prepare(`INSERT OR IGNORE INTO thread_turn_origins
        (tenant_id, owner_principal_id, application_thread_id, application_turn_id, operation_id, client_id)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(scope.tenantId, scope.principalId, threadId, turnId, firstInput.operationId ?? null, input?.clientId ?? null);
      row = read();
    }
    return row?.clientId ? { clientId: row.clientId } : undefined;
  }
}
