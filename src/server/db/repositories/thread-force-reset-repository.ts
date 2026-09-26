import { createHash } from "node:crypto";
import type Database from "better-sqlite3";
import type {
  ThreadForceResetBlockerKind,
  ThreadForceResetBlockerSummary,
  ThreadForceResetImpact,
  ThreadForceResetResult,
  ThreadForceResetWarning,
} from "../../../shared/protocol/api.js";
import {
  backgroundActivitySchema,
  hasOutstandingBackgroundActivity,
  type BackgroundActivity,
} from "../../../shared/protocol/background-activity.js";
import {
  threadRunStateSchema,
  type ThreadRunState,
} from "../../../shared/protocol/conversation.js";
import { DomainError } from "../../domain/errors.js";
import type { RequestScope } from "../../identity/identity-provider.js";

const MAXIMUM_AFFECTED_THREADS = 10_000;
const BLOCKER_KIND_ORDER: readonly ThreadForceResetBlockerKind[] = [
  "pending_interaction",
  "completion_callback",
  "queued_input",
  "conversation_operation",
  "provider_feature_operation",
  "creation_attempt",
  "thread_creation_state",
  "fork_origin",
  "automation_run",
  "conversation_runtime",
];

type Blocker = {
  readonly kind: ThreadForceResetBlockerKind;
  readonly id: string;
  readonly threadId: string;
  readonly state: string;
  readonly mayHaveProviderSideEffect: boolean;
};

export interface ThreadForceResetPendingInteractionBlocker {
  readonly kind: "pending_interaction";
  readonly id: string;
  readonly threadId: string;
}

export interface ThreadForceResetConversationRuntimeBlocker {
  readonly kind: "conversation_runtime";
  readonly threadId: string;
  readonly generation: string;
  readonly runState: ThreadRunState;
  readonly activeTurnId?: string;
  /** Background work the loaded runtime reports; replacing it stops that work. */
  readonly backgroundActivity?: BackgroundActivity;
}

type PreparedFork = {
  readonly childThreadId: string;
  readonly sourceThreadId: string;
  readonly branchMethod: "provider_native" | "provider_history_import";
};

type Capture = {
  readonly affectedThreadIds: readonly string[];
  readonly affectedThreads: ThreadForceResetImpact["affectedThreads"];
  readonly blockers: readonly Blocker[];
  readonly preparedForks: readonly PreparedFork[];
  readonly blockerFingerprint: string;
  readonly summaries: readonly ThreadForceResetBlockerSummary[];
  readonly conversationRuntimes: readonly ThreadForceResetConversationRuntimeBlocker[];
};

export type ThreadForceResetCommit = ThreadForceResetResult & {
  readonly promotedTaskIds: readonly string[];
  readonly replayed: boolean;
  readonly resetConversationRuntimes: readonly ThreadForceResetConversationRuntimeBlocker[];
};

type ReceiptRow = {
  readonly threadId: string;
  readonly requestFingerprint: string;
  readonly blockerFingerprint: string;
  readonly blockerSummaryJson: string;
  readonly resetAt: number;
};

function hash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function requestFingerprint(
  threadId: string,
  expectedBlockerFingerprint: string,
): string {
  return hash(["thread_force_reset", 1, threadId, expectedBlockerFingerprint]);
}

function parseSummaries(
  value: string,
): readonly ThreadForceResetBlockerSummary[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch (error) {
    throw new DomainError(
      "conflict",
      "The force-reset receipt is corrupt.",
      false,
      {
        cause: error,
      },
    );
  }
  if (!Array.isArray(parsed)) {
    throw new DomainError("conflict", "The force-reset receipt is corrupt.");
  }
  return parsed as readonly ThreadForceResetBlockerSummary[];
}

/**
 * Principal-scoped Sedes state abandonment. This repository intentionally
 * has no backend/runtime dependency and performs the full transition in one
 * SQLite transaction.
 */
export class ThreadForceResetRepository {
  constructor(readonly database: Database.Database) {}

  impact(
    scope: RequestScope,
    threadId: string,
    pendingInteractions: readonly ThreadForceResetPendingInteractionBlocker[] = [],
    conversationRuntimes: readonly ThreadForceResetConversationRuntimeBlocker[] = [],
  ): ThreadForceResetImpact {
    const capture = this.#capture(
      scope,
      threadId,
      pendingInteractions,
      conversationRuntimes,
    );
    const warnings: ThreadForceResetWarning[] = [];
    if (
      capture.blockers.some(
        ({ mayHaveProviderSideEffect }) => mayHaveProviderSideEffect,
      )
    ) {
      warnings.push({
        code: "provider_side_effects_may_remain",
        message:
          "Sedes will abandon unresolved work, but an operation may already have affected the provider.",
      });
    }
    if (
      capture.preparedForks.some(
        ({ branchMethod }) => branchMethod === "provider_native",
      )
    ) {
      warnings.push({
        code: "native_fork_orphan_may_remain",
        message:
          "A provider-native fork may remain outside Sedes and will not be deleted or adopted.",
      });
    }
    warnings.push({
      code: "provider_activity_may_reappear",
      message:
        "Force reset does not stop provider work or claim that the provider is idle; authoritative activity may appear again.",
    });
    if (
      capture.conversationRuntimes.some(
        (runtime) =>
          !["idle", "failed"].includes(runtime.runState) ||
          hasOutstandingBackgroundActivity(runtime.backgroundActivity),
      )
    ) {
      warnings.unshift({
        code: "running_work_will_stop",
        message:
          "Force reset replaces the loaded runtimes listed below, which stops their running turns and background work.",
      });
    }
    return {
      blockerFingerprint: capture.blockerFingerprint,
      resettable: capture.blockers.length > 0,
      blockers: [...capture.summaries],
      affectedThreads: [...capture.affectedThreads],
      warnings,
    };
  }

  forceReset(
    scope: RequestScope,
    threadId: string,
    input: {
      readonly expectedBlockerFingerprint: string;
      readonly mutationId: string;
      readonly now: number;
      readonly pendingInteractions?: readonly ThreadForceResetPendingInteractionBlocker[];
      readonly conversationRuntimes?: readonly ThreadForceResetConversationRuntimeBlocker[];
    },
  ): ThreadForceResetCommit {
    const fingerprint = requestFingerprint(
      threadId,
      input.expectedBlockerFingerprint,
    );
    return this.database.transaction(() => {
      const replay = this.#receipt(scope, input.mutationId);
      if (replay) {
        if (
          replay.threadId !== threadId ||
          replay.requestFingerprint !== fingerprint
        ) {
          throw new DomainError(
            "conflict",
            "The mutation ID was reused for a different force reset.",
          );
        }
        return this.#hydrateReceipt(scope, input.mutationId, replay, true);
      }

      const capture = this.#capture(
        scope,
        threadId,
        input.pendingInteractions ?? [],
        input.conversationRuntimes ?? [],
      );
      if (capture.blockerFingerprint !== input.expectedBlockerFingerprint) {
        throw new DomainError(
          "conflict",
          "The thread's resettable state changed. Review the current force-reset impact before trying again.",
        );
      }
      if (capture.blockers.length === 0) {
        throw new DomainError(
          "invalid_transition",
          "The thread has no unresolved Sedes state to force reset.",
        );
      }

      this.database
        .prepare(
          `INSERT INTO thread_force_reset_receipts(
             tenant_id, principal_id, thread_id, mutation_id,
             request_fingerprint, blocker_fingerprint, blocker_summary_json,
             reset_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          scope.tenantId,
          scope.principalId,
          threadId,
          input.mutationId,
          fingerprint,
          capture.blockerFingerprint,
          JSON.stringify(capture.summaries),
          input.now,
        );

      const insertAffectedThread = this.database.prepare(
        `INSERT INTO thread_force_reset_affected_threads(
           tenant_id, principal_id, reset_mutation_id, thread_id
         ) VALUES (?, ?, ?, ?)`,
      );
      for (const affectedThreadId of capture.affectedThreadIds) {
        insertAffectedThread.run(
          scope.tenantId,
          scope.principalId,
          input.mutationId,
          affectedThreadId,
        );
      }

      for (const fork of capture.preparedForks) {
        this.database
          .prepare(
            `INSERT INTO thread_force_reset_abandoned_forks(
               tenant_id, principal_id, child_thread_id,
               reset_mutation_id, abandoned_at
             ) VALUES (?, ?, ?, ?, ?)`,
          )
          .run(
            scope.tenantId,
            scope.principalId,
            fork.childThreadId,
            input.mutationId,
            input.now,
          );
      }

      const threadIds = capture.affectedThreadIds;
      const placeholders = threadIds.map(() => "?").join(", ");
      const scoped = [scope.tenantId, scope.principalId, ...threadIds] as const;

      this.database
        .prepare(
          `UPDATE thread_completion_callbacks
           SET state = 'cancelled', cancelled_at = ?,
             cancellation_reason =
               'The user force-reset an endpoint of this registered callback.',
             cancellation_mutation_id = ?
           WHERE tenant_id = ? AND owner_principal_id = ?
             AND state = 'registered'
             AND (
               caller_thread_id IN (${placeholders})
               OR target_thread_id IN (${placeholders})
             )`,
        )
        .run(
          input.now,
          input.mutationId,
          scope.tenantId,
          scope.principalId,
          ...threadIds,
          ...threadIds,
        );

      this.database
        .prepare(
          `UPDATE queued_inputs
           SET state = 'failed', dispatch_started_at = dispatch_started_at,
             accepted_at = NULL, resolved_at = ?, reconciliation_token = NULL,
             retry_anchor = NULL, backend_correlation = NULL,
             next_attempt_at = NULL, delivery_mode = NULL,
             diagnostic = 'The user force-reset this unresolved Sedes input.',
             failure_acknowledged_at = ?
           WHERE tenant_id = ? AND owner_principal_id = ?
             AND application_thread_id IN (${placeholders})
             AND state IN ('pending', 'retry_wait', 'dispatching', 'uncertain')`,
        )
        .run(input.now, input.now, ...scoped);

      this.database
        .prepare(
          `UPDATE queued_inputs
           SET failure_acknowledged_at = ?
           WHERE tenant_id = ? AND owner_principal_id = ?
             AND application_thread_id IN (${placeholders})
             AND state = 'failed' AND failure_acknowledged_at IS NULL`,
        )
        .run(input.now, ...scoped);

      this.database
        .prepare(
          `UPDATE mutation_receipts
           SET result_code = 'abandoned', replayable = 0,
             result_json = json_object(
               'version', 1,
               'diagnostic', 'The user force-reset this unresolved Sedes operation.',
               'forceResetMutationId', ?
             )
           WHERE tenant_id = ? AND principal_id = ?
             AND thread_id IN (${placeholders})
             AND result_code IN ('prepared', 'uncertain', 'pending_materialization')`,
        )
        .run(input.mutationId, ...scoped);

      this.database
        .prepare(
          `UPDATE provider_feature_mutation_receipts
           SET force_reset_at = ?, force_reset_mutation_id = ?,
             updated_at = max(updated_at, ?)
           WHERE tenant_id = ? AND owner_principal_id = ?
             AND application_thread_id IN (${placeholders})
             AND force_reset_at IS NULL
             AND state IN ('prepared', 'uncertain')`,
        )
        .run(input.now, input.mutationId, input.now, ...scoped);

      this.database
        .prepare(
          `UPDATE conversation_creation_attempts
           SET force_reset_at = ?, force_reset_mutation_id = ?,
             diagnostic = 'The user force-reset this unresolved Sedes creation.'
           WHERE tenant_id = ? AND owner_principal_id = ?
             AND application_thread_id IN (${placeholders})
             AND force_reset_at IS NULL
             AND phase NOT IN ('bound', 'aborted_unpersisted')`,
        )
        .run(input.now, input.mutationId, ...scoped);

      this.database
        .prepare(
          `UPDATE automation_runs
           SET state = 'failed', claim_token = NULL, lease_expires_at = NULL,
             prompt_snapshot = NULL, finished_at = ?,
             error_code = 'force_reset',
             error_diagnostic = 'The user force-reset this unresolved Sedes automation run.',
             updated_at = max(updated_at, ?), force_reset_at = ?,
             force_reset_mutation_id = ?
           WHERE tenant_id = ? AND owner_principal_id = ?
             AND anchor_thread_id IN (${placeholders})
             AND force_reset_at IS NULL
             AND state IN ('claimed', 'dispatching', 'queued', 'running', 'uncertain')`,
        )
        .run(input.now, input.now, input.now, input.mutationId, ...scoped);

      this.database
        .prepare(
          `UPDATE application_threads
           SET backing_state = CASE
               WHEN backing_state = 'creating' THEN 'creation_unknown'
               ELSE backing_state
             END,
             force_reset_at = CASE
               WHEN backing_state IN ('creating', 'creation_unknown')
                 AND force_reset_at IS NULL THEN ?
               ELSE force_reset_at
             END,
             force_reset_mutation_id = CASE
               WHEN backing_state IN ('creating', 'creation_unknown')
                 AND force_reset_at IS NULL THEN ?
               ELSE force_reset_mutation_id
             END,
             revision = revision + 1, updated_at = max(updated_at, ?)
           WHERE tenant_id = ? AND owner_principal_id = ?
             AND id IN (${placeholders})`,
        )
        .run(input.now, input.mutationId, input.now, ...scoped);

      const promotedTaskIds: string[] = [];
      const forkByChild = new Map(
        capture.preparedForks.map((fork) => [fork.childThreadId, fork]),
      );
      const taskDestination = (fork: PreparedFork): string => {
        let destination = fork.sourceThreadId;
        const visited = new Set([fork.childThreadId]);
        while (forkByChild.has(destination)) {
          if (visited.has(destination)) {
            throw new DomainError(
              "conflict",
              "The incomplete fork graph contains a cycle.",
            );
          }
          visited.add(destination);
          destination = forkByChild.get(destination)!.sourceThreadId;
        }
        return destination;
      };
      for (const fork of capture.preparedForks) {
        const promoted = this.database
          .prepare(
            `UPDATE tasks
             SET thread_id = ?, revision = revision + 1,
               updated_at = max(updated_at, ?)
             WHERE tenant_id = ? AND owner_principal_id = ?
               AND scope_kind = 'thread' AND thread_id = ?
             RETURNING id`,
          )
          .all(
            taskDestination(fork),
            input.now,
            scope.tenantId,
            scope.principalId,
            fork.childThreadId,
          ) as readonly { readonly id: string }[];
        promotedTaskIds.push(...promoted.map(({ id }) => id));
        this.database
          .prepare(
            `UPDATE thread_principal_state
             SET inventory_state = 'archived', state_changed_at = ?,
               snoozed_at = NULL, snoozed_until = NULL, woke_at = NULL,
               wake_reason = NULL, wake_acknowledged_at = NULL,
               wake_reminder_text = NULL,
               inventory_revision = inventory_revision + 1
             WHERE tenant_id = ? AND principal_id = ? AND thread_id = ?
               AND inventory_state <> 'archived'`,
          )
          .run(
            input.now,
            scope.tenantId,
            scope.principalId,
            fork.childThreadId,
          );
      }

      const insertPromotedTask = this.database.prepare(
        `INSERT INTO thread_force_reset_promoted_tasks(
           tenant_id, principal_id, reset_mutation_id, task_id
         ) VALUES (?, ?, ?, ?)`,
      );
      for (const taskId of [...new Set(promotedTaskIds)].sort()) {
        insertPromotedTask.run(
          scope.tenantId,
          scope.principalId,
          input.mutationId,
          taskId,
        );
      }

      this.database
        .prepare(
          `UPDATE principal_generations
           SET inventory_generation = inventory_generation + 1
           WHERE tenant_id = ? AND principal_id = ?`,
        )
        .run(scope.tenantId, scope.principalId);

      return {
        ...this.#hydrateReceipt(
          scope,
          input.mutationId,
          this.#receipt(scope, input.mutationId)!,
          false,
        ),
        resetConversationRuntimes: [...capture.conversationRuntimes],
      };
    })();
  }

  #capture(
    scope: RequestScope,
    threadId: string,
    pendingInteractions: readonly ThreadForceResetPendingInteractionBlocker[] = [],
    conversationRuntimes: readonly ThreadForceResetConversationRuntimeBlocker[] = [],
  ): Capture {
    const owned = this.database
      .prepare(
        `SELECT 1 FROM application_threads
         WHERE tenant_id = ? AND owner_principal_id = ? AND id = ?`,
      )
      .get(scope.tenantId, scope.principalId, threadId);
    if (!owned) throw new DomainError("not_found", "The thread was not found.");

    const affected = new Set([threadId]);
    const preparedForks = new Map<string, PreparedFork>();
    while (true) {
      const ids = [...affected].sort();
      const placeholders = ids.map(() => "?").join(", ");
      const rows = this.database
        .prepare(
          `SELECT origin.child_thread_id AS childThreadId,
             origin.source_thread_id AS sourceThreadId,
             origin.branch_method AS branchMethod
           FROM thread_fork_origins AS origin
           LEFT JOIN thread_force_reset_abandoned_forks AS abandoned
             ON abandoned.tenant_id = origin.tenant_id
             AND abandoned.principal_id = origin.owner_principal_id
             AND abandoned.child_thread_id = origin.child_thread_id
           WHERE origin.tenant_id = ? AND origin.owner_principal_id = ?
             AND origin.origin_state = 'prepared'
             AND abandoned.child_thread_id IS NULL
             AND (
               origin.child_thread_id IN (${placeholders})
               OR origin.source_thread_id IN (${placeholders})
             )
           ORDER BY origin.child_thread_id`,
        )
        .all(
          scope.tenantId,
          scope.principalId,
          ...ids,
          ...ids,
        ) as readonly (PreparedFork & {
        readonly sourceThreadId: string | null;
      })[];
      let changed = false;
      for (const row of rows) {
        if (row.sourceThreadId === null) {
          throw new DomainError(
            "conflict",
            "An incomplete fork has no resolved source thread and cannot be safely force-reset.",
          );
        }
        preparedForks.set(row.childThreadId, {
          childThreadId: row.childThreadId,
          sourceThreadId: row.sourceThreadId,
          branchMethod: row.branchMethod,
        });
        // Resetting a thread abandons the incomplete forks it is the source
        // of, but never reaches up: a reset started from a fork child leaves
        // its source, and the source's runtime and sibling forks, untouched.
        if (!affected.has(row.childThreadId)) {
          affected.add(row.childThreadId);
          changed = true;
        }
      }
      if (affected.size > MAXIMUM_AFFECTED_THREADS) {
        throw new DomainError(
          "invalid_transition",
          "The force-reset impact exceeds the supported thread bound.",
        );
      }
      if (!changed) break;
    }

    const threadIds = [...affected].sort();
    const placeholders = threadIds.map(() => "?").join(", ");
    const args = [scope.tenantId, scope.principalId, ...threadIds] as const;
    const blockers: Blocker[] = [];
    const collect = (
      sql: string,
      kind: ThreadForceResetBlockerKind,
      mayHaveEffect: (state: string) => boolean,
    ): void => {
      const rows = this.database.prepare(sql).all(...args) as readonly {
        readonly id: string;
        readonly threadId: string;
        readonly state: string;
      }[];
      blockers.push(
        ...rows.map((row) => ({
          kind,
          ...row,
          mayHaveProviderSideEffect: mayHaveEffect(row.state),
        })),
      );
    };

    const callbackRows = this.database
      .prepare(
        `SELECT id,
           CASE
             WHEN caller_thread_id IN (${placeholders}) THEN caller_thread_id
             ELSE target_thread_id
           END AS threadId,
           state
         FROM thread_completion_callbacks
         WHERE tenant_id = ? AND owner_principal_id = ?
           AND state = 'registered'
           AND (
             caller_thread_id IN (${placeholders})
             OR target_thread_id IN (${placeholders})
           )`,
      )
      .all(
        ...threadIds,
        scope.tenantId,
        scope.principalId,
        ...threadIds,
        ...threadIds,
      ) as readonly {
      readonly id: string;
      readonly threadId: string;
      readonly state: string;
    }[];
    blockers.push(
      ...callbackRows.map((row) => ({
        kind: "completion_callback" as const,
        ...row,
        mayHaveProviderSideEffect: false,
      })),
    );

    collect(
      `SELECT id, application_thread_id AS threadId, state
       FROM queued_inputs
       WHERE tenant_id = ? AND owner_principal_id = ?
         AND application_thread_id IN (${placeholders})
         AND (
           state IN ('pending', 'retry_wait', 'dispatching', 'uncertain')
           OR (state = 'failed' AND failure_acknowledged_at IS NULL)
         )`,
      "queued_input",
      (state) => state === "dispatching" || state === "uncertain",
    );
    collect(
      `SELECT mutation_id AS id, thread_id AS threadId, result_code AS state
       FROM mutation_receipts
       WHERE tenant_id = ? AND principal_id = ?
         AND thread_id IN (${placeholders})
         AND result_code IN ('prepared', 'uncertain', 'pending_materialization')`,
      "conversation_operation",
      () => true,
    );
    collect(
      `SELECT mutation_id AS id, application_thread_id AS threadId, state
       FROM provider_feature_mutation_receipts
       WHERE tenant_id = ? AND owner_principal_id = ?
         AND application_thread_id IN (${placeholders})
         AND force_reset_at IS NULL
         AND state IN ('prepared', 'uncertain')`,
      "provider_feature_operation",
      () => true,
    );
    collect(
      `SELECT attempt_id AS id, application_thread_id AS threadId, phase AS state
       FROM conversation_creation_attempts
       WHERE tenant_id = ? AND owner_principal_id = ?
         AND application_thread_id IN (${placeholders})
         AND force_reset_at IS NULL
         AND phase NOT IN ('bound', 'aborted_unpersisted')`,
      "creation_attempt",
      (state) => state !== "prepared",
    );
    collect(
      `SELECT id, id AS threadId, backing_state AS state
       FROM application_threads
       WHERE tenant_id = ? AND owner_principal_id = ?
         AND id IN (${placeholders})
         AND force_reset_at IS NULL
         AND backing_state IN ('creating', 'creation_unknown')`,
      "thread_creation_state",
      (state) => state === "creation_unknown",
    );
    for (const fork of preparedForks.values()) {
      blockers.push({
        kind: "fork_origin",
        id: fork.childThreadId,
        threadId: fork.sourceThreadId,
        state: "prepared",
        mayHaveProviderSideEffect: false,
      });
    }
    collect(
      `SELECT id, anchor_thread_id AS threadId, state
       FROM automation_runs
       WHERE tenant_id = ? AND owner_principal_id = ?
         AND anchor_thread_id IN (${placeholders})
         AND state IN ('claimed', 'dispatching', 'queued', 'running', 'uncertain')`,
      "automation_run",
      (state) =>
        state === "dispatching" || state === "running" || state === "uncertain",
    );

    if (pendingInteractions.length > MAXIMUM_AFFECTED_THREADS) {
      throw new DomainError(
        "invalid_transition",
        "The pending-interaction force-reset impact exceeds the supported bound.",
      );
    }
    const pendingInteractionKeys = new Set<string>();
    for (const pending of pendingInteractions) {
      const key = `${pending.threadId}\0${pending.id}`;
      if (
        pending.kind !== "pending_interaction" ||
        pending.id.length === 0 ||
        pending.id.length > 160 ||
        !affected.has(pending.threadId) ||
        pendingInteractionKeys.has(key)
      ) {
        throw new DomainError(
          "conflict",
          "The pending-interaction force-reset evidence is invalid or stale.",
        );
      }
      pendingInteractionKeys.add(key);
      blockers.push({
        kind: pending.kind,
        id: pending.id,
        threadId: pending.threadId,
        state: "pending",
        mayHaveProviderSideEffect: true,
      });
    }

    if (conversationRuntimes.length > MAXIMUM_AFFECTED_THREADS) {
      throw new DomainError(
        "invalid_transition",
        "The conversation-runtime force-reset impact exceeds the supported bound.",
      );
    }
    const runtimeThreads = new Set<string>();
    const normalizedConversationRuntimes = conversationRuntimes.map(
      (runtime) => {
        if (
          runtime.kind !== "conversation_runtime" ||
          !affected.has(runtime.threadId) ||
          runtimeThreads.has(runtime.threadId) ||
          runtime.generation.length === 0 ||
          runtime.generation.length > 240 ||
          !threadRunStateSchema.safeParse(runtime.runState).success ||
          (runtime.activeTurnId !== undefined &&
            (runtime.activeTurnId.length === 0 ||
              runtime.activeTurnId.length > 240))
        ) {
          throw new DomainError(
            "conflict",
            "The conversation-runtime force-reset evidence is invalid or stale.",
          );
        }
        runtimeThreads.add(runtime.threadId);
        if (
          runtime.backgroundActivity !== undefined &&
          !backgroundActivitySchema.safeParse(runtime.backgroundActivity).success
        ) {
          throw new DomainError(
            "conflict",
            "The conversation-runtime force-reset evidence is invalid or stale.",
          );
        }
        const normalized = {
          kind: "conversation_runtime" as const,
          threadId: runtime.threadId,
          generation: runtime.generation,
          runState: runtime.runState,
          ...(runtime.activeTurnId
            ? { activeTurnId: runtime.activeTurnId }
            : {}),
          ...(runtime.backgroundActivity
            ? { backgroundActivity: runtime.backgroundActivity }
            : {}),
        };
        const background = normalized.backgroundActivity;
        blockers.push({
          kind: normalized.kind,
          id: normalized.generation,
          threadId: normalized.threadId,
          state: JSON.stringify([
            normalized.runState,
            normalized.activeTurnId ?? null,
            ...(background
              ? [background.state, background.agents, background.commands, background.other]
              : []),
          ]),
          mayHaveProviderSideEffect:
            !["idle", "failed"].includes(normalized.runState) ||
            hasOutstandingBackgroundActivity(background),
        });
        return normalized;
      },
    );

    blockers.sort(
      (left, right) =>
        BLOCKER_KIND_ORDER.indexOf(left.kind) -
          BLOCKER_KIND_ORDER.indexOf(right.kind) ||
        left.threadId.localeCompare(right.threadId) ||
        left.id.localeCompare(right.id) ||
        left.state.localeCompare(right.state),
    );
    const summaries = BLOCKER_KIND_ORDER.flatMap((kind) => {
      const count = blockers.filter((blocker) => blocker.kind === kind).length;
      return count === 0 ? [] : [{ kind, count }];
    });
    const forkChildIds = [...preparedForks.keys()].sort();
    const taskRows =
      forkChildIds.length === 0
        ? []
        : (this.database
            .prepare(
              `SELECT id, thread_id AS threadId, revision
               FROM tasks
               WHERE tenant_id = ? AND owner_principal_id = ?
                 AND scope_kind = 'thread'
                 AND thread_id IN (${forkChildIds.map(() => "?").join(", ")})
               ORDER BY thread_id, id`,
            )
            .all(
              scope.tenantId,
              scope.principalId,
              ...forkChildIds,
            ) as readonly {
            readonly id: string;
            readonly threadId: string;
            readonly revision: number;
          }[]);
    const titles = new Map(
      (this.database
        .prepare(
          `SELECT id, title FROM application_threads
           WHERE tenant_id = ? AND owner_principal_id = ? AND id IN (${placeholders})`,
        )
        .all(...args) as readonly { readonly id: string; readonly title: string }[])
        .map(({ id, title }) => [id, title]),
    );
    const runtimeByThread = new Map(
      normalizedConversationRuntimes.map((runtime) => [runtime.threadId, runtime]),
    );
    const affectedThreads = threadIds.map((affectedThreadId) => {
      const runtime = runtimeByThread.get(affectedThreadId);
      return {
        threadId: affectedThreadId,
        title: (titles.get(affectedThreadId) ?? "").slice(0, 240) || "Untitled thread",
        ...(runtime
          ? {
              runtime: {
                runState: runtime.runState,
                ...(runtime.backgroundActivity
                  ? { backgroundActivity: runtime.backgroundActivity }
                  : {}),
              },
            }
          : {}),
      };
    });
    return {
      affectedThreadIds: threadIds,
      affectedThreads,
      blockers,
      preparedForks: [...preparedForks.values()].sort((left, right) =>
        left.childThreadId.localeCompare(right.childThreadId),
      ),
      blockerFingerprint: hash({
        blockers: blockers.map(
          ({ kind, id, threadId: blockerThreadId, state }) => [
            kind,
            blockerThreadId,
            id,
            state,
          ],
        ),
        promotedTasks: taskRows.map(
          ({ id, threadId: taskThreadId, revision }) => [
            taskThreadId,
            id,
            revision,
          ],
        ),
      }),
      summaries,
      conversationRuntimes: normalizedConversationRuntimes.sort((left, right) =>
        left.threadId.localeCompare(right.threadId),
      ),
    };
  }

  #receipt(scope: RequestScope, mutationId: string): ReceiptRow | undefined {
    return this.database
      .prepare(
        `SELECT thread_id AS threadId,
           request_fingerprint AS requestFingerprint,
           blocker_fingerprint AS blockerFingerprint,
           blocker_summary_json AS blockerSummaryJson,
           reset_at AS resetAt
         FROM thread_force_reset_receipts
         WHERE tenant_id = ? AND principal_id = ? AND mutation_id = ?`,
      )
      .get(scope.tenantId, scope.principalId, mutationId) as
      ReceiptRow | undefined;
  }

  #hydrateReceipt(
    scope: RequestScope,
    mutationId: string,
    receipt: ReceiptRow,
    replayed: boolean,
  ): ThreadForceResetCommit {
    const promotedTaskIds = this.database
      .prepare(
        `SELECT task_id AS taskId
         FROM thread_force_reset_promoted_tasks
         WHERE tenant_id = ? AND principal_id = ?
           AND reset_mutation_id = ?
         ORDER BY task_id`,
      )
      .all(scope.tenantId, scope.principalId, mutationId) as readonly {
      readonly taskId: string;
    }[];
    const affectedThreadIds = this.database
      .prepare(
        `SELECT thread_id AS threadId
         FROM thread_force_reset_affected_threads
         WHERE tenant_id = ? AND principal_id = ?
           AND reset_mutation_id = ?
         ORDER BY thread_id`,
      )
      .all(scope.tenantId, scope.principalId, mutationId) as readonly {
      readonly threadId: string;
    }[];
    return {
      resetAt: receipt.resetAt,
      blockerFingerprint: receipt.blockerFingerprint,
      resetBlockers: [...parseSummaries(receipt.blockerSummaryJson)],
      affectedThreadIds: affectedThreadIds.map(({ threadId }) => threadId),
      promotedTaskIds: promotedTaskIds.map(({ taskId }) => taskId),
      replayed,
      resetConversationRuntimes: [],
    };
  }
}
