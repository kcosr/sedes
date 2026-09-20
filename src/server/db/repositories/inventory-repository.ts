import { createHash, randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import type { ProjectSummary } from "../../../shared/protocol/projects.js";
import { DomainError } from "../../domain/errors.js";
import type { RequestScope } from "../../identity/identity-provider.js";
import type { ContextExcerpt } from "../../../shared/protocol/context-excerpts.js";
import type { ComposerAttachmentDescriptor } from "../../../shared/protocol/composer-attachments.js";
import {
  MAXIMUM_BULK_INVENTORY_TARGETS,
  type BulkInventoryAction,
  type BulkInventoryTarget,
} from "../../../shared/protocol/api.js";
import {
  parseStoredContextExcerpts,
  serializeContextExcerpts,
} from "../context-excerpts-json.js";
import { ComposerAttachmentRepository } from "./composer-attachment-repository.js";
import type { ComposerTaskReference } from "../../../shared/protocol/tasks.js";
import {
  parseStoredTaskReferences,
  resolveDraftTaskReferences,
  serializeTaskReferences,
} from "../composer-tasks-json.js";

export type InventoryState = "active" | "snoozed" | "settled" | "archived";
export type InventoryWakeReason =
  "manual" | "deadline" | "completion" | "failure" | "needs-input" | "activity";

export type InventoryEnvironmentRecord = {
  readonly tenantId: string;
  readonly ownerPrincipalId: string;
  readonly id: string;
  readonly kind: "local" | "ssh" | "outbound";
  readonly label: string;
  readonly availability: "available" | "unavailable";
  readonly diagnosticCode: string | null;
  readonly revision: number;
  readonly configurationRevision: number;
  readonly configurationFingerprint: string;
  readonly operationsConfigurationRevision: number;
  readonly operationsConfigurationFingerprint: string;
};

export type InventoryWorkspaceRecord = {
  readonly tenantId: string;
  readonly ownerPrincipalId: string;
  readonly environmentId: string;
  readonly id: string;
  readonly canonicalPath: string;
  readonly displayName: string;
  readonly availability: "available" | "unavailable";
  readonly trustState: "trusted" | "untrusted";
  readonly revision: number;
  readonly environmentConfigurationRevision: number;
  readonly lastOpenedAt: number;
  readonly createdAt: number;
  readonly updatedAt: number;
};

export type InventoryThreadRecord = {
  readonly tenantId: string;
  readonly ownerPrincipalId: string;
  readonly id: string;
  readonly environmentId: string;
  readonly workspaceId: string;
  readonly backendInstanceId: string;
  readonly connectionProfileId: string;
  readonly backingState: "unbound" | "creating" | "bound" | "creation_unknown";
  readonly title: string;
  readonly availability:
    "available" | "missing" | "quarantined" | "environment_unavailable";
  readonly reconciliationAt: number | null;
  readonly lastActivityAt: number;
  readonly revision: number;
  readonly createdAt: number;
  readonly updatedAt: number;
};

export type InventoryPrincipalStateRecord = {
  readonly tenantId: string;
  readonly principalId: string;
  readonly threadId: string;
  readonly inventoryState: InventoryState;
  readonly stateChangedAt: number;
  readonly snoozedAt: number | null;
  readonly snoozedUntil: number | null;
  readonly wokeAt: number | null;
  readonly wakeReason: InventoryWakeReason | null;
  readonly wakeAcknowledgedAt: number | null;
  readonly inventoryRevision: number;
  readonly pinned: 0 | 1;
  readonly pinRevision: number;
  readonly bookmarkRevision: number;
  readonly preferredWorktreeRootId: string | null;
  readonly preferredWorktreeRevision: number;
  readonly wakeReminderText: string | null;
  readonly automationContextRunId: string | null;
  readonly automationContextSourceThreadId: string | null;
  readonly automationContextAt: number | null;
  readonly automationContextOutcome: "triggered" | "failed" | null;
  readonly automationContextDiagnostic: string | null;
};

export type InventoryDraftRecord = {
  readonly tenantId: string;
  readonly principalId: string;
  readonly threadId: string;
  readonly text: string;
  readonly selectedSkillId: string | null;
  readonly contextExcerpts: ContextExcerpt[];
  readonly attachments: ComposerAttachmentDescriptor[];
  readonly taskReferences: ComposerTaskReference[];
  readonly updatedAt: number;
  readonly revision: number;
};

export type InventoryStashRecord = {
  readonly tenantId: string;
  readonly principalId: string;
  readonly threadId: string;
  readonly id: string;
  readonly text: string;
  readonly selectedSkillId: string | null;
  readonly contextExcerpts: ContextExcerpt[];
  readonly attachments: ComposerAttachmentDescriptor[];
  readonly taskReferences: ComposerTaskReference[];
  readonly createdAt: number;
};

export type InventoryThreadAggregate = {
  readonly thread: InventoryThreadRecord;
  readonly inventory: InventoryPrincipalStateRecord;
  readonly draft: InventoryDraftRecord;
};

export type InventoryTransition =
  | { readonly action: "settle" }
  | { readonly action: "unsettle" }
  | {
      readonly action: "snooze";
      readonly snoozedUntil: number;
      readonly wakeReminderText?: string | null;
    }
  | {
      readonly action: "remind";
      readonly wakeReminderText: string;
    }
  | { readonly action: "wake" }
  | { readonly action: "archive" }
  | { readonly action: "restore" };

const environmentColumns = `
  tenant_id AS tenantId,
  owner_principal_id AS ownerPrincipalId,
  id, kind, label, availability,
  diagnostic_code AS diagnosticCode,
  revision,
  configuration_revision AS configurationRevision,
  configuration_fingerprint AS configurationFingerprint,
  operations_configuration_revision AS operationsConfigurationRevision,
  operations_configuration_fingerprint AS operationsConfigurationFingerprint
`;
const workspaceColumns = `
  tenant_id AS tenantId,
  owner_principal_id AS ownerPrincipalId,
  environment_id AS environmentId,
  id, canonical_path AS canonicalPath,
  display_name AS displayName,
  availability, trust_state AS trustState, revision,
  environment_configuration_revision AS environmentConfigurationRevision,
  last_opened_at AS lastOpenedAt,
  created_at AS createdAt, updated_at AS updatedAt
`;
const threadColumns = `
  tenant_id AS tenantId,
  owner_principal_id AS ownerPrincipalId,
  id, environment_id AS environmentId,
  workspace_id AS workspaceId,
  backend_instance_id AS backendInstanceId,
  connection_profile_id AS connectionProfileId,
  backing_state AS backingState, title, availability,
  reconciliation_at AS reconciliationAt,
  last_activity_at AS lastActivityAt,
  revision, created_at AS createdAt, updated_at AS updatedAt
`;
const inventoryColumns = `
  tenant_id AS tenantId, principal_id AS principalId,
  thread_id AS threadId, inventory_state AS inventoryState,
  state_changed_at AS stateChangedAt,
  snoozed_at AS snoozedAt, snoozed_until AS snoozedUntil,
  woke_at AS wokeAt, wake_reason AS wakeReason,
  wake_acknowledged_at AS wakeAcknowledgedAt,
  inventory_revision AS inventoryRevision,
  pinned, pin_revision AS pinRevision,
  bookmark_revision AS bookmarkRevision,
  preferred_worktree_root_id AS preferredWorktreeRootId,
  preferred_worktree_revision AS preferredWorktreeRevision,
  wake_reminder_text AS wakeReminderText,
  automation_context_run_id AS automationContextRunId,
  automation_context_source_thread_id AS automationContextSourceThreadId,
  automation_context_at AS automationContextAt,
  automation_context_outcome AS automationContextOutcome,
  automation_context_diagnostic AS automationContextDiagnostic
`;
const draftColumns = `
  tenant_id AS tenantId, principal_id AS principalId,
  thread_id AS threadId, text, selected_skill_id AS selectedSkillId,
  context_excerpts_json AS contextExcerptsJson,
  task_references_json AS taskReferencesJson,
  updated_at AS updatedAt, revision
`;
const stashColumns = `
  tenant_id AS tenantId, principal_id AS principalId,
  thread_id AS threadId, id, text, selected_skill_id AS selectedSkillId,
  context_excerpts_json AS contextExcerptsJson,
  task_references_json AS taskReferencesJson,
  created_at AS createdAt
`;

type InventoryDraftRow = Omit<
  InventoryDraftRecord,
  "contextExcerpts" | "attachments" | "taskReferences"
> & {
  readonly contextExcerptsJson: string;
  readonly taskReferencesJson: string;
};
type InventoryStashRow = Omit<
  InventoryStashRecord,
  "contextExcerpts" | "attachments" | "taskReferences"
> & {
  readonly contextExcerptsJson: string;
  readonly taskReferencesJson: string;
};

function hydrateDraft(
  row: InventoryDraftRow,
  attachments: ComposerAttachmentDescriptor[],
): InventoryDraftRecord {
  return {
    ...row,
    contextExcerpts: parseStoredContextExcerpts(row.contextExcerptsJson),
    taskReferences: parseStoredTaskReferences(row.taskReferencesJson),
    attachments,
  };
}

function hydrateStash(
  row: InventoryStashRow,
  attachments: ComposerAttachmentDescriptor[],
): InventoryStashRecord {
  return {
    ...row,
    contextExcerpts: parseStoredContextExcerpts(row.contextExcerptsJson),
    taskReferences: parseStoredTaskReferences(row.taskReferencesJson),
    attachments,
  };
}

type MutationReceipt = {
  readonly threadId: string;
  readonly operationKind: string;
  readonly requestFingerprint: string;
  readonly resultJson: string;
};

type ArchiveThreadsReceiptResult = {
  readonly version: 1 | 2;
  readonly threadIds: readonly string[];
  /**
   * Task ids moved up-scope by the archive's open-task disposition. Version-1
   * receipts predate schema 24 and moved nothing; they parse to an empty
   * list.
   */
  readonly movedTaskIds: readonly string[];
};

type BulkInventoryReceiptResult = {
  readonly version: 1;
  readonly targetThreadIds: readonly string[];
  readonly changedThreadIds: readonly string[];
  readonly movedTaskIds: readonly string[];
};

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function parseArchiveThreadsReceiptResult(
  value: string,
  rootThreadId: string,
): ArchiveThreadsReceiptResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error("archive_threads_receipt_invalid");
  }
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    Array.isArray(parsed) ||
    !("version" in parsed) ||
    (parsed.version !== 1 && parsed.version !== 2) ||
    Object.keys(parsed).length !== (parsed.version === 1 ? 2 : 3) ||
    !("threadIds" in parsed) ||
    !Array.isArray(parsed.threadIds) ||
    parsed.threadIds.length < 1 ||
    parsed.threadIds.length > 10_000 ||
    parsed.threadIds[0] !== rootThreadId ||
    parsed.threadIds.some(
      (threadId) =>
        typeof threadId !== "string" || !UUID_PATTERN.test(threadId),
    ) ||
    new Set(parsed.threadIds).size !== parsed.threadIds.length
  ) {
    throw new Error("archive_threads_receipt_invalid");
  }
  let movedTaskIds: readonly string[] = [];
  if (parsed.version === 2) {
    const moved = (parsed as { movedTaskIds?: unknown }).movedTaskIds;
    if (
      !Array.isArray(moved) ||
      moved.length > 10_000 ||
      moved.some(
        (taskId) => typeof taskId !== "string" || !UUID_PATTERN.test(taskId),
      ) ||
      new Set(moved).size !== moved.length
    ) {
      throw new Error("archive_threads_receipt_invalid");
    }
    movedTaskIds = moved as readonly string[];
  }
  return {
    version: parsed.version,
    threadIds: parsed.threadIds as readonly string[],
    movedTaskIds,
  };
}

function parseBulkInventoryReceiptResult(
  value: string,
  anchorThreadId: string,
): BulkInventoryReceiptResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error("bulk_inventory_receipt_invalid");
  }
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    Array.isArray(parsed) ||
    !("version" in parsed) ||
    parsed.version !== 1 ||
    Object.keys(parsed).length !== 4 ||
    !("targetThreadIds" in parsed) ||
    !("changedThreadIds" in parsed) ||
    !("movedTaskIds" in parsed) ||
    !Array.isArray(parsed.targetThreadIds) ||
    parsed.targetThreadIds.length < 2 ||
    parsed.targetThreadIds.length > MAXIMUM_BULK_INVENTORY_TARGETS ||
    !(parsed.targetThreadIds as unknown[]).includes(anchorThreadId) ||
    parsed.targetThreadIds.some(
      (threadId) =>
        typeof threadId !== "string" || !UUID_PATTERN.test(threadId),
    ) ||
    new Set(parsed.targetThreadIds).size !== parsed.targetThreadIds.length ||
    !Array.isArray(parsed.changedThreadIds) ||
    parsed.changedThreadIds.some(
      (threadId) =>
        typeof threadId !== "string" ||
        !(parsed.targetThreadIds as unknown[]).includes(threadId),
    ) ||
    new Set(parsed.changedThreadIds).size !== parsed.changedThreadIds.length ||
    !Array.isArray(parsed.movedTaskIds) ||
    parsed.movedTaskIds.length > 10_000 ||
    parsed.movedTaskIds.some(
      (taskId) => typeof taskId !== "string" || !UUID_PATTERN.test(taskId),
    ) ||
    new Set(parsed.movedTaskIds).size !== parsed.movedTaskIds.length
  ) {
    throw new Error("bulk_inventory_receipt_invalid");
  }
  return parsed as BulkInventoryReceiptResult;
}

function fingerprint(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

/** Non-default archive side effects participate in mutation replay identity. */
function archiveThreadsFingerprint(
  threadId: string,
  input: {
    readonly expectedRevision: number;
    readonly includeDescendants: boolean;
    readonly expectedStashedPromptCount?: number;
    readonly openTaskDisposition?:
      "move_to_workspace" | "move_to_global" | "keep";
    readonly executionWorkspaceDisposition?:
      | { readonly kind: "keep" }
      | {
          readonly kind: "delete";
          readonly expectedRevision: number;
          readonly operationId: string;
        };
  },
): string {
  const disposition = input.openTaskDisposition ?? "keep";
  return fingerprint([
    "archive_threads",
    threadId,
    input.expectedRevision,
    input.includeDescendants,
    ...(input.expectedStashedPromptCount === undefined
      ? []
      : [input.expectedStashedPromptCount]),
    ...(disposition === "keep" ? [] : [disposition]),
    ...(input.executionWorkspaceDisposition?.kind === "delete"
      ? [input.executionWorkspaceDisposition]
      : []),
  ]);
}

function bulkInventoryFingerprint(input: {
  readonly action: BulkInventoryAction;
  readonly targets: readonly BulkInventoryTarget[];
  readonly expectedStashedPromptCount?: number;
  readonly expectedOpenTaskCount?: number;
  readonly openTaskDisposition?:
    "move_to_workspace" | "move_to_global" | "keep";
}): string {
  const disposition = input.openTaskDisposition ?? "keep";
  const canonicalTargets = input.targets
    .map(
      ({ threadId, expectedRevision }) => [threadId, expectedRevision] as const,
    )
    .toSorted(([left], [right]) => left.localeCompare(right));
  return fingerprint([
    "bulk_inventory_transition",
    input.action,
    canonicalTargets,
    ...(input.expectedStashedPromptCount === undefined
      ? []
      : [input.expectedStashedPromptCount]),
    ...(input.expectedOpenTaskCount === undefined
      ? []
      : [input.expectedOpenTaskCount]),
    disposition,
  ]);
}

export class InventoryRepository {
  readonly #attachments: ComposerAttachmentRepository;

  constructor(readonly database: Database.Database) {
    this.#attachments = new ComposerAttachmentRepository(database);
  }

  countThreadsByInventoryState(
    scope: RequestScope,
  ): Readonly<Record<InventoryState, number>> {
    const rows = this.database
      .prepare(
        `
          SELECT inventory_state AS state, count(*) AS count
          FROM thread_principal_state
          WHERE tenant_id = ? AND principal_id = ?
            AND EXISTS (SELECT 1 FROM application_threads AS thread JOIN workspaces AS workspace
              ON workspace.tenant_id = thread.tenant_id AND workspace.owner_principal_id = thread.owner_principal_id
              AND workspace.id = thread.workspace_id
              WHERE thread.tenant_id = thread_principal_state.tenant_id
                AND thread.owner_principal_id = thread_principal_state.principal_id
                AND thread.id = thread_principal_state.thread_id AND workspace.removed_at IS NULL)
          GROUP BY inventory_state
        `,
      )
      .all(scope.tenantId, scope.principalId) as Array<{
      state: InventoryState;
      count: number;
    }>;
    const counts: Record<InventoryState, number> = {
      active: 0,
      snoozed: 0,
      settled: 0,
      archived: 0,
    };
    for (const row of rows) counts[row.state] = row.count;
    return counts;
  }

  getEnvironment(
    scope: RequestScope,
    environmentId: string,
  ): InventoryEnvironmentRecord {
    const row = this.database
      .prepare(
        `
          SELECT ${environmentColumns}
          FROM execution_environments
          WHERE tenant_id = ? AND owner_principal_id = ? AND id = ?
        `,
      )
      .get(scope.tenantId, scope.principalId, environmentId) as
      InventoryEnvironmentRecord | undefined;
    if (!row) {
      throw new DomainError(
        "not_found",
        "The execution environment was not found.",
      );
    }
    return row;
  }

  listEnvironments(scope: RequestScope): InventoryEnvironmentRecord[] {
    // Configuration controls admission, while retained workspaces (including
    // unavailable ones) keep their environment labels and history addressable.
    // Availability diagnostics are observations, not configuration membership.
    return this.database
      .prepare(
        `
          WITH configuration AS (
            SELECT configuration_json
            FROM principal_execution_configuration
            WHERE tenant_id = ? AND owner_principal_id = ?
          ), configured_environments AS (
            SELECT json_extract(value, '$.id') AS id
            FROM configuration, json_each(configuration_json, '$.executionEnvironments')
          )
          SELECT ${environmentColumns}
          FROM execution_environments AS environment
          WHERE tenant_id = ? AND owner_principal_id = ?
            AND (
              NOT EXISTS (SELECT 1 FROM configuration)
              OR id IN (SELECT id FROM configured_environments)
              OR EXISTS (
                SELECT 1 FROM workspaces AS workspace
                WHERE workspace.tenant_id = environment.tenant_id
                  AND workspace.owner_principal_id = environment.owner_principal_id
                  AND workspace.environment_id = environment.id
              )
            )
          ORDER BY kind, id
        `,
      )
      .all(scope.tenantId, scope.principalId, scope.tenantId, scope.principalId) as InventoryEnvironmentRecord[];
  }

  getLocalEnvironment(scope: RequestScope): InventoryEnvironmentRecord {
    const rows = this.database
      .prepare(
        `
          SELECT ${environmentColumns}
          FROM execution_environments
          WHERE tenant_id = ? AND owner_principal_id = ? AND kind = 'local'
          ORDER BY id
        `,
      )
      .all(scope.tenantId, scope.principalId) as InventoryEnvironmentRecord[];
    if (rows.length !== 1 || !rows[0]) {
      throw new DomainError(
        "conflict",
        "The principal must have exactly one Local execution environment.",
      );
    }
    return rows[0];
  }

  updateEnvironmentAvailability(
    scope: RequestScope,
    environmentId: string,
    input: {
      readonly available: boolean;
      readonly diagnosticCode?: string;
      readonly now: number;
    },
  ): InventoryEnvironmentRecord {
    const current = this.getEnvironment(scope, environmentId);
    const availability = input.available ? "available" : "unavailable";
    const diagnosticCode = input.available
      ? null
      : (input.diagnosticCode ?? "environment_unavailable");
    if (
      current.availability === availability &&
      current.diagnosticCode === diagnosticCode
    ) {
      return current;
    }
    this.database.transaction(() => {
      this.database
        .prepare(
          `
            UPDATE execution_environments
            SET availability = ?, diagnostic_code = ?, revision = revision + 1,
              updated_at = ?
            WHERE tenant_id = ? AND owner_principal_id = ? AND id = ?
          `,
        )
        .run(
          availability,
          diagnosticCode,
          input.now,
          scope.tenantId,
          scope.principalId,
          environmentId,
        );
      if (input.available) {
        this.database
          .prepare(
            `
              UPDATE application_threads
              SET availability = 'available', revision = revision + 1,
                updated_at = ?
              WHERE tenant_id = ? AND owner_principal_id = ?
                AND environment_id = ?
                AND availability = 'environment_unavailable'
            `,
          )
          .run(input.now, scope.tenantId, scope.principalId, environmentId);
      }
      this.#bumpGeneration(scope);
    })();
    return this.getEnvironment(scope, environmentId);
  }

  upsertWorkspace(
    scope: RequestScope,
    input: {
      readonly id?: string;
      /** Only explicit user open/restore may revive a removed project. */
      readonly restoreRemoved?: true;
      readonly environmentId: string;
      readonly canonicalPath: string;
      readonly displayName: string;
      readonly available: boolean;
      readonly trustState: "trusted" | "untrusted";
      readonly environmentConfigurationRevision: number;
      readonly now: number;
    },
  ): InventoryWorkspaceRecord {
    this.getEnvironment(scope, input.environmentId);
    return this.database.transaction(() => {
      const existing = this.database
        .prepare(
          `
            SELECT ${workspaceColumns}
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
        ) as InventoryWorkspaceRecord | undefined;
      if (!existing) {
        const id = input.id ?? randomUUID();
        this.database
          .prepare(
            `
              INSERT INTO workspaces(
                tenant_id, owner_principal_id, environment_id, id,
                canonical_path, display_name, availability, trust_state,
                revision, environment_configuration_revision,
                last_opened_at, created_at, updated_at
              )
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?)
            `,
          )
          .run(
            scope.tenantId,
            scope.principalId,
            input.environmentId,
            id,
            input.canonicalPath,
            input.displayName,
            input.available ? "available" : "unavailable",
            input.trustState,
            input.environmentConfigurationRevision,
            input.now,
            input.now,
            input.now,
          );
        this.#bumpGeneration(scope);
        return this.getWorkspace(scope, id);
      }
      const removed = this.isWorkspaceRemoved(scope, existing.id);
      if (removed && !input.restoreRemoved) this.assertWorkspaceActive(scope, existing.id);
      const availability = input.available ? "available" : "unavailable";
      const changed =
        removed ||
        existing.displayName !== input.displayName ||
        existing.availability !== availability ||
        existing.trustState !== input.trustState ||
        existing.environmentConfigurationRevision !==
          input.environmentConfigurationRevision;
      this.database
        .prepare(
          `
            UPDATE workspaces
            SET removed_at = NULL, display_name = ?, availability = ?, trust_state = ?,
              environment_configuration_revision = ?,
              last_opened_at = ?, updated_at = ?,
              revision = revision + ?
            WHERE tenant_id = ? AND owner_principal_id = ? AND id = ?
          `,
        )
        .run(
          input.displayName,
          availability,
          input.trustState,
          input.environmentConfigurationRevision,
          input.now,
          input.now,
          changed ? 1 : 0,
          scope.tenantId,
          scope.principalId,
          existing.id,
        );
      if (changed) this.#bumpGeneration(scope);
      return this.getWorkspace(scope, existing.id);
    })();
  }

  getWorkspace(
    scope: RequestScope,
    workspaceId: string,
  ): InventoryWorkspaceRecord {
    const row = this.database
      .prepare(
        `
          SELECT ${workspaceColumns}
          FROM workspaces
          WHERE tenant_id = ? AND owner_principal_id = ? AND id = ?
        `,
      )
      .get(scope.tenantId, scope.principalId, workspaceId) as
      InventoryWorkspaceRecord | undefined;
    if (!row)
      throw new DomainError("not_found", "The workspace was not found.");
    return row;
  }

  isWorkspaceRemoved(scope: RequestScope, workspaceId: string): boolean {
    const row = this.database.prepare(`SELECT removed_at AS removedAt FROM workspaces
      WHERE tenant_id = ? AND owner_principal_id = ? AND id = ?`)
      .get(scope.tenantId, scope.principalId, workspaceId) as { removedAt: number | null } | undefined;
    if (!row) throw new DomainError("not_found", "The project was not found.");
    return row.removedAt !== null;
  }

  assertWorkspaceActive(scope: RequestScope, workspaceId: string): void {
    if (this.isWorkspaceRemoved(scope, workspaceId)) {
      throw new DomainError("invalid_transition", "This project was removed. Restore it in Settings → Projects before starting new work.");
    }
  }

  listWorkspaces(scope: RequestScope): InventoryWorkspaceRecord[] {
    return this.database.prepare(`SELECT ${workspaceColumns} FROM workspaces
      WHERE tenant_id = ? AND owner_principal_id = ? AND removed_at IS NULL
      ORDER BY last_opened_at DESC, id`)
      .all(scope.tenantId, scope.principalId) as InventoryWorkspaceRecord[];
  }

  listProjects(scope: RequestScope): ProjectSummary[] {
    return (this.database.prepare(`SELECT workspace.id, workspace.environment_id AS environmentId,
      environment.label AS environmentLabel, workspace.display_name AS label,
      workspace.canonical_path AS path, workspace.removed_at IS NOT NULL AS removed,
      workspace.availability = 'available' AND environment.availability = 'available' AS available,
      workspace.revision,
      (SELECT COUNT(*) FROM application_threads AS thread WHERE thread.tenant_id = workspace.tenant_id
        AND thread.owner_principal_id = workspace.owner_principal_id AND thread.workspace_id = workspace.id) AS threadCount
      FROM workspaces AS workspace JOIN execution_environments AS environment
        ON environment.tenant_id = workspace.tenant_id AND environment.owner_principal_id = workspace.owner_principal_id
        AND environment.id = workspace.environment_id
      WHERE workspace.tenant_id = ? AND workspace.owner_principal_id = ?
      ORDER BY workspace.display_name COLLATE NOCASE, workspace.id`)
      .all(scope.tenantId, scope.principalId) as Array<Omit<ProjectSummary, "removed" | "available"> & { removed: number; available: number }> )
      .map(row => ({ ...row, removed: row.removed === 1, available: row.available === 1 }));
  }

  listThreadIdsForWorkspace(scope: RequestScope, workspaceId: string): string[] {
    this.getWorkspace(scope, workspaceId);
    return (this.database.prepare(`SELECT id FROM application_threads
      WHERE tenant_id = ? AND owner_principal_id = ? AND workspace_id = ? ORDER BY id`)
      .all(scope.tenantId, scope.principalId, workspaceId) as Array<{ id: string }>).map(row => row.id);
  }

  assertWorkspaceRemovable(scope: RequestScope, workspaceId: string, input: {
    readonly expectedRevision: number;
    readonly expectedThreadIds: readonly string[];
  }): void {
    const workspace = this.getWorkspace(scope, workspaceId);
    if (this.isWorkspaceRemoved(scope, workspaceId)) return;
    if (workspace.revision !== input.expectedRevision) {
      throw new DomainError("conflict", "The project changed. Refresh and try again.");
    }
    const threadIds = this.listThreadIdsForWorkspace(scope, workspaceId);
    if (JSON.stringify(threadIds) !== JSON.stringify(input.expectedThreadIds)) {
      throw new DomainError("conflict", "The project's threads changed. Refresh and try again.");
    }
    if (this.findArchiveDurablyBlockedThreadIds(scope, threadIds).size > 0) {
      throw new DomainError("invalid_transition", "Resolve running, queued, or uncertain work before removing this project.");
    }
    const enabledSchedule = this.database.prepare(`SELECT 1 FROM automation_definitions AS automation
      JOIN application_threads AS thread ON thread.tenant_id = automation.tenant_id
        AND thread.owner_principal_id = automation.owner_principal_id AND thread.id = automation.anchor_thread_id
      WHERE thread.tenant_id = ? AND thread.owner_principal_id = ? AND thread.workspace_id = ?
        AND automation.enabled = 1 AND automation.deleted_at IS NULL AND automation.completed_at IS NULL LIMIT 1`)
      .get(scope.tenantId, scope.principalId, workspaceId);
    if (enabledSchedule) throw new DomainError("invalid_transition", "Pause scheduled work before removing this project. Restore will leave schedules paused.");
    const liveTerminal = this.database.prepare(`SELECT 1 FROM terminals
      WHERE tenant_id = ? AND owner_principal_id = ? AND workspace_id = ?
        AND lifecycle NOT IN ('exited', 'failed') LIMIT 1`).get(scope.tenantId, scope.principalId, workspaceId);
    if (liveTerminal) throw new DomainError("invalid_transition", "End live or interrupted terminals before removing this project.");
  }

  removeWorkspace(scope: RequestScope, workspaceId: string, input: {
    readonly expectedRevision: number;
    readonly expectedThreadIds: readonly string[];
    readonly now: number;
  }): void {
    this.database.transaction(() => {
      this.assertWorkspaceRemovable(scope, workspaceId, input);
      if (this.isWorkspaceRemoved(scope, workspaceId)) return;
      this.database.prepare(`UPDATE workspaces SET removed_at = ?, revision = revision + 1, updated_at = ?
        WHERE tenant_id = ? AND owner_principal_id = ? AND id = ?`)
        .run(input.now, input.now, scope.tenantId, scope.principalId, workspaceId);
      this.#bumpGeneration(scope);
    })();
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
            WHERE tenant_id = ? AND owner_principal_id = ?
              AND environment_id = ?
            ORDER BY id
          `,
        )
        .all(scope.tenantId, scope.principalId, environmentId) as Array<{
        readonly id: string;
      }>
    ).map(({ id }) => id);
  }

  getThread(scope: RequestScope, threadId: string): InventoryThreadAggregate {
    const thread = this.database
      .prepare(
        `
          SELECT ${threadColumns}
          FROM application_threads
          WHERE tenant_id = ? AND owner_principal_id = ? AND id = ?
        `,
      )
      .get(scope.tenantId, scope.principalId, threadId) as
      InventoryThreadRecord | undefined;
    if (!thread)
      throw new DomainError("not_found", "The thread was not found.");
    return {
      thread,
      inventory: this.getInventory(scope, threadId),
      draft: this.getDraft(scope, threadId),
    };
  }

  getInventory(
    scope: RequestScope,
    threadId: string,
  ): InventoryPrincipalStateRecord {
    const row = this.database
      .prepare(
        `
          SELECT ${inventoryColumns}
          FROM thread_principal_state
          WHERE tenant_id = ? AND principal_id = ? AND thread_id = ?
        `,
      )
      .get(scope.tenantId, scope.principalId, threadId) as
      InventoryPrincipalStateRecord | undefined;
    if (!row) throw new DomainError("not_found", "The thread was not found.");
    return row;
  }

  getDraft(scope: RequestScope, threadId: string): InventoryDraftRecord {
    const row = this.database
      .prepare(
        `
          SELECT ${draftColumns}
          FROM thread_drafts
          WHERE tenant_id = ? AND principal_id = ? AND thread_id = ?
        `,
      )
      .get(scope.tenantId, scope.principalId, threadId) as
      InventoryDraftRow | undefined;
    if (!row)
      throw new DomainError("not_found", "The thread draft was not found.");
    return hydrateDraft(
      row,
      this.#attachments.descriptorsForOwner(scope, {
        kind: "draft",
        threadId,
      }),
    );
  }

  setPreferredWorktree(
    scope: RequestScope,
    threadId: string,
    input: {
      readonly rootId: string | null;
      readonly expectedRevision: number;
      readonly mutationId: string;
      readonly now: number;
    },
  ): {
    readonly preference: {
      readonly rootId: string | null;
      readonly revision: number;
    };
  } {
    const requestFingerprint = fingerprint([
      "set_preferred_worktree",
      threadId,
      input.rootId,
      input.expectedRevision,
    ]);
    return this.database.transaction(() => {
      const receipt = this.#receipt(scope, input.mutationId);
      if (receipt) {
        this.#assertReceipt(
          receipt,
          threadId,
          "set_preferred_worktree",
          requestFingerprint,
        );
        return JSON.parse(receipt.resultJson) as {
          readonly preference: {
            readonly rootId: string | null;
            readonly revision: number;
          };
        };
      }
      const thread = this.getThread(scope, threadId);
      if (
        thread.inventory.preferredWorktreeRevision !== input.expectedRevision
      ) {
        throw new DomainError(
          "conflict",
          "The preferred worktree changed in another client.",
        );
      }
      if (input.rootId !== null) {
        const available = this.database
          .prepare(
            `SELECT 1 FROM workspace_file_linked_worktree_roots
             WHERE tenant_id = ? AND owner_principal_id = ?
               AND workspace_id = ? AND root_id = ?
               AND availability = 'available'`,
          )
          .get(
            scope.tenantId,
            scope.principalId,
            thread.thread.workspaceId,
            input.rootId,
          );
        if (!available) {
          throw new DomainError(
            "not_found",
            "The linked worktree is not available for this thread's workspace.",
          );
        }
      }
      const changedPreference =
        thread.inventory.preferredWorktreeRootId !== input.rootId;
      const nextRevision = input.expectedRevision + (changedPreference ? 1 : 0);
      if (changedPreference) {
        const changed = this.database
          .prepare(
            `UPDATE thread_principal_state
             SET preferred_worktree_root_id = ?, preferred_worktree_revision = ?
             WHERE tenant_id = ? AND principal_id = ? AND thread_id = ?
               AND preferred_worktree_revision = ?`,
          )
          .run(
            input.rootId,
            nextRevision,
            scope.tenantId,
            scope.principalId,
            threadId,
            input.expectedRevision,
          );
        if (changed.changes !== 1) {
          throw new DomainError(
            "conflict",
            "The preferred worktree changed in another client.",
          );
        }
      }
      const result = {
        preference: { rootId: input.rootId, revision: nextRevision },
      };
      this.#insertReceipt(
        scope,
        threadId,
        input.mutationId,
        "set_preferred_worktree",
        requestFingerprint,
        result,
        input.now,
      );
      if (changedPreference) this.#bumpGeneration(scope);
      return result;
    })();
  }

  saveDraft(
    scope: RequestScope,
    threadId: string,
    input: {
      readonly text: string;
      readonly selectedSkillId?: string;
      readonly contextExcerpts: readonly ContextExcerpt[];
      readonly attachmentIds: readonly string[];
      readonly taskReferenceIds: readonly string[];
      readonly expectedRevision: number;
      readonly now: number;
    },
  ): InventoryDraftRecord {
    const changed = this.database.transaction(() => {
      this.getInventory(scope, threadId);
      this.#attachments.replaceOwnerLinks(
        scope,
        { kind: "draft", threadId },
        input.attachmentIds,
      );
      const result = this.database
        .prepare(
          `
            UPDATE thread_drafts
            SET text = ?, selected_skill_id = ?, context_excerpts_json = ?,
              task_references_json = ?,
              updated_at = ?,
              revision = revision + 1
            WHERE tenant_id = ? AND principal_id = ? AND thread_id = ?
              AND revision = ?
          `,
        )
        .run(
          input.text,
          input.selectedSkillId ?? null,
          serializeContextExcerpts(input.contextExcerpts),
          serializeTaskReferences(
            resolveDraftTaskReferences(
              this.database,
              scope,
              this.getDraft(scope, threadId).taskReferences,
              input.taskReferenceIds,
            ),
          ),
          input.now,
          scope.tenantId,
          scope.principalId,
          threadId,
          input.expectedRevision,
        );
      if (result.changes !== 1) {
        throw new DomainError(
          "draft_revision_conflict",
          "The draft changed in another client.",
        );
      }
      this.#bumpGeneration(scope);
      return true;
    })();
    if (!changed) throw new Error("draft_update_failed");
    return this.getDraft(scope, threadId);
  }

  listStashes(scope: RequestScope, threadId: string): InventoryStashRecord[] {
    this.getInventory(scope, threadId);
    const rows = this.database
      .prepare(
        `
          SELECT ${stashColumns}
          FROM prompt_stashes
          WHERE tenant_id = ? AND principal_id = ? AND thread_id = ?
          ORDER BY created_at DESC, id
        `,
      )
      .all(scope.tenantId, scope.principalId, threadId) as InventoryStashRow[];
    return rows.map((row) =>
      hydrateStash(
        row,
        this.#attachments.descriptorsForOwner(scope, {
          kind: "stash",
          threadId,
          stashId: row.id,
        }),
      ),
    );
  }

  stashDraft(
    scope: RequestScope,
    threadId: string,
    input: {
      readonly stashId?: string;
      readonly expectedDraftRevision: number;
      readonly mutationId: string;
      readonly maximumStashes: number;
      readonly now: number;
    },
  ): {
    readonly draft: InventoryDraftRecord;
    readonly stash: InventoryStashRecord;
    readonly replayed: boolean;
  } {
    const requestFingerprint = fingerprint([
      "stash_prompt",
      threadId,
      input.expectedDraftRevision,
    ]);
    return this.database.transaction(() => {
      const receipt = this.#receipt(scope, input.mutationId);
      if (receipt) {
        this.#assertReceipt(
          receipt,
          threadId,
          "stash_prompt",
          requestFingerprint,
        );
        const { stashId } = JSON.parse(receipt.resultJson) as {
          readonly stashId: string;
        };
        const stash = this.listStashes(scope, threadId).find(
          ({ id }) => id === stashId,
        );
        if (!stash)
          throw new DomainError("conflict", "The stashed prompt is missing.");
        return { draft: this.getDraft(scope, threadId), stash, replayed: true };
      }
      const draft = this.getDraft(scope, threadId);
      if (
        draft.revision !== input.expectedDraftRevision ||
        (draft.text.length === 0 &&
          draft.selectedSkillId === null &&
          draft.contextExcerpts.length === 0 &&
          draft.taskReferences.length === 0 &&
          draft.attachments.length === 0)
      ) {
        throw new DomainError(
          "draft_revision_conflict",
          "Only the current non-empty draft can be stashed.",
        );
      }
      if (this.listStashes(scope, threadId).length >= input.maximumStashes) {
        throw new DomainError(
          "invalid_transition",
          "This thread has reached its prompt stash limit.",
        );
      }
      const stashId = input.stashId ?? randomUUID();
      this.#attachments.copyOwnerLinks(
        scope,
        { kind: "draft", threadId },
        { kind: "stash", threadId, stashId },
      );
      this.#attachments.replaceOwnerLinks(
        scope,
        { kind: "draft", threadId },
        [],
      );
      this.database
        .prepare(
          `
            INSERT INTO prompt_stashes(
              tenant_id, principal_id, thread_id, id, text,
              selected_skill_id, context_excerpts_json, task_references_json,
              created_at
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
          `,
        )
        .run(
          scope.tenantId,
          scope.principalId,
          threadId,
          stashId,
          draft.text,
          draft.selectedSkillId,
          serializeContextExcerpts(draft.contextExcerpts),
          serializeTaskReferences(draft.taskReferences),
          input.now,
        );
      const cleared = this.database
        .prepare(
          `
            UPDATE thread_drafts
            SET text = '', selected_skill_id = NULL,
              context_excerpts_json = '[]', task_references_json = '[]',
              updated_at = ?,
              revision = revision + 1
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
      if (cleared.changes !== 1) {
        throw new DomainError(
          "draft_revision_conflict",
          "The draft changed while it was being stashed.",
        );
      }
      this.#insertReceipt(
        scope,
        threadId,
        input.mutationId,
        "stash_prompt",
        requestFingerprint,
        { stashId },
        input.now,
      );
      this.#bumpGeneration(scope);
      return {
        draft: this.getDraft(scope, threadId),
        stash: this.listStashes(scope, threadId).find(
          ({ id }) => id === stashId,
        )!,
        replayed: false,
      };
    })();
  }

  restoreStash(
    scope: RequestScope,
    threadId: string,
    stashId: string,
    input: {
      readonly expectedDraftRevision: number;
      readonly mutationId: string;
      readonly now: number;
    },
  ): { readonly draft: InventoryDraftRecord; readonly replayed: boolean } {
    const requestFingerprint = fingerprint([
      "restore_stash",
      threadId,
      stashId,
      input.expectedDraftRevision,
    ]);
    return this.database.transaction(() => {
      const receipt = this.#receipt(scope, input.mutationId);
      if (receipt) {
        this.#assertReceipt(
          receipt,
          threadId,
          "restore_stash",
          requestFingerprint,
        );
        return { draft: this.getDraft(scope, threadId), replayed: true };
      }
      const draft = this.getDraft(scope, threadId);
      if (draft.revision !== input.expectedDraftRevision) {
        throw new DomainError(
          "draft_revision_conflict",
          "The draft changed in another client.",
        );
      }
      const stash = this.listStashes(scope, threadId).find(
        ({ id }) => id === stashId,
      );
      if (!stash)
        throw new DomainError("not_found", "The stash was not found.");
      if (
        draft.selectedSkillId !== null &&
        stash.selectedSkillId !== null &&
        draft.selectedSkillId !== stash.selectedSkillId
      ) {
        throw new DomainError(
          "invalid_transition",
          "Remove the current skill before restoring a prompt with another skill.",
        );
      }
      const text =
        draft.text.length === 0 ? stash.text : `${draft.text}\n\n${stash.text}`;
      const selectedSkillId = draft.selectedSkillId ?? stash.selectedSkillId;
      const contextExcerpts = [
        ...draft.contextExcerpts,
        ...stash.contextExcerpts,
      ];
      const taskReferences = [...draft.taskReferences, ...stash.taskReferences];
      if (
        new Set(taskReferences.map(({ taskId }) => taskId)).size !==
        taskReferences.length
      ) {
        throw new DomainError(
          "invalid_transition",
          "The stashed prompt contains a task already in the draft.",
        );
      }
      serializeTaskReferences(taskReferences);
      if (
        new Set(contextExcerpts.map(({ id }) => id)).size !==
        contextExcerpts.length
      ) {
        throw new DomainError(
          "invalid_transition",
          "The stashed prompt contains a context excerpt already in the draft.",
        );
      }
      serializeContextExcerpts(contextExcerpts);
      const attachmentIds = [
        ...draft.attachments.map(({ id }) => id),
        ...stash.attachments.map(({ id }) => id),
      ];
      if (new Set(attachmentIds).size !== attachmentIds.length) {
        throw new DomainError(
          "invalid_transition",
          "The stashed prompt contains an attachment already in the draft.",
        );
      }
      this.#attachments.replaceOwnerLinks(
        scope,
        { kind: "draft", threadId },
        attachmentIds,
      );
      this.database
        .prepare(
          `
            UPDATE thread_drafts
            SET text = ?, selected_skill_id = ?, context_excerpts_json = ?,
              task_references_json = ?,
              updated_at = ?,
              revision = revision + 1
            WHERE tenant_id = ? AND principal_id = ? AND thread_id = ?
              AND revision = ?
          `,
        )
        .run(
          text,
          selectedSkillId,
          serializeContextExcerpts(contextExcerpts),
          serializeTaskReferences(taskReferences),
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
        requestFingerprint,
        { stashId },
        input.now,
      );
      this.#bumpGeneration(scope);
      return { draft: this.getDraft(scope, threadId), replayed: false };
    })();
  }

  deleteStash(scope: RequestScope, threadId: string, stashId: string): boolean {
    return this.database.transaction(() => {
      this.getInventory(scope, threadId);
      const removed =
        this.database
          .prepare(
            `
            DELETE FROM prompt_stashes
            WHERE tenant_id = ? AND principal_id = ? AND thread_id = ? AND id = ?
          `,
          )
          .run(scope.tenantId, scope.principalId, threadId, stashId).changes ===
        1;
      if (removed) this.#bumpGeneration(scope);
      return removed;
    })();
  }

  transitionInventory(
    scope: RequestScope,
    threadId: string,
    input: {
      readonly expectedRevision: number;
      readonly mutationId: string;
      readonly change: InventoryTransition;
      readonly now: number;
    },
  ): {
    readonly state: InventoryPrincipalStateRecord;
    readonly replayed: boolean;
  } {
    const requestFingerprint = fingerprint([
      "inventory_transition",
      threadId,
      input.expectedRevision,
      input.change,
    ]);
    return this.database.transaction(() => {
      const receipt = this.#receipt(scope, input.mutationId);
      if (receipt) {
        this.#assertReceipt(
          receipt,
          threadId,
          "inventory_transition",
          requestFingerprint,
        );
        return {
          state: JSON.parse(
            receipt.resultJson,
          ) as InventoryPrincipalStateRecord,
          replayed: true,
        };
      }
      const current = this.getInventory(scope, threadId);
      if (current.inventoryRevision !== input.expectedRevision) {
        throw new DomainError(
          "inventory_revision_conflict",
          "The thread inventory changed in another client.",
        );
      }
      this.#assertTransitionNotBlocked(scope, threadId, input.change);
      const next = this.#nextInventory(current, input.change, input.now);
      if (next !== current) {
        this.#writeInventory(next);
        this.#bumpGeneration(scope);
      }
      const state =
        next === current ? current : this.getInventory(scope, threadId);
      this.#insertReceipt(
        scope,
        threadId,
        input.mutationId,
        "inventory_transition",
        requestFingerprint,
        state,
        input.now,
      );
      return { state, replayed: false };
    })();
  }

  setThreadPinned(
    scope: RequestScope,
    threadId: string,
    input: {
      readonly pinned: boolean;
      readonly expectedRevision: number;
      readonly mutationId: string;
      readonly now: number;
    },
  ): {
    readonly pinned: boolean;
    readonly pinRevision: number;
    readonly replayed: boolean;
  } {
    const requestFingerprint = fingerprint([
      "set_thread_pin",
      threadId,
      input.pinned,
      input.expectedRevision,
    ]);
    return this.database.transaction(() => {
      const receipt = this.#receipt(scope, input.mutationId);
      if (receipt) {
        this.#assertReceipt(
          receipt,
          threadId,
          "set_thread_pin",
          requestFingerprint,
        );
        return {
          ...(JSON.parse(receipt.resultJson) as {
            readonly pinned: boolean;
            readonly pinRevision: number;
          }),
          replayed: true,
        };
      }

      const current = this.getInventory(scope, threadId);
      if (current.pinRevision !== input.expectedRevision) {
        throw new DomainError(
          "pin_revision_conflict",
          "The thread pin changed in another client.",
        );
      }
      const changed = (current.pinned === 1) !== input.pinned;
      const pinRevision = current.pinRevision + (changed ? 1 : 0);
      if (changed) {
        const result = this.database
          .prepare(
            `
              UPDATE thread_principal_state
              SET pinned = ?, pin_revision = pin_revision + 1
              WHERE tenant_id = ? AND principal_id = ? AND thread_id = ?
                AND pin_revision = ?
            `,
          )
          .run(
            input.pinned ? 1 : 0,
            scope.tenantId,
            scope.principalId,
            threadId,
            input.expectedRevision,
          );
        if (result.changes !== 1) {
          throw new DomainError(
            "pin_revision_conflict",
            "The thread pin changed in another client.",
          );
        }
        this.#bumpGeneration(scope);
      }
      const pin = { pinned: input.pinned, pinRevision };
      this.#insertReceipt(
        scope,
        threadId,
        input.mutationId,
        "set_thread_pin",
        requestFingerprint,
        pin,
        input.now,
      );
      return { ...pin, replayed: false };
    })();
  }

  settleThread(
    scope: RequestScope,
    threadId: string,
    input: {
      readonly expectedRevision: number;
      readonly mutationId: string;
      readonly now: number;
      readonly expectedStashedPromptCount?: number;
      readonly openTaskDisposition?:
        "move_to_workspace" | "move_to_global" | "keep";
      readonly moveOpenTasks?: () => readonly string[];
    },
  ): {
    readonly state: InventoryPrincipalStateRecord;
    readonly replayed: boolean;
    readonly movedTaskIds: readonly string[];
  } {
    const disposition = input.openTaskDisposition ?? "keep";
    const requestFingerprint = fingerprint([
      "settle_thread",
      threadId,
      input.expectedRevision,
      disposition,
      ...(input.expectedStashedPromptCount === undefined
        ? []
        : [input.expectedStashedPromptCount]),
    ]);
    return this.database.transaction(() => {
      const receipt = this.#receipt(scope, input.mutationId);
      if (receipt) {
        this.#assertReceipt(
          receipt,
          threadId,
          "settle_thread",
          requestFingerprint,
        );
        const replay = JSON.parse(receipt.resultJson) as {
          readonly state: InventoryPrincipalStateRecord;
          readonly movedTaskIds: readonly string[];
        };
        return { ...replay, replayed: true };
      }
      const current = this.getInventory(scope, threadId);
      if (current.inventoryRevision !== input.expectedRevision) {
        throw new DomainError(
          "inventory_revision_conflict",
          "The thread inventory changed in another client.",
        );
      }
      this.#assertTransitionNotBlocked(scope, threadId, { action: "settle" });
      this.#assertStashedPromptCount(
        scope,
        [threadId],
        input.expectedStashedPromptCount,
      );
      const next = this.#nextInventory(
        current,
        { action: "settle" },
        input.now,
      );
      if (next !== current) {
        this.#writeInventory(next);
        this.#bumpGeneration(scope);
      }
      const state =
        next === current ? current : this.getInventory(scope, threadId);
      const movedTaskIds =
        disposition !== "keep" && input.moveOpenTasks
          ? input.moveOpenTasks()
          : ([] as readonly string[]);
      this.#insertReceipt(
        scope,
        threadId,
        input.mutationId,
        "settle_thread",
        requestFingerprint,
        { state, movedTaskIds },
        input.now,
      );
      return { state, replayed: false, movedTaskIds };
    })();
  }

  archiveThreads(
    scope: RequestScope,
    threadId: string,
    input: {
      readonly expectedRevision: number;
      readonly mutationId: string;
      readonly includeDescendants: boolean;
      readonly expectedThreadIds: readonly string[];
      readonly blockedThreadIds: ReadonlySet<string>;
      readonly now: number;
      readonly expectedStashedPromptCount?: number;
      readonly openTaskDisposition?:
        "move_to_workspace" | "move_to_global" | "keep";
      readonly executionWorkspaceDisposition?:
        | { readonly kind: "keep" }
        | {
            readonly kind: "delete";
            readonly expectedRevision: number;
            readonly operationId: string;
          };
      /**
       * Task disposition executed inside this archive transaction (nested as
       * a savepoint) so the up-scope move and the archive commit atomically.
       * Invoked only for a non-"keep" disposition; returns moved task ids.
       */
      readonly moveOpenTasks?: (
        archivedThreadIds: readonly string[],
      ) => readonly string[];
    },
  ): {
    readonly states: readonly InventoryPrincipalStateRecord[];
    readonly replayed: boolean;
    readonly movedTaskIds: readonly string[];
  } {
    const replay = this.findArchiveThreadsReplay(scope, threadId, input);
    if (replay) {
      return {
        states: replay.states,
        replayed: true,
        movedTaskIds: replay.movedTaskIds,
      };
    }
    if (
      input.expectedThreadIds.length < 1 ||
      input.expectedThreadIds.length > 10_000 ||
      input.expectedThreadIds[0] !== threadId ||
      new Set(input.expectedThreadIds).size !== input.expectedThreadIds.length
    ) {
      throw new Error("archive_thread_set_invalid");
    }
    const requestFingerprint = archiveThreadsFingerprint(threadId, input);
    return this.database.transaction(() => {
      const receipt = this.#receipt(scope, input.mutationId);
      if (receipt) {
        this.#assertReceipt(
          receipt,
          threadId,
          "archive_threads",
          requestFingerprint,
        );
        const replayResult = parseArchiveThreadsReceiptResult(
          receipt.resultJson,
          threadId,
        );
        return {
          states: replayResult.threadIds.map((candidate) =>
            this.getInventory(scope, candidate),
          ),
          replayed: true,
          movedTaskIds: replayResult.movedTaskIds,
        };
      }

      const root = this.getInventory(scope, threadId);
      if (root.inventoryRevision !== input.expectedRevision) {
        throw new DomainError(
          "inventory_revision_conflict",
          "The thread inventory changed in another client.",
        );
      }
      const currentThreadIds = input.includeDescendants
        ? this.#archiveFamilyThreadIds(scope, threadId)
        : [threadId];
      if (
        currentThreadIds.length !== input.expectedThreadIds.length ||
        currentThreadIds.some(
          (candidate, index) => candidate !== input.expectedThreadIds[index],
        )
      ) {
        throw new DomainError(
          "conflict",
          "The thread family changed while its archive state was being checked.",
        );
      }
      const currentInventory = new Map(
        currentThreadIds.map((candidate) => [
          candidate,
          candidate === threadId ? root : this.getInventory(scope, candidate),
        ]),
      );
      const archivableThreadIds = currentThreadIds.filter(
        (candidate) =>
          currentInventory.get(candidate)!.inventoryState !== "archived",
      );
      this.#assertStashedPromptCount(
        scope,
        archivableThreadIds,
        input.expectedStashedPromptCount,
      );
      if (
        archivableThreadIds.some((candidate) =>
          input.blockedThreadIds.has(candidate),
        )
      ) {
        throw new DomainError(
          "invalid_transition",
          input.includeDescendants
            ? "The thread family cannot be archived while one of its threads is active."
            : "The thread cannot be archived while it is active.",
        );
      }

      const transitions = archivableThreadIds.map((candidate) => {
        const current = currentInventory.get(candidate)!;
        this.#assertTransitionNotBlocked(scope, candidate, {
          action: "archive",
        });
        return {
          current,
          next: this.#nextInventory(current, { action: "archive" }, input.now),
        };
      });
      this.#assertArchiveThreadsDurablyInactive(scope, archivableThreadIds);
      let changed = false;
      for (const { current, next } of transitions) {
        if (next !== current) {
          this.#writeInventory(next);
          changed = true;
        }
      }
      if (changed) this.#bumpGeneration(scope);
      const disposition = input.openTaskDisposition ?? "keep";
      const movedTaskIds =
        disposition !== "keep" && input.moveOpenTasks
          ? input.moveOpenTasks(archivableThreadIds)
          : ([] as readonly string[]);
      const states = currentThreadIds.map((candidate) =>
        this.getInventory(scope, candidate),
      );
      this.#insertReceipt(
        scope,
        threadId,
        input.mutationId,
        "archive_threads",
        requestFingerprint,
        { version: 2, threadIds: currentThreadIds, movedTaskIds },
        input.now,
      );
      return { states, replayed: false, movedTaskIds };
    })();
  }

  findArchiveThreadsReplay(
    scope: RequestScope,
    threadId: string,
    input: {
      readonly expectedRevision: number;
      readonly mutationId: string;
      readonly includeDescendants: boolean;
      readonly expectedStashedPromptCount?: number;
      readonly openTaskDisposition?:
        "move_to_workspace" | "move_to_global" | "keep";
      readonly executionWorkspaceDisposition?:
        | { readonly kind: "keep" }
        | {
            readonly kind: "delete";
            readonly expectedRevision: number;
            readonly operationId: string;
          };
    },
  ):
    | {
        readonly states: readonly InventoryPrincipalStateRecord[];
        readonly threadIds: readonly string[];
        readonly movedTaskIds: readonly string[];
      }
    | undefined {
    const receipt = this.#receipt(scope, input.mutationId);
    if (!receipt) return undefined;
    const requestFingerprint = archiveThreadsFingerprint(threadId, input);
    this.#assertReceipt(
      receipt,
      threadId,
      "archive_threads",
      requestFingerprint,
    );
    const result = parseArchiveThreadsReceiptResult(
      receipt.resultJson,
      threadId,
    );
    return {
      states: result.threadIds.map((candidate) =>
        this.getInventory(scope, candidate),
      ),
      threadIds: result.threadIds,
      movedTaskIds: result.movedTaskIds,
    };
  }

  bulkInventoryTransition(
    scope: RequestScope,
    input: {
      readonly action: BulkInventoryAction;
      readonly targets: readonly BulkInventoryTarget[];
      readonly mutationId: string;
      readonly blockedThreadIds: ReadonlySet<string>;
      readonly now: number;
      readonly expectedStashedPromptCount?: number;
      readonly expectedOpenTaskCount?: number;
      readonly openTaskDisposition?:
        "move_to_workspace" | "move_to_global" | "keep";
      /** Runs inside this transaction and must inspect the affected set. */
      readonly countOpenTasks?: (threadIds: readonly string[]) => number;
      /** Runs inside this transaction and must move only the affected set. */
      readonly moveOpenTasks?: (
        threadIds: readonly string[],
      ) => readonly string[];
    },
  ): {
    readonly states: readonly InventoryPrincipalStateRecord[];
    readonly changedThreadIds: readonly string[];
    readonly movedTaskIds: readonly string[];
    readonly replayed: boolean;
  } {
    this.#assertBulkInventoryTargets(input.targets);
    const anchorThreadId = input.targets
      .map(({ threadId }) => threadId)
      .toSorted()[0]!;
    const requestFingerprint = bulkInventoryFingerprint(input);
    return this.database.transaction(() => {
      const receipt = this.#receipt(scope, input.mutationId);
      if (receipt) {
        this.#assertReceipt(
          receipt,
          anchorThreadId,
          "bulk_inventory_transition",
          requestFingerprint,
        );
        const replay = parseBulkInventoryReceiptResult(
          receipt.resultJson,
          anchorThreadId,
        );
        return {
          states: replay.changedThreadIds.map((threadId) =>
            this.getInventory(scope, threadId),
          ),
          changedThreadIds: replay.changedThreadIds,
          movedTaskIds: replay.movedTaskIds,
          replayed: true,
        };
      }

      const currentStates = input.targets.map((target) => {
        const state = this.getInventory(scope, target.threadId);
        if (state.inventoryRevision !== target.expectedRevision) {
          throw new DomainError(
            "inventory_revision_conflict",
            "A thread inventory changed in another client.",
          );
        }
        if (state.inventoryState === "archived") {
          throw new DomainError(
            "invalid_transition",
            "An archived thread cannot belong to a visible stack.",
          );
        }
        return state;
      });
      const affectedStates = currentStates.filter((state) => {
        switch (input.action) {
          case "settle":
            return (
              state.inventoryState === "active" ||
              state.inventoryState === "snoozed"
            );
          case "unsettle":
            return state.inventoryState === "settled";
          case "archive":
            return true;
        }
      });
      const affectedThreadIds = affectedStates.map(({ threadId }) => threadId);

      if (affectedThreadIds.length === 0) {
        throw new DomainError(
          "invalid_transition",
          "Every thread in the stack already has the requested inventory state.",
        );
      }

      if (
        (input.action === "settle" || input.action === "archive") &&
        affectedThreadIds.some((threadId) =>
          input.blockedThreadIds.has(threadId),
        )
      ) {
        throw new DomainError(
          "invalid_transition",
          "The stack cannot be changed while one of its affected threads has active or unresolved work.",
        );
      }
      if (input.action === "settle" || input.action === "archive") {
        this.#assertBulkThreadsDurablyInactive(scope, affectedThreadIds);
      }
      this.#assertStashedPromptCount(
        scope,
        affectedThreadIds,
        input.expectedStashedPromptCount,
      );
      if (input.expectedOpenTaskCount !== undefined) {
        if (!input.countOpenTasks) {
          throw new Error("bulk_inventory_open_task_counter_required");
        }
        if (
          input.countOpenTasks(affectedThreadIds) !==
          input.expectedOpenTaskCount
        ) {
          throw new DomainError(
            "conflict",
            "Open tasks changed while this action was being confirmed. Review the updated impact and try again.",
          );
        }
      }

      const transition: InventoryTransition = { action: input.action };
      const nextStates = affectedStates.map((current) => {
        this.#assertTransitionNotBlocked(scope, current.threadId, transition);
        return this.#nextInventory(current, transition, input.now);
      });
      for (const next of nextStates) this.#writeInventory(next);
      if (nextStates.length > 0) this.#bumpGeneration(scope);

      const disposition = input.openTaskDisposition ?? "keep";
      const movedTaskIds =
        disposition !== "keep" && input.moveOpenTasks
          ? input.moveOpenTasks(affectedThreadIds)
          : ([] as readonly string[]);
      const changedThreadIds = nextStates.map(({ threadId }) => threadId);
      const states = changedThreadIds.map((threadId) =>
        this.getInventory(scope, threadId),
      );
      this.#insertReceipt(
        scope,
        anchorThreadId,
        input.mutationId,
        "bulk_inventory_transition",
        requestFingerprint,
        {
          version: 1,
          targetThreadIds: input.targets.map(({ threadId }) => threadId),
          changedThreadIds,
          movedTaskIds,
        } satisfies BulkInventoryReceiptResult,
        input.now,
      );
      return { states, changedThreadIds, movedTaskIds, replayed: false };
    })();
  }

  findBulkInventoryReplay(
    scope: RequestScope,
    input: {
      readonly action: BulkInventoryAction;
      readonly targets: readonly BulkInventoryTarget[];
      readonly mutationId: string;
      readonly expectedStashedPromptCount?: number;
      readonly expectedOpenTaskCount?: number;
      readonly openTaskDisposition?:
        "move_to_workspace" | "move_to_global" | "keep";
    },
  ):
    | {
        readonly states: readonly InventoryPrincipalStateRecord[];
        readonly changedThreadIds: readonly string[];
        readonly movedTaskIds: readonly string[];
      }
    | undefined {
    this.#assertBulkInventoryTargets(input.targets);
    const receipt = this.#receipt(scope, input.mutationId);
    if (!receipt) return undefined;
    const anchorThreadId = input.targets
      .map(({ threadId }) => threadId)
      .toSorted()[0]!;
    this.#assertReceipt(
      receipt,
      anchorThreadId,
      "bulk_inventory_transition",
      bulkInventoryFingerprint(input),
    );
    const replay = parseBulkInventoryReceiptResult(
      receipt.resultJson,
      anchorThreadId,
    );
    return {
      states: replay.changedThreadIds.map((threadId) =>
        this.getInventory(scope, threadId),
      ),
      changedThreadIds: replay.changedThreadIds,
      movedTaskIds: replay.movedTaskIds,
    };
  }

  findArchiveDurablyBlockedThreadIds(
    scope: RequestScope,
    threadIds: readonly string[],
  ): ReadonlySet<string> {
    const blocked = new Set<string>();
    for (let offset = 0; offset < threadIds.length; offset += 100) {
      const page = threadIds.slice(offset, offset + 100);
      if (page.length === 0) continue;
      const placeholders = page.map(() => "?").join(",");
      const add = (sql: string, id: string): void => {
        const rows = this.database
          .prepare(sql)
          .all(scope.tenantId, scope.principalId, ...page) as readonly Record<
          string,
          string
        >[];
        for (const row of rows) blocked.add(row[id]!);
      };
      add(
        `SELECT id AS threadId
         FROM application_threads
         WHERE tenant_id = ? AND owner_principal_id = ?
           AND id IN (${placeholders})
           AND backing_state IN ('creating', 'creation_unknown')
           AND force_reset_at IS NULL`,
        "threadId",
      );
      add(
        `SELECT DISTINCT application_thread_id AS threadId
         FROM queued_inputs
         WHERE tenant_id = ? AND owner_principal_id = ?
           AND application_thread_id IN (${placeholders})
           AND (
             state IN ('pending', 'retry_wait', 'dispatching', 'uncertain')
             OR (state = 'failed' AND failure_acknowledged_at IS NULL)
           )`,
        "threadId",
      );
      const callbackRows = this.database
        .prepare(
          `SELECT caller_thread_id AS callerThreadId,
             target_thread_id AS targetThreadId
           FROM thread_completion_callbacks
           WHERE tenant_id = ? AND owner_principal_id = ?
             AND state = 'registered'
             AND (
               caller_thread_id IN (${placeholders})
               OR target_thread_id IN (${placeholders})
             )`,
        )
        .all(scope.tenantId, scope.principalId, ...page, ...page) as readonly {
        readonly callerThreadId: string;
        readonly targetThreadId: string;
      }[];
      const pageIds = new Set(page);
      for (const callback of callbackRows) {
        if (pageIds.has(callback.callerThreadId)) {
          blocked.add(callback.callerThreadId);
        }
        if (pageIds.has(callback.targetThreadId)) {
          blocked.add(callback.targetThreadId);
        }
      }
      add(
        `SELECT DISTINCT application_thread_id AS threadId
         FROM conversation_creation_attempts
         WHERE tenant_id = ? AND owner_principal_id = ?
           AND application_thread_id IN (${placeholders})
           AND force_reset_at IS NULL
           AND phase NOT IN ('bound', 'aborted_unpersisted')`,
        "threadId",
      );
      add(
        `SELECT DISTINCT thread_id AS threadId
         FROM mutation_receipts
         WHERE tenant_id = ? AND principal_id = ?
           AND thread_id IN (${placeholders})
           AND result_code IN ('prepared', 'uncertain', 'pending_materialization')`,
        "threadId",
      );
      add(
        `SELECT DISTINCT application_thread_id AS threadId
         FROM provider_feature_mutation_receipts
         WHERE tenant_id = ? AND owner_principal_id = ?
           AND application_thread_id IN (${placeholders})
           AND force_reset_at IS NULL
           AND state IN ('prepared', 'uncertain')`,
        "threadId",
      );
      add(
        `SELECT DISTINCT origin.source_thread_id AS threadId
         FROM thread_fork_origins AS origin
         LEFT JOIN thread_force_reset_abandoned_forks AS abandoned
           ON abandoned.tenant_id = origin.tenant_id
           AND abandoned.principal_id = origin.owner_principal_id
           AND abandoned.child_thread_id = origin.child_thread_id
         WHERE origin.tenant_id = ? AND origin.owner_principal_id = ?
           AND origin.source_thread_id IN (${placeholders})
           AND origin.origin_state = 'prepared'
           AND abandoned.child_thread_id IS NULL`,
        "threadId",
      );
      add(
        `SELECT DISTINCT anchor_thread_id AS threadId
         FROM automation_runs
         WHERE tenant_id = ? AND owner_principal_id = ?
           AND anchor_thread_id IN (${placeholders})
           AND force_reset_at IS NULL
           AND state IN ('claimed', 'dispatching', 'queued', 'running', 'uncertain')`,
        "threadId",
      );
    }
    return blocked;
  }

  isThreadCreationForceReset(scope: RequestScope, threadId: string): boolean {
    return (
      this.database
        .prepare(
          `SELECT 1
           FROM application_threads
           WHERE tenant_id = ? AND owner_principal_id = ? AND id = ?
             AND backing_state IN ('creating', 'creation_unknown')
             AND force_reset_at IS NOT NULL`,
        )
        .get(scope.tenantId, scope.principalId, threadId) !== undefined
    );
  }

  acknowledgeWake(
    scope: RequestScope,
    threadId: string,
    observedWokeAt: number,
    now: number,
  ): InventoryPrincipalStateRecord {
    return this.database.transaction(() => {
      this.getInventory(scope, threadId);
      const changed = this.database
        .prepare(
          `
            UPDATE thread_principal_state
            SET wake_acknowledged_at = ?, wake_reminder_text = NULL,
              inventory_revision = inventory_revision + 1
            WHERE tenant_id = ? AND principal_id = ? AND thread_id = ?
              AND inventory_state = 'active' AND woke_at = ?
              AND (wake_acknowledged_at IS NULL OR wake_acknowledged_at < woke_at)
          `,
        )
        .run(now, scope.tenantId, scope.principalId, threadId, observedWokeAt);
      if (changed.changes === 1) this.#bumpGeneration(scope);
      return this.getInventory(scope, threadId);
    })();
  }

  dismissAutomationContext(
    scope: RequestScope,
    threadId: string,
    runId: string,
  ): InventoryPrincipalStateRecord {
    return this.database.transaction(() => {
      this.getInventory(scope, threadId);
      const changed = this.database
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
      if (changed.changes === 1) this.#bumpGeneration(scope);
      return this.getInventory(scope, threadId);
    })();
  }

  wakeForRuntimeSignal(
    scope: RequestScope,
    threadId: string,
    reason: "completion" | "failure" | "needs-input",
    now: number,
  ): InventoryPrincipalStateRecord {
    return this.database.transaction(() => {
      const current = this.getInventory(scope, threadId);
      if (current.inventoryState !== "snoozed") return current;
      const changed = this.database
        .prepare(
          `
            UPDATE thread_principal_state
            SET inventory_state = 'active', state_changed_at = ?,
              snoozed_at = NULL, snoozed_until = NULL,
              woke_at = ?, wake_reason = ?, wake_acknowledged_at = NULL,
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
      if (changed.changes !== 1) {
        throw new DomainError(
          "conflict",
          "The thread inventory changed while it was being woken.",
        );
      }
      this.#bumpGeneration(scope);
      return this.getInventory(scope, threadId);
    })();
  }

  wakeDueSnoozes(now: number): Array<{
    readonly scope: RequestScope;
    readonly state: InventoryPrincipalStateRecord;
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
        .all(now) as Array<RequestScope & { readonly threadId: string }>;
      const changed: Array<{
        scope: RequestScope;
        state: InventoryPrincipalStateRecord;
      }> = [];
      for (const row of due) {
        const scope = {
          tenantId: row.tenantId,
          principalId: row.principalId,
        };
        const result = this.database
          .prepare(
            `
              UPDATE thread_principal_state
              SET inventory_state = 'active', state_changed_at = ?,
                snoozed_at = NULL, snoozed_until = NULL,
                woke_at = ?, wake_reason = 'deadline',
                wake_acknowledged_at = NULL,
                inventory_revision = inventory_revision + 1
              WHERE tenant_id = ? AND principal_id = ? AND thread_id = ?
                AND inventory_state = 'snoozed' AND snoozed_until <= ?
            `,
          )
          .run(now, now, scope.tenantId, scope.principalId, row.threadId, now);
        if (result.changes === 1) {
          this.#bumpGeneration(scope);
          changed.push({
            scope,
            state: this.getInventory(scope, row.threadId),
          });
        }
      }
      return changed;
    })();
  }

  getNearestSnoozeDeadline(): number | null {
    return (
      this.database
        .prepare(
          `
            SELECT min(snoozed_until) AS deadline
            FROM thread_principal_state
            WHERE inventory_state = 'snoozed'
          `,
        )
        .get() as { readonly deadline: number | null }
    ).deadline;
  }

  renameThread(
    scope: RequestScope,
    threadId: string,
    input: {
      readonly title: string;
      readonly expectedRevision: number;
      readonly mutationId: string;
      readonly now: number;
    },
  ): InventoryThreadAggregate {
    const requestFingerprint = fingerprint([
      "rename_thread",
      threadId,
      input.title,
      input.expectedRevision,
    ]);
    return this.database.transaction(() => {
      const receipt = this.#receipt(scope, input.mutationId);
      if (receipt) {
        this.#assertReceipt(
          receipt,
          threadId,
          "rename_thread",
          requestFingerprint,
        );
        return this.getThread(scope, threadId);
      }
      const changed = this.database
        .prepare(
          `
            UPDATE application_threads
            SET title = ?, revision = revision + 1, updated_at = ?
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
      if (changed.changes !== 1) {
        throw new DomainError(
          "conflict",
          "The thread changed in another client.",
        );
      }
      this.#insertReceipt(
        scope,
        threadId,
        input.mutationId,
        "rename_thread",
        requestFingerprint,
        { title: input.title },
        input.now,
      );
      this.#bumpGeneration(scope);
      return this.getThread(scope, threadId);
    })();
  }

  markDiscoveredAvailable(
    scope: RequestScope,
    threadId: string,
    input: {
      readonly title?: string;
      readonly updatedAt: number;
      readonly now: number;
    },
  ): InventoryThreadAggregate {
    return this.database.transaction(() => {
      const current = this.getThread(scope, threadId).thread;
      const inventoryChanged =
        (input.title !== undefined && input.title !== current.title) ||
        current.availability !== "available" ||
        input.updatedAt > current.lastActivityAt;
      const changed = this.database
        .prepare(
          `
            UPDATE application_threads
            SET title = coalesce(?, title), availability = 'available',
              reconciliation_at = ?, last_activity_at = max(last_activity_at, ?),
              revision = revision + ?, updated_at = ?
            WHERE tenant_id = ? AND owner_principal_id = ? AND id = ?
              AND backing_state = 'bound'
          `,
        )
        .run(
          input.title ?? null,
          input.now,
          input.updatedAt,
          inventoryChanged ? 1 : 0,
          input.now,
          scope.tenantId,
          scope.principalId,
          threadId,
        );
      if (changed.changes !== 1) {
        throw new DomainError(
          "invalid_transition",
          "Only a bound thread can be reconciled from discovery.",
        );
      }
      // Refresh discovery bookkeeping without invalidating pending input when
      // the provider reports the same visible thread state.
      if (inventoryChanged) this.#bumpGeneration(scope);
      return this.getThread(scope, threadId);
    })();
  }

  finishDiscovery(
    scope: RequestScope,
    environmentId: string,
    workspaceId: string,
    backendInstanceId: string,
    connectionProfileIds: readonly string[],
    seenBackendConversationIds: ReadonlySet<string>,
    now: number,
  ): InventoryThreadAggregate[] {
    if (connectionProfileIds.length === 0) {
      throw new Error("discovery_connection_profiles_required");
    }
    return this.database.transaction(() => {
      const profilePlaceholders = connectionProfileIds
        .map(() => "?")
        .join(", ");
      const candidates = this.database
        .prepare(
          `
            SELECT thread.id, binding.backend_conversation_id AS conversationId
            FROM application_threads AS thread
            JOIN conversation_bindings AS binding
              ON binding.tenant_id = thread.tenant_id
              AND binding.owner_principal_id = thread.owner_principal_id
              AND binding.application_thread_id = thread.id
            WHERE thread.tenant_id = ? AND thread.owner_principal_id = ?
              AND thread.environment_id = ? AND thread.backing_state = 'bound'
              AND thread.workspace_id = ?
              AND thread.backend_instance_id = ?
              AND binding.backend_instance_id = ?
              AND thread.connection_profile_id IN (${profilePlaceholders})
              AND thread.availability = 'available'
            ORDER BY thread.id
          `,
        )
        .all(
          scope.tenantId,
          scope.principalId,
          environmentId,
          workspaceId,
          backendInstanceId,
          backendInstanceId,
          ...connectionProfileIds,
        ) as Array<{ readonly id: string; readonly conversationId: string }>;
      const changed: InventoryThreadAggregate[] = [];
      for (const candidate of candidates) {
        if (seenBackendConversationIds.has(candidate.conversationId)) continue;
        this.database
          .prepare(
            `
              UPDATE application_threads
              SET availability = 'missing', reconciliation_at = ?,
                revision = revision + 1, updated_at = ?
              WHERE tenant_id = ? AND owner_principal_id = ? AND id = ?
                AND availability = 'available'
            `,
          )
          .run(now, now, scope.tenantId, scope.principalId, candidate.id);
        changed.push(this.getThread(scope, candidate.id));
      }
      if (changed.length > 0) this.#bumpGeneration(scope);
      return changed;
    })();
  }

  quarantineDiscoveredConversations(
    scope: RequestScope,
    environmentId: string,
    backendInstanceId: string,
    backendConversationIds: readonly string[],
    now: number,
  ): InventoryThreadAggregate[] {
    if (backendConversationIds.length === 0) return [];
    return this.database.transaction(() => {
      const uniqueIds = [...new Set(backendConversationIds)];
      const placeholders = uniqueIds.map(() => "?").join(", ");
      const threadIds = (
        this.database
          .prepare(
            `
              SELECT thread.id
              FROM application_threads AS thread
              JOIN conversation_bindings AS binding
                ON binding.tenant_id = thread.tenant_id
                AND binding.owner_principal_id = thread.owner_principal_id
                AND binding.application_thread_id = thread.id
              WHERE thread.tenant_id = ? AND thread.owner_principal_id = ?
                AND thread.environment_id = ?
                AND thread.backend_instance_id = ?
                AND binding.backend_instance_id = ?
                AND binding.backend_conversation_id IN (${placeholders})
              ORDER BY thread.id
            `,
          )
          .all(
            scope.tenantId,
            scope.principalId,
            environmentId,
            backendInstanceId,
            backendInstanceId,
            ...uniqueIds,
          ) as Array<{ readonly id: string }>
      ).map(({ id }) => id);
      const changed: InventoryThreadAggregate[] = [];
      for (const threadId of threadIds) {
        const result = this.database
          .prepare(
            `
              UPDATE application_threads
              SET availability = 'quarantined', reconciliation_at = ?,
                revision = revision + 1, updated_at = ?
              WHERE tenant_id = ? AND owner_principal_id = ? AND id = ?
                AND availability <> 'quarantined'
            `,
          )
          .run(now, now, scope.tenantId, scope.principalId, threadId);
        if (result.changes === 1) changed.push(this.getThread(scope, threadId));
      }
      if (changed.length > 0) this.#bumpGeneration(scope);
      return changed;
    })();
  }

  #nextInventory(
    current: InventoryPrincipalStateRecord,
    change: InventoryTransition,
    now: number,
  ): InventoryPrincipalStateRecord {
    const base = {
      ...current,
      inventoryRevision: current.inventoryRevision + 1,
      stateChangedAt: now,
    };
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
          ...base,
          inventoryState: "settled",
          snoozedAt: null,
          snoozedUntil: null,
          wokeAt: null,
          wakeReason: null,
          wakeAcknowledgedAt: null,
          wakeReminderText: null,
        };
      case "unsettle":
        if (current.inventoryState === "active") return current;
        if (current.inventoryState !== "settled") {
          throw new DomainError(
            "invalid_transition",
            "Only a Settled thread can be unsettled.",
          );
        }
        return { ...base, inventoryState: "active" };
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
          ...base,
          inventoryState: "snoozed",
          snoozedAt: now,
          snoozedUntil: change.snoozedUntil,
          wokeAt: null,
          wakeReason: null,
          wakeAcknowledgedAt: null,
          wakeReminderText: change.wakeReminderText ?? null,
        };
      case "remind":
        if (current.inventoryState !== "active") {
          throw new DomainError(
            "invalid_transition",
            "Only an Active thread can receive a reminder now.",
          );
        }
        return {
          ...base,
          stateChangedAt: current.stateChangedAt,
          snoozedAt: null,
          snoozedUntil: null,
          // `wokeAt` is also the acknowledgement generation token. Keep it
          // strictly increasing when two reminders are written in one clock
          // tick so a stale dismissal cannot clear the replacement.
          wokeAt: Math.max(now, (current.wokeAt ?? now - 1) + 1),
          wakeReason: "manual",
          wakeAcknowledgedAt: null,
          wakeReminderText: change.wakeReminderText,
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
          ...base,
          inventoryState: "active",
          snoozedAt: null,
          snoozedUntil: null,
          wokeAt: now,
          wakeReason: "manual",
          wakeAcknowledgedAt: null,
        };
      case "archive":
        if (current.inventoryState === "archived") return current;
        return {
          ...base,
          inventoryState: "archived",
          snoozedAt: null,
          snoozedUntil: null,
          wokeAt: null,
          wakeReason: null,
          wakeAcknowledgedAt: null,
          wakeReminderText: null,
        };
      case "restore":
        if (current.inventoryState === "active") return current;
        if (current.inventoryState !== "archived") {
          throw new DomainError(
            "invalid_transition",
            "Only an Archived thread can be restored.",
          );
        }
        return { ...base, inventoryState: "active" };
    }
  }

  #assertTransitionNotBlocked(
    scope: RequestScope,
    threadId: string,
    change: InventoryTransition,
  ): void {
    if (change.action === "snooze") {
      const callback = this.database
        .prepare(
          `
            SELECT 1
            FROM thread_completion_callbacks
            WHERE tenant_id = ? AND owner_principal_id = ?
              AND caller_thread_id = ? AND state = 'registered'
            LIMIT 1
          `,
        )
        .get(scope.tenantId, scope.principalId, threadId);
      if (callback) {
        throw new DomainError(
          "invalid_transition",
          "A thread awaiting an agent result cannot be snoozed.",
        );
      }
      const dispatching = this.database
        .prepare(
          `
            SELECT 1
            FROM automation_runs
            WHERE tenant_id = ? AND owner_principal_id = ?
              AND anchor_thread_id = ? AND occurrence_kind = 'scheduled'
              AND state = 'dispatching'
            LIMIT 1
          `,
        )
        .get(scope.tenantId, scope.principalId, threadId);
      if (dispatching) {
        throw new DomainError(
          "invalid_transition",
          "The thread cannot be snoozed while a scheduled run is dispatching.",
        );
      }
    }
    if (change.action === "archive") {
      const active = this.database
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
        .get(scope.tenantId, scope.principalId, threadId);
      if (active) {
        throw new DomainError(
          "invalid_transition",
          "The thread cannot be archived while an automation run is active.",
        );
      }
    }
  }

  #archiveFamilyThreadIds(
    scope: RequestScope,
    threadId: string,
  ): readonly string[] {
    const rows = this.database
      .prepare(
        `SELECT family.threadId
         FROM (
           SELECT root.id AS threadId, 0 AS familyOrder
           FROM application_threads AS root
           WHERE root.tenant_id = ? AND root.owner_principal_id = ?
             AND root.id = ?
           UNION ALL
           SELECT closure.descendant_thread_id AS threadId, 1 AS familyOrder
           FROM thread_lineage_closure AS closure
           INNER JOIN thread_fork_origins AS origin
             ON origin.tenant_id = closure.tenant_id
             AND origin.owner_principal_id = closure.owner_principal_id
             AND origin.child_thread_id = closure.descendant_thread_id
             AND origin.origin_state = 'committed'
           WHERE closure.tenant_id = ? AND closure.owner_principal_id = ?
             AND closure.ancestor_thread_id = ?
         ) AS family
         ORDER BY family.familyOrder, family.threadId
         LIMIT 10001`,
      )
      .all(
        scope.tenantId,
        scope.principalId,
        threadId,
        scope.tenantId,
        scope.principalId,
        threadId,
      ) as readonly { readonly threadId: string }[];
    if (rows.length > 10_000) {
      throw new DomainError(
        "invalid_transition",
        "The thread family is outside the supported application bounds.",
      );
    }
    return rows.map(({ threadId: candidate }) => candidate);
  }

  #assertStashedPromptCount(
    scope: RequestScope,
    threadIds: readonly string[],
    expectedCount: number | undefined,
  ): void {
    if (expectedCount === undefined) return;
    let actualCount = 0;
    for (let offset = 0; offset < threadIds.length; offset += 500) {
      const page = threadIds.slice(offset, offset + 500);
      const row = this.database
        .prepare(
          `SELECT count(*) AS count
           FROM prompt_stashes
           WHERE tenant_id = ? AND principal_id = ?
             AND thread_id IN (${page.map(() => "?").join(", ")})`,
        )
        .get(scope.tenantId, scope.principalId, ...page) as {
        readonly count: number;
      };
      actualCount += row.count;
    }
    if (actualCount !== expectedCount) {
      throw new DomainError(
        "conflict",
        "Stashed prompts changed while this action was being confirmed. Review the updated impact and try again.",
      );
    }
  }

  #assertArchiveThreadsDurablyInactive(
    scope: RequestScope,
    threadIds: readonly string[],
  ): void {
    if (this.findArchiveDurablyBlockedThreadIds(scope, threadIds).size > 0) {
      throw new DomainError(
        "invalid_transition",
        "The thread family cannot be archived while it has active or unresolved work.",
      );
    }
  }

  #assertBulkThreadsDurablyInactive(
    scope: RequestScope,
    threadIds: readonly string[],
  ): void {
    if (this.findArchiveDurablyBlockedThreadIds(scope, threadIds).size > 0) {
      throw new DomainError(
        "invalid_transition",
        "The stack cannot be changed while one of its affected threads has active or unresolved work.",
      );
    }
  }

  #assertBulkInventoryTargets(targets: readonly BulkInventoryTarget[]): void {
    if (
      targets.length < 2 ||
      targets.length > MAXIMUM_BULK_INVENTORY_TARGETS ||
      new Set(targets.map(({ threadId }) => threadId)).size !==
        targets.length ||
      targets.some(
        ({ threadId, expectedRevision }) =>
          !UUID_PATTERN.test(threadId) ||
          !Number.isInteger(expectedRevision) ||
          expectedRevision < 0,
      )
    ) {
      throw new Error("bulk_inventory_targets_invalid");
    }
  }

  #writeInventory(state: InventoryPrincipalStateRecord): void {
    const result = this.database
      .prepare(
        `
          UPDATE thread_principal_state
          SET inventory_state = ?, state_changed_at = ?,
            snoozed_at = ?, snoozed_until = ?, woke_at = ?, wake_reason = ?,
            wake_acknowledged_at = ?, inventory_revision = ?,
            wake_reminder_text = ?,
            automation_context_run_id = ?,
            automation_context_source_thread_id = ?,
            automation_context_at = ?, automation_context_outcome = ?,
            automation_context_diagnostic = ?
          WHERE tenant_id = ? AND principal_id = ? AND thread_id = ?
            AND inventory_revision = ?
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
        state.inventoryRevision,
        state.wakeReminderText,
        state.automationContextRunId,
        state.automationContextSourceThreadId,
        state.automationContextAt,
        state.automationContextOutcome,
        state.automationContextDiagnostic,
        state.tenantId,
        state.principalId,
        state.threadId,
        state.inventoryRevision - 1,
      );
    if (result.changes !== 1) {
      throw new DomainError(
        "inventory_revision_conflict",
        "The thread inventory changed in another client.",
      );
    }
  }

  #receipt(
    scope: RequestScope,
    mutationId: string,
  ): MutationReceipt | undefined {
    return this.database
      .prepare(
        `
          SELECT thread_id AS threadId, operation_kind AS operationKind,
            request_fingerprint AS requestFingerprint,
            result_json AS resultJson
          FROM mutation_receipts
          WHERE tenant_id = ? AND principal_id = ? AND mutation_id = ?
        `,
      )
      .get(scope.tenantId, scope.principalId, mutationId) as
      MutationReceipt | undefined;
  }

  #assertReceipt(
    receipt: MutationReceipt,
    threadId: string,
    operationKind: string,
    requestFingerprint: string,
  ): void {
    if (
      receipt.threadId !== threadId ||
      receipt.operationKind !== operationKind ||
      receipt.requestFingerprint !== requestFingerprint
    ) {
      throw new DomainError(
        "conflict",
        "The mutation ID was reused for a different operation.",
      );
    }
  }

  #insertReceipt(
    scope: RequestScope,
    threadId: string,
    mutationId: string,
    operationKind: string,
    requestFingerprint: string,
    result: unknown,
    now: number,
  ): void {
    this.database
      .prepare(
        `
          INSERT INTO mutation_receipts(
            tenant_id, principal_id, thread_id, mutation_id, operation_kind,
            request_fingerprint, result_code, result_json, replayable, created_at
          )
          VALUES (?, ?, ?, ?, ?, ?, 'completed', ?, 1, ?)
        `,
      )
      .run(
        scope.tenantId,
        scope.principalId,
        threadId,
        mutationId,
        operationKind,
        requestFingerprint,
        JSON.stringify(result),
        now,
      );
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
      throw new DomainError(
        "conflict",
        "The principal inventory generation is missing.",
      );
    }
  }
}
