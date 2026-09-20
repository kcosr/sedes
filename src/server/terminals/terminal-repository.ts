import { createHash } from "node:crypto";
import type Database from "better-sqlite3";
import {
  terminalResourceSchema,
  type TerminalResource,
} from "../../shared/protocol/terminals.js";
import type { RequestScope } from "../identity/identity-provider.js";

type TerminalRow = {
  terminalId: string;
  threadId: string;
  workspaceId: string;
  environmentId: string;
  environmentLabel: string;
  incarnationId: string | null;
  displayName: string;
  shellProfile: string | null;
  initialCwd: string;
  terminationEffect: TerminalResource["terminationEffect"];
  lifecycle: TerminalResource["lifecycle"];
  lifecycleRevision: number;
  rows: number;
  columns: number;
  initialRows: number;
  initialColumns: number;
  historyFloorSeq: number;
  headSeq: number;
  exitCode: number | null;
  exitSignal: string | null;
  publicReason: string | null;
  createdAt: number;
  startedAt: number | null;
  exitedAt: number | null;
  updatedAt: number;
};

export type PendingTerminalDeletion = {
  readonly terminalId: string;
  readonly mutationId: string;
  readonly operationKind: string;
  readonly requestFingerprint: string;
  readonly requestedAt: number;
  readonly cleanupConfirmed: boolean;
  readonly transportClosed: boolean;
  readonly terminationEffect: TerminalResource["terminationEffect"];
};

export type PrepareTerminalDeletionResult =
  | { readonly kind: "prepared"; readonly deletion: PendingTerminalDeletion }
  | {
      readonly kind: "completed";
      readonly result: { readonly terminalId: string };
    };

export type TerminalJournalFinalStatus = {
  readonly lifecycle: "exited" | "failed" | "interrupted";
  readonly exitCode: number | null;
  readonly exitSignal: string | null;
  readonly publicReason: string | null;
};

export type TerminalThreadSummary = {
  readonly runningCount: number;
  readonly retainedCount: number;
};

const columns = `
  terminal_id AS terminalId, thread_id AS threadId,
  workspace_id AS workspaceId, environment_id AS environmentId,
  environment_label AS environmentLabel, incarnation_id AS incarnationId,
  display_name AS displayName, shell_profile AS shellProfile,
  initial_cwd AS initialCwd, termination_effect AS terminationEffect, lifecycle,
  lifecycle_revision AS lifecycleRevision, rows, columns,
  initial_rows AS initialRows, initial_columns AS initialColumns,
  history_floor_seq AS historyFloorSeq, head_seq AS headSeq,
  exit_code AS exitCode, exit_signal AS exitSignal,
  public_reason AS publicReason, created_at AS createdAt,
  started_at AS startedAt, exited_at AS exitedAt, updated_at AS updatedAt
`;

function hydrate(row: TerminalRow): TerminalResource {
  return terminalResourceSchema.parse({
    ...row,
    createdAt: new Date(row.createdAt).toISOString(),
    startedAt:
      row.startedAt === null ? null : new Date(row.startedAt).toISOString(),
    exitedAt:
      row.exitedAt === null ? null : new Date(row.exitedAt).toISOString(),
    updatedAt: new Date(row.updatedAt).toISOString(),
  });
}

export class TerminalRepository {
  readonly #database: Database.Database;

  constructor(database: Database.Database) {
    this.#database = database;
  }

  list(scope: RequestScope, threadId: string): TerminalResource[] {
    return (
      this.#database
        .prepare(
          `SELECT ${columns} FROM terminals
           WHERE tenant_id = ? AND owner_principal_id = ? AND thread_id = ?
           ORDER BY created_at, terminal_id`,
        )
        .all(scope.tenantId, scope.principalId, threadId) as TerminalRow[]
    ).map(hydrate);
  }

  listAll(scope: RequestScope): TerminalResource[] {
    return (
      this.#database
        .prepare(
          `SELECT ${columns} FROM terminals
           WHERE tenant_id = ? AND owner_principal_id = ?
           ORDER BY created_at, terminal_id`,
        )
        .all(scope.tenantId, scope.principalId) as TerminalRow[]
    ).map(hydrate);
  }

  summariesByThread(
    scope: RequestScope,
    threadIds: readonly string[],
  ): ReadonlyMap<string, TerminalThreadSummary> {
    const summaries = new Map<string, TerminalThreadSummary>(
      threadIds.map((threadId) => [
        threadId,
        { runningCount: 0, retainedCount: 0 },
      ]),
    );
    const uniqueIds = [...new Set(threadIds)];
    if (uniqueIds.length === 0) return summaries;
    const placeholders = uniqueIds.map(() => "?").join(", ");
    const rows = this.#database
      .prepare(
        `SELECT thread_id AS threadId,
                COUNT(*) AS retainedCount,
                SUM(CASE WHEN lifecycle IN ('reserved', 'starting', 'running', 'stopping')
                    THEN 1 ELSE 0 END) AS runningCount
         FROM terminals
         WHERE tenant_id = ? AND owner_principal_id = ?
           AND delete_mutation_id IS NULL
           AND thread_id IN (${placeholders})
         GROUP BY thread_id`,
      )
      .all(scope.tenantId, scope.principalId, ...uniqueIds) as Array<{
      threadId: string;
      runningCount: number;
      retainedCount: number;
    }>;
    for (const row of rows) {
      summaries.set(row.threadId, {
        runningCount: row.runningCount,
        retainedCount: row.retainedCount,
      });
    }
    return summaries;
  }

  get(scope: RequestScope, terminalId: string): TerminalResource | undefined {
    const row = this.#database
      .prepare(
        `SELECT ${columns} FROM terminals
         WHERE tenant_id = ? AND owner_principal_id = ? AND terminal_id = ?`,
      )
      .get(scope.tenantId, scope.principalId, terminalId) as
      TerminalRow | undefined;
    return row ? hydrate(row) : undefined;
  }

  insert(
    scope: RequestScope,
    input: {
      readonly terminalId: string;
      readonly threadId: string;
      readonly workspaceId: string;
      readonly environmentId: string;
      readonly environmentLabel: string;
      readonly terminationEffect: TerminalResource["terminationEffect"];
      readonly displayName: string;
      readonly shellProfile: string | null;
      readonly initialCwd: string;
      readonly rows: number;
      readonly columns: number;
      readonly now: number;
    },
  ): TerminalResource {
    this.#database
      .prepare(
        `INSERT INTO terminals(
           tenant_id, owner_principal_id, terminal_id, thread_id, workspace_id,
           environment_id, environment_label, display_name, shell_profile,
           initial_cwd, termination_effect, lifecycle, lifecycle_revision, rows, columns,
           initial_rows, initial_columns, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'reserved', 1, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        scope.tenantId,
        scope.principalId,
        input.terminalId,
        input.threadId,
        input.workspaceId,
        input.environmentId,
        input.environmentLabel,
        input.displayName,
        input.shellProfile,
        input.initialCwd,
        input.terminationEffect,
        input.rows,
        input.columns,
        input.rows,
        input.columns,
        input.now,
        input.now,
      );
    return this.require(scope, input.terminalId);
  }

  beginStart(
    scope: RequestScope,
    terminalId: string,
    incarnationId: string,
    now: number,
  ): TerminalResource {
    const result = this.#database
      .prepare(
        `UPDATE terminals SET lifecycle = 'starting', incarnation_id = ?,
           lifecycle_revision = lifecycle_revision + 1, updated_at = ?
         WHERE tenant_id = ? AND owner_principal_id = ? AND terminal_id = ?
           AND lifecycle = 'reserved'`,
      )
      .run(incarnationId, now, scope.tenantId, scope.principalId, terminalId);
    if (result.changes !== 1)
      throw new Error("terminal_start_transition_invalid");
    return this.require(scope, terminalId);
  }

  markRunning(
    scope: RequestScope,
    terminalId: string,
    now: number,
  ): TerminalResource {
    const result = this.#database
      .prepare(
        `UPDATE terminals SET lifecycle = 'running', started_at = ?,
           lifecycle_revision = lifecycle_revision + 1, updated_at = ?
         WHERE tenant_id = ? AND owner_principal_id = ? AND terminal_id = ?
           AND lifecycle = 'starting'`,
      )
      .run(now, now, scope.tenantId, scope.principalId, terminalId);
    if (result.changes !== 1)
      throw new Error("terminal_running_transition_invalid");
    return this.require(scope, terminalId);
  }

  updateHead(
    scope: RequestScope,
    terminalId: string,
    headSeq: number,
    now: number,
  ): void {
    this.#database
      .prepare(
        `UPDATE terminals SET head_seq = ?, updated_at = ?
         WHERE tenant_id = ? AND owner_principal_id = ? AND terminal_id = ?
           AND head_seq < ?`,
      )
      .run(
        headSeq,
        now,
        scope.tenantId,
        scope.principalId,
        terminalId,
        headSeq,
      );
  }

  advanceHistoryFloor(
    scope: RequestScope,
    terminalId: string,
    historyFloorSeq: number,
    now: number,
  ): TerminalResource {
    const result = this.#database
      .prepare(
        `UPDATE terminals SET history_floor_seq = ?, updated_at = ?
         WHERE tenant_id = ? AND owner_principal_id = ? AND terminal_id = ?
           AND history_floor_seq < ? AND head_seq >= ?`,
      )
      .run(
        historyFloorSeq,
        now,
        scope.tenantId,
        scope.principalId,
        terminalId,
        historyFloorSeq,
        historyFloorSeq,
      );
    if (result.changes !== 1) {
      throw new Error("terminal_history_floor_transition_invalid");
    }
    return this.require(scope, terminalId);
  }

  reconcileHead(
    scope: RequestScope,
    terminalId: string,
    headSeq: number,
    now: number,
  ): void {
    this.#database
      .prepare(
        `UPDATE terminals SET head_seq = ?,
           history_floor_seq = MIN(history_floor_seq, ?), updated_at = ?
         WHERE tenant_id = ? AND owner_principal_id = ? AND terminal_id = ?`,
      )
      .run(
        headSeq,
        headSeq,
        now,
        scope.tenantId,
        scope.principalId,
        terminalId,
      );
  }

  reconcileJournal(
    scope: RequestScope,
    terminalId: string,
    input: {
      readonly headSeq: number;
      readonly historyFloorSeq: number;
      readonly rows: number;
      readonly columns: number;
      readonly finalStatus?: TerminalJournalFinalStatus;
      readonly now: number;
    },
  ): TerminalResource {
    const final = input.finalStatus;
    const result = this.#database
      .prepare(
        `UPDATE terminals SET
           head_seq = ?, history_floor_seq = ?,
           rows = ?, columns = ?,
           lifecycle = COALESCE(?, lifecycle),
           exit_code = CASE WHEN ? IS NULL THEN exit_code ELSE ? END,
           exit_signal = CASE WHEN ? IS NULL THEN exit_signal ELSE ? END,
           public_reason = CASE WHEN ? IS NULL THEN public_reason ELSE ? END,
           exited_at = CASE WHEN ? IS NULL THEN exited_at ELSE COALESCE(exited_at, ?) END,
           lifecycle_revision = lifecycle_revision + CASE
             WHEN ? IS NOT NULL AND (
               lifecycle <> ? OR exit_code IS NOT ? OR exit_signal IS NOT ?
               OR public_reason IS NOT ?
             ) THEN 1 ELSE 0 END,
           updated_at = ?
         WHERE tenant_id = ? AND owner_principal_id = ? AND terminal_id = ?`,
      )
      .run(
        input.headSeq,
        input.historyFloorSeq,
        input.rows,
        input.columns,
        final?.lifecycle ?? null,
        final?.lifecycle ?? null,
        final?.exitCode ?? null,
        final?.lifecycle ?? null,
        final?.exitSignal ?? null,
        final?.lifecycle ?? null,
        final?.publicReason ?? null,
        final?.lifecycle ?? null,
        input.now,
        final?.lifecycle ?? null,
        final?.lifecycle ?? null,
        final?.exitCode ?? null,
        final?.exitSignal ?? null,
        final?.publicReason ?? null,
        input.now,
        scope.tenantId,
        scope.principalId,
        terminalId,
      );
    if (result.changes !== 1) throw new Error("terminal_not_found");
    return this.require(scope, terminalId);
  }

  markJournalCorrupt(
    scope: RequestScope,
    terminalId: string,
    now: number,
  ): TerminalResource {
    const result = this.#database
      .prepare(
        `UPDATE terminals SET lifecycle = 'failed',
           lifecycle_revision = lifecycle_revision + CASE
             WHEN lifecycle <> 'failed' OR public_reason IS NOT 'history_corrupt'
             THEN 1 ELSE 0 END,
           rows = initial_rows, columns = initial_columns,
           history_floor_seq = 0, head_seq = 0,
           exit_code = NULL, exit_signal = NULL,
           public_reason = 'history_corrupt', exited_at = COALESCE(exited_at, ?),
           updated_at = ?
         WHERE tenant_id = ? AND owner_principal_id = ? AND terminal_id = ?`,
      )
      .run(now, now, scope.tenantId, scope.principalId, terminalId);
    if (result.changes !== 1) throw new Error("terminal_not_found");
    return this.require(scope, terminalId);
  }

  resize(
    scope: RequestScope,
    terminalId: string,
    rows: number,
    columnsValue: number,
    headSeq: number,
    now: number,
  ): TerminalResource {
    this.#database
      .prepare(
        `UPDATE terminals SET rows = ?, columns = ?, head_seq = ?, updated_at = ?
         WHERE tenant_id = ? AND owner_principal_id = ? AND terminal_id = ?`,
      )
      .run(
        rows,
        columnsValue,
        headSeq,
        now,
        scope.tenantId,
        scope.principalId,
        terminalId,
      );
    return this.require(scope, terminalId);
  }

  markStopping(
    scope: RequestScope,
    terminalId: string,
    expectedRevision: number,
    now: number,
  ): TerminalResource {
    const result = this.#database
      .prepare(
        `UPDATE terminals SET lifecycle = 'stopping',
           lifecycle_revision = lifecycle_revision + 1, updated_at = ?
         WHERE tenant_id = ? AND owner_principal_id = ? AND terminal_id = ?
           AND lifecycle = 'running' AND lifecycle_revision = ?`,
      )
      .run(
        now,
        scope.tenantId,
        scope.principalId,
        terminalId,
        expectedRevision,
      );
    if (result.changes !== 1) throw new Error("terminal_revision_conflict");
    return this.require(scope, terminalId);
  }

  finalize(
    scope: RequestScope,
    terminalId: string,
    input: {
      readonly lifecycle: "exited" | "failed" | "interrupted";
      readonly headSeq: number;
      readonly exitCode?: number | null;
      readonly exitSignal?: string | null;
      readonly publicReason?: string | null;
      readonly confirmPendingEndCleanup?: boolean;
      readonly confirmPendingTransportClosed?: boolean;
      readonly now: number;
    },
  ): TerminalResource {
    this.#database
      .prepare(
        `UPDATE terminals SET lifecycle = ?, head_seq = ?, exit_code = ?,
           exit_signal = ?, public_reason = ?, exited_at = ?, updated_at = ?,
           delete_cleanup_confirmed = CASE
             WHEN delete_operation_kind = 'terminal_end' AND ? = 1 THEN 1
             ELSE delete_cleanup_confirmed
           END,
           delete_transport_closed = CASE
             WHEN delete_operation_kind = 'terminal_end' AND ? = 1 THEN 1
             ELSE delete_transport_closed
           END,
           lifecycle_revision = lifecycle_revision + 1
         WHERE tenant_id = ? AND owner_principal_id = ? AND terminal_id = ?
           AND lifecycle NOT IN ('exited', 'failed', 'interrupted')`,
      )
      .run(
        input.lifecycle,
        input.headSeq,
        input.exitCode ?? null,
        input.exitSignal ?? null,
        input.publicReason ?? null,
        input.now,
        input.now,
        input.confirmPendingEndCleanup ? 1 : 0,
        input.confirmPendingTransportClosed ? 1 : 0,
        scope.tenantId,
        scope.principalId,
        terminalId,
      );
    return this.require(scope, terminalId);
  }

  rename(
    scope: RequestScope,
    terminalId: string,
    expectedRevision: number,
    displayName: string,
    now: number,
  ): TerminalResource {
    const result = this.#database
      .prepare(
        `UPDATE terminals SET display_name = ?,
           lifecycle_revision = lifecycle_revision + 1, updated_at = ?
         WHERE tenant_id = ? AND owner_principal_id = ? AND terminal_id = ?
           AND lifecycle_revision = ?`,
      )
      .run(
        displayName,
        now,
        scope.tenantId,
        scope.principalId,
        terminalId,
        expectedRevision,
      );
    if (result.changes !== 1) throw new Error("terminal_revision_conflict");
    return this.require(scope, terminalId);
  }

  prepareDeletion(
    scope: RequestScope,
    input: {
      readonly terminalId: string;
      readonly expectedRevision: number;
      readonly mutationId: string;
      readonly operationKind: string;
      readonly request: unknown;
      readonly now: number;
    },
  ): PrepareTerminalDeletionResult {
    const fingerprint = this.#fingerprint(input.request);
    const completed = this.#readReceipt<{ terminalId: string }>(
      scope,
      input.mutationId,
      input.operationKind,
      fingerprint,
    );
    if (completed !== undefined)
      return { kind: "completed", result: completed };

    const transaction = this.#database.transaction(() => {
      const pending = this.#pendingDeletion(scope, input.terminalId);
      if (pending) {
        if (
          pending.mutationId !== input.mutationId ||
          pending.operationKind !== input.operationKind ||
          pending.requestFingerprint !== fingerprint
        ) {
          throw new Error("terminal_deletion_pending");
        }
        return pending;
      }
      const result = this.#database
        .prepare(
          `UPDATE terminals SET delete_mutation_id = ?, delete_operation_kind = ?,
             delete_request_fingerprint = ?, delete_requested_at = ?,
             delete_cleanup_confirmed = CASE WHEN ? = 'terminal_end' THEN 0 ELSE 1 END,
             delete_transport_closed = 0,
             lifecycle_revision = lifecycle_revision + 1, updated_at = ?
           WHERE tenant_id = ? AND owner_principal_id = ? AND terminal_id = ?
             AND (
               (? = 'terminal_delete' AND lifecycle IN ('exited', 'failed', 'interrupted'))
               OR (? = 'terminal_end' AND lifecycle IN ('reserved', 'starting', 'running', 'stopping'))
             )
             AND lifecycle_revision = ? AND delete_mutation_id IS NULL`,
        )
        .run(
          input.mutationId,
          input.operationKind,
          fingerprint,
          input.now,
          input.operationKind,
          input.now,
          scope.tenantId,
          scope.principalId,
          input.terminalId,
          input.operationKind,
          input.operationKind,
          input.expectedRevision,
        );
      if (result.changes !== 1) {
        const terminal = this.get(scope, input.terminalId);
        if (!terminal) throw new Error("terminal_not_found");
        if (terminal.lifecycleRevision !== input.expectedRevision) {
          throw new Error("terminal_revision_conflict");
        }
        throw new Error("terminal_delete_transition_invalid");
      }
      return this.#pendingDeletion(scope, input.terminalId)!;
    });
    return { kind: "prepared", deletion: transaction() };
  }

  cancelDeletion(
    scope: RequestScope,
    input: {
      readonly terminalId: string;
      readonly mutationId: string;
      readonly operationKind: string;
      readonly now: number;
    },
  ): TerminalResource {
    const result = this.#database
      .prepare(
        `UPDATE terminals SET delete_mutation_id = NULL,
           delete_operation_kind = NULL, delete_request_fingerprint = NULL,
           delete_requested_at = NULL, delete_cleanup_confirmed = NULL,
           delete_transport_closed = NULL,
           lifecycle_revision = lifecycle_revision + 1, updated_at = ?
         WHERE tenant_id = ? AND owner_principal_id = ? AND terminal_id = ?
           AND delete_mutation_id = ? AND delete_operation_kind = ?`,
      )
      .run(
        input.now,
        scope.tenantId,
        scope.principalId,
        input.terminalId,
        input.mutationId,
        input.operationKind,
      );
    if (result.changes !== 1) throw new Error("terminal_deletion_not_prepared");
    return this.require(scope, input.terminalId);
  }

  listPendingDeletions(scope: RequestScope): PendingTerminalDeletion[] {
    return (
      this.#database
      .prepare(
        `SELECT terminal_id AS terminalId, delete_mutation_id AS mutationId,
                delete_operation_kind AS operationKind,
                delete_request_fingerprint AS requestFingerprint,
                delete_requested_at AS requestedAt,
                termination_effect AS terminationEffect,
                delete_transport_closed AS transportClosed,
                delete_cleanup_confirmed AS cleanupConfirmed
         FROM terminals
         WHERE tenant_id = ? AND owner_principal_id = ?
           AND delete_mutation_id IS NOT NULL
         ORDER BY delete_requested_at, terminal_id`,
      )
      .all(scope.tenantId, scope.principalId) as Array<
        Omit<PendingTerminalDeletion, "cleanupConfirmed" | "transportClosed"> & { cleanupConfirmed: number; transportClosed: number }
      >
    ).map((pending) => ({
      ...pending,
      cleanupConfirmed: pending.cleanupConfirmed === 1,
      transportClosed: pending.transportClosed === 1,
    }));
  }

  getPendingDeletion(
    scope: RequestScope,
    terminalId: string,
  ): PendingTerminalDeletion | undefined {
    return this.#pendingDeletion(scope, terminalId);
  }

  completeDeletion(
    scope: RequestScope,
    terminalId: string,
    now: number,
  ): { readonly terminalId: string } {
    const transaction = this.#database.transaction(() => {
      const pending = this.#pendingDeletion(scope, terminalId);
      if (!pending) throw new Error("terminal_deletion_not_prepared");
      const ready = pending.operationKind === "terminal_end"
        ? pending.terminationEffect === "disconnect_transport"
          ? pending.transportClosed
          : pending.cleanupConfirmed
        : pending.cleanupConfirmed;
      if (!ready) {
        throw new Error("terminal_cleanup_not_confirmed");
      }
      const result = { terminalId };
      this.#database
        .prepare(
          `INSERT INTO terminal_mutation_receipts(
             tenant_id, principal_id, mutation_id, operation_kind,
             request_fingerprint, result_json, created_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          scope.tenantId,
          scope.principalId,
          pending.mutationId,
          pending.operationKind,
          pending.requestFingerprint,
          JSON.stringify(result),
          now,
        );
      const deleted = this.#database
        .prepare(
          `DELETE FROM terminals
           WHERE tenant_id = ? AND owner_principal_id = ? AND terminal_id = ?
             AND delete_mutation_id = ?`,
        )
        .run(scope.tenantId, scope.principalId, terminalId, pending.mutationId);
      if (deleted.changes !== 1)
        throw new Error("terminal_deletion_not_prepared");
      return result;
    });
    return transaction();
  }

  recoverInterrupted(scope: RequestScope, now: number): TerminalResource[] {
    this.#database
      .prepare(
        `UPDATE terminals SET lifecycle = 'failed', public_reason = 'start_not_attempted',
           exited_at = ?, updated_at = ?, lifecycle_revision = lifecycle_revision + 1
         WHERE tenant_id = ? AND owner_principal_id = ? AND lifecycle = 'reserved'`,
      )
      .run(now, now, scope.tenantId, scope.principalId);
    this.#database
      .prepare(
        `UPDATE terminals SET lifecycle = 'interrupted', public_reason = 'server_restarted',
           exited_at = ?, updated_at = ?, lifecycle_revision = lifecycle_revision + 1
         WHERE tenant_id = ? AND owner_principal_id = ?
           AND lifecycle IN ('starting', 'running', 'stopping')
           AND (termination_effect = 'disconnect_transport' OR EXISTS (
             SELECT 1 FROM execution_environments AS environment
             WHERE environment.tenant_id = terminals.tenant_id
               AND environment.owner_principal_id = terminals.owner_principal_id
               AND environment.id = terminals.environment_id
               AND environment.kind = 'local'
           ))`,
      )
      .run(now, now, scope.tenantId, scope.principalId);
    return (
      this.#database
        .prepare(
          `SELECT ${columns} FROM terminals
           WHERE tenant_id = ? AND owner_principal_id = ?
             AND lifecycle IN ('failed', 'interrupted') AND updated_at = ?`,
        )
        .all(scope.tenantId, scope.principalId, now) as TerminalRow[]
    ).map(hydrate);
  }

  receipt<T>(
    scope: RequestScope,
    input: {
      readonly mutationId: string;
      readonly operationKind: string;
      readonly request: unknown;
      readonly now: number;
      readonly run: () => T;
    },
  ): T {
    const fingerprint = this.#fingerprint(input.request);
    const existing = this.#readReceipt<T>(
      scope,
      input.mutationId,
      input.operationKind,
      fingerprint,
    );
    if (existing !== undefined) return existing;
    const transaction = this.#database.transaction(() => {
      const result = input.run();
      this.#database
        .prepare(
          `INSERT INTO terminal_mutation_receipts(
             tenant_id, principal_id, mutation_id, operation_kind,
             request_fingerprint, result_json, created_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          scope.tenantId,
          scope.principalId,
          input.mutationId,
          input.operationKind,
          fingerprint,
          JSON.stringify(result),
          input.now,
        );
      return result;
    });
    return transaction();
  }

  completedReceipt<T>(
    scope: RequestScope,
    input: {
      readonly mutationId: string;
      readonly operationKind: string;
      readonly request: unknown;
    },
  ): T | undefined {
    return this.#readReceipt<T>(
      scope,
      input.mutationId,
      input.operationKind,
      this.#fingerprint(input.request),
    );
  }

  require(scope: RequestScope, terminalId: string): TerminalResource {
    const terminal = this.get(scope, terminalId);
    if (!terminal) throw new Error("terminal_not_found");
    return terminal;
  }

  #fingerprint(request: unknown): string {
    return createHash("sha256").update(JSON.stringify(request)).digest("hex");
  }

  #readReceipt<T>(
    scope: RequestScope,
    mutationId: string,
    operationKind: string,
    requestFingerprint: string,
  ): T | undefined {
    const existing = this.#database
      .prepare(
        `SELECT operation_kind AS operationKind,
                request_fingerprint AS requestFingerprint,
                result_json AS resultJson
         FROM terminal_mutation_receipts
         WHERE tenant_id = ? AND principal_id = ? AND mutation_id = ?`,
      )
      .get(scope.tenantId, scope.principalId, mutationId) as
      | {
          operationKind: string;
          requestFingerprint: string;
          resultJson: string;
        }
      | undefined;
    if (!existing) return undefined;
    if (
      existing.operationKind !== operationKind ||
      existing.requestFingerprint !== requestFingerprint
    ) {
      throw new Error("terminal_mutation_id_conflict");
    }
    return JSON.parse(existing.resultJson) as T;
  }

  #pendingDeletion(
    scope: RequestScope,
    terminalId: string,
  ): PendingTerminalDeletion | undefined {
    const pending = this.#database
      .prepare(
        `SELECT terminal_id AS terminalId, delete_mutation_id AS mutationId,
                delete_operation_kind AS operationKind,
                delete_request_fingerprint AS requestFingerprint,
                delete_requested_at AS requestedAt,
                termination_effect AS terminationEffect,
                delete_transport_closed AS transportClosed,
                delete_cleanup_confirmed AS cleanupConfirmed
         FROM terminals
         WHERE tenant_id = ? AND owner_principal_id = ? AND terminal_id = ?
           AND delete_mutation_id IS NOT NULL`,
      )
      .get(scope.tenantId, scope.principalId, terminalId) as
      (Omit<PendingTerminalDeletion, "cleanupConfirmed" | "transportClosed"> & {
        cleanupConfirmed: number;
        transportClosed: number;
      }) | undefined;
    return pending
      ? { ...pending, cleanupConfirmed: pending.cleanupConfirmed === 1, transportClosed: pending.transportClosed === 1 }
      : undefined;
  }
}
