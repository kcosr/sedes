import type Database from "better-sqlite3";
import type {
  NormalizedApplicationThreadSummary,
  NormalizedSidebarAttention,
} from "../../shared/protocol/application.js";
import type { RequestScope } from "../identity/identity-provider.js";
import { workspaceFileLinkedWorktreeRootIdSchema } from "../../shared/protocol/workspace-files.js";
import { boundDisplayText } from "../conversations/payload-policy.js";
import { BACKEND_BRANDS, type BackendKind } from "../backends/contracts.js";
import type { InventoryRepository } from "../db/repositories/inventory-repository.js";
import type { QueuedInputRepository } from "../db/repositories/queued-input-repository.js";
import type { SubmissionCompletionRepository } from "../db/repositories/submission-completion-repository.js";
import type {
  ApplicationThreadDurableSummary,
  ApplicationThreadSummaryReader,
} from "./application-snapshot-service.js";

type SummaryRow = {
  readonly id: string;
  readonly workspaceId: string;
  readonly targetId: string;
  readonly title: string;
  readonly backendSessionId: string | null;
  readonly backendKind: BackendKind;
  readonly backendLabel: string;
  readonly backingState: "unbound" | "creating" | "bound" | "creation_unknown";
  readonly inventoryState: "active" | "snoozed" | "settled" | "archived";
  readonly inventoryRevision: number;
  readonly pinned: 0 | 1;
  readonly pinRevision: number;
  readonly bookmarkRevision: number;
  readonly preferredWorktreeRootId: string | null;
  readonly preferredWorktreeRevision: number;
  readonly preferredWorktreeDisplayLabel: string | null;
  readonly preferredWorktreeBranchRef: string | null;
  readonly preferredWorktreeAvailability: "available" | "unavailable" | null;
  readonly turnBookmarkCount: number;
  readonly groupId: string | null;
  readonly groupAssignmentRevision: number;
  readonly threadRevision: number;
  readonly available: 0 | 1;
  readonly lastActivityAt: number;
  readonly stateChangedAt: number;
  readonly snoozedUntil: number | null;
  readonly automationStatus: "enabled" | "paused" | null;
  readonly automationRunMode: "same_thread" | "clone" | null;
  readonly automationScheduleKind: "date_time" | "interval" | "cron" | null;
  readonly automationNextRunAt: number | null;
  readonly automationRevision: number | null;
  readonly automationHasPrecheck: 0 | 1 | null;
  readonly automationRunId: string | null;
  readonly automationRunState:
    | "claimed"
    | "dispatching"
    | "queued"
    | "running"
    | "completed"
    | "failed"
    | "skipped"
    | "uncertain"
    | null;
  readonly automationOccurrence: "scheduled" | "manual" | null;
  readonly automationScheduledFor: number | null;
  readonly automationFinishedAt: number | null;
  readonly automationResultThreadId: string | null;
  readonly automationErrorCode: string | null;
  readonly queuedInputCount: number;
  readonly stashedPromptCount: number;
  readonly pendingQuestionCount: number;
  readonly wake: 0 | 1;
  readonly automationContext: "triggered" | "failed" | null;
  readonly unseenCompletion: 0 | 1;
  readonly queueFailure: 0 | 1;
};

/**
 * The application stream is a bootstrap, not an unbounded fork archive. Older
 * fork descendants remain available through the paged descendant endpoint.
 * Non-fork roots, durable top-level forks, lifecycle-effective roots, and the
 * authorized ancestor chain needed to explain selected children stay present.
 */
export const MAXIMUM_APPLICATION_BOOTSTRAP_FORKS = 1_000;

function iso(milliseconds: number): string {
  return new Date(milliseconds).toISOString();
}

function automation(
  row: SummaryRow,
): NormalizedApplicationThreadSummary["automation"] {
  if (
    row.automationStatus === null ||
    row.automationRunMode === null ||
    row.automationScheduleKind === null ||
    row.automationRevision === null ||
    row.automationHasPrecheck === null
  ) {
    return null;
  }
  return {
    status: row.automationStatus,
    runMode: row.automationRunMode,
    scheduleKind: row.automationScheduleKind,
    ...(row.automationNextRunAt === null
      ? {}
      : { nextRunAt: iso(row.automationNextRunAt) }),
    revision: row.automationRevision,
    hasPrecheck: row.automationHasPrecheck === 1,
    ...(row.automationRunId === null ||
    row.automationRunState === null ||
    row.automationOccurrence === null ||
    row.automationScheduledFor === null
      ? {}
      : {
          lastRun: {
            id: row.automationRunId,
            state: row.automationRunState,
            occurrence: row.automationOccurrence,
            scheduledFor: iso(row.automationScheduledFor),
            ...(row.automationFinishedAt === null
              ? {}
              : { finishedAt: iso(row.automationFinishedAt) }),
            ...(row.automationResultThreadId === null
              ? {}
              : { resultThreadId: row.automationResultThreadId }),
            ...(row.automationErrorCode === null
              ? {}
              : { errorCode: row.automationErrorCode }),
          },
        }),
  };
}

function attention(row: SummaryRow): NormalizedSidebarAttention {
  return {
    wake: row.wake === 1,
    automationContext: row.automationContext,
    unseenCompletion: row.unseenCompletion === 1,
    queueFailure: row.queueFailure === 1,
  };
}

/**
 * Reads the complete durable sidebar projection in one scoped SQLite query.
 * Draft and stash payloads deliberately remain outside this application-level
 * read path; they are only needed by an authorized thread snapshot.
 */
export class DatabaseApplicationThreadSummaryReader
  implements ApplicationThreadSummaryReader
{
  readonly #database: Database.Database;

  constructor(input: {
    readonly inventory: InventoryRepository;
    readonly queue: QueuedInputRepository;
    readonly completion: SubmissionCompletionRepository;
  }) {
    if (
      input.inventory.database !== input.queue.database ||
      input.inventory.database !== input.completion.database
    ) {
      throw new Error("application_summary_database_mismatch");
    }
    this.#database = input.inventory.database;
  }

  /** Matches the bounded selector's candidate set without materializing it. */
  forkSelectionSaturated(scope: RequestScope, environmentId: string): boolean {
    return (
      this.#database
        .prepare(
          `
      SELECT 1
      FROM application_threads AS candidate
      INNER JOIN thread_fork_origins AS origin
        ON origin.tenant_id = candidate.tenant_id
        AND origin.owner_principal_id = candidate.owner_principal_id
        AND origin.child_thread_id = candidate.id
        AND origin.origin_state = 'committed'
      INNER JOIN thread_lineage_placement AS placement
        ON placement.tenant_id = origin.tenant_id
        AND placement.owner_principal_id = origin.owner_principal_id
        AND placement.child_thread_id = origin.child_thread_id
      INNER JOIN thread_principal_state AS child_state
        ON child_state.tenant_id = candidate.tenant_id
        AND child_state.principal_id = candidate.owner_principal_id
        AND child_state.thread_id = candidate.id
      WHERE candidate.tenant_id = ?
        AND candidate.owner_principal_id = ?
        AND candidate.environment_id = ?
      LIMIT 1 OFFSET ?
    `,
        )
        .get(
          scope.tenantId,
          scope.principalId,
          environmentId,
          MAXIMUM_APPLICATION_BOOTSTRAP_FORKS,
        ) !== undefined
    );
  }

  /** Durable lineage facts include committed children outside the bootstrap. */
  structure(
    scope: RequestScope,
    threadId: string,
  ):
    | { environmentId: string; isFork: boolean; isForkSource: boolean }
    | undefined {
    const row = this.#database
      .prepare(
        `
      SELECT thread.environment_id AS environmentId,
        EXISTS (
          SELECT 1 FROM thread_fork_origins AS origin
          WHERE origin.tenant_id = thread.tenant_id
            AND origin.owner_principal_id = thread.owner_principal_id
            AND origin.child_thread_id = thread.id
            AND origin.origin_state = 'committed'
        ) AS isFork,
        EXISTS (
          SELECT 1 FROM thread_fork_origins AS origin
          WHERE origin.tenant_id = thread.tenant_id
            AND origin.owner_principal_id = thread.owner_principal_id
            AND origin.source_thread_id = thread.id
            AND origin.origin_state = 'committed'
        ) AS isForkSource
      FROM application_threads AS thread
      WHERE thread.tenant_id = ? AND thread.owner_principal_id = ?
        AND thread.id = ?
    `,
      )
      .get(scope.tenantId, scope.principalId, threadId) as
      | {
          environmentId: string;
          isFork: 0 | 1;
          isForkSource: 0 | 1;
        }
      | undefined;
    return (
      row && {
        environmentId: row.environmentId,
        isFork: row.isFork === 1,
        isForkSource: row.isForkSource === 1,
      }
    );
  }

  list(
    scope: RequestScope,
    environmentId: string,
  ): readonly ApplicationThreadDurableSummary[] {
    return this.#list(
      scope,
      `WITH RECURSIVE scoped_forks(
           id,
           source_thread_id,
           child_inventory_state,
           child_pinned,
           child_grouped,
           source_inventory_state,
           placement_mode,
           last_activity_at
         ) AS MATERIALIZED (
           SELECT
             candidate.id,
             origin.source_thread_id,
             child_state.inventory_state,
             child_state.pinned,
             CASE WHEN child_group.group_id IS NULL THEN 0 ELSE 1 END,
             source_state.inventory_state,
             placement.placement_mode,
             candidate.last_activity_at
           FROM application_threads AS candidate
           INNER JOIN thread_fork_origins AS origin
             ON origin.tenant_id = candidate.tenant_id
             AND origin.owner_principal_id = candidate.owner_principal_id
             AND origin.child_thread_id = candidate.id
             AND origin.origin_state = 'committed'
           INNER JOIN thread_lineage_placement AS placement
             ON placement.tenant_id = origin.tenant_id
             AND placement.owner_principal_id = origin.owner_principal_id
             AND placement.child_thread_id = origin.child_thread_id
           INNER JOIN thread_principal_state AS child_state
             ON child_state.tenant_id = candidate.tenant_id
             AND child_state.principal_id = candidate.owner_principal_id
             AND child_state.thread_id = candidate.id
           LEFT JOIN thread_principal_state AS source_state
             ON source_state.tenant_id = origin.tenant_id
             AND source_state.principal_id = origin.owner_principal_id
             AND source_state.thread_id = origin.source_thread_id
           LEFT JOIN thread_group_memberships AS child_group
             ON child_group.tenant_id = candidate.tenant_id
             AND child_group.principal_id = candidate.owner_principal_id
             AND child_group.thread_id = candidate.id
           WHERE candidate.tenant_id = ?
             AND candidate.owner_principal_id = ?
             AND candidate.environment_id = ?
         ),
         ranked_forks(id, rank) AS (
           SELECT id, row_number() OVER (
             ORDER BY last_activity_at DESC, id
           )
           FROM scoped_forks
         ),
         selected_forks(id) AS (
           SELECT id FROM ranked_forks WHERE rank <= ?
           UNION
           SELECT id
           FROM scoped_forks
           WHERE placement_mode = 'top_level'
             OR source_thread_id IS NULL
             OR source_inventory_state IS NULL
             OR child_inventory_state != source_inventory_state
             OR child_pinned = 1
             OR child_grouped = 1
         ),
         lineage_threads(id) AS (
           SELECT id FROM selected_forks
           UNION
           SELECT fork.source_thread_id
           FROM scoped_forks AS fork
           INNER JOIN lineage_threads AS selected
             ON selected.id = fork.id
           WHERE fork.source_thread_id IS NOT NULL
         ),
         root_threads(id) AS (
           SELECT candidate.id
           FROM application_threads AS candidate
           LEFT JOIN thread_fork_origins AS origin
             ON origin.tenant_id = candidate.tenant_id
             AND origin.owner_principal_id = candidate.owner_principal_id
             AND origin.child_thread_id = candidate.id
             AND origin.origin_state = 'committed'
           WHERE candidate.tenant_id = ?
             AND candidate.owner_principal_id = ?
             AND candidate.environment_id = ?
             AND origin.child_thread_id IS NULL
         ),
         bootstrap_threads(id) AS (
           SELECT id FROM root_threads
           UNION
           SELECT id FROM lineage_threads
         )
       SELECT id FROM bootstrap_threads`,
      [
        scope.tenantId,
        scope.principalId,
        environmentId,
        MAXIMUM_APPLICATION_BOOTSTRAP_FORKS,
        scope.tenantId,
        scope.principalId,
        environmentId,
      ],
    );
  }

  listByIds(
    scope: RequestScope,
    threadIds: readonly string[],
  ): readonly ApplicationThreadDurableSummary[] {
    if (threadIds.length === 0) return [];
    if (threadIds.length > 100) {
      throw new Error("application_summary_page_too_large");
    }
    const uniqueThreadIds = [...new Set(threadIds)];
    return this.#list(
      scope,
      `VALUES ${uniqueThreadIds.map(() => "(?)").join(",")}`,
      uniqueThreadIds,
    );
  }

  #list(
    scope: RequestScope,
    requestedThreadsSql: string,
    requestedThreadParameters: readonly (string | number)[],
  ): readonly ApplicationThreadDurableSummary[] {
    const rows = this.#database
      .prepare(
        `
          -- Reuse the selected lineage once. Keep targeted updates from scanning
          -- retained queue/completion history or the entire thread inventory.
          WITH requested_threads(id) AS MATERIALIZED (${requestedThreadsSql}),
          target_definitions AS MATERIALIZED (
            SELECT definition.*
            FROM requested_threads AS requested
            CROSS JOIN automation_definitions AS definition
              ON definition.anchor_thread_id = requested.id
            INNER JOIN application_threads AS anchor
              ON anchor.tenant_id = definition.tenant_id
              AND anchor.owner_principal_id =
                definition.owner_principal_id
              AND anchor.id = definition.anchor_thread_id
            WHERE definition.tenant_id = ?
              AND definition.owner_principal_id = ?
              AND definition.deleted_at IS NULL
          ),
          scoped_queue AS (
            SELECT
              application_thread_id AS thread_id,
              count(*) AS queued_input_count,
              max(CASE WHEN state = 'failed' THEN 1 ELSE 0 END)
                AS queue_failure
            FROM requested_threads AS requested
            CROSS JOIN queued_inputs AS queue
              ON queue.application_thread_id = requested.id
            WHERE queue.tenant_id = ? AND queue.owner_principal_id = ?
              AND (
                state IN ('pending', 'retry_wait', 'dispatching', 'uncertain')
                OR (
                  state = 'failed'
                  AND failure_acknowledged_at IS NULL
                )
              )
            GROUP BY application_thread_id
          ),
          scoped_completion AS (
            SELECT application_thread_id AS thread_id, 1 AS unseen_completion
            FROM requested_threads AS requested
            CROSS JOIN submission_completion_observations AS completion
              ON completion.application_thread_id = requested.id
            WHERE completion.tenant_id = ? AND completion.owner_principal_id = ?
              AND attention_created_at IS NOT NULL
              AND acknowledged_at IS NULL
            GROUP BY application_thread_id
          ),
          scoped_stashes AS (
            SELECT stash.thread_id, count(*) AS stashed_prompt_count
            FROM requested_threads AS requested
            CROSS JOIN prompt_stashes AS stash
              ON requested.id = stash.thread_id
            WHERE stash.tenant_id = ? AND stash.principal_id = ?
            GROUP BY stash.thread_id
          ),
          scoped_turn_bookmarks AS (
            SELECT bookmark.thread_id, count(*) AS turn_bookmark_count
            FROM requested_threads AS requested
            CROSS JOIN conversation_turn_bookmarks AS bookmark
              ON requested.id = bookmark.thread_id
            WHERE bookmark.tenant_id = ? AND bookmark.principal_id = ?
            GROUP BY bookmark.thread_id
          ),
          scoped_questions AS (
            SELECT question.thread_id,
              sum(json_array_length(question.payload_json, '$.questions')) AS pending_question_count
            FROM requested_threads AS requested
            CROSS JOIN question_requests AS question
              ON requested.id = question.thread_id
            WHERE question.tenant_id = ? AND question.principal_id = ?
              AND question.payload_json IS NOT NULL
            GROUP BY question.thread_id
          ),
          scoped_runs AS (
            SELECT
              candidate.automation_id,
              candidate.id,
              candidate.state,
              candidate.occurrence_kind,
              candidate.scheduled_for,
              candidate.finished_at,
              candidate.child_thread_id,
              candidate.anchor_thread_id,
              candidate.error_code,
              row_number() OVER (
                PARTITION BY candidate.automation_id
                ORDER BY candidate.scheduled_for DESC,
                  candidate.created_at DESC, candidate.id DESC
              ) AS rank
            FROM target_definitions AS definition
            CROSS JOIN automation_runs AS candidate
              ON definition.tenant_id = candidate.tenant_id
              AND definition.owner_principal_id =
                candidate.owner_principal_id
              AND definition.id = candidate.automation_id
            WHERE candidate.tenant_id = ?
              AND candidate.owner_principal_id = ?
          )
          SELECT
            thread.id,
            thread.workspace_id AS workspaceId,
            thread.connection_profile_id AS targetId,
            thread.title,
            binding.backend_conversation_id AS backendSessionId,
            backend.kind AS backendKind,
            backend.label AS backendLabel,
            thread.backing_state AS backingState,
            principal.inventory_state AS inventoryState,
            principal.inventory_revision AS inventoryRevision,
            principal.pinned,
            principal.pin_revision AS pinRevision,
            principal.bookmark_revision AS bookmarkRevision,
            principal.preferred_worktree_root_id AS preferredWorktreeRootId,
            principal.preferred_worktree_revision AS preferredWorktreeRevision,
            preferred_worktree.display_label AS preferredWorktreeDisplayLabel,
            preferred_worktree.branch_ref AS preferredWorktreeBranchRef,
            preferred_worktree.availability AS preferredWorktreeAvailability,
            coalesce(bookmark.turn_bookmark_count, 0) AS turnBookmarkCount,
            membership.group_id AS groupId,
            principal.group_assignment_revision AS groupAssignmentRevision,
            thread.revision AS threadRevision,
            CASE
              WHEN thread.availability = 'available'
                AND workspace.availability = 'available'
                AND (
                  environment.availability = 'available'
                  OR environment.diagnostic_code =
                    'ssh_environment_not_validated'
                )
              THEN 1 ELSE 0
            END AS available,
            thread.last_activity_at AS lastActivityAt,
            principal.state_changed_at AS stateChangedAt,
            principal.snoozed_until AS snoozedUntil,
            CASE
              WHEN definition.id IS NULL THEN NULL
              WHEN definition.enabled = 1 THEN 'enabled'
              ELSE 'paused'
            END AS automationStatus,
            definition.run_mode AS automationRunMode,
            definition.schedule_kind AS automationScheduleKind,
            definition.next_run_at AS automationNextRunAt,
            definition.revision AS automationRevision,
            CASE
              WHEN definition.id IS NULL THEN NULL
              WHEN definition.precheck_command IS NULL THEN 0
              ELSE 1
            END AS automationHasPrecheck,
            run.id AS automationRunId,
            run.state AS automationRunState,
            run.occurrence_kind AS automationOccurrence,
            run.scheduled_for AS automationScheduledFor,
            run.finished_at AS automationFinishedAt,
            coalesce(run.child_thread_id, run.anchor_thread_id)
              AS automationResultThreadId,
            run.error_code AS automationErrorCode,
            coalesce(queue.queued_input_count, 0) AS queuedInputCount,
            coalesce(stash.stashed_prompt_count, 0) AS stashedPromptCount,
            coalesce(question.pending_question_count, 0) AS pendingQuestionCount,
            CASE
              WHEN principal.woke_at IS NOT NULL
                AND (
                  principal.wake_acknowledged_at IS NULL
                  OR principal.wake_acknowledged_at < principal.woke_at
                )
              THEN 1 ELSE 0
            END AS wake,
            CASE
              WHEN principal.automation_context_run_id IS NOT NULL
                AND principal.automation_context_source_thread_id IS NOT NULL
                AND principal.automation_context_at IS NOT NULL
                AND principal.automation_context_outcome IS NOT NULL
              THEN principal.automation_context_outcome
              ELSE NULL
            END AS automationContext,
            coalesce(completion.unseen_completion, 0) AS unseenCompletion,
            coalesce(queue.queue_failure, 0) AS queueFailure
          FROM requested_threads AS requested
          CROSS JOIN application_threads AS thread
            ON requested.id = thread.id
          LEFT JOIN conversation_bindings AS binding
            ON binding.tenant_id = thread.tenant_id
            AND binding.owner_principal_id = thread.owner_principal_id
            AND binding.application_thread_id = thread.id
          INNER JOIN thread_principal_state AS principal
            ON principal.tenant_id = thread.tenant_id
            AND principal.principal_id = thread.owner_principal_id
            AND principal.thread_id = thread.id
          INNER JOIN workspaces AS workspace
            ON workspace.tenant_id = thread.tenant_id
            AND workspace.owner_principal_id = thread.owner_principal_id
            AND workspace.id = thread.workspace_id
            AND workspace.removed_at IS NULL
          LEFT JOIN workspace_file_linked_worktree_roots AS preferred_worktree
            ON preferred_worktree.tenant_id = thread.tenant_id
            AND preferred_worktree.owner_principal_id = thread.owner_principal_id
            AND preferred_worktree.workspace_id = thread.workspace_id
            AND preferred_worktree.root_id = principal.preferred_worktree_root_id
          LEFT JOIN thread_group_memberships AS membership
            ON membership.tenant_id = thread.tenant_id
            AND membership.principal_id = thread.owner_principal_id
            AND membership.thread_id = thread.id
          INNER JOIN execution_environments AS environment
            ON environment.tenant_id = thread.tenant_id
            AND environment.owner_principal_id = thread.owner_principal_id
            AND environment.id = thread.environment_id
          INNER JOIN agent_backend_instances AS backend
            ON backend.tenant_id = thread.tenant_id
            AND backend.id = thread.backend_instance_id
          LEFT JOIN target_definitions AS definition
            ON definition.tenant_id = thread.tenant_id
            AND definition.owner_principal_id = thread.owner_principal_id
            AND definition.anchor_thread_id = thread.id
          LEFT JOIN scoped_runs AS run
            ON run.automation_id = definition.id AND run.rank = 1
          LEFT JOIN scoped_queue AS queue ON queue.thread_id = thread.id
          LEFT JOIN scoped_completion AS completion
            ON completion.thread_id = thread.id
          LEFT JOIN scoped_stashes AS stash ON stash.thread_id = thread.id
          LEFT JOIN scoped_turn_bookmarks AS bookmark
            ON bookmark.thread_id = thread.id
          LEFT JOIN scoped_questions AS question ON question.thread_id = thread.id
          WHERE thread.tenant_id = ? AND thread.owner_principal_id = ?
          ORDER BY thread.last_activity_at DESC, thread.id
        `,
      )
      .all(
        ...requestedThreadParameters,
        scope.tenantId,
        scope.principalId,
        scope.tenantId,
        scope.principalId,
        scope.tenantId,
        scope.principalId,
        scope.tenantId,
        scope.principalId,
        scope.tenantId,
        scope.principalId,
        scope.tenantId,
        scope.principalId,
        scope.tenantId,
        scope.principalId,
        scope.tenantId,
        scope.principalId,
      ) as SummaryRow[];

    return rows.map((row) => ({
      id: row.id,
      workspaceId: row.workspaceId,
      targetId: row.targetId,
      title: boundDisplayText(row.title),
      ...(row.backendSessionId === null ? {} : { backendSessionId: row.backendSessionId }),
      backend: {
        label: boundDisplayText(row.backendLabel),
        brand: BACKEND_BRANDS[row.backendKind],
      },
      backingState: row.backingState,
      inventoryState: row.inventoryState,
      inventoryRevision: row.inventoryRevision,
      pinned: row.pinned === 1,
      pinRevision: row.pinRevision,
      bookmarkRevision: row.bookmarkRevision,
      preferredWorktreeRevision: row.preferredWorktreeRevision,
      preferredWorktree:
        row.preferredWorktreeRootId === null ||
        row.preferredWorktreeDisplayLabel === null ||
        row.preferredWorktreeAvailability === null
          ? null
          : {
              rootId: workspaceFileLinkedWorktreeRootIdSchema.parse(
                row.preferredWorktreeRootId,
              ),
              displayLabel: row.preferredWorktreeDisplayLabel,
              branch: row.preferredWorktreeBranchRef?.startsWith("refs/heads/")
                ? row.preferredWorktreeBranchRef.slice("refs/heads/".length)
                : null,
              availability: row.preferredWorktreeAvailability,
            },
      turnBookmarkCount: row.turnBookmarkCount,
      groupId: row.groupId,
      groupAssignmentRevision: row.groupAssignmentRevision,
      threadRevision: row.threadRevision,
      available: row.available === 1,
      lastActivityAt: iso(row.lastActivityAt),
      stateChangedAt: iso(row.stateChangedAt),
      ...(row.snoozedUntil === null
        ? {}
        : { snoozedUntil: iso(row.snoozedUntil) }),
      automation: automation(row),
      queuedInputCount: row.queuedInputCount,
      stashedPromptCount: row.stashedPromptCount,
      pendingQuestionCount: row.pendingQuestionCount,
      attention: attention(row),
    }));
  }
}
