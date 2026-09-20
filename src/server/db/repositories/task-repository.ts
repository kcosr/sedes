import { createHash, randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import {
  taskDetailsSchema,
  taskFilesSchema,
  taskListProjectionSchema,
  taskQuerySchema,
  taskScopeModeSchema,
  taskTitleSchema,
  type TaskListProjection,
  type TaskScope,
  type TaskScopeMode,
} from "../../../shared/protocol/tasks.js";
import { DomainError } from "../../domain/errors.js";
import type { RequestScope } from "../../identity/identity-provider.js";

export type TaskScopeKind = "global" | "workspace" | "thread";

export type TaskRecord = {
  readonly tenantId: string;
  readonly ownerPrincipalId: string;
  readonly id: string;
  readonly scopeKind: TaskScopeKind;
  readonly environmentId: string | null;
  readonly workspaceId: string | null;
  readonly threadId: string | null;
  readonly title: string;
  readonly details: string;
  readonly pinned: boolean;
  readonly files: readonly string[];
  readonly completedAt: number | null;
  readonly revision: number;
  readonly createdAt: number;
  readonly updatedAt: number;
};

export type OpenThreadTaskSummary = Pick<
  TaskRecord,
  "id" | "title" | "threadId"
> & {
  readonly threadId: string;
};

export type OpenThreadTaskSummaryCollection = {
  readonly items: readonly OpenThreadTaskSummary[];
  readonly total: number;
  readonly omitted: number;
};

export type TaskListSummary = Pick<
  TaskRecord,
  | "id"
  | "scopeKind"
  | "workspaceId"
  | "threadId"
  | "title"
  | "pinned"
  | "completedAt"
  | "revision"
  | "createdAt"
  | "updatedAt"
> & {
  readonly associatedWorkspaceId: string | null;
  readonly fileCount: number;
};

export type AssociatedTaskRecord = TaskRecord & {
  /** Read-only workspace association resolved from authoritative thread state. */
  readonly associatedWorkspaceId: string | null;
};

/**
 * Bounded task authority facts used before any task body or list result is
 * read. Thread-scoped tasks deliberately resolve their environment through
 * the authoritative thread row because tasks.environment_id is NULL for that
 * scope.
 */
export type TaskEnvironmentAuthority = {
  readonly taskId: string;
  readonly revision: number;
  readonly scopeKind: TaskScopeKind;
  readonly environmentId: string | null;
};

export type TaskListPage =
  | {
      readonly projection: "summary";
      readonly items: readonly TaskListSummary[];
      readonly nextCursor?: string;
    }
  | {
      readonly projection: "full";
      readonly items: readonly AssociatedTaskRecord[];
      readonly nextCursor?: string;
    };

type TaskRow = Omit<TaskRecord, "pinned" | "files"> & {
  readonly pinned: 0 | 1;
  readonly filesJson: string;
};

type AssociatedTaskRow = TaskRow & {
  readonly associatedWorkspaceId: string | null;
};

type TaskSummaryRow = Omit<TaskListSummary, "pinned"> & {
  readonly pinned: 0 | 1;
};

type TaskMutationReceipt = {
  readonly operationKind: string;
  readonly requestFingerprint: string;
  readonly resultJson: string;
};

// Leaves room beneath the canonical tool's 1 MiB result ceiling for the page
// envelope, cursor, and normalized Task presentation. A valid individual task
// is bounded below that ceiling and is always admitted so pagination advances.
const FULL_TASK_LIST_RECORD_BUDGET_BYTES = 900 * 1_024;

/**
 * Scope column tuple for one task row. The environment id of a workspace
 * scope is resolved server-side from the workspace row; thread scopes stay
 * unresolved on purpose so a draft moving between workspaces cannot strand a
 * stale denormalized copy.
 */
type ResolvedScopeColumns = {
  readonly scopeKind: TaskScopeKind;
  readonly environmentId: string | null;
  readonly workspaceId: string | null;
  readonly threadId: string | null;
};

function fingerprint(operation: string, parts: readonly unknown[]): string {
  return createHash("sha256")
    .update(JSON.stringify([operation, ...parts]))
    .digest("hex");
}

function scopeFingerprintParts(scope: TaskScope): readonly unknown[] {
  if (scope.kind === "workspace") return [scope.kind, scope.workspaceId];
  if (scope.kind === "thread") return [scope.kind, scope.threadId];
  return [scope.kind];
}

function asciiLowercase(value: string): string {
  return value.replace(/[A-Z]/g, (character) => character.toLowerCase());
}

function encodeTaskCursor(value: unknown): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

function decodeTaskCursor(
  cursor: string,
  expectedFingerprint: string,
): { readonly createdAt: number; readonly id: string } {
  try {
    const decoded = JSON.parse(
      Buffer.from(cursor, "base64url").toString("utf8"),
    ) as unknown;
    if (
      typeof decoded !== "object" ||
      decoded === null ||
      Object.keys(decoded).length !== 3 ||
      !("fingerprint" in decoded) ||
      decoded.fingerprint !== expectedFingerprint ||
      !("createdAt" in decoded) ||
      !Number.isSafeInteger(decoded.createdAt) ||
      (decoded.createdAt as number) < 0 ||
      !("id" in decoded) ||
      typeof decoded.id !== "string" ||
      decoded.id.length === 0
    ) {
      throw new Error("task_cursor_invalid");
    }
    return { createdAt: decoded.createdAt as number, id: decoded.id };
  } catch (cause) {
    throw new DomainError(
      "cursor_invalid",
      "The task cursor is invalid.",
      false,
      {
        cause,
      },
    );
  }
}

const columns = `
  tenant_id AS tenantId,
  owner_principal_id AS ownerPrincipalId,
  id,
  scope_kind AS scopeKind,
  environment_id AS environmentId,
  workspace_id AS workspaceId,
  thread_id AS threadId,
  title,
  details,
  pinned,
  files_json AS filesJson,
  completed_at AS completedAt,
  revision,
  created_at AS createdAt,
  updated_at AS updatedAt
`;

const associatedColumns = `
  ${columns},
  CASE
    WHEN scope_kind = 'thread' THEN (
      SELECT task_thread.workspace_id
      FROM application_threads AS task_thread
      WHERE task_thread.tenant_id = tasks.tenant_id
        AND task_thread.owner_principal_id = tasks.owner_principal_id
        AND task_thread.id = tasks.thread_id
    )
    ELSE workspace_id
  END AS associatedWorkspaceId
`;

export class TaskRepository {
  constructor(readonly database: Database.Database) {}

  list(scope: RequestScope): readonly TaskRecord[] {
    const rows = this.database
      .prepare(
        `
          SELECT ${columns}
          FROM tasks
          WHERE tenant_id = ? AND owner_principal_id = ?
          ORDER BY created_at ASC, id ASC
        `,
      )
      .all(scope.tenantId, scope.principalId) as TaskRow[];
    return rows.map((row) => this.#presentRow(row));
  }

  listAssociated(scope: RequestScope): readonly AssociatedTaskRecord[] {
    const rows = this.database
      .prepare(
        `
          SELECT ${associatedColumns}
          FROM tasks
          WHERE tenant_id = ? AND owner_principal_id = ?
          ORDER BY created_at ASC, id ASC
        `,
      )
      .all(scope.tenantId, scope.principalId) as AssociatedTaskRow[];
    return rows.map((row) => this.#presentAssociatedRow(row));
  }

  listAssociatedByThread(
    scope: RequestScope,
    threadId: string,
  ): readonly AssociatedTaskRecord[] {
    const rows = this.database
      .prepare(
        `
          SELECT ${associatedColumns}
          FROM tasks
          WHERE tenant_id = ? AND owner_principal_id = ?
            AND scope_kind = 'thread' AND thread_id = ?
          ORDER BY created_at ASC, id ASC
        `,
      )
      .all(scope.tenantId, scope.principalId, threadId) as AssociatedTaskRow[];
    return rows.map((row) => this.#presentAssociatedRow(row));
  }

  /**
   * Resolve only the environment roots spanned by a task query. Global-exact
   * is environment-neutral, while global-subtree intentionally spans every
   * configured principal environment, including environments with no tasks.
   */
  resolveScopeEnvironmentIds(
    scope: RequestScope,
    taskScope: TaskScope,
    scopeMode: TaskScopeMode,
  ): readonly string[] {
    const mode = taskScopeModeSchema.parse(scopeMode);
    if (taskScope.kind === "global") {
      if (mode === "exact") return [];
      const rows = this.database
        .prepare(
          `
            SELECT id
            FROM execution_environments
            WHERE tenant_id = ? AND owner_principal_id = ?
            ORDER BY id ASC
          `,
        )
        .all(scope.tenantId, scope.principalId) as Array<{
        readonly id: string;
      }>;
      return rows.map(({ id }) => id);
    }
    const resolved = this.#resolveScope(scope, taskScope);
    if (resolved.scopeKind === "workspace") {
      return [resolved.environmentId!];
    }
    const row = this.database
      .prepare(
        `
          SELECT environment_id AS environmentId
          FROM application_threads
          WHERE tenant_id = ? AND owner_principal_id = ? AND id = ?
        `,
      )
      .get(scope.tenantId, scope.principalId, resolved.threadId) as
      { readonly environmentId: string } | undefined;
    if (!row) {
      throw new DomainError("not_found", "The task scope was not found.");
    }
    return [row.environmentId];
  }

  /** Resolve current task scope authority without selecting task contents. */
  resolveTaskEnvironmentAuthority(
    scope: RequestScope,
    taskId: string,
  ): TaskEnvironmentAuthority {
    const row = this.database
      .prepare(
        `
          SELECT task.id AS taskId, task.revision,
            task.scope_kind AS scopeKind,
            CASE
              WHEN task.scope_kind = 'global' THEN NULL
              WHEN task.scope_kind = 'workspace' THEN workspace.environment_id
              ELSE thread.environment_id
            END AS environmentId,
            task.environment_id AS storedEnvironmentId,
            workspace.id AS resolvedWorkspaceId,
            thread.id AS resolvedThreadId
          FROM tasks AS task
          LEFT JOIN workspaces AS workspace
            ON workspace.tenant_id = task.tenant_id
            AND workspace.owner_principal_id = task.owner_principal_id
            AND workspace.id = task.workspace_id
            AND task.scope_kind = 'workspace'
          LEFT JOIN application_threads AS thread
            ON thread.tenant_id = task.tenant_id
            AND thread.owner_principal_id = task.owner_principal_id
            AND thread.id = task.thread_id
            AND task.scope_kind = 'thread'
          WHERE task.tenant_id = ? AND task.owner_principal_id = ?
            AND task.id = ?
        `,
      )
      .get(scope.tenantId, scope.principalId, taskId) as
      | {
          readonly taskId: string;
          readonly revision: number;
          readonly scopeKind: TaskScopeKind;
          readonly environmentId: string | null;
          readonly storedEnvironmentId: string | null;
          readonly resolvedWorkspaceId: string | null;
          readonly resolvedThreadId: string | null;
        }
      | undefined;
    if (!row) {
      throw new DomainError("not_found", "The task was not found.");
    }
    const invalidWorkspace =
      row.scopeKind === "workspace" &&
      (row.resolvedWorkspaceId === null ||
        row.environmentId === null ||
        row.storedEnvironmentId !== row.environmentId);
    const invalidThread =
      row.scopeKind === "thread" &&
      (row.resolvedThreadId === null || row.environmentId === null);
    const invalidGlobal =
      row.scopeKind === "global" && row.environmentId !== null;
    if (invalidWorkspace || invalidThread || invalidGlobal) {
      throw new DomainError("not_found", "The task was not found.");
    }
    return {
      taskId: row.taskId,
      revision: row.revision,
      scopeKind: row.scopeKind,
      environmentId: row.environmentId,
    };
  }

  listPage(
    scope: RequestScope,
    input: {
      readonly taskScope: TaskScope;
      readonly scopeMode: TaskScopeMode;
      readonly completed?: boolean;
      readonly pinned?: boolean;
      readonly query?: string;
      readonly projection: TaskListProjection;
      readonly cursor?: string;
      readonly pageSize: number;
      /** Trusted authority binding for agent-tool cursors. */
      readonly authorityBinding?: {
        readonly sourceEnvironmentId: string;
        readonly targetEnvironmentIds: readonly string[];
        readonly policyRevision: number;
        readonly continuationAuthorityDigest: string;
      };
    },
  ): TaskListPage {
    if (
      !Number.isInteger(input.pageSize) ||
      input.pageSize < 1 ||
      input.pageSize > 100
    ) {
      throw new Error("task_page_size_invalid");
    }
    const projection = taskListProjectionSchema.parse(input.projection);
    const scopeMode = taskScopeModeSchema.parse(input.scopeMode);
    const query =
      input.query === undefined
        ? undefined
        : asciiLowercase(taskQuerySchema.parse(input.query).trim());
    const resolved = this.#resolveScope(scope, input.taskScope);
    const queryFingerprint = fingerprint("task.list@3", [
      scope.tenantId,
      scope.principalId,
      ...scopeFingerprintParts(input.taskScope),
      scopeMode,
      input.completed ?? null,
      input.pinned ?? null,
      query ?? null,
      projection,
      input.pageSize,
      input.authorityBinding ?? null,
    ]);
    const after = input.cursor
      ? decodeTaskCursor(input.cursor, queryFingerprint)
      : undefined;
    const scopeSelection =
      scopeMode === "subtree" && resolved.scopeKind === "global"
        ? { clause: "1 = 1", values: [] }
        : scopeMode === "subtree" && resolved.scopeKind === "workspace"
          ? {
              clause: `(
                (scope_kind = 'workspace' AND workspace_id = ?)
                OR (
                  scope_kind = 'thread'
                  AND EXISTS (
                    SELECT 1
                    FROM application_threads AS scoped_thread
                    WHERE scoped_thread.tenant_id = tasks.tenant_id
                      AND scoped_thread.owner_principal_id = tasks.owner_principal_id
                      AND scoped_thread.id = tasks.thread_id
                      AND scoped_thread.workspace_id = ?
                  )
                )
              )`,
              values: [resolved.workspaceId, resolved.workspaceId],
            }
          : resolved.scopeKind === "global"
            ? { clause: "scope_kind = 'global'", values: [] }
            : resolved.scopeKind === "workspace"
              ? {
                  clause: "scope_kind = 'workspace' AND workspace_id = ?",
                  values: [resolved.workspaceId],
                }
              : {
                  clause: "scope_kind = 'thread' AND thread_id = ?",
                  values: [resolved.threadId],
                };
    const filters = [
      input.completed === undefined
        ? undefined
        : input.completed
          ? "completed_at IS NOT NULL"
          : "completed_at IS NULL",
      input.pinned === undefined ? undefined : "pinned = ?",
      query === undefined
        ? undefined
        : "(instr(lower(title), ?) > 0 OR instr(lower(details), ?) > 0)",
    ].filter((filter): filter is string => filter !== undefined);
    const rows = this.database
      .prepare(
        `
          SELECT id, scope_kind AS scopeKind, workspace_id AS workspaceId,
            thread_id AS threadId,
            CASE
              WHEN scope_kind = 'thread' THEN (
                SELECT task_thread.workspace_id
                FROM application_threads AS task_thread
                WHERE task_thread.tenant_id = tasks.tenant_id
                  AND task_thread.owner_principal_id = tasks.owner_principal_id
                  AND task_thread.id = tasks.thread_id
              )
              ELSE workspace_id
            END AS associatedWorkspaceId,
            title, pinned, completed_at AS completedAt,
            revision, created_at AS createdAt, updated_at AS updatedAt,
            json_array_length(files_json) AS fileCount
          FROM tasks
          WHERE tenant_id = ? AND owner_principal_id = ? AND ${scopeSelection.clause}
            ${filters.map((filter) => `AND ${filter}`).join("\n            ")}
            ${after ? "AND (created_at > ? OR (created_at = ? AND id > ?))" : ""}
          ORDER BY created_at ASC, id ASC
          LIMIT ?
        `,
      )
      .all(
        scope.tenantId,
        scope.principalId,
        ...scopeSelection.values,
        ...(input.pinned === undefined ? [] : [input.pinned ? 1 : 0]),
        ...(query === undefined ? [] : [query, query]),
        ...(after ? [after.createdAt, after.createdAt, after.id] : []),
        input.pageSize + 1,
      ) as TaskSummaryRow[];
    if (projection === "full") {
      const items: AssociatedTaskRecord[] = [];
      let serializedBytes = 0;
      for (const row of rows.slice(0, input.pageSize)) {
        const record = this.getAssociated(scope, row.id);
        const recordBytes = Buffer.byteLength(JSON.stringify(record), "utf8");
        if (
          items.length > 0 &&
          serializedBytes + recordBytes > FULL_TASK_LIST_RECORD_BUDGET_BYTES
        ) {
          break;
        }
        items.push(record);
        serializedBytes += recordBytes;
      }
      const last = items.at(-1);
      return {
        projection,
        items,
        ...(last &&
        (items.length < Math.min(rows.length, input.pageSize) ||
          rows.length > input.pageSize)
          ? {
              nextCursor: encodeTaskCursor({
                fingerprint: queryFingerprint,
                createdAt: last.createdAt,
                id: last.id,
              }),
            }
          : {}),
      };
    }
    const items = rows.slice(0, input.pageSize).map((row) => ({
      ...row,
      pinned: row.pinned === 1,
    }));
    const last = items.at(-1);
    return {
      projection,
      items,
      ...(rows.length > input.pageSize && last
        ? {
            nextCursor: encodeTaskCursor({
              fingerprint: queryFingerprint,
              createdAt: last.createdAt,
              id: last.id,
            }),
          }
        : {}),
    };
  }

  /**
   * Agent-tool list entry point. The admitted set must exactly match fresh
   * scope authority, preventing a missing or narrower grant from falling back
   * to the principal-wide global-subtree query.
   */
  listPageWithEnvironmentAuthority(
    scope: RequestScope,
    input: {
      readonly taskScope: TaskScope;
      readonly scopeMode: TaskScopeMode;
      readonly targetEnvironmentIds: readonly string[];
      readonly sourceEnvironmentId: string;
      readonly policyRevision: number;
      readonly continuationAuthorityDigest: string;
      readonly completed?: boolean;
      readonly pinned?: boolean;
      readonly query?: string;
      readonly projection: TaskListProjection;
      readonly cursor?: string;
      readonly pageSize: number;
    },
  ): TaskListPage {
    const currentEnvironmentIds = this.resolveScopeEnvironmentIds(
      scope,
      input.taskScope,
      input.scopeMode,
    );
    const targetEnvironmentIds = [
      ...new Set(input.targetEnvironmentIds),
    ].sort();
    if (
      targetEnvironmentIds.length !== currentEnvironmentIds.length ||
      targetEnvironmentIds.some(
        (environmentId, index) =>
          environmentId !== currentEnvironmentIds[index],
      )
    ) {
      throw new DomainError(
        "not_found",
        "The target task environments no longer match the query scope.",
      );
    }
    return this.listPage(scope, {
      taskScope: input.taskScope,
      scopeMode: input.scopeMode,
      ...(input.completed === undefined ? {} : { completed: input.completed }),
      ...(input.pinned === undefined ? {} : { pinned: input.pinned }),
      ...(input.query === undefined ? {} : { query: input.query }),
      projection: input.projection,
      ...(input.cursor === undefined ? {} : { cursor: input.cursor }),
      pageSize: input.pageSize,
      authorityBinding: {
        sourceEnvironmentId: input.sourceEnvironmentId,
        targetEnvironmentIds,
        policyRevision: input.policyRevision,
        continuationAuthorityDigest: input.continuationAuthorityDigest,
      },
    });
  }

  find(scope: RequestScope, taskId: string): TaskRecord | undefined {
    const row = this.database
      .prepare(
        `
          SELECT ${columns}
          FROM tasks
          WHERE tenant_id = ? AND owner_principal_id = ? AND id = ?
        `,
      )
      .get(scope.tenantId, scope.principalId, taskId) as TaskRow | undefined;
    return row ? this.#presentRow(row) : undefined;
  }

  get(scope: RequestScope, taskId: string): TaskRecord {
    const record = this.find(scope, taskId);
    if (!record) {
      throw new DomainError("not_found", "The task was not found.");
    }
    return record;
  }

  findAssociated(
    scope: RequestScope,
    taskId: string,
  ): AssociatedTaskRecord | undefined {
    const row = this.database
      .prepare(
        `
          SELECT ${associatedColumns}
          FROM tasks
          WHERE tenant_id = ? AND owner_principal_id = ? AND id = ?
        `,
      )
      .get(scope.tenantId, scope.principalId, taskId) as
      AssociatedTaskRow | undefined;
    return row ? this.#presentAssociatedRow(row) : undefined;
  }

  getAssociated(scope: RequestScope, taskId: string): AssociatedTaskRecord {
    const record = this.findAssociated(scope, taskId);
    if (!record) {
      throw new DomainError("not_found", "The task was not found.");
    }
    return record;
  }

  /**
   * Read a task body only if its bounded authority facts still match the
   * pre-admission snapshot. The revision comparison also closes scope-change
   * races because every task update increments the same CAS revision.
   */
  getWithEnvironmentAuthority(
    scope: RequestScope,
    expected: TaskEnvironmentAuthority,
  ): TaskRecord {
    const current = this.resolveTaskEnvironmentAuthority(
      scope,
      expected.taskId,
    );
    if (
      current.revision !== expected.revision ||
      current.scopeKind !== expected.scopeKind ||
      current.environmentId !== expected.environmentId
    ) {
      throw new DomainError(
        "conflict",
        "The task authority changed before it could be read.",
      );
    }
    return this.get(scope, expected.taskId);
  }

  create(
    scope: RequestScope,
    input: {
      readonly title: string;
      readonly details?: string;
      readonly pinned?: boolean;
      readonly files?: readonly string[];
      readonly scope: TaskScope;
      readonly mutationId: string;
      readonly now: number;
    },
  ): TaskRecord {
    taskTitleSchema.parse(input.title);
    const details = input.details ?? "";
    taskDetailsSchema.parse(details);
    const pinned = input.pinned ?? false;
    const files = input.files ?? [];
    taskFilesSchema.parse(files);
    const requestFingerprint = fingerprint("create_task", [
      input.title,
      details,
      pinned,
      files,
      ...scopeFingerprintParts(input.scope),
    ]);
    return this.database.transaction(() => {
      const replayed = this.#replayedTask(
        scope,
        input.mutationId,
        "create_task",
        requestFingerprint,
      );
      if (replayed) return replayed;
      const resolved = this.#resolveScope(scope, input.scope);
      const id = randomUUID();
      this.database
        .prepare(
          `
            INSERT INTO tasks(
              tenant_id, owner_principal_id, id, scope_kind, environment_id,
              workspace_id, thread_id, title, details, pinned, files_json,
              completed_at, revision, created_at, updated_at
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, 0, ?, ?)
          `,
        )
        .run(
          scope.tenantId,
          scope.principalId,
          id,
          resolved.scopeKind,
          resolved.environmentId,
          resolved.workspaceId,
          resolved.threadId,
          input.title,
          details,
          pinned ? 1 : 0,
          JSON.stringify(files),
          input.now,
          input.now,
        );
      const record = this.get(scope, id);
      this.#insertReceipt(
        scope,
        input.mutationId,
        "create_task",
        requestFingerprint,
        record,
        input.now,
      );
      return record;
    })();
  }

  update(
    scope: RequestScope,
    taskId: string,
    input: {
      readonly title?: string;
      readonly details?: string;
      readonly completed?: boolean;
      readonly pinned?: boolean;
      readonly files?: readonly string[];
      readonly scope?: TaskScope;
      readonly expectedRevision: number;
      readonly mutationId: string;
      readonly now: number;
    },
  ): TaskRecord {
    if (input.title !== undefined) taskTitleSchema.parse(input.title);
    if (input.details !== undefined) taskDetailsSchema.parse(input.details);
    if (input.files !== undefined) taskFilesSchema.parse(input.files);
    const legacyFingerprintParts = [
      taskId,
      input.title ?? null,
      input.details ?? null,
      input.completed ?? null,
      input.expectedRevision,
    ] as const;
    const requestFingerprint = fingerprint(
      "update_task",
      input.pinned === undefined &&
        input.files === undefined &&
        input.scope === undefined
        ? legacyFingerprintParts
        : [
            ...legacyFingerprintParts,
            input.pinned ?? null,
            input.files ?? null,
            input.scope === undefined
              ? null
              : scopeFingerprintParts(input.scope),
          ],
    );
    return this.database.transaction(() => {
      const replayed = this.#replayedTask(
        scope,
        input.mutationId,
        "update_task",
        requestFingerprint,
      );
      if (replayed) return replayed;
      this.get(scope, taskId);
      const resolvedScope =
        input.scope === undefined
          ? undefined
          : this.#resolveScope(scope, input.scope);
      const assignments = ["revision = revision + 1", "updated_at = ?"];
      const values: unknown[] = [input.now];
      if (input.title !== undefined) {
        assignments.push("title = ?");
        values.push(input.title);
      }
      if (input.details !== undefined) {
        assignments.push("details = ?");
        values.push(input.details);
      }
      if (input.completed !== undefined) {
        assignments.push("completed_at = ?");
        values.push(input.completed ? input.now : null);
      }
      if (input.pinned !== undefined) {
        assignments.push("pinned = ?");
        values.push(input.pinned ? 1 : 0);
      }
      if (input.files !== undefined) {
        assignments.push("files_json = ?");
        values.push(JSON.stringify(input.files));
      }
      if (resolvedScope !== undefined) {
        assignments.push(
          "scope_kind = ?",
          "environment_id = ?",
          "workspace_id = ?",
          "thread_id = ?",
        );
        values.push(
          resolvedScope.scopeKind,
          resolvedScope.environmentId,
          resolvedScope.workspaceId,
          resolvedScope.threadId,
        );
      }
      const changed = this.database
        .prepare(
          `
            UPDATE tasks
            SET ${assignments.join(", ")}
            WHERE tenant_id = ? AND owner_principal_id = ? AND id = ?
              AND revision = ?
          `,
        )
        .run(
          ...values,
          scope.tenantId,
          scope.principalId,
          taskId,
          input.expectedRevision,
        );
      if (changed.changes !== 1) {
        throw new DomainError(
          "task_revision_conflict",
          "The task changed in another client.",
        );
      }
      const record = this.get(scope, taskId);
      this.#insertReceipt(
        scope,
        input.mutationId,
        "update_task",
        requestFingerprint,
        record,
        input.now,
      );
      return record;
    })();
  }

  move(
    scope: RequestScope,
    taskId: string,
    input: {
      readonly scope: TaskScope;
      readonly expectedRevision: number;
      readonly mutationId: string;
      readonly now: number;
    },
  ): TaskRecord {
    const requestFingerprint = fingerprint("move_task", [
      taskId,
      ...scopeFingerprintParts(input.scope),
      input.expectedRevision,
    ]);
    return this.database.transaction(() => {
      const replayed = this.#replayedTask(
        scope,
        input.mutationId,
        "move_task",
        requestFingerprint,
      );
      if (replayed) return replayed;
      const current = this.get(scope, taskId);
      const resolved = this.#resolveScope(scope, input.scope);
      if (
        current.scopeKind === resolved.scopeKind &&
        current.environmentId === resolved.environmentId &&
        current.workspaceId === resolved.workspaceId &&
        current.threadId === resolved.threadId
      ) {
        if (current.revision !== input.expectedRevision) {
          throw new DomainError(
            "task_revision_conflict",
            "The task changed in another client.",
          );
        }
      } else {
        const changed = this.database
          .prepare(
            `
              UPDATE tasks
              SET scope_kind = ?, environment_id = ?, workspace_id = ?,
                thread_id = ?, revision = revision + 1, updated_at = ?
              WHERE tenant_id = ? AND owner_principal_id = ? AND id = ?
                AND revision = ?
            `,
          )
          .run(
            resolved.scopeKind,
            resolved.environmentId,
            resolved.workspaceId,
            resolved.threadId,
            input.now,
            scope.tenantId,
            scope.principalId,
            taskId,
            input.expectedRevision,
          );
        if (changed.changes !== 1) {
          throw new DomainError(
            "task_revision_conflict",
            "The task changed in another client.",
          );
        }
      }
      const record = this.get(scope, taskId);
      this.#insertReceipt(
        scope,
        input.mutationId,
        "move_task",
        requestFingerprint,
        record,
        input.now,
      );
      return record;
    })();
  }

  /** Idempotent, receipt-less delete following the stash-delete convention. */
  remove(scope: RequestScope, taskId: string): boolean {
    return (
      this.database
        .prepare(
          `
            DELETE FROM tasks
            WHERE tenant_id = ? AND owner_principal_id = ? AND id = ?
          `,
        )
        .run(scope.tenantId, scope.principalId, taskId).changes === 1
    );
  }

  /**
   * Bounded open thread-task summaries for an authoritative archive set.
   * Membership and ownership are both supplied by the server; callers never
   * use a browser task snapshot to select archive-impact rows.
   */
  listOpenThreadTaskSummaries(
    scope: RequestScope,
    threadIds: readonly string[],
    limit: number,
  ): OpenThreadTaskSummaryCollection {
    if (!Number.isInteger(limit) || limit < 0) {
      throw new Error("open_thread_task_summary_limit_invalid");
    }
    if (threadIds.length === 0) {
      return { items: [], total: 0, omitted: 0 };
    }
    const placeholders = threadIds.map(() => "?").join(", ");
    const countRow = this.database
      .prepare(
        `
          SELECT COUNT(*) AS total
          FROM tasks
          WHERE tenant_id = ? AND owner_principal_id = ?
            AND scope_kind = 'thread'
            AND thread_id IN (${placeholders})
            AND completed_at IS NULL
        `,
      )
      .get(scope.tenantId, scope.principalId, ...threadIds) as {
      readonly total: number;
    };
    const items = this.database
      .prepare(
        `
          SELECT id, title, thread_id AS threadId
          FROM tasks
          WHERE tenant_id = ? AND owner_principal_id = ?
            AND scope_kind = 'thread'
            AND thread_id IN (${placeholders})
            AND completed_at IS NULL
          ORDER BY created_at ASC, id ASC
          LIMIT ?
        `,
      )
      .all(
        scope.tenantId,
        scope.principalId,
        ...threadIds,
        limit,
      ) as OpenThreadTaskSummary[];
    return {
      items,
      total: countRow.total,
      omitted: countRow.total - items.length,
    };
  }

  /**
   * Archive-time disposition of the archive set's open thread tasks. Runs
   * inside the caller's archive transaction (better-sqlite3 nests as a
   * savepoint); the enclosing inventory mutation receipt covers it, so no
   * task receipt is written here. Returns the moved task ids for post-commit
   * publication.
   */
  moveOpenThreadTasks(
    scope: RequestScope,
    threadIds: readonly string[],
    disposition: "move_to_workspace" | "move_to_global",
    now: number,
  ): readonly string[] {
    if (threadIds.length === 0) return [];
    const placeholders = threadIds.map(() => "?").join(", ");
    const moveSql =
      disposition === "move_to_global"
        ? `
          UPDATE tasks
          SET scope_kind = 'global', environment_id = NULL,
            workspace_id = NULL, thread_id = NULL,
            revision = revision + 1, updated_at = ?
          WHERE tenant_id = ? AND owner_principal_id = ?
            AND thread_id IN (${placeholders})
            AND completed_at IS NULL
          RETURNING id
        `
        : `
          UPDATE tasks
          SET scope_kind = 'workspace',
            environment_id = (
              SELECT thread.environment_id FROM application_threads AS thread
              WHERE thread.tenant_id = tasks.tenant_id
                AND thread.owner_principal_id = tasks.owner_principal_id
                AND thread.id = tasks.thread_id
            ),
            workspace_id = (
              SELECT thread.workspace_id FROM application_threads AS thread
              WHERE thread.tenant_id = tasks.tenant_id
                AND thread.owner_principal_id = tasks.owner_principal_id
                AND thread.id = tasks.thread_id
            ),
            thread_id = NULL,
            revision = revision + 1, updated_at = ?
          WHERE tenant_id = ? AND owner_principal_id = ?
            AND thread_id IN (${placeholders})
            AND completed_at IS NULL
          RETURNING id
        `;
    return this.database.transaction(() => {
      const moved = this.database
        .prepare(moveSql)
        .all(now, scope.tenantId, scope.principalId, ...threadIds) as readonly {
        readonly id: string;
      }[];
      return moved.map(({ id }) => id);
    })();
  }

  /**
   * Draft-discard disposition: promote every task of a hard-deleted thread
   * (open and completed) to the thread's workspace. Runs inside the caller's
   * delete transaction, before the thread row disappears.
   */
  promoteThreadTasksToWorkspace(
    scope: RequestScope,
    threadId: string,
    now: number,
  ): readonly string[] {
    const moved = this.database
      .prepare(
        `
          UPDATE tasks
          SET scope_kind = 'workspace',
            environment_id = (
              SELECT thread.environment_id FROM application_threads AS thread
              WHERE thread.tenant_id = tasks.tenant_id
                AND thread.owner_principal_id = tasks.owner_principal_id
                AND thread.id = tasks.thread_id
            ),
            workspace_id = (
              SELECT thread.workspace_id FROM application_threads AS thread
              WHERE thread.tenant_id = tasks.tenant_id
                AND thread.owner_principal_id = tasks.owner_principal_id
                AND thread.id = tasks.thread_id
            ),
            thread_id = NULL,
            revision = revision + 1, updated_at = ?
          WHERE tenant_id = ? AND owner_principal_id = ? AND thread_id = ?
          RETURNING id
        `,
      )
      .all(now, scope.tenantId, scope.principalId, threadId) as readonly {
      readonly id: string;
    }[];
    return moved.map(({ id }) => id);
  }

  #resolveScope(scope: RequestScope, target: TaskScope): ResolvedScopeColumns {
    if (target.kind === "global") {
      return {
        scopeKind: "global",
        environmentId: null,
        workspaceId: null,
        threadId: null,
      };
    }
    if (target.kind === "workspace") {
      const workspace = this.database
        .prepare(
          `
            SELECT environment_id AS environmentId
            FROM workspaces
            WHERE tenant_id = ? AND owner_principal_id = ? AND id = ?
          `,
        )
        .get(scope.tenantId, scope.principalId, target.workspaceId) as
        { readonly environmentId: string } | undefined;
      if (!workspace) {
        throw new DomainError(
          "not_found",
          "The destination workspace was not found.",
        );
      }
      return {
        scopeKind: "workspace",
        environmentId: workspace.environmentId,
        workspaceId: target.workspaceId,
        threadId: null,
      };
    }
    const thread = this.database
      .prepare(
        `
          SELECT 1
          FROM application_threads
          WHERE tenant_id = ? AND owner_principal_id = ? AND id = ?
        `,
      )
      .get(scope.tenantId, scope.principalId, target.threadId);
    if (!thread) {
      throw new DomainError(
        "not_found",
        "The destination thread was not found.",
      );
    }
    return {
      scopeKind: "thread",
      environmentId: null,
      workspaceId: null,
      threadId: target.threadId,
    };
  }

  #presentRow(row: TaskRow): TaskRecord {
    const { pinned, filesJson, ...record } = row;
    return {
      ...record,
      pinned: pinned === 1,
      files: taskFilesSchema.parse(JSON.parse(filesJson)),
    };
  }

  #presentAssociatedRow(row: AssociatedTaskRow): AssociatedTaskRecord {
    const { associatedWorkspaceId, ...taskRow } = row;
    return { ...this.#presentRow(taskRow), associatedWorkspaceId };
  }

  /**
   * A replayed mutation returns the receipted result — the committed row as
   * of the original mutation — not the live row, so retries stay stable when
   * later mutations changed or deleted the task.
   */
  #replayedTask(
    scope: RequestScope,
    mutationId: string,
    operationKind: string,
    requestFingerprint: string,
  ): TaskRecord | undefined {
    const receipt = this.database
      .prepare(
        `
          SELECT operation_kind AS operationKind,
            request_fingerprint AS requestFingerprint,
            result_json AS resultJson
          FROM task_mutation_receipts
          WHERE tenant_id = ? AND principal_id = ? AND mutation_id = ?
        `,
      )
      .get(scope.tenantId, scope.principalId, mutationId) as
      TaskMutationReceipt | undefined;
    if (!receipt) return undefined;
    if (
      receipt.operationKind !== operationKind ||
      receipt.requestFingerprint !== requestFingerprint
    ) {
      throw new DomainError(
        "conflict",
        "The mutation ID was reused for a different operation.",
      );
    }
    const { record } = JSON.parse(receipt.resultJson) as {
      readonly record: TaskRecord;
    };
    return record;
  }

  #insertReceipt(
    scope: RequestScope,
    mutationId: string,
    operationKind: string,
    requestFingerprint: string,
    record: TaskRecord,
    now: number,
  ): void {
    this.database
      .prepare(
        `
          INSERT INTO task_mutation_receipts(
            tenant_id, principal_id, mutation_id, operation_kind,
            request_fingerprint, result_json, created_at
          )
          VALUES (?, ?, ?, ?, ?, ?, ?)
        `,
      )
      .run(
        scope.tenantId,
        scope.principalId,
        mutationId,
        operationKind,
        requestFingerprint,
        JSON.stringify({ version: 1, record }),
        now,
      );
  }
}
