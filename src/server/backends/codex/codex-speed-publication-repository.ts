import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import { speedResultSchema, type SpeedCurrentRunResult, type SpeedResult } from "../../../shared/provider-features/codex-speed.js";
import type { RequestScope } from "../../identity/identity-provider.js";

// Changes only on a process restart. Abandoned attempts can never acquire a new sender.
const EXECUTOR_ID = randomUUID();
const liveAttempts = new Set<string>();
const attemptKey = (scope: RequestScope, id: string) => JSON.stringify([scope.tenantId, scope.principalId, id]);
export type SpeedPublicationPhase = "ready" | "dispatching" | "settled" | "uncertain";
export interface SpeedPublication {
  readonly threadId: string;
  readonly executorId: string;
  readonly phase: SpeedPublicationPhase;
  readonly result: SpeedResult;
}
type Row = { threadId: string; executorId: string; phase: SpeedPublicationPhase; resultJson: string };
const columns = "application_thread_id AS threadId, executor_id AS executorId, phase, result_json AS resultJson";

export class CodexSpeedPublicationRepository {
  constructor(readonly database: Database.Database) {}
  find(scope: RequestScope, mutationId: string): SpeedPublication | undefined {
    const row = this.database.prepare(`SELECT ${columns} FROM codex_speed_publications
      WHERE tenant_id = ? AND owner_principal_id = ? AND mutation_id = ?`)
      .get(scope.tenantId, scope.principalId, mutationId) as Row | undefined;
    if (!row) return undefined;
    const result = speedResultSchema.parse(JSON.parse(row.resultJson));
    if ((!liveAttempts.has(attemptKey(scope, mutationId)) || row.executorId !== EXECUTOR_ID) && (row.phase === "ready" || row.phase === "dispatching")) {
      const attempt = result.currentRun;
      if (attempt.status !== "pending") throw new Error("codex_speed_publication_pending_invalid");
      const outcome: SpeedCurrentRunResult = row.phase === "ready"
        ? { status: "not_attempted", target: attempt.target, selection: attempt.selection, reason: "publication_aborted" }
        : { status: "uncertain", target: attempt.target, selection: attempt.selection, reason: "response_lost" };
      return this.#transition(scope, mutationId, row.phase, row.executorId, result, outcome);
    }
    return { threadId: row.threadId, executorId: row.executorId, phase: row.phase, result };
  }
  latest(scope: RequestScope, threadId: string): SpeedResult | null {
    const row = this.database.prepare(`SELECT mutation_id AS id FROM codex_speed_publications
      WHERE tenant_id = ? AND owner_principal_id = ? AND application_thread_id = ? ORDER BY rowid DESC LIMIT 1`)
      .get(scope.tenantId, scope.principalId, threadId) as { id: string } | undefined;
    return row ? this.find(scope, row.id)!.result : null;
  }
  create(scope: RequestScope, threadId: string, result: SpeedResult, now: number): SpeedPublication {
    if (!this.database.inTransaction) throw new Error("codex_speed_save_requires_transaction");
    const validated = speedResultSchema.parse(result);
    const phase = validated.currentRun.status === "pending" ? "ready" : "settled";
    this.database.prepare(`INSERT INTO codex_speed_publications
      (tenant_id, owner_principal_id, application_thread_id, mutation_id, executor_id, phase, receipt_revision, result_json, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(scope.tenantId, scope.principalId, threadId,
        validated.operationId, EXECUTOR_ID, phase, validated.receiptRevision, JSON.stringify(validated), now, now);
    if (phase === "ready") liveAttempts.add(attemptKey(scope, validated.operationId));
    return this.find(scope, validated.operationId)!;
  }
  dispatching(scope: RequestScope, mutationId: string, continuity: string): void {
    const current = this.find(scope, mutationId);
    if (!current || current.executorId !== EXECUTOR_ID || current.phase !== "ready") throw new Error("codex_speed_attempt_not_owned");
    const result = { ...current.result, receiptRevision: current.result.receiptRevision + 1 };
    const changed = this.database.prepare(`UPDATE codex_speed_publications SET phase = 'dispatching',
      continuity_json = ?, receipt_revision = ?, result_json = ?, updated_at = max(updated_at, ?)
      WHERE tenant_id = ? AND owner_principal_id = ? AND mutation_id = ? AND phase = 'ready' AND executor_id = ?`)
      .run(JSON.stringify({ identity: continuity }), result.receiptRevision, JSON.stringify(result), Date.now(),
        scope.tenantId, scope.principalId, mutationId, EXECUTOR_ID);
    if (changed.changes !== 1) throw new Error("codex_speed_attempt_not_owned");
  }
  finish(scope: RequestScope, mutationId: string, outcome: SpeedCurrentRunResult): SpeedResult {
    const current = this.find(scope, mutationId);
    if (current?.phase === "settled" || current?.phase === "uncertain") return current.result;
    if (!current || current.executorId !== EXECUTOR_ID || !["ready", "dispatching"].includes(current.phase)) throw new Error("codex_speed_attempt_not_owned");
    return this.#transition(scope, mutationId, current.phase, EXECUTOR_ID, current.result, outcome).result;
  }
  release(scope: RequestScope, mutationId: string): void { liveAttempts.delete(attemptKey(scope, mutationId)); }
  /** Only exact recorded remote evidence calls this; no native request is made. */
  refineRemote(scope: RequestScope, mutationId: string, outcome: SpeedCurrentRunResult): void {
    const current = this.find(scope, mutationId);
    if (!current || current.phase === "settled") return;
    if (current.phase !== "uncertain" && current.phase !== "dispatching") return;
    this.#transition(scope, mutationId, current.phase, current.executorId, current.result, outcome);
  }
  #transition(scope: RequestScope, mutationId: string, phase: SpeedPublicationPhase, executorId: string,
    previous: SpeedResult, outcome: SpeedCurrentRunResult): SpeedPublication {
    if (outcome.status === "pending") throw new Error("codex_speed_terminal_outcome_required");
    const result = speedResultSchema.parse({ ...previous, receiptRevision: previous.receiptRevision + 1, currentRun: outcome });
    const next = outcome.status === "uncertain" ? "uncertain" : "settled";
    const changed = this.database.prepare(`UPDATE codex_speed_publications SET phase = ?, receipt_revision = ?,
      result_json = ?, updated_at = max(updated_at, ?) WHERE tenant_id = ? AND owner_principal_id = ? AND mutation_id = ?
      AND phase = ? AND executor_id = ? AND receipt_revision = ?`).run(next, result.receiptRevision, JSON.stringify(result), Date.now(),
        scope.tenantId, scope.principalId, mutationId, phase, executorId, previous.receiptRevision);
    if (changed.changes !== 1) throw new Error("codex_speed_receipt_changed");
    const row = this.database.prepare(`SELECT application_thread_id AS threadId FROM codex_speed_publications
      WHERE tenant_id = ? AND owner_principal_id = ? AND mutation_id = ?`).get(scope.tenantId, scope.principalId, mutationId) as { threadId: string };
    return { threadId: row.threadId, executorId, phase: next, result };
  }
}
