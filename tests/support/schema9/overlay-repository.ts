import { createHash, randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import type {
  BackingState,
  InventoryState,
  WakeReason,
} from "./legacy-domain.js";
import type { RequestScope } from "../../../src/server/identity/identity-provider.js";
import { DomainError } from "../../../src/server/domain/errors.js";
import type {
  ApplicationThreadRecord,
  DraftRecord,
  EnvironmentRecord,
  PendingFirstSendRecord,
  StashRecord,
  ThreadStartPreferencesRecord,
  ThreadInventoryChange,
  ThreadPrincipalStateRecord,
  ThreadWithState,
  WorkspaceRecord,
} from "./models.js";
import {
  hashSearch,
  normalizeSearch,
  type ThreadCursorCodec,
} from "./cursor-codec.js";

const threadColumns = `
  t.tenant_id AS tenantId,
  t.id,
  t.owner_principal_id AS ownerPrincipalId,
  t.environment_id AS environmentId,
  t.workspace_id AS workspaceId,
  t.backing_state AS backingState,
  t.reserved_native_session_id AS reservedNativeSessionId,
  t.native_session_path AS nativeSessionPath,
  t.title,
  t.tool_mode AS toolMode,
  t.availability,
  t.reconciliation_at AS reconciliationAt,
  t.last_activity_at AS lastActivityAt,
  t.materialization_attempt_id AS materializationAttemptId,
  t.attempt_phase AS attemptPhase,
  t.attempt_diagnostic_code AS attemptDiagnosticCode,
  t.uncertain_at AS uncertainAt,
  t.revision,
  t.created_at AS createdAt,
  t.updated_at AS updatedAt
`;

const inventoryColumns = `
  s.tenant_id AS tenantId,
  s.principal_id AS principalId,
  s.thread_id AS threadId,
  s.inventory_state AS inventoryState,
  s.state_changed_at AS stateChangedAt,
  s.snoozed_at AS snoozedAt,
  s.snoozed_until AS snoozedUntil,
  s.woke_at AS wokeAt,
  s.wake_reason AS wakeReason,
  s.wake_acknowledged_at AS wakeAcknowledgedAt,
  s.wake_reminder_text AS wakeReminderText,
  s.latest_agent_completion_id AS latestAgentCompletionId,
  s.latest_agent_completion_at AS latestAgentCompletionAt,
  s.seen_agent_completion_id AS seenAgentCompletionId,
  s.automation_context_run_id AS automationContextRunId,
  s.automation_context_source_thread_id AS automationContextSourceThreadId,
  s.automation_context_at AS automationContextAt,
  s.automation_context_outcome AS automationContextOutcome,
  s.automation_context_diagnostic AS automationContextDiagnostic,
  s.inventory_revision AS inventoryRevision
`;

const draftColumns = `
  d.tenant_id AS tenantId,
  d.principal_id AS principalId,
  d.thread_id AS threadId,
  d.text,
  d.updated_at AS updatedAt,
  d.revision
`;

type ReceiptRow = {
  mutationKind: string;
  requestFingerprint: string;
  resultCode: string;
  resultJson: string;
};

export type FirstSendPreparation = ThreadWithState & {
  mutationReceipt: {
    readonly replayed: boolean;
    readonly resultCode: string;
  };
};

export type NativeMutationReceipt = {
  readonly replayed: boolean;
  readonly resultCode: "submitting" | "accepted";
};

export type NativeOperationKind =
  | "native_send"
  | "automation_send"
  | "native_compact"
  | "native_abort"
  | "config"
  | "native_rename"
  | "materialization_retry";

type ListThreadRow = ApplicationThreadRecord &
  ThreadPrincipalStateRecord & {
    primarySort: number;
  };

export type CreateWorkspaceInput = {
  id?: string;
  environmentId: string;
  canonicalPath: string;
  displayName: string;
  availability: "available" | "unavailable";
  trustState: "trusted" | "untrusted";
  now: number;
};

export type CreateThreadInput = {
  id?: string;
  workspaceId: string;
  title: string;
  now: number;
};

export type InventoryMutationInput = {
  expectedRevision: number;
  mutationId: string;
  change: ThreadInventoryChange;
  now: number;
};

export type ThreadListInput = {
  inventoryState: InventoryState;
  backingState?: BackingState;
  search: string;
  pageSize: number;
  cursor?: string;
  cursorCodec: ThreadCursorCodec;
};

export type ThreadListResult = {
  items: Array<{
    thread: ApplicationThreadRecord;
    inventory: ThreadPrincipalStateRecord;
  }>;
  nextCursor: string | null;
};

export type ReconcileNativeSessionInput = {
  environmentId: string;
  workspaceId: string;
  nativeSessionId: string;
  canonicalSessionPath: string;
  title?: string;
  updatedAt: number;
  now: number;
};

export class OverlayRepository {
  constructor(readonly database: Database.Database) {}

  getLocalEnvironment(scope: RequestScope): EnvironmentRecord {
    const row = this.database
      .prepare(
        `
          SELECT
            tenant_id AS tenantId,
            owner_principal_id AS ownerPrincipalId,
            id,
            kind,
            label,
            availability,
            diagnostic_code AS diagnosticCode,
            revision
          FROM execution_environments
          WHERE tenant_id = ? AND owner_principal_id = ? AND kind = 'local'
        `,
      )
      .get(scope.tenantId, scope.principalId) as EnvironmentRecord | undefined;
    if (!row) {
      throw new DomainError("not_found", "The Local environment is unavailable.");
    }
    return row;
  }

  updateEnvironmentAvailability(
    scope: RequestScope,
    environmentId: string,
    input: {
      availability: EnvironmentRecord["availability"];
      diagnosticCode: string | null;
      now: number;
    },
  ): EnvironmentRecord {
    const result = this.database
      .prepare(
        `
          UPDATE execution_environments
          SET
            availability = ?,
            diagnostic_code = ?,
            revision = revision + 1,
            updated_at = ?
          WHERE
            tenant_id = ?
            AND owner_principal_id = ?
            AND id = ?
        `,
      )
      .run(
        input.availability,
        input.diagnosticCode,
        input.now,
        scope.tenantId,
        scope.principalId,
        environmentId,
      );
    if (result.changes !== 1) {
      throw new DomainError("not_found", "The execution environment was not found.");
    }
    return this.getLocalEnvironment(scope);
  }

  listThreadIdsForEnvironment(
    scope: RequestScope,
    environmentId: string,
  ): string[] {
    return (
      this.database
        .prepare(
          `
            SELECT id
            FROM application_threads
            WHERE
              tenant_id = ?
              AND owner_principal_id = ?
              AND environment_id = ?
            ORDER BY id
          `,
        )
        .all(
          scope.tenantId,
          scope.principalId,
          environmentId,
        ) as Array<{ id: string }>
    ).map(({ id }) => id);
  }

  upsertWorkspace(
    scope: RequestScope,
    input: CreateWorkspaceInput,
  ): WorkspaceRecord {
    const environment = this.database
      .prepare(
        `
          SELECT 1
          FROM execution_environments
          WHERE tenant_id = ? AND owner_principal_id = ? AND id = ?
        `,
      )
      .get(scope.tenantId, scope.principalId, input.environmentId);
    if (!environment) {
      throw new DomainError("not_found", "The execution environment was not found.");
    }

    const existing = this.database
      .prepare(
        `
          SELECT id
          FROM workspaces
          WHERE tenant_id = ? AND owner_principal_id = ?
            AND environment_id = ? AND canonical_path = ?
        `,
      )
      .get(
        scope.tenantId,
        scope.principalId,
        input.environmentId,
        input.canonicalPath,
      ) as { id: string } | undefined;
    const id = existing?.id ?? input.id ?? randomUUID();
    this.database
      .prepare(
        `
          INSERT INTO workspaces(
            tenant_id, owner_principal_id, environment_id, id, canonical_path,
            display_name, availability, trust_state, revision, last_opened_at,
            created_at, updated_at
          )
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?)
          ON CONFLICT(tenant_id, environment_id, canonical_path) DO UPDATE SET
            display_name = excluded.display_name,
            availability = excluded.availability,
            trust_state = excluded.trust_state,
            last_opened_at = excluded.last_opened_at,
            updated_at = excluded.updated_at,
            revision = workspaces.revision + CASE
              WHEN workspaces.display_name <> excluded.display_name
                OR workspaces.availability <> excluded.availability
                OR workspaces.trust_state <> excluded.trust_state
              THEN 1 ELSE 0 END
        `,
      )
      .run(
        scope.tenantId,
        scope.principalId,
        input.environmentId,
        id,
        input.canonicalPath,
        input.displayName,
        input.availability,
        input.trustState,
        input.now,
        input.now,
        input.now,
      );
    return this.getWorkspace(scope, id);
  }

  getWorkspace(scope: RequestScope, workspaceId: string): WorkspaceRecord {
    const row = this.database
      .prepare(
        `
          SELECT
            tenant_id AS tenantId,
            owner_principal_id AS ownerPrincipalId,
            environment_id AS environmentId,
            id,
            canonical_path AS canonicalPath,
            display_name AS displayName,
            availability,
            trust_state AS trustState,
            revision,
            last_opened_at AS lastOpenedAt,
            created_at AS createdAt,
            updated_at AS updatedAt
          FROM workspaces
          WHERE tenant_id = ? AND owner_principal_id = ? AND id = ?
        `,
      )
      .get(scope.tenantId, scope.principalId, workspaceId) as
      | WorkspaceRecord
      | undefined;
    if (!row) {
      throw new DomainError("not_found", "The workspace was not found.");
    }
    return row;
  }

  listWorkspaces(scope: RequestScope): WorkspaceRecord[] {
    return this.database
      .prepare(
        `
          SELECT
            tenant_id AS tenantId,
            owner_principal_id AS ownerPrincipalId,
            environment_id AS environmentId,
            id,
            canonical_path AS canonicalPath,
            display_name AS displayName,
            availability,
            trust_state AS trustState,
            revision,
            last_opened_at AS lastOpenedAt,
            created_at AS createdAt,
            updated_at AS updatedAt
          FROM workspaces
          WHERE tenant_id = ? AND owner_principal_id = ?
          ORDER BY last_opened_at DESC, id
        `,
      )
      .all(scope.tenantId, scope.principalId) as WorkspaceRecord[];
  }

  createThread(scope: RequestScope, input: CreateThreadInput): ThreadWithState {
    const workspace = this.getWorkspace(scope, input.workspaceId);
    const threadId = input.id ?? randomUUID();
    this.database.transaction(() => {
      const result = this.database
        .prepare(
          `
            INSERT INTO application_threads(
              tenant_id, id, owner_principal_id, environment_id, workspace_id,
              backing_state, reserved_native_session_id, native_session_path,
              title, tool_mode, availability, reconciliation_at,
              last_activity_at, materialization_attempt_id, attempt_phase,
              attempt_diagnostic_code, uncertain_at, revision, created_at, updated_at
            )
            VALUES (
              ?, ?, ?, ?, ?, 'draft', NULL, NULL, ?, 'read_only', 'available',
              NULL, ?, NULL, NULL, NULL, NULL, 0, ?, ?
            )
          `,
        )
        .run(
          scope.tenantId,
          threadId,
          scope.principalId,
          workspace.environmentId,
          workspace.id,
          input.title,
          input.now,
          input.now,
          input.now,
        );
      this.database
        .prepare(
          `
            INSERT INTO thread_principal_state(
              tenant_id, principal_id, thread_id, inventory_state,
              state_changed_at, snoozed_at, snoozed_until, woke_at,
              wake_reason, wake_acknowledged_at, inventory_revision
            )
            VALUES (?, ?, ?, 'active', ?, NULL, NULL, NULL, NULL, NULL, 0)
          `,
        )
        .run(scope.tenantId, scope.principalId, threadId, input.now);
      this.database
        .prepare(
          `
            INSERT INTO thread_drafts(
              tenant_id, principal_id, thread_id, text, updated_at, revision
            )
            VALUES (?, ?, ?, '', ?, 0)
          `,
        )
        .run(scope.tenantId, scope.principalId, threadId, input.now);
      this.database
        .prepare(
          `
            INSERT INTO thread_start_preferences(
              tenant_id, thread_id, model_provider, model_id, thinking_level, revision
            )
            VALUES (?, ?, NULL, NULL, NULL, 0)
          `,
        )
        .run(scope.tenantId, threadId);
      this.#bumpGeneration(scope);
    })();
    return this.getThread(scope, threadId);
  }

  getThread(scope: RequestScope, threadId: string): ThreadWithState {
    const thread = this.database
      .prepare(
        `
          SELECT ${threadColumns}
          FROM application_threads t
          WHERE t.tenant_id = ? AND t.owner_principal_id = ? AND t.id = ?
        `,
      )
      .get(scope.tenantId, scope.principalId, threadId) as
      | ApplicationThreadRecord
      | undefined;
    if (!thread) {
      throw new DomainError("not_found", "The thread was not found.");
    }
    const inventory = this.#getInventory(scope, threadId);
    const draft = this.getDraft(scope, threadId);
    return { thread, inventory, draft };
  }

  getDraft(scope: RequestScope, threadId: string): DraftRecord {
    const row = this.database
      .prepare(
        `
          SELECT ${draftColumns}
          FROM thread_drafts d
          WHERE d.tenant_id = ? AND d.principal_id = ? AND d.thread_id = ?
        `,
      )
      .get(scope.tenantId, scope.principalId, threadId) as DraftRecord | undefined;
    if (!row) {
      throw new DomainError("not_found", "The draft was not found.");
    }
    return row;
  }

  saveDraft(
    scope: RequestScope,
    threadId: string,
    text: string,
    expectedRevision: number,
    now: number,
  ): DraftRecord {
    const result = this.database
      .prepare(
        `
          UPDATE thread_drafts
          SET text = ?, updated_at = ?, revision = revision + 1
          WHERE tenant_id = ? AND principal_id = ? AND thread_id = ?
            AND revision = ?
        `,
      )
      .run(
        text,
        now,
        scope.tenantId,
        scope.principalId,
        threadId,
        expectedRevision,
      );
    if (result.changes !== 1) {
      this.#throwDraftConflictOrNotFound(scope, threadId);
    }
    return this.getDraft(scope, threadId);
  }

  listStashes(scope: RequestScope, threadId: string): StashRecord[] {
    this.#getInventory(scope, threadId);
    return this.database
      .prepare(
        `
          SELECT
            tenant_id AS tenantId,
            principal_id AS principalId,
            thread_id AS threadId,
            id,
            text,
            created_at AS createdAt
          FROM prompt_stashes
          WHERE tenant_id = ? AND principal_id = ? AND thread_id = ?
          ORDER BY created_at DESC, id
        `,
      )
      .all(scope.tenantId, scope.principalId, threadId) as StashRecord[];
  }

  stashDraft(
    scope: RequestScope,
    threadId: string,
    input: {
      expectedDraftRevision: number;
      mutationId: string;
      stashId: string;
      maximumStashes: number;
      now: number;
    },
  ): { stash: StashRecord; draft: DraftRecord; replayed: boolean } {
    const fingerprint = this.#fingerprint([
      "stash_draft",
      threadId,
      input.expectedDraftRevision,
    ]);
    return this.database.transaction(() => {
      const receipt = this.#getReceipt(scope, input.mutationId);
      if (receipt) {
        this.#assertReceipt(receipt, "stash_draft", fingerprint);
        const result = JSON.parse(receipt.resultJson) as {
          stashId: string;
        };
        const stash = this.#getStash(scope, threadId, result.stashId);
        return {
          stash,
          draft: this.getDraft(scope, threadId),
          replayed: true,
        };
      }
      const draft = this.getDraft(scope, threadId);
      if (draft.revision !== input.expectedDraftRevision) {
        throw new DomainError(
          "draft_revision_conflict",
          "The draft changed in another client.",
        );
      }
      if (draft.text.length === 0) {
        throw new DomainError("invalid_transition", "An empty draft cannot be stashed.");
      }
      const count = this.database
        .prepare(
          `
            SELECT count(*) AS count
            FROM prompt_stashes
            WHERE tenant_id = ? AND principal_id = ? AND thread_id = ?
          `,
        )
        .get(scope.tenantId, scope.principalId, threadId) as { count: number };
      if (count.count >= input.maximumStashes) {
        throw new DomainError(
          "stash_limit_reached",
          "This thread has reached its stashed-prompt limit.",
        );
      }
      this.database
        .prepare(
          `
            INSERT INTO prompt_stashes(
              tenant_id, principal_id, thread_id, id, text, created_at
            )
            VALUES (?, ?, ?, ?, ?, ?)
          `,
        )
        .run(
          scope.tenantId,
          scope.principalId,
          threadId,
          input.stashId,
          draft.text,
          input.now,
        );
      this.database
        .prepare(
          `
            UPDATE thread_drafts
            SET text = '', updated_at = ?, revision = revision + 1
            WHERE tenant_id = ? AND principal_id = ? AND thread_id = ?
              AND revision = ?
          `,
        )
        .run(
          input.now,
          scope.tenantId,
          scope.principalId,
          threadId,
          input.expectedDraftRevision,
        );
      this.#insertReceipt(
        scope,
        threadId,
        input.mutationId,
        "stash_draft",
        fingerprint,
        "created",
        { stashId: input.stashId, draftRevision: draft.revision + 1 },
        input.now,
      );
      return {
        stash: this.#getStash(scope, threadId, input.stashId),
        draft: this.getDraft(scope, threadId),
        replayed: false,
      };
    })();
  }

  restoreStash(
    scope: RequestScope,
    threadId: string,
    stashId: string,
    input: {
      expectedDraftRevision: number;
      mutationId: string;
      now: number;
    },
  ): { draft: DraftRecord; replayed: boolean } {
    const fingerprint = this.#fingerprint([
      "restore_stash",
      threadId,
      stashId,
      input.expectedDraftRevision,
    ]);
    return this.database.transaction(() => {
      const receipt = this.#getReceipt(scope, input.mutationId);
      if (receipt) {
        this.#assertReceipt(receipt, "restore_stash", fingerprint);
        return { draft: this.getDraft(scope, threadId), replayed: true };
      }
      const draft = this.getDraft(scope, threadId);
      if (draft.revision !== input.expectedDraftRevision) {
        throw new DomainError(
          "draft_revision_conflict",
          "The draft changed in another client.",
        );
      }
      const stash = this.#getStash(scope, threadId, stashId);
      const nextText =
        draft.text.length === 0 ? stash.text : `${draft.text}\n\n${stash.text}`;
      this.database
        .prepare(
          `
            UPDATE thread_drafts
            SET text = ?, updated_at = ?, revision = revision + 1
            WHERE tenant_id = ? AND principal_id = ? AND thread_id = ?
              AND revision = ?
          `,
        )
        .run(
          nextText,
          input.now,
          scope.tenantId,
          scope.principalId,
          threadId,
          input.expectedDraftRevision,
        );
      this.database
        .prepare(
          `
            DELETE FROM prompt_stashes
            WHERE tenant_id = ? AND principal_id = ? AND thread_id = ? AND id = ?
          `,
        )
        .run(scope.tenantId, scope.principalId, threadId, stashId);
      this.#insertReceipt(
        scope,
        threadId,
        input.mutationId,
        "restore_stash",
        fingerprint,
        "restored",
        { draftRevision: draft.revision + 1, stashId },
        input.now,
      );
      return { draft: this.getDraft(scope, threadId), replayed: false };
    })();
  }

  deleteStash(
    scope: RequestScope,
    threadId: string,
    stashId: string,
  ): boolean {
    this.#getInventory(scope, threadId);
    return (
      this.database
        .prepare(
          `
            DELETE FROM prompt_stashes
            WHERE tenant_id = ? AND principal_id = ? AND thread_id = ? AND id = ?
          `,
        )
        .run(scope.tenantId, scope.principalId, threadId, stashId).changes === 1
    );
  }

  transitionInventory(
    scope: RequestScope,
    threadId: string,
    input: InventoryMutationInput,
  ): { state: ThreadPrincipalStateRecord; replayed: boolean } {
    const fingerprint = this.#fingerprint([
      "inventory",
      threadId,
      input.expectedRevision,
      input.change,
    ]);
    return this.database.transaction(() => {
      const receipt = this.#getReceipt(scope, input.mutationId);
      if (receipt) {
        this.#assertReceipt(receipt, "inventory", fingerprint);
        return {
          state: JSON.parse(receipt.resultJson) as ThreadPrincipalStateRecord,
          replayed: true,
        };
      }
      const current = this.#getInventory(scope, threadId);
      if (current.inventoryRevision !== input.expectedRevision) {
        throw new DomainError(
          "inventory_revision_conflict",
          "The thread inventory state changed in another client.",
        );
      }
      if (
        input.change.action === "snooze" &&
        this.database
          .prepare(
            `
              SELECT 1
              FROM automation_runs
              WHERE tenant_id = ? AND owner_principal_id = ?
                AND anchor_thread_id = ?
                AND occurrence_kind = 'scheduled'
                AND state = 'dispatching'
              LIMIT 1
            `,
          )
          .get(scope.tenantId, scope.principalId, threadId)
      ) {
        throw new DomainError(
          "invalid_transition",
          "This thread cannot be snoozed after a scheduled automation begins dispatch.",
          true,
        );
      }
      if (
        input.change.action === "archive" &&
        this.database
          .prepare(
            `
              SELECT 1
              FROM automation_runs
              WHERE tenant_id = ? AND owner_principal_id = ?
                AND anchor_thread_id = ?
                AND state IN (
                  'claimed', 'dispatching', 'queued', 'running', 'uncertain'
                )
              LIMIT 1
            `,
          )
          .get(scope.tenantId, scope.principalId, threadId)
      ) {
        throw new DomainError(
          "invalid_transition",
          "This thread cannot be archived while an automation run is active.",
          true,
        );
      }
      const next = this.#nextInventoryState(current, input.change, input.now);
      const changed = !this.#sameInventory(current, next);
      if (changed) {
        this.#writeInventory(next);
        this.#bumpGeneration(scope);
      }
      const result = changed ? this.#getInventory(scope, threadId) : current;
      this.#insertReceipt(
        scope,
        threadId,
        input.mutationId,
        "inventory",
        fingerprint,
        changed ? "changed" : "noop",
        result,
        input.now,
      );
      return { state: result, replayed: false };
    })();
  }

  acknowledgeWake(
    scope: RequestScope,
    threadId: string,
    observedWokeAt: number,
    now: number,
  ): ThreadPrincipalStateRecord {
    return this.database.transaction(() => {
      this.#getInventory(scope, threadId);
      const result = this.database
        .prepare(
          `
            UPDATE thread_principal_state
            SET wake_acknowledged_at = ?, inventory_revision = inventory_revision + 1
            WHERE tenant_id = ? AND principal_id = ? AND thread_id = ?
              AND inventory_state = 'active'
              AND woke_at = ?
              AND (wake_acknowledged_at IS NULL OR wake_acknowledged_at < woke_at)
          `,
        )
        .run(
          now,
          scope.tenantId,
          scope.principalId,
          threadId,
          observedWokeAt,
        );
      if (result.changes === 1) {
        this.#bumpGeneration(scope);
      }
      return this.#getInventory(scope, threadId);
    })();
  }

  dismissWakeReminder(
    scope: RequestScope,
    threadId: string,
    observedWokeAt: number,
    _now: number,
  ): ThreadPrincipalStateRecord {
    return this.database.transaction(() => {
      this.#getInventory(scope, threadId);
      const result = this.database
        .prepare(
          `
            UPDATE thread_principal_state
            SET wake_reminder_text = NULL,
              inventory_revision = inventory_revision + 1
            WHERE tenant_id = ? AND principal_id = ? AND thread_id = ?
              AND woke_at = ? AND wake_reminder_text IS NOT NULL
          `,
        )
        .run(
          scope.tenantId,
          scope.principalId,
          threadId,
          observedWokeAt,
        );
      if (result.changes === 1) {
        this.#bumpGeneration(scope);
      }
      return this.#getInventory(scope, threadId);
    })();
  }

  dismissAutomationContext(
    scope: RequestScope,
    threadId: string,
    runId: string,
  ): ThreadPrincipalStateRecord {
    return this.database.transaction(() => {
      this.#getInventory(scope, threadId);
      const result = this.database
        .prepare(
          `
            UPDATE thread_principal_state
            SET automation_context_run_id = NULL,
              automation_context_source_thread_id = NULL,
              automation_context_at = NULL,
              automation_context_outcome = NULL,
              automation_context_diagnostic = NULL,
              inventory_revision = inventory_revision + 1
            WHERE tenant_id = ? AND principal_id = ? AND thread_id = ?
              AND automation_context_run_id = ?
          `,
        )
        .run(scope.tenantId, scope.principalId, threadId, runId);
      if (result.changes === 1) {
        this.#bumpGeneration(scope);
      }
      return this.#getInventory(scope, threadId);
    })();
  }

  recordAgentCompletion(
    scope: RequestScope,
    threadId: string,
    completionId: string,
    now: number,
  ): ThreadPrincipalStateRecord {
    return this.database.transaction(() => {
      this.#getInventory(scope, threadId);
      const result = this.database
        .prepare(
          `
            UPDATE thread_principal_state
            SET latest_agent_completion_id = ?,
              latest_agent_completion_at = ?,
              inventory_revision = inventory_revision + 1
            WHERE tenant_id = ? AND principal_id = ? AND thread_id = ?
              AND (
                latest_agent_completion_id IS NULL
                OR latest_agent_completion_id <> ?
              )
          `,
        )
        .run(
          completionId,
          now,
          scope.tenantId,
          scope.principalId,
          threadId,
          completionId,
        );
      if (result.changes === 1) this.#bumpGeneration(scope);
      return this.#getInventory(scope, threadId);
    })();
  }

  acknowledgeAgentCompletion(
    scope: RequestScope,
    threadId: string,
    observedCompletionId: string,
  ): ThreadPrincipalStateRecord {
    return this.database.transaction(() => {
      this.#getInventory(scope, threadId);
      const result = this.database
        .prepare(
          `
            UPDATE thread_principal_state
            SET seen_agent_completion_id = ?,
              inventory_revision = inventory_revision + 1
            WHERE tenant_id = ? AND principal_id = ? AND thread_id = ?
              AND latest_agent_completion_id = ?
              AND (
                seen_agent_completion_id IS NULL
                OR seen_agent_completion_id <> latest_agent_completion_id
              )
          `,
        )
        .run(
          observedCompletionId,
          scope.tenantId,
          scope.principalId,
          threadId,
          observedCompletionId,
        );
      if (result.changes === 1) this.#bumpGeneration(scope);
      return this.#getInventory(scope, threadId);
    })();
  }

  activateForAcceptedSend(
    scope: RequestScope,
    threadId: string,
    now: number,
  ): ThreadPrincipalStateRecord {
    return this.database.transaction(() => {
      const current = this.#getInventory(scope, threadId);
      if (
        current.inventoryState !== "settled" &&
        current.inventoryState !== "snoozed"
      ) {
        return current;
      }
      const fromSnooze = current.inventoryState === "snoozed";
      this.database
        .prepare(
          `
            UPDATE thread_principal_state
            SET inventory_state = 'active',
              state_changed_at = ?,
              snoozed_at = NULL,
              snoozed_until = NULL,
              woke_at = ?,
              wake_reason = ?,
              wake_acknowledged_at = ?,
              inventory_revision = inventory_revision + 1
            WHERE tenant_id = ? AND principal_id = ? AND thread_id = ?
              AND inventory_revision = ?
          `,
        )
        .run(
          now,
          fromSnooze ? now : null,
          fromSnooze ? "activity" : null,
          fromSnooze ? now : null,
          scope.tenantId,
          scope.principalId,
          threadId,
          current.inventoryRevision,
        );
      this.#bumpGeneration(scope);
      return this.#getInventory(scope, threadId);
    })();
  }

  activateForAutomation(
    scope: RequestScope,
    threadId: string,
    now: number,
  ): ThreadPrincipalStateRecord {
    return this.database.transaction(() => {
      const current = this.#getInventory(scope, threadId);
      if (
        current.inventoryState !== "settled"
      ) {
        return current;
      }
      const result = this.database
        .prepare(
          `
            UPDATE thread_principal_state
            SET inventory_state = 'active',
              state_changed_at = ?,
              snoozed_at = NULL,
              snoozed_until = NULL,
              woke_at = NULL,
              wake_reason = NULL,
              wake_acknowledged_at = NULL,
              inventory_revision = inventory_revision + 1
            WHERE tenant_id = ? AND principal_id = ? AND thread_id = ?
              AND inventory_revision = ?
          `,
        )
        .run(
          now,
          scope.tenantId,
          scope.principalId,
          threadId,
          current.inventoryRevision,
        );
      if (result.changes !== 1) {
        throw new DomainError(
          "inventory_revision_conflict",
          "The thread inventory changed during automation activation.",
        );
      }
      this.#bumpGeneration(scope);
      return this.#getInventory(scope, threadId);
    })();
  }

  wakeSnoozedForRuntimeSignal(
    scope: RequestScope,
    threadId: string,
    reason: "completion" | "failure" | "needs-input",
    now: number,
  ): ThreadPrincipalStateRecord {
    return this.database.transaction(() => {
      const current = this.#getInventory(scope, threadId);
      if (current.inventoryState !== "snoozed") {
        return current;
      }
      this.database
        .prepare(
          `
            UPDATE thread_principal_state
            SET inventory_state = 'active',
              state_changed_at = ?,
              snoozed_at = NULL,
              snoozed_until = NULL,
              woke_at = ?,
              wake_reason = ?,
              wake_acknowledged_at = NULL,
              inventory_revision = inventory_revision + 1
            WHERE tenant_id = ? AND principal_id = ? AND thread_id = ?
              AND inventory_revision = ?
          `,
        )
        .run(
          now,
          now,
          reason,
          scope.tenantId,
          scope.principalId,
          threadId,
          current.inventoryRevision,
        );
      this.#bumpGeneration(scope);
      return this.#getInventory(scope, threadId);
    })();
  }

  wakeDueSnoozes(now: number): Array<{
    scope: RequestScope;
    state: ThreadPrincipalStateRecord;
  }> {
    return this.database.transaction(() => {
      const due = this.database
        .prepare(
          `
            SELECT tenant_id AS tenantId, principal_id AS principalId,
              thread_id AS threadId
            FROM thread_principal_state
            WHERE inventory_state = 'snoozed' AND snoozed_until <= ?
            ORDER BY snoozed_until, tenant_id, principal_id, thread_id
          `,
        )
        .all(now) as Array<RequestScope & { threadId: string }>;
      const changed: Array<{
        scope: RequestScope;
        state: ThreadPrincipalStateRecord;
      }> = [];
      for (const item of due) {
        const scope = {
          tenantId: item.tenantId,
          principalId: item.principalId,
        };
        const result = this.database
          .prepare(
            `
              UPDATE thread_principal_state
              SET inventory_state = 'active',
                state_changed_at = ?,
                snoozed_at = NULL,
                snoozed_until = NULL,
                woke_at = ?,
                wake_reason = 'deadline',
                wake_acknowledged_at = NULL,
                inventory_revision = inventory_revision + 1
              WHERE tenant_id = ? AND principal_id = ? AND thread_id = ?
                AND inventory_state = 'snoozed' AND snoozed_until <= ?
            `,
          )
          .run(
            now,
            now,
            scope.tenantId,
            scope.principalId,
            item.threadId,
            now,
          );
        if (result.changes === 1) {
          this.#bumpGeneration(scope);
          changed.push({
            scope,
            state: this.#getInventory(scope, item.threadId),
          });
        }
      }
      return changed;
    })();
  }

  getNearestSnoozeDeadline(): number | null {
    const row = this.database
      .prepare(
        `
          SELECT min(snoozed_until) AS deadline
          FROM thread_principal_state
          WHERE inventory_state = 'snoozed'
        `,
      )
      .get() as { deadline: number | null };
    return row.deadline;
  }

  listThreads(scope: RequestScope, input: ThreadListInput): ThreadListResult {
    const generation = this.getInventoryGeneration(scope);
    const search = normalizeSearch(input.search);
    const searchHash = hashSearch(search);
    const decoded = input.cursor
      ? input.cursorCodec.decode(scope, input.cursor, {
          inventoryState: input.inventoryState,
          backingState: input.backingState ?? null,
          searchHash,
          generation,
        })
      : undefined;
    const ascending = input.inventoryState === "snoozed";
    const comparator = ascending ? ">" : "<";
    const order = ascending ? "ASC" : "DESC";
    const searchPattern = `%${this.#escapeLike(search)}%`;
    const rows = this.database
      .prepare(
        `
          SELECT
            ${threadColumns},
            ${inventoryColumns},
            CASE
              WHEN s.inventory_state = 'active' THEN t.last_activity_at
              WHEN s.inventory_state = 'snoozed' THEN s.snoozed_until
              ELSE s.state_changed_at
            END AS primarySort
          FROM application_threads t
          JOIN thread_principal_state s
            ON s.tenant_id = t.tenant_id AND s.thread_id = t.id
          JOIN workspaces w
            ON w.tenant_id = t.tenant_id AND w.id = t.workspace_id
          JOIN execution_environments e
            ON e.tenant_id = t.tenant_id AND e.id = t.environment_id
          WHERE t.tenant_id = ? AND t.owner_principal_id = ?
            AND s.principal_id = ?
            AND s.inventory_state = ?
            AND (? IS NULL OR t.backing_state = ?)
            AND (
              ? = ''
              OR lower(t.title) LIKE ? ESCAPE '\\'
              OR lower(w.display_name) LIKE ? ESCAPE '\\'
              OR lower(e.label) LIKE ? ESCAPE '\\'
            )
            AND (
              ? IS NULL
              OR (
                (CASE
                  WHEN s.inventory_state = 'active' THEN t.last_activity_at
                  WHEN s.inventory_state = 'snoozed' THEN s.snoozed_until
                  ELSE s.state_changed_at
                END) ${comparator} ?
              )
              OR (
                (CASE
                  WHEN s.inventory_state = 'active' THEN t.last_activity_at
                  WHEN s.inventory_state = 'snoozed' THEN s.snoozed_until
                  ELSE s.state_changed_at
                END) = ?
                AND t.id > ?
              )
            )
          ORDER BY primarySort ${order}, t.id ASC
          LIMIT ?
        `,
      )
      .all(
        scope.tenantId,
        scope.principalId,
        scope.principalId,
        input.inventoryState,
        input.backingState ?? null,
        input.backingState ?? null,
        search,
        searchPattern,
        searchPattern,
        searchPattern,
        decoded?.primarySort ?? null,
        decoded?.primarySort ?? null,
        decoded?.primarySort ?? null,
        decoded?.threadId ?? "",
        input.pageSize + 1,
      ) as ListThreadRow[];
    const hasMore = rows.length > input.pageSize;
    const pageRows = hasMore ? rows.slice(0, input.pageSize) : rows;
    const items = pageRows.map((row) => ({
      thread: this.#threadFromJoined(row),
      inventory: this.#inventoryFromJoined(row),
    }));
    const last = pageRows.at(-1);
    const nextCursor =
      hasMore && last
          ? input.cursorCodec.encode(scope, {
            inventoryState: input.inventoryState,
            backingState: input.backingState ?? null,
            searchHash,
            generation,
            primarySort: last.primarySort,
            threadId: last.id,
          })
        : null;
    return { items, nextCursor };
  }

  getInventoryGeneration(scope: RequestScope): number {
    const row = this.database
      .prepare(
        `
          SELECT inventory_generation AS generation
          FROM principal_generations
          WHERE tenant_id = ? AND principal_id = ?
        `,
      )
      .get(scope.tenantId, scope.principalId) as
      | { generation: number }
      | undefined;
    if (!row) {
      throw new DomainError("not_found", "The request scope was not found.");
    }
    return row.generation;
  }

  countThreads(scope: RequestScope, inventoryState: InventoryState): number {
    const row = this.database
      .prepare(
        `
          SELECT count(*) AS count
          FROM thread_principal_state s
          JOIN application_threads t
            ON t.tenant_id = s.tenant_id AND t.id = s.thread_id
          WHERE s.tenant_id = ? AND s.principal_id = ?
            AND t.owner_principal_id = ? AND s.inventory_state = ?
        `,
      )
      .get(
        scope.tenantId,
        scope.principalId,
        scope.principalId,
        inventoryState,
      ) as { count: number };
    return row.count;
  }

  prepareFirstSend(
    scope: RequestScope,
    threadId: string,
    input: {
      expectedDraftRevision: number;
      mutationId: string;
      attemptId: string;
      reservedNativeSessionId: string;
      now: number;
    },
  ): FirstSendPreparation {
    const fingerprint = this.#fingerprint([
      "first_send",
      threadId,
      input.expectedDraftRevision,
    ]);
    return this.database.transaction(() => {
      const receipt = this.#getReceipt(scope, input.mutationId);
      if (receipt) {
        this.#assertReceipt(receipt, "first_send", fingerprint);
        return {
          ...this.getThread(scope, threadId),
          mutationReceipt: {
            replayed: true,
            resultCode: receipt.resultCode,
          },
        };
      }
      const current = this.getThread(scope, threadId);
      if (current.thread.backingState !== "draft") {
        throw new DomainError(
          "invalid_transition",
          "Only a Draft thread can begin first-send materialization.",
        );
      }
      if (current.draft.revision !== input.expectedDraftRevision) {
        throw new DomainError(
          "draft_revision_conflict",
          "The draft changed in another client.",
        );
      }
      if (current.draft.text.length === 0) {
        throw new DomainError("invalid_transition", "An empty draft cannot be sent.");
      }
      this.database
        .prepare(
          `
            INSERT INTO pending_first_sends(
              tenant_id, principal_id, thread_id, attempt_id, mutation_id, text, created_at
            )
            VALUES (?, ?, ?, ?, ?, ?, ?)
          `,
        )
        .run(
          scope.tenantId,
          scope.principalId,
          threadId,
          input.attemptId,
          input.mutationId,
          current.draft.text,
          input.now,
        );
      this.database
        .prepare(
          `
            UPDATE thread_drafts
            SET text = '', updated_at = ?, revision = revision + 1
            WHERE tenant_id = ? AND principal_id = ? AND thread_id = ?
              AND revision = ?
          `,
        )
        .run(
          input.now,
          scope.tenantId,
          scope.principalId,
          threadId,
          input.expectedDraftRevision,
        );
      this.database
        .prepare(
          `
            UPDATE application_threads
            SET backing_state = 'materializing',
              reserved_native_session_id = ?,
              materialization_attempt_id = ?,
              attempt_phase = 'prepared',
              updated_at = ?,
              revision = revision + 1
            WHERE tenant_id = ? AND owner_principal_id = ? AND id = ?
              AND backing_state = 'draft'
          `,
        )
        .run(
          input.reservedNativeSessionId,
          input.attemptId,
          input.now,
          scope.tenantId,
          scope.principalId,
          threadId,
        );
      this.#insertReceipt(
        scope,
        threadId,
        input.mutationId,
        "first_send",
        fingerprint,
        "prepared",
        {
          attemptId: input.attemptId,
          reservedNativeSessionId: input.reservedNativeSessionId,
        },
        input.now,
      );
      this.#bumpGeneration(scope);
      return {
        ...this.getThread(scope, threadId),
        mutationReceipt: {
          replayed: false,
          resultCode: "prepared",
        },
      };
    })();
  }

  prepareAutomationFirstSend(
    scope: RequestScope,
    threadId: string,
    input: {
      prompt: string;
      automationId: string;
      automationRunId: string;
      mutationId: string;
      attemptId: string;
      reservedNativeSessionId: string;
      now: number;
    },
  ): FirstSendPreparation {
    const fingerprint = this.#fingerprint([
      "automation_first_send",
      threadId,
      input.automationId,
      input.automationRunId,
      input.prompt,
    ]);
    return this.database.transaction(() => {
      const receipt = this.#getReceipt(scope, input.mutationId);
      if (receipt) {
        this.#assertReceipt(receipt, "automation_first_send", fingerprint);
        return {
          ...this.getThread(scope, threadId),
          mutationReceipt: {
            replayed: true,
            resultCode: receipt.resultCode,
          },
        };
      }
      const current = this.getThread(scope, threadId);
      if (current.thread.backingState !== "draft") {
        throw new DomainError(
          "invalid_transition",
          "Only a Draft thread can begin automation materialization.",
        );
      }
      if (!input.prompt.length) {
        throw new DomainError(
          "invalid_transition",
          "An empty automation prompt cannot be sent.",
        );
      }
      this.database
        .prepare(
          `
            INSERT INTO pending_first_sends(
              tenant_id, principal_id, thread_id, attempt_id, mutation_id,
              text, created_at, source_kind, automation_id, automation_run_id
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, 'automation', ?, ?)
          `,
        )
        .run(
          scope.tenantId,
          scope.principalId,
          threadId,
          input.attemptId,
          input.mutationId,
          input.prompt,
          input.now,
          input.automationId,
          input.automationRunId,
        );
      this.database
        .prepare(
          `
            UPDATE application_threads
            SET backing_state = 'materializing',
              reserved_native_session_id = ?,
              materialization_attempt_id = ?,
              attempt_phase = 'prepared',
              updated_at = ?,
              revision = revision + 1
            WHERE tenant_id = ? AND owner_principal_id = ? AND id = ?
              AND backing_state = 'draft'
          `,
        )
        .run(
          input.reservedNativeSessionId,
          input.attemptId,
          input.now,
          scope.tenantId,
          scope.principalId,
          threadId,
        );
      this.#insertReceipt(
        scope,
        threadId,
        input.mutationId,
        "automation_first_send",
        fingerprint,
        "prepared",
        {
          attemptId: input.attemptId,
          reservedNativeSessionId: input.reservedNativeSessionId,
        },
        input.now,
      );
      this.#bumpGeneration(scope);
      return {
        ...this.getThread(scope, threadId),
        mutationReceipt: {
          replayed: false,
          resultCode: "prepared",
        },
      };
    })();
  }

  setMaterializationPhase(
    scope: RequestScope,
    threadId: string,
    attemptId: string,
    phase: "submitting" | "accepted_unpersisted" | "aborted_unpersisted",
    now: number,
  ): ThreadWithState {
    return this.database.transaction(() => {
      const result = this.database
        .prepare(
          `
            UPDATE application_threads
            SET attempt_phase = ?,
              backing_state = CASE
                WHEN ? = 'aborted_unpersisted' AND backing_state != 'native'
                  THEN 'materialization_failed'
                ELSE backing_state
              END,
              uncertain_at = CASE
                WHEN ? = 'aborted_unpersisted' THEN ? ELSE uncertain_at
              END,
              updated_at = ?,
              revision = revision + 1
            WHERE tenant_id = ? AND owner_principal_id = ? AND id = ?
              AND materialization_attempt_id = ?
              AND backing_state IN (
                'materializing', 'materialization_failed', 'native'
              )
          `,
        )
        .run(
          phase,
          phase,
          phase,
          now,
          now,
          scope.tenantId,
          scope.principalId,
          threadId,
          attemptId,
        );
      if (result.changes !== 1) {
        throw new DomainError("conflict", "The materialization attempt changed.");
      }
      this.#updateFirstSendReceipt(
        scope,
        threadId,
        phase,
        { attemptId, phase },
      );
      this.#bumpGeneration(scope);
      return this.getThread(scope, threadId);
    })();
  }

  markMaterializationUncertain(
    scope: RequestScope,
    threadId: string,
    attemptId: string,
    now: number,
  ): ThreadWithState {
    return this.database.transaction(() => {
      const result = this.database
        .prepare(
          `
            UPDATE application_threads
            SET backing_state = CASE
                WHEN backing_state = 'native' THEN 'native'
                ELSE 'materialization_failed'
              END,
              attempt_diagnostic_code = 'submission_outcome_uncertain',
              uncertain_at = ?, updated_at = ?, revision = revision + 1
            WHERE tenant_id = ? AND owner_principal_id = ? AND id = ?
              AND materialization_attempt_id = ?
              AND attempt_phase IN ('submitting', 'accepted_unpersisted')
          `,
        )
        .run(
          now,
          now,
          scope.tenantId,
          scope.principalId,
          threadId,
          attemptId,
        );
      if (result.changes !== 1) {
        throw new DomainError("conflict", "The materialization attempt changed.");
      }
      this.#bumpGeneration(scope);
      return this.getThread(scope, threadId);
    })();
  }

  bindNativeSession(
    scope: RequestScope,
    threadId: string,
    input: {
      attemptId: string;
      nativeSessionPath: string;
      promptVerified: boolean;
      now: number;
    },
  ): ThreadWithState {
    return this.database.transaction(() => {
      const thread = this.getThread(scope, threadId).thread;
      if (thread.materializationAttemptId !== input.attemptId) {
        throw new DomainError("conflict", "The materialization attempt changed.");
      }
      this.database
        .prepare(
          `
            UPDATE application_threads
            SET backing_state = 'native',
              native_session_path = ?,
              materialization_attempt_id = CASE WHEN ? THEN NULL ELSE materialization_attempt_id END,
              attempt_phase = CASE WHEN ? THEN NULL ELSE attempt_phase END,
              attempt_diagnostic_code = CASE
                WHEN ? THEN NULL ELSE 'native_prompt_unresolved' END,
              uncertain_at = CASE WHEN ? THEN NULL ELSE uncertain_at END,
              reconciliation_at = ?,
              updated_at = ?,
              revision = revision + 1
            WHERE tenant_id = ? AND owner_principal_id = ? AND id = ?
          `,
        )
        .run(
          input.nativeSessionPath,
          input.promptVerified ? 1 : 0,
          input.promptVerified ? 1 : 0,
          input.promptVerified ? 1 : 0,
          input.promptVerified ? 1 : 0,
          input.now,
          input.now,
          scope.tenantId,
          scope.principalId,
          threadId,
        );
      if (input.promptVerified) {
        this.#updateFirstSendReceipt(
          scope,
          threadId,
          "accepted",
          { attemptId: input.attemptId },
        );
        this.database
          .prepare(
            `
              DELETE FROM pending_first_sends
              WHERE tenant_id = ? AND principal_id = ? AND thread_id = ?
            `,
          )
          .run(scope.tenantId, scope.principalId, threadId);
      }
      this.#bumpGeneration(scope);
      return this.getThread(scope, threadId);
    })();
  }

  reconcileDiscoveredNativeSession(
    scope: RequestScope,
    input: ReconcileNativeSessionInput,
  ): ThreadWithState {
    return this.database.transaction(() => {
      const workspace = this.getWorkspace(scope, input.workspaceId);
      if (workspace.environmentId !== input.environmentId) {
        throw new DomainError(
          "conflict",
          "The discovered session workspace belongs to another environment.",
        );
      }
      const byNativeId = this.#findThreadByNativeId(
        scope,
        input.environmentId,
        input.nativeSessionId,
      );
      const byPath = this.#findThreadByNativePath(
        scope,
        input.environmentId,
        input.canonicalSessionPath,
      );
      if (byNativeId && byPath && byNativeId.id !== byPath.id) {
        this.#quarantineThreads(
          scope,
          [byNativeId.id, byPath.id],
          input.now,
        );
        return this.getThread(scope, byNativeId.id);
      }
      if (byPath && byPath.reservedNativeSessionId !== input.nativeSessionId) {
        this.#quarantineThreads(scope, [byPath.id], input.now);
        return this.getThread(scope, byPath.id);
      }

      const existing = byNativeId ?? byPath;
      if (existing) {
        if (existing.availability === "quarantined") {
          this.database
            .prepare(
              `
                UPDATE application_threads
                SET reconciliation_at = ?, updated_at = ?
                WHERE tenant_id = ? AND owner_principal_id = ? AND id = ?
              `,
            )
            .run(
              input.now,
              input.now,
              scope.tenantId,
              scope.principalId,
              existing.id,
            );
          return this.getThread(scope, existing.id);
        }
        if (existing.workspaceId !== input.workspaceId) {
          this.#quarantineThreads(scope, [existing.id], input.now);
          return this.getThread(scope, existing.id);
        }
        const title = input.title ?? existing.title;
        const changed =
          existing.nativeSessionPath !== input.canonicalSessionPath ||
          existing.title !== title ||
          existing.backingState !== "native" ||
          existing.availability !== "available" ||
          input.updatedAt > existing.lastActivityAt;
        this.database
          .prepare(
            `
              UPDATE application_threads
              SET backing_state = 'native', native_session_path = ?, workspace_id = ?,
                title = ?, availability = 'available',
                attempt_diagnostic_code = CASE
                  WHEN materialization_attempt_id IS NULL THEN NULL
                  ELSE 'native_prompt_unresolved'
                END,
                reconciliation_at = ?, last_activity_at = max(last_activity_at, ?),
                updated_at = ?,
                revision = revision + CASE WHEN ? THEN 1 ELSE 0 END
              WHERE tenant_id = ? AND owner_principal_id = ? AND id = ?
            `,
          )
          .run(
            input.canonicalSessionPath,
            input.workspaceId,
            title,
            input.now,
            input.updatedAt,
            input.now,
            changed ? 1 : 0,
            scope.tenantId,
            scope.principalId,
            existing.id,
          );
        if (changed) {
          this.#bumpGeneration(scope);
        }
        return this.getThread(scope, existing.id);
      }

      const threadId = randomUUID();
      this.database
        .prepare(
          `
            INSERT INTO application_threads(
              tenant_id, id, owner_principal_id, environment_id, workspace_id,
              backing_state, reserved_native_session_id, native_session_path,
              title, tool_mode, availability, reconciliation_at,
              last_activity_at, materialization_attempt_id, attempt_phase,
              attempt_diagnostic_code, uncertain_at, revision, created_at, updated_at
            )
            VALUES (
              ?, ?, ?, ?, ?, 'native', ?, ?, ?, 'read_only', 'available', ?,
              ?, NULL, NULL, NULL, NULL, 0, ?, ?
            )
          `,
        )
        .run(
          scope.tenantId,
          threadId,
          scope.principalId,
          input.environmentId,
          input.workspaceId,
          input.nativeSessionId,
          input.canonicalSessionPath,
          input.title ?? "Imported Pi session",
          input.now,
          input.updatedAt,
          input.now,
          input.now,
        );
      this.database
        .prepare(
          `
            INSERT INTO thread_principal_state(
              tenant_id, principal_id, thread_id, inventory_state,
              state_changed_at, snoozed_at, snoozed_until, woke_at,
              wake_reason, wake_acknowledged_at, inventory_revision
            )
            VALUES (?, ?, ?, 'active', ?, NULL, NULL, NULL, NULL, NULL, 0)
          `,
        )
        .run(scope.tenantId, scope.principalId, threadId, input.now);
      this.database
        .prepare(
          `
            INSERT INTO thread_drafts(
              tenant_id, principal_id, thread_id, text, updated_at, revision
            )
            VALUES (?, ?, ?, '', ?, 0)
          `,
        )
        .run(scope.tenantId, scope.principalId, threadId, input.now);
      this.database
        .prepare(
          `
            INSERT INTO thread_start_preferences(
              tenant_id, thread_id, model_provider, model_id, thinking_level, revision
            )
            VALUES (?, ?, NULL, NULL, NULL, 0)
          `,
        )
        .run(scope.tenantId, threadId);
      this.#bumpGeneration(scope);
      return this.getThread(scope, threadId);
    })();
  }

  finishNativeDiscovery(
    scope: RequestScope,
    environmentId: string,
    seenNativeSessionIds: ReadonlySet<string>,
    now: number,
  ): ThreadWithState[] {
    return this.database.transaction(() => {
      const rows = this.database
        .prepare(
          `
            SELECT id, reserved_native_session_id AS nativeSessionId, availability
            FROM application_threads
            WHERE tenant_id = ? AND owner_principal_id = ?
              AND environment_id = ? AND backing_state = 'native'
              AND availability <> 'quarantined'
          `,
        )
        .all(
          scope.tenantId,
          scope.principalId,
          environmentId,
        ) as Array<{
          id: string;
          nativeSessionId: string;
          availability: ApplicationThreadRecord["availability"];
        }>;
      const changed: string[] = [];
      for (const row of rows) {
        const availability = seenNativeSessionIds.has(row.nativeSessionId)
          ? "available"
          : "missing";
        this.database
          .prepare(
            `
              UPDATE application_threads
              SET availability = ?, reconciliation_at = ?, updated_at = ?,
                revision = revision + CASE WHEN availability <> ? THEN 1 ELSE 0 END
              WHERE tenant_id = ? AND owner_principal_id = ? AND id = ?
            `,
          )
          .run(
            availability,
            now,
            now,
            availability,
            scope.tenantId,
            scope.principalId,
            row.id,
          );
        if (row.availability !== availability) {
          changed.push(row.id);
        }
      }
      if (changed.length > 0) {
        this.#bumpGeneration(scope);
      }
      return changed.map((threadId) => this.getThread(scope, threadId));
    })();
  }

  quarantineNativeSessions(
    scope: RequestScope,
    environmentId: string,
    nativeSessionIds: readonly string[],
    canonicalSessionPaths: readonly string[],
    now: number,
  ): ThreadWithState[] {
    return this.database.transaction(() => {
      const ids = new Set<string>();
      for (const nativeSessionId of nativeSessionIds) {
        const thread = this.#findThreadByNativeId(
          scope,
          environmentId,
          nativeSessionId,
        );
        if (thread) ids.add(thread.id);
      }
      for (const canonicalSessionPath of canonicalSessionPaths) {
        const thread = this.#findThreadByNativePath(
          scope,
          environmentId,
          canonicalSessionPath,
        );
        if (thread) ids.add(thread.id);
      }
      this.#quarantineThreads(scope, [...ids], now);
      return [...ids].map((threadId) => this.getThread(scope, threadId));
    })();
  }

  getStartPreferences(
    scope: RequestScope,
    threadId: string,
  ): ThreadStartPreferencesRecord {
    this.getThread(scope, threadId);
    const row = this.database
      .prepare(
        `
          SELECT
            tenant_id AS tenantId,
            thread_id AS threadId,
            model_provider AS modelProvider,
            model_id AS modelId,
            thinking_level AS thinkingLevel,
            revision
          FROM thread_start_preferences
          WHERE tenant_id = ? AND thread_id = ?
        `,
      )
      .get(scope.tenantId, threadId) as
      | ThreadStartPreferencesRecord
      | undefined;
    if (!row) {
      throw new DomainError("not_found", "The thread configuration was not found.");
    }
    return row;
  }

  getPendingFirstSend(
    scope: RequestScope,
    threadId: string,
  ): PendingFirstSendRecord | null {
    this.getThread(scope, threadId);
    return (
      (this.database
        .prepare(
          `
            SELECT
              tenant_id AS tenantId,
              principal_id AS principalId,
              thread_id AS threadId,
              attempt_id AS attemptId,
              mutation_id AS mutationId,
              text,
              created_at AS createdAt,
              retry_mutation_id AS retryMutationId,
              retry_anchor_entry_id AS retryAnchorEntryId,
              retry_anchor_entry_count AS retryAnchorEntryCount,
              source_kind AS sourceKind,
              automation_id AS automationId,
              automation_run_id AS automationRunId
            FROM pending_first_sends
            WHERE tenant_id = ? AND principal_id = ? AND thread_id = ?
          `,
        )
        .get(
          scope.tenantId,
          scope.principalId,
          threadId,
        ) as PendingFirstSendRecord | undefined) ?? null
    );
  }

  updateThreadConfiguration(
    scope: RequestScope,
    threadId: string,
    input: {
      expectedRevision: number;
      modelProvider: string | null;
      modelId: string | null;
      thinkingLevel: string | null;
      toolMode: "read_only" | "full";
      now: number;
    },
  ): ThreadWithState {
    return this.database.transaction(() => {
      const current = this.getThread(scope, threadId);
      if (current.thread.revision !== input.expectedRevision) {
        throw new DomainError(
          "conflict",
          "The thread configuration changed in another client.",
        );
      }
      if ((input.modelProvider === null) !== (input.modelId === null)) {
        throw new DomainError(
          "invalid_transition",
          "Model provider and model ID must be configured together.",
        );
      }
      this.database
        .prepare(
          `
            UPDATE thread_start_preferences
            SET model_provider = ?, model_id = ?, thinking_level = ?,
              revision = revision + 1
            WHERE tenant_id = ? AND thread_id = ?
          `,
        )
        .run(
          input.modelProvider,
          input.modelId,
          input.thinkingLevel,
          scope.tenantId,
          threadId,
        );
      const result = this.database
        .prepare(
          `
            UPDATE application_threads
            SET tool_mode = ?, updated_at = ?, revision = revision + 1
            WHERE tenant_id = ? AND owner_principal_id = ? AND id = ?
              AND revision = ?
          `,
        )
        .run(
          input.toolMode,
          input.now,
          scope.tenantId,
          scope.principalId,
          threadId,
          input.expectedRevision,
        );
      if (result.changes !== 1) {
        throw new DomainError("conflict", "The thread configuration changed.");
      }
      this.#bumpGeneration(scope);
      return this.getThread(scope, threadId);
    })();
  }

  moveDraftThread(
    scope: RequestScope,
    threadId: string,
    input: {
      workspaceId: string;
      expectedRevision: number;
      mutationId: string;
      now: number;
    },
  ): ThreadWithState {
    const fingerprint = this.#fingerprint([
      "location",
      threadId,
      input.workspaceId,
      input.expectedRevision,
    ]);
    return this.database.transaction(() => {
      const receipt = this.#getReceipt(scope, input.mutationId);
      if (receipt) {
        this.#assertReceipt(receipt, "location", fingerprint);
        return this.getThread(scope, threadId);
      }
      const current = this.getThread(scope, threadId);
      if (current.thread.backingState !== "draft") {
        throw new DomainError(
          "invalid_transition",
          "A thread location can change only while it is a Draft.",
        );
      }
      if (current.thread.revision !== input.expectedRevision) {
        throw new DomainError(
          "conflict",
          "The thread changed in another client.",
        );
      }
      const workspace = this.getWorkspace(scope, input.workspaceId);
      this.database
        .prepare(
          `
            UPDATE application_threads
            SET environment_id = ?, workspace_id = ?, updated_at = ?,
              revision = revision + 1
            WHERE tenant_id = ? AND owner_principal_id = ? AND id = ?
              AND backing_state = 'draft' AND revision = ?
          `,
        )
        .run(
          workspace.environmentId,
          workspace.id,
          input.now,
          scope.tenantId,
          scope.principalId,
          threadId,
          input.expectedRevision,
        );
      this.#insertReceipt(
        scope,
        threadId,
        input.mutationId,
        "location",
        fingerprint,
        "moved",
        { workspaceId: workspace.id },
        input.now,
      );
      this.#bumpGeneration(scope);
      return this.getThread(scope, threadId);
    })();
  }

  renameThread(
    scope: RequestScope,
    threadId: string,
    input: {
      title: string;
      expectedRevision: number;
      mutationId: string;
      now: number;
    },
  ): ThreadWithState {
    const fingerprint = this.#fingerprint([
      "rename",
      threadId,
      input.title,
      input.expectedRevision,
    ]);
    return this.database.transaction(() => {
      const receipt = this.#getReceipt(scope, input.mutationId);
      if (receipt) {
        this.#assertReceipt(receipt, "rename", fingerprint);
        return this.getThread(scope, threadId);
      }
      const current = this.getThread(scope, threadId);
      if (current.thread.revision !== input.expectedRevision) {
        throw new DomainError("conflict", "The thread changed in another client.");
      }
      this.database
        .prepare(
          `
            UPDATE application_threads
            SET title = ?, updated_at = ?, revision = revision + 1
            WHERE tenant_id = ? AND owner_principal_id = ? AND id = ?
              AND revision = ?
          `,
        )
        .run(
          input.title,
          input.now,
          scope.tenantId,
          scope.principalId,
          threadId,
          input.expectedRevision,
        );
      this.#insertReceipt(
        scope,
        threadId,
        input.mutationId,
        "rename",
        fingerprint,
        "renamed",
        { title: input.title },
        input.now,
      );
      this.#bumpGeneration(scope);
      return this.getThread(scope, threadId);
    })();
  }

  beginNativeOperation(
    scope: RequestScope,
    threadId: string,
    input: {
      mutationId: string;
      kind: NativeOperationKind;
      request: unknown;
      now: number;
    },
  ): NativeMutationReceipt {
    const fingerprint = this.#fingerprint([
      input.kind,
      threadId,
      input.request,
    ]);
    return this.database.transaction(() => {
      this.getThread(scope, threadId);
      const receipt = this.#getReceipt(scope, input.mutationId);
      if (receipt) {
        this.#assertReceipt(receipt, input.kind, fingerprint);
        const resultCode = receipt.resultCode;
        if (
          resultCode !== "submitting" &&
          resultCode !== "accepted"
        ) {
          throw new DomainError(
            "operation_outcome_uncertain",
            "This operation already ended in a state that requires reconciliation.",
          );
        }
        return {
          replayed: true as const,
          resultCode: resultCode as NativeMutationReceipt["resultCode"],
        };
      }
      this.#insertReceipt(
        scope,
        threadId,
        input.mutationId,
        input.kind,
        fingerprint,
        "submitting",
        {},
        input.now,
      );
      return {
        replayed: false as const,
        resultCode: "submitting" as const,
      };
    })();
  }

  prepareMaterializationRetry(
    scope: RequestScope,
    threadId: string,
    input: {
      attemptId: string;
      mutationId: string;
      anchorEntryId: string | null;
      anchorEntryCount: number;
      now: number;
    },
  ): NativeMutationReceipt {
    if (
      input.anchorEntryCount < 0 ||
      !Number.isSafeInteger(input.anchorEntryCount) ||
      (input.anchorEntryCount === 0) !== (input.anchorEntryId === null)
    ) {
      throw new DomainError(
        "invalid_transition",
        "The retry branch anchor is invalid.",
      );
    }
    const request = {
      attemptId: input.attemptId,
      anchorEntryId: input.anchorEntryId,
      anchorEntryCount: input.anchorEntryCount,
    };
    return this.database.transaction(() => {
      const current = this.getThread(scope, threadId);
      const pending = this.getPendingFirstSend(scope, threadId);
      if (
        !pending ||
        pending.attemptId !== input.attemptId ||
        current.thread.materializationAttemptId !== input.attemptId
      ) {
        throw new DomainError(
          "materialization_unresolved",
          "No recoverable first send is pending.",
        );
      }
      const receipt = this.beginNativeOperation(scope, threadId, {
        mutationId: input.mutationId,
        kind: "materialization_retry",
        request,
        now: input.now,
      });
      if (receipt.replayed) {
        return receipt;
      }
      const anchor = this.database
        .prepare(
          `
            UPDATE pending_first_sends
            SET retry_mutation_id = ?,
              retry_anchor_entry_id = ?,
              retry_anchor_entry_count = ?
            WHERE tenant_id = ? AND principal_id = ? AND thread_id = ?
              AND attempt_id = ?
          `,
        )
        .run(
          input.mutationId,
          input.anchorEntryId,
          input.anchorEntryCount,
          scope.tenantId,
          scope.principalId,
          threadId,
          input.attemptId,
        );
      if (anchor.changes !== 1) {
        throw new DomainError(
          "conflict",
          "The materialization attempt changed.",
        );
      }
      const phase = this.database
        .prepare(
          `
            UPDATE application_threads
            SET attempt_phase = 'submitting', updated_at = ?,
              revision = revision + 1
            WHERE tenant_id = ? AND owner_principal_id = ? AND id = ?
              AND materialization_attempt_id = ?
              AND backing_state IN (
                'materializing', 'materialization_failed', 'native'
              )
          `,
        )
        .run(
          input.now,
          scope.tenantId,
          scope.principalId,
          threadId,
          input.attemptId,
        );
      if (phase.changes !== 1) {
        throw new DomainError(
          "conflict",
          "The materialization attempt changed.",
        );
      }
      this.#updateFirstSendReceipt(
        scope,
        threadId,
        "submitting",
        { attemptId: input.attemptId, phase: "submitting" },
      );
      this.#bumpGeneration(scope);
      return receipt;
    })();
  }

  completeNativeOperation(
    scope: RequestScope,
    threadId: string,
    input: {
      mutationId: string;
      kind: NativeOperationKind;
      request: unknown;
      now: number;
    },
  ): void {
    const fingerprint = this.#fingerprint([
      input.kind,
      threadId,
      input.request,
    ]);
    this.database.transaction(() => {
      const receipt = this.#getReceipt(scope, input.mutationId);
      if (!receipt) {
        throw new DomainError(
          "conflict",
          "The operation receipt was not prepared.",
        );
      }
      this.#assertReceipt(receipt, input.kind, fingerprint);
      this.database
        .prepare(
          `
            UPDATE mutation_receipts
            SET result_code = 'accepted', result_json = '{}'
            WHERE tenant_id = ? AND principal_id = ? AND mutation_id = ?
          `,
        )
        .run(scope.tenantId, scope.principalId, input.mutationId);
    })();
  }

  cancelNativeOperationBeforeSubmission(
    scope: RequestScope,
    threadId: string,
    input: {
      mutationId: string;
      kind: NativeOperationKind;
      request: unknown;
    },
  ): void {
    const fingerprint = this.#fingerprint([
      input.kind,
      threadId,
      input.request,
    ]);
    this.database.transaction(() => {
      const receipt = this.#getReceipt(scope, input.mutationId);
      if (!receipt) {
        return;
      }
      this.#assertReceipt(receipt, input.kind, fingerprint);
      if (receipt.resultCode !== "submitting") {
        throw new DomainError(
          "conflict",
          "An accepted native operation cannot be cancelled.",
        );
      }
      this.database
        .prepare(
          `
            DELETE FROM mutation_receipts
            WHERE tenant_id = ? AND principal_id = ? AND mutation_id = ?
          `,
        )
        .run(scope.tenantId, scope.principalId, input.mutationId);
    })();
  }

  completeNativeSend(
    scope: RequestScope,
    threadId: string,
    input: {
      mutationId: string;
      delivery: "normal" | "steer" | "followUp";
      expectedDraftRevision: number;
      now: number;
    },
  ): DraftRecord {
    const request = {
      delivery: input.delivery,
      expectedDraftRevision: input.expectedDraftRevision,
    };
    return this.database.transaction(() => {
      this.completeNativeOperation(scope, threadId, {
        mutationId: input.mutationId,
        kind: "native_send",
        request,
        now: input.now,
      });
      this.database
        .prepare(
          `
            UPDATE thread_drafts
            SET text = '', updated_at = ?, revision = revision + 1
            WHERE tenant_id = ? AND principal_id = ? AND thread_id = ?
              AND revision = ?
          `,
        )
        .run(
          input.now,
          scope.tenantId,
          scope.principalId,
          threadId,
          input.expectedDraftRevision,
        );
      this.database
        .prepare(
          `
            UPDATE application_threads
            SET last_activity_at = ?, updated_at = ?, revision = revision + 1
            WHERE tenant_id = ? AND owner_principal_id = ? AND id = ?
          `,
        )
        .run(
          input.now,
          input.now,
          scope.tenantId,
          scope.principalId,
          threadId,
        );
      this.#bumpGeneration(scope);
      return this.getDraft(scope, threadId);
    })();
  }

  completeNativeRename(
    scope: RequestScope,
    threadId: string,
    input: {
      mutationId: string;
      title: string;
      expectedRevision: number;
      now: number;
    },
  ): ThreadWithState {
    const request = {
      title: input.title,
      expectedRevision: input.expectedRevision,
    };
    return this.database.transaction(() => {
      this.completeNativeOperation(scope, threadId, {
        mutationId: input.mutationId,
        kind: "native_rename",
        request,
        now: input.now,
      });
      this.database
        .prepare(
          `
            UPDATE application_threads
            SET title = ?, updated_at = ?, revision = revision + 1
            WHERE tenant_id = ? AND owner_principal_id = ? AND id = ?
          `,
        )
        .run(
          input.title,
          input.now,
          scope.tenantId,
          scope.principalId,
          threadId,
        );
      this.#bumpGeneration(scope);
      return this.getThread(scope, threadId);
    })();
  }

  completeNativeConfiguration(
    scope: RequestScope,
    threadId: string,
    input: {
      mutationId: string;
      request: unknown;
      expectedRevision: number;
      modelProvider: string | null;
      modelId: string | null;
      thinkingLevel: string | null;
      toolMode: "read_only" | "full";
      now: number;
    },
  ): ThreadWithState {
    return this.database.transaction(() => {
      this.completeNativeOperation(scope, threadId, {
        mutationId: input.mutationId,
        kind: "config",
        request: input.request,
        now: input.now,
      });
      return this.updateThreadConfiguration(scope, threadId, {
        expectedRevision: input.expectedRevision,
        modelProvider: input.modelProvider,
        modelId: input.modelId,
        thinkingLevel: input.thinkingLevel,
        toolMode: input.toolMode,
        now: input.now,
      });
    })();
  }

  resolveDefiniteFirstSendFailure(
    scope: RequestScope,
    threadId: string,
    attemptId: string,
    now: number,
  ): ThreadWithState {
    return this.database.transaction(() => {
      const current = this.getThread(scope, threadId);
      const pending = this.getPendingFirstSend(scope, threadId);
      if (
        current.thread.materializationAttemptId !== attemptId ||
        !pending ||
        pending.attemptId !== attemptId
      ) {
        throw new DomainError("conflict", "The materialization attempt changed.");
      }
      this.#updateFirstSendReceipt(
        scope,
        threadId,
        "definite_failure",
        { attemptId },
      );
      if (pending.sourceKind === "automation") {
        this.database
          .prepare(
            `
              DELETE FROM pending_first_sends
              WHERE tenant_id = ? AND principal_id = ? AND thread_id = ?
            `,
          )
          .run(scope.tenantId, scope.principalId, threadId);
        this.database
          .prepare(
            `
              UPDATE application_threads
              SET backing_state = 'draft', reserved_native_session_id = NULL,
                native_session_path = NULL, materialization_attempt_id = NULL,
                attempt_phase = NULL, attempt_diagnostic_code = NULL,
                uncertain_at = NULL, updated_at = ?, revision = revision + 1
              WHERE tenant_id = ? AND owner_principal_id = ? AND id = ?
            `,
          )
          .run(now, scope.tenantId, scope.principalId, threadId);
      } else if (current.draft.text.length > 0) {
        this.database
          .prepare(
            `
              UPDATE application_threads
              SET backing_state = 'materialization_failed',
                attempt_diagnostic_code = 'preflight_rejected_with_newer_draft',
                uncertain_at = NULL, updated_at = ?, revision = revision + 1
              WHERE tenant_id = ? AND owner_principal_id = ? AND id = ?
            `,
          )
          .run(now, scope.tenantId, scope.principalId, threadId);
      } else {
        this.database
          .prepare(
            `
              UPDATE thread_drafts
              SET text = ?, updated_at = ?, revision = revision + 1
              WHERE tenant_id = ? AND principal_id = ? AND thread_id = ?
            `,
          )
          .run(
            pending.text,
            now,
            scope.tenantId,
            scope.principalId,
            threadId,
          );
        this.database
          .prepare(
            `
              DELETE FROM pending_first_sends
              WHERE tenant_id = ? AND principal_id = ? AND thread_id = ?
            `,
          )
          .run(scope.tenantId, scope.principalId, threadId);
        this.database
          .prepare(
            `
              UPDATE application_threads
              SET backing_state = 'draft', reserved_native_session_id = NULL,
                native_session_path = NULL, materialization_attempt_id = NULL,
                attempt_phase = NULL, attempt_diagnostic_code = NULL,
                uncertain_at = NULL, updated_at = ?, revision = revision + 1
              WHERE tenant_id = ? AND owner_principal_id = ? AND id = ?
            `,
          )
          .run(now, scope.tenantId, scope.principalId, threadId);
      }
      this.#bumpGeneration(scope);
      return this.getThread(scope, threadId);
    })();
  }

  resolveMaterializationRecovery(
    scope: RequestScope,
    threadId: string,
    input: {
      action: "restore_to_draft" | "discard";
      expectedDraftRevision?: number;
      mutationId: string;
      now: number;
    },
  ): ThreadWithState {
    const fingerprint = this.#fingerprint([
      "materialization_recovery",
      threadId,
      input.action,
      input.expectedDraftRevision ?? null,
    ]);
    return this.database.transaction(() => {
      const receipt = this.#getReceipt(scope, input.mutationId);
      if (receipt) {
        this.#assertReceipt(
          receipt,
          "materialization_recovery",
          fingerprint,
        );
        return this.getThread(scope, threadId);
      }
      const current = this.getThread(scope, threadId);
      const pending = this.getPendingFirstSend(scope, threadId);
      if (!pending || !current.thread.materializationAttemptId) {
        throw new DomainError(
          "materialization_unresolved",
          "No recoverable first send exists.",
        );
      }
      if (
        input.action === "restore_to_draft" &&
        current.draft.revision !== input.expectedDraftRevision
      ) {
        throw new DomainError(
          "draft_revision_conflict",
          "The draft changed in another client.",
        );
      }
      if (
        input.action === "restore_to_draft" &&
        pending.sourceKind === "automation"
      ) {
        throw new DomainError(
          "invalid_transition",
          "An automation prompt cannot be restored into the composer.",
        );
      }
      this.#updateFirstSendReceipt(
        scope,
        threadId,
        input.action === "restore_to_draft"
          ? "restored_to_draft"
          : "discarded",
        { attemptId: pending.attemptId },
      );
      if (input.action === "restore_to_draft") {
        const merged =
          current.draft.text.length === 0
            ? pending.text
            : `${current.draft.text}\n\n${pending.text}`;
        this.database
          .prepare(
            `
              UPDATE thread_drafts
              SET text = ?, updated_at = ?, revision = revision + 1
              WHERE tenant_id = ? AND principal_id = ? AND thread_id = ?
            `,
          )
          .run(
            merged,
            input.now,
            scope.tenantId,
            scope.principalId,
            threadId,
          );
      }
      this.database
        .prepare(
          `
            DELETE FROM pending_first_sends
            WHERE tenant_id = ? AND principal_id = ? AND thread_id = ?
          `,
        )
        .run(scope.tenantId, scope.principalId, threadId);
      if (current.thread.nativeSessionPath) {
        this.database
          .prepare(
            `
              UPDATE application_threads
              SET materialization_attempt_id = NULL, attempt_phase = NULL,
                attempt_diagnostic_code = NULL, uncertain_at = NULL,
                updated_at = ?, revision = revision + 1
              WHERE tenant_id = ? AND owner_principal_id = ? AND id = ?
            `,
          )
          .run(input.now, scope.tenantId, scope.principalId, threadId);
      } else {
        this.database
          .prepare(
            `
              UPDATE application_threads
              SET backing_state = 'draft', reserved_native_session_id = NULL,
                native_session_path = NULL, materialization_attempt_id = NULL,
                attempt_phase = NULL, attempt_diagnostic_code = NULL,
                uncertain_at = NULL, updated_at = ?, revision = revision + 1
              WHERE tenant_id = ? AND owner_principal_id = ? AND id = ?
            `,
          )
          .run(input.now, scope.tenantId, scope.principalId, threadId);
      }
      this.#insertReceipt(
        scope,
        threadId,
        input.mutationId,
        "materialization_recovery",
        fingerprint,
        "resolved",
        { action: input.action },
        input.now,
      );
      this.#bumpGeneration(scope);
      return this.getThread(scope, threadId);
    })();
  }

  replayMaterializationRecovery(
    scope: RequestScope,
    threadId: string,
    input: {
      action: "restore_to_draft" | "discard";
      expectedDraftRevision?: number;
      mutationId: string;
    },
  ): ThreadWithState | null {
    const fingerprint = this.#fingerprint([
      "materialization_recovery",
      threadId,
      input.action,
      input.expectedDraftRevision ?? null,
    ]);
    const receipt = this.#getReceipt(scope, input.mutationId);
    if (!receipt) {
      return null;
    }
    this.#assertReceipt(receipt, "materialization_recovery", fingerprint);
    return this.getThread(scope, threadId);
  }

  #getInventory(
    scope: RequestScope,
    threadId: string,
  ): ThreadPrincipalStateRecord {
    const row = this.database
      .prepare(
        `
          SELECT ${inventoryColumns}
          FROM thread_principal_state s
          WHERE s.tenant_id = ? AND s.principal_id = ? AND s.thread_id = ?
        `,
      )
      .get(scope.tenantId, scope.principalId, threadId) as
      | ThreadPrincipalStateRecord
      | undefined;
    if (!row) {
      throw new DomainError("not_found", "The thread was not found.");
    }
    return row;
  }

  #findThreadByNativeId(
    scope: RequestScope,
    environmentId: string,
    nativeSessionId: string,
  ): ApplicationThreadRecord | undefined {
    return this.database
      .prepare(
        `
          SELECT ${threadColumns}
          FROM application_threads t
          WHERE t.tenant_id = ? AND t.owner_principal_id = ?
            AND t.environment_id = ? AND t.reserved_native_session_id = ?
        `,
      )
      .get(
        scope.tenantId,
        scope.principalId,
        environmentId,
        nativeSessionId,
      ) as ApplicationThreadRecord | undefined;
  }

  #findThreadByNativePath(
    scope: RequestScope,
    environmentId: string,
    canonicalSessionPath: string,
  ): ApplicationThreadRecord | undefined {
    return this.database
      .prepare(
        `
          SELECT ${threadColumns}
          FROM application_threads t
          WHERE t.tenant_id = ? AND t.owner_principal_id = ?
            AND t.environment_id = ? AND t.native_session_path = ?
        `,
      )
      .get(
        scope.tenantId,
        scope.principalId,
        environmentId,
        canonicalSessionPath,
      ) as ApplicationThreadRecord | undefined;
  }

  #quarantineThreads(
    scope: RequestScope,
    threadIds: readonly string[],
    now: number,
  ): void {
    let changed = false;
    for (const threadId of new Set(threadIds)) {
      const result = this.database
        .prepare(
          `
            UPDATE application_threads
            SET availability = 'quarantined', reconciliation_at = ?,
              updated_at = ?, revision = revision + 1
            WHERE tenant_id = ? AND owner_principal_id = ? AND id = ?
              AND availability <> 'quarantined'
          `,
        )
        .run(
          now,
          now,
          scope.tenantId,
          scope.principalId,
          threadId,
        );
      changed ||= result.changes === 1;
    }
    if (changed) {
      this.#bumpGeneration(scope);
    }
  }

  #getStash(
    scope: RequestScope,
    threadId: string,
    stashId: string,
  ): StashRecord {
    const row = this.database
      .prepare(
        `
          SELECT
            tenant_id AS tenantId,
            principal_id AS principalId,
            thread_id AS threadId,
            id,
            text,
            created_at AS createdAt
          FROM prompt_stashes
          WHERE tenant_id = ? AND principal_id = ? AND thread_id = ? AND id = ?
        `,
      )
      .get(scope.tenantId, scope.principalId, threadId, stashId) as
      | StashRecord
      | undefined;
    if (!row) {
      throw new DomainError("not_found", "The stashed prompt was not found.");
    }
    return row;
  }

  #throwDraftConflictOrNotFound(scope: RequestScope, threadId: string): never {
    const exists = this.database
      .prepare(
        `
          SELECT 1 FROM thread_drafts
          WHERE tenant_id = ? AND principal_id = ? AND thread_id = ?
        `,
      )
      .get(scope.tenantId, scope.principalId, threadId);
    if (!exists) {
      throw new DomainError("not_found", "The draft was not found.");
    }
    throw new DomainError(
      "draft_revision_conflict",
      "The draft changed in another client.",
    );
  }

  #nextInventoryState(
    current: ThreadPrincipalStateRecord,
    change: ThreadInventoryChange,
    now: number,
  ): ThreadPrincipalStateRecord {
    const nextRevision = current.inventoryRevision + 1;
    switch (change.action) {
      case "settle":
        if (current.inventoryState === "settled") return current;
        if (
          current.inventoryState !== "active" &&
          current.inventoryState !== "snoozed"
        ) {
          throw new DomainError(
            "invalid_transition",
            "Only an Active or Snoozed thread can be settled.",
          );
        }
        return {
          ...current,
          inventoryState: "settled",
          stateChangedAt: now,
          snoozedAt: null,
          snoozedUntil: null,
          wokeAt: null,
          wakeReason: null,
          wakeAcknowledgedAt: null,
          wakeReminderText: null,
          inventoryRevision: nextRevision,
        };
      case "unsettle":
        if (current.inventoryState === "active") return current;
        if (current.inventoryState !== "settled") {
          throw new DomainError(
            "invalid_transition",
            "Only a Settled thread can be unsettled.",
          );
        }
        return {
          ...current,
          inventoryState: "active",
          stateChangedAt: now,
          inventoryRevision: nextRevision,
        };
      case "snooze":
        if (
          current.inventoryState !== "active" &&
          current.inventoryState !== "snoozed"
        ) {
          throw new DomainError(
            "invalid_transition",
            "Only an Active thread can be snoozed.",
          );
        }
        if (change.snoozedUntil <= now) {
          throw new DomainError(
            "invalid_transition",
            "The snooze deadline must be in the future.",
          );
        }
        if (
          current.inventoryState === "snoozed" &&
          current.snoozedUntil === change.snoozedUntil &&
          current.wakeReminderText === (change.wakeReminderText ?? null)
        ) {
          return current;
        }
        return {
          ...current,
          inventoryState: "snoozed",
          stateChangedAt: now,
          snoozedAt: now,
          snoozedUntil: change.snoozedUntil,
          wokeAt: null,
          wakeReason: null,
          wakeAcknowledgedAt: null,
          wakeReminderText: change.wakeReminderText ?? null,
          inventoryRevision: nextRevision,
        };
      case "wake":
        if (current.inventoryState === "active") return current;
        if (current.inventoryState !== "snoozed") {
          throw new DomainError(
            "invalid_transition",
            "Only a Snoozed thread can be woken.",
          );
        }
        return {
          ...current,
          inventoryState: "active",
          stateChangedAt: now,
          snoozedAt: null,
          snoozedUntil: null,
          wokeAt: now,
          wakeReason: "manual",
          wakeAcknowledgedAt: null,
          inventoryRevision: nextRevision,
        };
      case "archive":
        if (current.inventoryState === "archived") return current;
        if (
          current.inventoryState !== "active" &&
          current.inventoryState !== "snoozed" &&
          current.inventoryState !== "settled"
        ) {
          throw new DomainError(
            "invalid_transition",
            "Only an Active, Snoozed, or Settled thread can be archived.",
          );
        }
        return {
          ...current,
          inventoryState: "archived",
          stateChangedAt: now,
          snoozedAt: null,
          snoozedUntil: null,
          wokeAt: null,
          wakeReason: null,
          wakeAcknowledgedAt: null,
          wakeReminderText: null,
          inventoryRevision: nextRevision,
        };
      case "restore":
        if (current.inventoryState === "active") return current;
        if (current.inventoryState !== "archived") {
          throw new DomainError(
            "invalid_transition",
            "Only an Archived thread can be restored.",
          );
        }
        return {
          ...current,
          inventoryState: "active",
          stateChangedAt: now,
          inventoryRevision: nextRevision,
        };
    }
  }

  #sameInventory(
    left: ThreadPrincipalStateRecord,
    right: ThreadPrincipalStateRecord,
  ): boolean {
    return (
      left.inventoryState === right.inventoryState &&
      left.stateChangedAt === right.stateChangedAt &&
      left.snoozedAt === right.snoozedAt &&
      left.snoozedUntil === right.snoozedUntil &&
      left.wokeAt === right.wokeAt &&
      left.wakeReason === right.wakeReason &&
      left.wakeAcknowledgedAt === right.wakeAcknowledgedAt &&
      left.wakeReminderText === right.wakeReminderText &&
      left.latestAgentCompletionId === right.latestAgentCompletionId &&
      left.latestAgentCompletionAt === right.latestAgentCompletionAt &&
      left.seenAgentCompletionId === right.seenAgentCompletionId &&
      left.automationContextRunId === right.automationContextRunId &&
      left.automationContextSourceThreadId ===
        right.automationContextSourceThreadId &&
      left.automationContextAt === right.automationContextAt &&
      left.automationContextOutcome === right.automationContextOutcome &&
      left.automationContextDiagnostic === right.automationContextDiagnostic &&
      left.inventoryRevision === right.inventoryRevision
    );
  }

  #writeInventory(state: ThreadPrincipalStateRecord): void {
    this.database
      .prepare(
        `
          UPDATE thread_principal_state
          SET inventory_state = ?,
            state_changed_at = ?,
            snoozed_at = ?,
            snoozed_until = ?,
            woke_at = ?,
            wake_reason = ?,
            wake_acknowledged_at = ?,
            wake_reminder_text = ?,
            latest_agent_completion_id = ?,
            latest_agent_completion_at = ?,
            seen_agent_completion_id = ?,
            automation_context_run_id = ?,
            automation_context_source_thread_id = ?,
            automation_context_at = ?,
            automation_context_outcome = ?,
            automation_context_diagnostic = ?,
            inventory_revision = ?
          WHERE tenant_id = ? AND principal_id = ? AND thread_id = ?
        `,
      )
      .run(
        state.inventoryState,
        state.stateChangedAt,
        state.snoozedAt,
        state.snoozedUntil,
        state.wokeAt,
        state.wakeReason,
        state.wakeAcknowledgedAt,
        state.wakeReminderText,
        state.latestAgentCompletionId,
        state.latestAgentCompletionAt,
        state.seenAgentCompletionId,
        state.automationContextRunId,
        state.automationContextSourceThreadId,
        state.automationContextAt,
        state.automationContextOutcome,
        state.automationContextDiagnostic,
        state.inventoryRevision,
        state.tenantId,
        state.principalId,
        state.threadId,
      );
  }

  #getReceipt(scope: RequestScope, mutationId: string): ReceiptRow | undefined {
    return this.database
      .prepare(
        `
          SELECT
            mutation_kind AS mutationKind,
            request_fingerprint AS requestFingerprint,
            result_code AS resultCode,
            result_json AS resultJson
          FROM mutation_receipts
          WHERE tenant_id = ? AND principal_id = ? AND mutation_id = ?
        `,
      )
      .get(scope.tenantId, scope.principalId, mutationId) as
      | ReceiptRow
      | undefined;
  }

  #updateFirstSendReceipt(
    scope: RequestScope,
    threadId: string,
    resultCode: string,
    result: unknown,
  ): void {
    this.database
      .prepare(
        `
          UPDATE mutation_receipts
          SET result_code = ?, result_json = ?
          WHERE tenant_id = ? AND principal_id = ? AND thread_id = ?
            AND mutation_kind IN ('first_send', 'automation_first_send')
            AND mutation_id = (
              SELECT mutation_id
              FROM pending_first_sends
              WHERE tenant_id = ? AND principal_id = ? AND thread_id = ?
            )
        `,
      )
      .run(
        resultCode,
        JSON.stringify(result),
        scope.tenantId,
        scope.principalId,
        threadId,
        scope.tenantId,
        scope.principalId,
        threadId,
      );
  }

  #assertReceipt(
    receipt: ReceiptRow,
    kind: string,
    fingerprint: string,
  ): void {
    if (
      receipt.mutationKind !== kind ||
      receipt.requestFingerprint !== fingerprint
    ) {
      throw new DomainError(
        "conflict",
        "The mutation ID was already used for a different request.",
      );
    }
  }

  #insertReceipt(
    scope: RequestScope,
    threadId: string,
    mutationId: string,
    kind: string,
    fingerprint: string,
    resultCode: string,
    result: unknown,
    now: number,
  ): void {
    this.database
      .prepare(
        `
          INSERT INTO mutation_receipts(
            tenant_id, principal_id, thread_id, mutation_id, mutation_kind,
            request_fingerprint, result_code, result_json, created_at
          )
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `,
      )
      .run(
        scope.tenantId,
        scope.principalId,
        threadId,
        mutationId,
        kind,
        fingerprint,
        resultCode,
        JSON.stringify(result),
        now,
      );
  }

  #fingerprint(value: unknown): string {
    return createHash("sha256").update(JSON.stringify(value)).digest("hex");
  }

  #bumpGeneration(scope: RequestScope): void {
    const result = this.database
      .prepare(
        `
          UPDATE principal_generations
          SET inventory_generation = inventory_generation + 1
          WHERE tenant_id = ? AND principal_id = ?
        `,
      )
      .run(scope.tenantId, scope.principalId);
    if (result.changes !== 1) {
      throw new DomainError("not_found", "The request scope was not found.");
    }
  }

  #escapeLike(value: string): string {
    return value.replaceAll("\\", "\\\\").replaceAll("%", "\\%").replaceAll("_", "\\_");
  }

  #threadFromJoined(row: ListThreadRow): ApplicationThreadRecord {
    return {
      tenantId: row.tenantId,
      id: row.id,
      ownerPrincipalId: row.ownerPrincipalId,
      environmentId: row.environmentId,
      workspaceId: row.workspaceId,
      backingState: row.backingState,
      reservedNativeSessionId: row.reservedNativeSessionId,
      nativeSessionPath: row.nativeSessionPath,
      title: row.title,
      toolMode: row.toolMode,
      availability: row.availability,
      reconciliationAt: row.reconciliationAt,
      lastActivityAt: row.lastActivityAt,
      materializationAttemptId: row.materializationAttemptId,
      attemptPhase: row.attemptPhase,
      attemptDiagnosticCode: row.attemptDiagnosticCode,
      uncertainAt: row.uncertainAt,
      revision: row.revision,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }

  #inventoryFromJoined(row: ListThreadRow): ThreadPrincipalStateRecord {
    return {
      tenantId: row.tenantId,
      principalId: row.principalId,
      threadId: row.threadId,
      inventoryState: row.inventoryState,
      stateChangedAt: row.stateChangedAt,
      snoozedAt: row.snoozedAt,
      snoozedUntil: row.snoozedUntil,
      wokeAt: row.wokeAt,
      wakeReason: row.wakeReason as WakeReason | null,
      wakeAcknowledgedAt: row.wakeAcknowledgedAt,
      wakeReminderText: row.wakeReminderText,
      latestAgentCompletionId: row.latestAgentCompletionId,
      latestAgentCompletionAt: row.latestAgentCompletionAt,
      seenAgentCompletionId: row.seenAgentCompletionId,
      automationContextRunId: row.automationContextRunId,
      automationContextSourceThreadId: row.automationContextSourceThreadId,
      automationContextAt: row.automationContextAt,
      automationContextOutcome: row.automationContextOutcome,
      automationContextDiagnostic: row.automationContextDiagnostic,
      inventoryRevision: row.inventoryRevision,
    };
  }
}
