import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import {
  boundedDisplayTextSchema,
  boundedTextSchema,
  type BoundedDisplayText,
  type BoundedText,
} from "../../../shared/protocol/payload.js";
import { DomainError } from "../../domain/errors.js";
import type { RequestScope } from "../../identity/identity-provider.js";

export const MAXIMUM_REGISTERED_COMPLETION_CALLBACKS_PER_THREAD = 100;

export type ThreadCompletionCallbackState =
  "registered" | "materialized" | "cancelled";

export type ThreadCompletionCallbackRecord = {
  readonly tenantId: string;
  readonly ownerPrincipalId: string;
  readonly id: string;
  readonly callerThreadId: string;
  readonly targetThreadId: string;
  readonly targetOperationId: string;
  readonly state: ThreadCompletionCallbackState;
  readonly registeredAt: number;
  readonly materializedAt: number | null;
  readonly cancelledAt: number | null;
  readonly cancellationReason: string | null;
  readonly cancellationMutationId: string | null;
  readonly completionIdentity: string | null;
  readonly sourceThreadLabel: BoundedDisplayText | null;
};

export type ReadyThreadCompletionCallback = {
  readonly callback: ThreadCompletionCallbackRecord;
  readonly applicationTurnId: string;
  readonly outcome: "completed" | "interrupted" | "failed";
  readonly result: BoundedText;
  readonly completionIdentity: string;
  readonly completionObservedAt: number;
};

type CallbackRow = Omit<ThreadCompletionCallbackRecord, "sourceThreadLabel"> & {
  readonly sourceThreadLabelJson: string | null;
};

const CALLBACK_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const columns = `
  callback.tenant_id AS tenantId,
  callback.owner_principal_id AS ownerPrincipalId,
  callback.id,
  callback.caller_thread_id AS callerThreadId,
  callback.target_thread_id AS targetThreadId,
  callback.target_operation_id AS targetOperationId,
  callback.state,
  callback.registered_at AS registeredAt,
  callback.materialized_at AS materializedAt,
  callback.cancelled_at AS cancelledAt,
  callback.cancellation_reason AS cancellationReason,
  callback.cancellation_mutation_id AS cancellationMutationId,
  callback.completion_identity AS completionIdentity,
  callback.source_thread_label_json AS sourceThreadLabelJson
`;

function parseJson<T>(
  value: string,
  schema: { readonly parse: (candidate: unknown) => T },
  diagnostic: string,
): T {
  try {
    return schema.parse(JSON.parse(value) as unknown);
  } catch (error) {
    throw new DomainError("conflict", diagnostic, false, { cause: error });
  }
}

function present(row: CallbackRow): ThreadCompletionCallbackRecord {
  return Object.freeze({
    ...row,
    sourceThreadLabel:
      row.sourceThreadLabelJson === null
        ? null
        : parseJson(
            row.sourceThreadLabelJson,
            boundedDisplayTextSchema,
            "The stored completion callback source label is invalid.",
          ),
  });
}

function assertTimestamp(value: number, description: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new DomainError("conflict", `${description} is invalid.`);
  }
}

export class ThreadCompletionCallbackRepository {
  constructor(readonly database: Database.Database) {}

  register(
    scope: RequestScope,
    input: {
      readonly id?: string;
      readonly callerThreadId: string;
      readonly targetThreadId: string;
      readonly targetOperationId: string;
      readonly registeredAt: number;
    },
  ): {
    readonly callback: ThreadCompletionCallbackRecord;
    readonly replayed: boolean;
  } {
    assertTimestamp(input.registeredAt, "The callback registration timestamp");
    if (input.callerThreadId === input.targetThreadId) {
      throw new DomainError(
        "invalid_transition",
        "A thread cannot register a completion callback to itself.",
      );
    }
    if (
      input.targetOperationId.length < 1 ||
      input.targetOperationId.length > 200
    ) {
      throw new DomainError(
        "conflict",
        "The target operation identifier is invalid.",
      );
    }
    return this.database.transaction(() => {
      const replay = this.findForTargetOperation(
        scope,
        input.targetThreadId,
        input.targetOperationId,
      );
      if (replay) {
        if (replay.callerThreadId !== input.callerThreadId) {
          throw new DomainError(
            "conflict",
            "The target operation already has a different completion callback.",
          );
        }
        if (input.id !== undefined && replay.id !== input.id) {
          throw new DomainError(
            "conflict",
            "The callback identifier does not match its durable registration.",
          );
        }
        return { callback: replay, replayed: true };
      }
      for (const threadId of [input.callerThreadId, input.targetThreadId]) {
        const thread = this.database
          .prepare(
            `
              SELECT 1 FROM application_threads
              WHERE tenant_id = ? AND owner_principal_id = ? AND id = ?
            `,
          )
          .get(scope.tenantId, scope.principalId, threadId);
        if (!thread) {
          throw new DomainError(
            "not_found",
            "The callback thread was not found.",
          );
        }
      }
      const outstanding = this.database
        .prepare(
          `
            SELECT count(*) AS count
            FROM thread_completion_callbacks
            WHERE tenant_id = ? AND owner_principal_id = ?
              AND caller_thread_id = ? AND state = 'registered'
          `,
        )
        .get(scope.tenantId, scope.principalId, input.callerThreadId) as {
        readonly count: number;
      };
      if (
        outstanding.count >= MAXIMUM_REGISTERED_COMPLETION_CALLBACKS_PER_THREAD
      ) {
        throw new DomainError(
          "conflict",
          "The calling thread has reached its outstanding completion callback limit.",
        );
      }
      const id = input.id ?? randomUUID();
      if (!CALLBACK_ID_PATTERN.test(id)) {
        throw new DomainError(
          "conflict",
          "The callback identifier is invalid.",
        );
      }
      this.database
        .prepare(
          `
            INSERT INTO thread_completion_callbacks(
              tenant_id, owner_principal_id, id, caller_thread_id,
              target_thread_id, target_operation_id, state, registered_at
            ) VALUES (?, ?, ?, ?, ?, ?, 'registered', ?)
          `,
        )
        .run(
          scope.tenantId,
          scope.principalId,
          id,
          input.callerThreadId,
          input.targetThreadId,
          input.targetOperationId,
          input.registeredAt,
        );
      return { callback: this.get(scope, id), replayed: false };
    })();
  }

  listReadyForMaterialization(
    scope: RequestScope,
  ): ReadyThreadCompletionCallback[] {
    const rows = this.database
      .prepare(
        `
          SELECT ${columns},
            completion.application_turn_id AS applicationTurnId,
            completion.completion_outcome AS outcome,
            completion.assistant_result_json AS resultJson,
            completion.last_completion_identity AS readyCompletionIdentity,
            completion.completion_observed_at AS completionObservedAt
          FROM thread_completion_callbacks AS callback
          JOIN submission_completion_observations AS completion
            ON completion.tenant_id = callback.tenant_id
            AND completion.owner_principal_id = callback.owner_principal_id
            AND completion.application_thread_id = callback.target_thread_id
            AND completion.operation_id = callback.target_operation_id
          WHERE callback.tenant_id = ? AND callback.owner_principal_id = ?
            AND callback.state = 'registered'
            AND completion.application_turn_id IS NOT NULL
            AND completion.completion_outcome IS NOT NULL
            AND completion.assistant_result_json IS NOT NULL
            AND completion.last_completion_identity IS NOT NULL
            AND completion.completion_observed_at IS NOT NULL
          ORDER BY completion.completion_observed_at, callback.registered_at,
            callback.id
        `,
      )
      .all(scope.tenantId, scope.principalId) as Array<
      CallbackRow & {
        readonly applicationTurnId: string;
        readonly outcome: "completed" | "interrupted" | "failed";
        readonly resultJson: string;
        readonly readyCompletionIdentity: string;
        readonly completionObservedAt: number;
      }
    >;
    return rows.map((row) => ({
      callback: present(row),
      applicationTurnId: row.applicationTurnId,
      outcome: row.outcome,
      result: parseJson(
        row.resultJson,
        boundedTextSchema,
        "The stored completion callback result is invalid.",
      ),
      completionIdentity: row.readyCompletionIdentity,
      completionObservedAt: row.completionObservedAt,
    }));
  }

  markMaterialized(
    scope: RequestScope,
    id: string,
    input: {
      readonly queuedInputId: string;
      readonly completionIdentity: string;
      readonly sourceThreadLabel: BoundedDisplayText;
      readonly materializedAt: number;
    },
  ): ThreadCompletionCallbackRecord {
    assertTimestamp(
      input.materializedAt,
      "The callback materialization timestamp",
    );
    const label = boundedDisplayTextSchema.parse(input.sourceThreadLabel);
    return this.database.transaction(() => {
      const current = this.get(scope, id);
      if (current.state === "materialized") {
        const queue = this.#findQueue(scope, id);
        if (
          queue?.id !== input.queuedInputId ||
          current.completionIdentity !== input.completionIdentity ||
          JSON.stringify(current.sourceThreadLabel) !== JSON.stringify(label)
        ) {
          throw new DomainError(
            "conflict",
            "The callback materialization does not match its durable record.",
          );
        }
        return current;
      }
      if (current.state !== "registered") {
        throw new DomainError(
          "invalid_transition",
          "Only a registered completion callback can be materialized.",
        );
      }
      const queue = this.#findQueue(scope, id);
      if (
        !queue ||
        queue.id !== input.queuedInputId ||
        queue.applicationThreadId !== current.callerThreadId
      ) {
        throw new DomainError(
          "invalid_transition",
          "The callback queue materialization is missing or mismatched.",
        );
      }
      const completion = this.database
        .prepare(
          `
            SELECT last_completion_identity AS completionIdentity
            FROM submission_completion_observations
            WHERE tenant_id = ? AND owner_principal_id = ?
              AND application_thread_id = ? AND operation_id = ?
              AND application_turn_id IS NOT NULL
              AND completion_outcome IS NOT NULL
              AND assistant_result_json IS NOT NULL
          `,
        )
        .get(
          scope.tenantId,
          scope.principalId,
          current.targetThreadId,
          current.targetOperationId,
        ) as { readonly completionIdentity: string } | undefined;
      if (completion?.completionIdentity !== input.completionIdentity) {
        throw new DomainError(
          "conflict",
          "The callback completion identity does not match its finalized result.",
        );
      }
      const changed = this.database
        .prepare(
          `
            UPDATE thread_completion_callbacks
            SET state = 'materialized', materialized_at = ?,
              completion_identity = ?, source_thread_label_json = ?
            WHERE tenant_id = ? AND owner_principal_id = ? AND id = ?
              AND state = 'registered'
          `,
        )
        .run(
          input.materializedAt,
          input.completionIdentity,
          JSON.stringify(label),
          scope.tenantId,
          scope.principalId,
          id,
        );
      if (changed.changes !== 1) {
        throw new DomainError(
          "conflict",
          "The completion callback changed during materialization.",
        );
      }
      return this.get(scope, id);
    })();
  }

  cancelRegisteredForThread(
    scope: RequestScope,
    threadId: string,
    input: {
      readonly cancelledAt: number;
      readonly reason: string;
      readonly cancellationMutationId: string;
    },
  ): number {
    assertTimestamp(input.cancelledAt, "The callback cancellation timestamp");
    this.#assertCancellationInput(input.reason, input.cancellationMutationId);
    return this.database
      .prepare(
        `
          UPDATE thread_completion_callbacks
          SET state = 'cancelled', cancelled_at = ?, cancellation_reason = ?,
            cancellation_mutation_id = ?
          WHERE tenant_id = ? AND owner_principal_id = ?
            AND state = 'registered'
            AND (caller_thread_id = ? OR target_thread_id = ?)
        `,
      )
      .run(
        input.cancelledAt,
        input.reason,
        input.cancellationMutationId,
        scope.tenantId,
        scope.principalId,
        threadId,
        threadId,
      ).changes;
  }

  cancelRegistered(
    scope: RequestScope,
    id: string,
    input: {
      readonly cancelledAt: number;
      readonly reason: string;
      readonly cancellationMutationId: string;
    },
  ): ThreadCompletionCallbackRecord {
    assertTimestamp(input.cancelledAt, "The callback cancellation timestamp");
    this.#assertCancellationInput(input.reason, input.cancellationMutationId);
    return this.database.transaction(() => {
      const current = this.get(scope, id);
      if (current.state === "cancelled") {
        if (
          current.cancellationReason !== input.reason ||
          current.cancellationMutationId !== input.cancellationMutationId
        ) {
          throw new DomainError(
            "conflict",
            "The callback cancellation does not match its durable record.",
          );
        }
        return current;
      }
      if (current.state !== "registered") {
        throw new DomainError(
          "invalid_transition",
          "Only a registered completion callback can be cancelled.",
        );
      }
      const changed = this.database
        .prepare(
          `
            UPDATE thread_completion_callbacks
            SET state = 'cancelled', cancelled_at = ?, cancellation_reason = ?,
              cancellation_mutation_id = ?
            WHERE tenant_id = ? AND owner_principal_id = ? AND id = ?
              AND state = 'registered'
          `,
        )
        .run(
          input.cancelledAt,
          input.reason,
          input.cancellationMutationId,
          scope.tenantId,
          scope.principalId,
          id,
        );
      if (changed.changes !== 1) {
        throw new DomainError(
          "conflict",
          "The completion callback changed during cancellation.",
        );
      }
      return this.get(scope, id);
    })();
  }

  countRegisteredForThread(scope: RequestScope, threadId: string): number {
    return (
      this.database
        .prepare(
          `
            SELECT count(*) AS count FROM thread_completion_callbacks
            WHERE tenant_id = ? AND owner_principal_id = ?
              AND state = 'registered'
              AND (caller_thread_id = ? OR target_thread_id = ?)
          `,
        )
        .get(scope.tenantId, scope.principalId, threadId, threadId) as {
        readonly count: number;
      }
    ).count;
  }

  findForTargetOperation(
    scope: RequestScope,
    targetThreadId: string,
    targetOperationId: string,
  ): ThreadCompletionCallbackRecord | undefined {
    const row = this.database
      .prepare(
        `
          SELECT ${columns}
          FROM thread_completion_callbacks AS callback
          WHERE callback.tenant_id = ? AND callback.owner_principal_id = ?
            AND callback.target_thread_id = ?
            AND callback.target_operation_id = ?
        `,
      )
      .get(
        scope.tenantId,
        scope.principalId,
        targetThreadId,
        targetOperationId,
      ) as CallbackRow | undefined;
    return row ? present(row) : undefined;
  }

  find(
    scope: RequestScope,
    id: string,
  ): ThreadCompletionCallbackRecord | undefined {
    const row = this.database
      .prepare(
        `
          SELECT ${columns}
          FROM thread_completion_callbacks AS callback
          WHERE callback.tenant_id = ? AND callback.owner_principal_id = ?
            AND callback.id = ?
        `,
      )
      .get(scope.tenantId, scope.principalId, id) as CallbackRow | undefined;
    return row ? present(row) : undefined;
  }

  get(scope: RequestScope, id: string): ThreadCompletionCallbackRecord {
    const callback = this.find(scope, id);
    if (!callback) {
      throw new DomainError(
        "not_found",
        "The completion callback was not found.",
      );
    }
    return callback;
  }

  #findQueue(
    scope: RequestScope,
    callbackId: string,
  ): { readonly id: string; readonly applicationThreadId: string } | undefined {
    return this.database
      .prepare(
        `
          SELECT id, application_thread_id AS applicationThreadId
          FROM queued_inputs
          WHERE tenant_id = ? AND owner_principal_id = ?
            AND completion_callback_id = ?
        `,
      )
      .get(scope.tenantId, scope.principalId, callbackId) as
      { readonly id: string; readonly applicationThreadId: string } | undefined;
  }

  #assertCancellationInput(reason: string, mutationId: string): void {
    if (
      Buffer.byteLength(reason, "utf8") < 1 ||
      Buffer.byteLength(reason, "utf8") > 500
    ) {
      throw new DomainError(
        "conflict",
        "The callback cancellation reason is invalid.",
      );
    }
    if (mutationId.length < 1 || mutationId.length > 160) {
      throw new DomainError(
        "conflict",
        "The callback cancellation mutation identifier is invalid.",
      );
    }
  }
}
